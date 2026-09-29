#!/usr/bin/env node
/*
 * Regenerates the sample GIF that visitors can open in the GIF editor, and the
 * homepage demonstration made from it.
 *
 *   npm run build && node scripts/make-sample-media.cjs
 *
 * The animation is drawn here, frame by frame, so the project owns it outright
 * and the caption's motion keyframes come from the same path the bee flies.
 * No tracking model is involved: the sample must never start GPU work.
 *
 * The homepage clip is not drawn: it is a real export of the sample session,
 * made by the GIF editor itself, then re-encoded as MP4 because it is a
 * fraction of the GIF's size.
 *
 * Writes frontend/samples/bee.{gif,json} and bee-demo.{mp4,webm,webp}.
 * Needs ffmpeg on PATH and the Playwright Chromium from `npm ci`.
 */
'use strict';

const { chromium } = require('@playwright/test');
const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { GifReader } = require('../frontend/vendor/omggif.js');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'frontend', 'samples');
const W = 640, H = 360, FRAMES = 40, DELAY_MS = 80;

// Figure-eight flight path in normalised coordinates, periodic over t in [0, 1).
function beeAt(t) {
  const a = 2 * Math.PI * t;
  return {
    x: 0.5 + 0.3 * Math.sin(a),
    y: 0.52 + 0.13 * Math.sin(2 * a) + 0.012 * Math.sin(6 * a),
    vx: Math.cos(a),
    vy: 0.26 * Math.cos(2 * a),
  };
}

// Runs in the browser. Kept free of closures so it can be serialised.
function drawFrame({ W, H, frame, bee, trail }) {
  const canvas = document.getElementById('c');
  // CPU-backed: a GPU canvas in headless Chromium can lose its context mid-run.
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const ink = '#2d2a26';

  const sky = ctx.createLinearGradient(0, 0, 0, H * 0.72);
  sky.addColorStop(0, '#8fcdf0');
  sky.addColorStop(1, '#e8f6fb');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, H);

  const sun = ctx.createRadialGradient(W * 0.84, H * 0.2, 0, W * 0.84, H * 0.2, H * 0.24);
  sun.addColorStop(0, 'rgba(255,244,190,1)');
  sun.addColorStop(0.35, 'rgba(255,236,150,0.95)');
  sun.addColorStop(0.36, 'rgba(255,240,180,0.35)');
  sun.addColorStop(1, 'rgba(255,240,180,0)');
  ctx.fillStyle = sun;
  ctx.fillRect(0, 0, W, H);

  function cloud(cx, cy, s) {
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    ctx.beginPath();
    [[0, 0, 26], [28, -10, 30], [58, 0, 24], [30, 8, 26], [-22, 8, 18], [80, 8, 16]].forEach(function (p) {
      ctx.moveTo(cx + (p[0] + p[2]) * s, cy + p[1] * s);
      ctx.arc(cx + p[0] * s, cy + p[1] * s, p[2] * s, 0, Math.PI * 2);
    });
    ctx.fill();
  }
  cloud(W * 0.12, H * 0.2, 0.9);
  cloud(W * 0.55, H * 0.12, 0.6);

  function hill(color, base, amp, freq, phase) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(0, H);
    for (let x = 0; x <= W; x += 8) {
      ctx.lineTo(x, H * base - amp * H * Math.sin((x / W) * Math.PI * freq + phase));
    }
    ctx.lineTo(W, H);
    ctx.closePath();
    ctx.fill();
  }
  hill('#b5e0b4', 0.7, 0.06, 1.6, 0.4);
  hill('#8fd08f', 0.8, 0.05, 2.2, 2.1);
  hill('#6fbf74', 0.9, 0.035, 3.1, 0.9);

  function flower(x, stemH, petal, color, s) {
    const top = H - stemH;
    ctx.strokeStyle = '#4f9e57';
    ctx.lineWidth = 3 * s;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x, H + 4);
    ctx.quadraticCurveTo(x - 6 * s, H - stemH / 2, x, top);
    ctx.stroke();
    ctx.fillStyle = '#5daa63';
    ctx.beginPath();
    ctx.ellipse(x + 8 * s, H - stemH * 0.42, 9 * s, 4 * s, -0.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = color;
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      ctx.beginPath();
      ctx.arc(x + Math.cos(a) * petal * s, top + Math.sin(a) * petal * s, petal * 0.78 * s, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = '#ffd24a';
    ctx.beginPath();
    ctx.arc(x, top, petal * 0.72 * s, 0, Math.PI * 2);
    ctx.fill();
  }
  [[0.07, 78, 9, '#ff8fb3'], [0.19, 58, 8, '#ffffff'], [0.31, 88, 10, '#c7a2ff'],
   [0.46, 62, 8, '#ffb870'], [0.6, 84, 9, '#ff8fb3'], [0.73, 56, 8, '#ffffff'],
   [0.86, 80, 10, '#c7a2ff'], [0.96, 60, 8, '#ffb870']].forEach(function (f) {
    flower(W * f[0], f[1], f[2], f[3], 1);
  });

  // Dotted flight trail, fading towards its tail.
  trail.forEach(function (p, i) {
    ctx.fillStyle = 'rgba(255,255,255,' + (0.15 + 0.6 * (i / trail.length)).toFixed(3) + ')';
    ctx.beginPath();
    ctx.arc(p.x * W, p.y * H, 2.6, 0, Math.PI * 2);
    ctx.fill();
  });

  const s = 1.25;
  const facing = bee.vx >= 0 ? 1 : -1;
  const tilt = Math.max(-0.35, Math.min(0.35, Math.atan2(bee.vy, Math.abs(bee.vx) + 0.35)));
  const wingUp = frame % 2 === 0;
  ctx.save();
  ctx.translate(bee.x * W, bee.y * H);
  ctx.scale(facing, 1);
  ctx.rotate(tilt);

  function wing(dx, dy, rot, alpha) {
    ctx.save();
    ctx.translate(dx * s, dy * s);
    ctx.rotate(rot);
    ctx.fillStyle = 'rgba(236,248,255,' + alpha + ')';
    ctx.strokeStyle = 'rgba(80,120,150,0.7)';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.ellipse(0, 0, 15 * s, 9 * s, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
  if (wingUp) wing(-8, -22, -0.5, 0.75); else wing(-6, -14, 0.25, 0.75);

  ctx.beginPath();
  ctx.moveTo(-27 * s, 0);
  ctx.lineTo(-36 * s, -3 * s);
  ctx.lineTo(-27 * s, 5 * s);
  ctx.fillStyle = ink;
  ctx.fill();

  ctx.save();
  ctx.beginPath();
  ctx.ellipse(0, 0, 27 * s, 19 * s, 0, 0, Math.PI * 2);
  ctx.fillStyle = '#ffc83d';
  ctx.fill();
  ctx.clip();
  ctx.fillStyle = ink;
  [-13, 1].forEach(function (x) { ctx.fillRect(x * s, -20 * s, 7 * s, 40 * s); });
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.beginPath();
  ctx.ellipse(-2 * s, -9 * s, 16 * s, 5 * s, -0.1, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  ctx.strokeStyle = ink;
  ctx.lineWidth = 2.4;
  ctx.beginPath();
  ctx.ellipse(0, 0, 27 * s, 19 * s, 0, 0, Math.PI * 2);
  ctx.stroke();

  ctx.fillStyle = ink;
  ctx.beginPath();
  ctx.arc(25 * s, -2 * s, 13 * s, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = ink;
  ctx.lineWidth = 2;
  [[26, -24, 20], [32, -21, 30]].forEach(function (a) {
    ctx.beginPath();
    ctx.moveTo(24 * s, -12 * s);
    ctx.quadraticCurveTo(a[2] * s, -26 * s, a[0] * s, a[1] * s);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(a[0] * s, a[1] * s, 2.6 * s, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(29 * s, -5 * s, 4.6 * s, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = ink;
  ctx.beginPath();
  ctx.arc(30.5 * s, -5 * s, 2.3 * s, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#ff9db5';
  ctx.beginPath();
  ctx.arc(31 * s, 3 * s, 2.4 * s, 0, Math.PI * 2);
  ctx.fill();

  if (wingUp) wing(-2, -24, -0.2, 0.85); else wing(0, -12, 0.45, 0.85);
  ctx.restore();

  if (ctx.getImageData(0, 0, 1, 1).data[3] !== 255) throw new Error('Canvas lost frame ' + frame);
  return canvas.toDataURL('image/png');
}

// Caption preset. Position is the top-centre of the text box; it rides just
// above the bee. Keyframes every other frame match what tracking produces.
function captionPreset() {
  const motion = [];
  for (let f = 0; f < FRAMES; f += 2) motion.push(keyframe(f));
  motion.push(keyframe(FRAMES - 1));
  function keyframe(frame) {
    const p = beeAt(frame / FRAMES);
    return { frame, x: +p.x.toFixed(4), y: +(p.y - 0.27).toFixed(4) };
  }
  return {
    text: 'BZZZ!', fontSize: 46, fontFamily: 'Impact', fontWeight: 700,
    color: '#ffffff', strokeColor: '#000000', strokeWidth: 3, align: 'center',
    boxWidth: 0.3, boxHeight: 0.17, x: motion[0].x, y: motion[0].y, motion,
  };
}

async function renderSample() {
  fs.mkdirSync(OUT, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sample-gif-'));
  const browser = await chromium.launch({ args: ['--disable-gpu'] });
  try {
    const page = await browser.newPage();
    await page.setContent(`<canvas id="c" width="${W}" height="${H}"></canvas>`);
    for (let i = 0; i < FRAMES; i++) {
      const t = i / FRAMES;
      const trail = [];
      for (let k = 14; k >= 1; k--) trail.push(beeAt(t - k * 0.012 - 0.02));
      const url = await page.evaluate(drawFrame, { W, H, frame: i, bee: beeAt(t), trail });
      fs.writeFileSync(path.join(tmp, `f${String(i).padStart(3, '0')}.png`),
        Buffer.from(url.split(',')[1], 'base64'));
    }
  } finally {
    await browser.close();
  }

  // Ordered dithering is identical in every frame, so the static scenery
  // encodes once and each frame only stores the bee and its trail.
  const gif = path.join(OUT, 'bee.gif');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(1000 / DELAY_MS),
    '-i', path.join(tmp, 'f%03d.png'), '-vf',
    'split[a][b];[a]palettegen=max_colors=160:stats_mode=full[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle',
    '-loop', '0', gif]);
  fs.rmSync(tmp, { recursive: true, force: true });

  const preset = {
    gif: '/samples/bee.gif',
    filename: 'sample-bee.gif',
    subject: 'bee',
    captions: [captionPreset()],
  };
  fs.writeFileSync(path.join(OUT, 'bee.json'), JSON.stringify(preset) + '\n');
  console.log(`bee.gif ${(fs.statSync(gif).size / 1024).toFixed(0)} KB, ${FRAMES} frames`);
}

async function exportDemo() {
  const port = 3190 + Math.floor(Math.random() * 100);
  const server = spawn('npx', ['serve', 'frontend', '-l', String(port)], { cwd: ROOT, stdio: 'ignore' });
  const browser = await chromium.launch({ args: ['--disable-gpu'] });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sample-demo-'));
  try {
    const page = await browser.newPage();
    await page.addInitScript(() => localStorage.setItem('gc_cookie_consent', 'rejected'));
    for (let attempt = 0; ; attempt++) {
      try { await page.goto(`http://localhost:${port}/gif-editor/edit/?sample=1`); break; }
      catch (err) { if (attempt > 40) throw err; await page.waitForTimeout(250); }
    }
    await page.waitForFunction(() => GC.state.isSample && GC.state._workerBlobUrl);
    const dataUrl = await page.evaluate(() => new Promise(resolve => {
      GC.exportGif({ onBlob: blob => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.readAsDataURL(blob);
      } });
    }));
    const gif = path.join(tmp, 'demo.gif');
    const bytes = Buffer.from(dataUrl.split(',')[1], 'base64');
    const exported = new GifReader(new Uint8Array(bytes));
    if (exported.numFrames() !== FRAMES) throw new Error('Editor exported ' + exported.numFrames() + ' frames');
    fs.writeFileSync(gif, bytes);
    const mp4 = path.join(OUT, 'bee-demo.mp4'), webm = path.join(OUT, 'bee-demo.webm');
    const poster = path.join(OUT, 'bee-demo.webp');
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', gif, '-an', '-c:v', 'libx264',
      '-preset', 'veryslow', '-tune', 'animation', '-crf', '24', '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart', mp4]);
    // For browsers built without H.264, such as some Linux Chromium builds.
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', gif, '-an', '-c:v', 'libvpx-vp9',
      '-b:v', '0', '-crf', '36', '-row-mt', '1', '-pix_fmt', 'yuv420p', webm]);
    // Frame 3 has the bee low and its caption clear of the sun: a readable still.
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', gif, '-vf', 'select=eq(n\\,3)',
      '-frames:v', '1', '-c:v', 'libwebp', '-quality', '80', poster]);
    const kb = file => (fs.statSync(file).size / 1024).toFixed(0) + ' KB';
    console.log(`bee-demo.mp4 ${kb(mp4)}, .webm ${kb(webm)}, poster ${kb(poster)}`);
  } finally {
    await browser.close();
    server.kill();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

renderSample().then(exportDemo).catch(function (err) { console.error(err); process.exit(1); });
