#!/usr/bin/env node
/*
 * Regenerates the sample GIFs that visitors can open in the GIF editor, and the
 * homepage demonstrations made from them.
 *
 *   npm run build && node scripts/make-sample-media.cjs
 *
 * The animation is drawn here, frame by frame, so the project owns it outright.
 * It comes as a day scene and a night scene for the dark theme; both share one
 * flight path. That path is written into the preset twice: as the caption's
 * motion keyframes, and as the bee's position on every frame, which lets
 * Follow an Object work on the sample without the GPU tracker.
 *
 * The homepage clips are not drawn: each is a real export of the sample session,
 * made by the GIF editor itself, then re-encoded as video because it is a
 * fraction of the GIF's size.
 *
 * The bee's outline on every frame is also written as masks in the
 * segmentation service's format, so removing the sample's background needs
 * no GPU either.
 *
 * Writes frontend/samples/bee{,-night}.gif, bee.json, bee.masks.gz and
 * bee{,-night}-demo.{mp4,webm,webp}. Name steps (gifs, preset, masks, demos)
 * to run only those.
 * Needs ffmpeg on PATH and the Playwright Chromium from `npm ci`.
 */
'use strict';

const { chromium } = require('@playwright/test');
const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
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

// A fixed pseudo-random sequence, so the night sky is the same on every run.
function seeded(seed) {
  return function () {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

function nightSky() {
  const rand = seeded(7), stars = [];
  while (stars.length < 46) {
    const x = rand() * W, y = rand() * H * 0.56;
    if (Math.hypot(x - W * 0.84, y - H * 0.2) < 62) continue;   // keep the moon clear
    stars.push({ x, y, r: 0.6 + rand() * 1.1, a: 0.35 + rand() * 0.6,
      twinkle: stars.length % 6 === 0 ? 1 + (stars.length % 2) : 0, phase: rand() });
  }
  const fireflies = [[0.14, 0.64], [0.29, 0.73], [0.41, 0.6], [0.66, 0.68], [0.79, 0.61], [0.92, 0.74]]
    .map(function (p, i) { return { x: p[0], y: p[1], phase: i / 6 }; });
  return { stars, fireflies };
}

const PALETTES = {
  day: {
    sky: [[0, '#8fcdf0'], [1, '#e8f6fb']], cloud: 'rgba(255,255,255,0.95)',
    hills: ['#b5e0b4', '#8fd08f', '#6fbf74'], stem: '#4f9e57', leaf: '#5daa63',
    petals: ['#ff8fb3', '#ffffff', '#c7a2ff', '#ffb870'], center: '#ffd24a',
    trail: '255,255,255', colors: 160,
  },
  night: Object.assign({
    night: true,
    sky: [[0, '#0b1030'], [0.55, '#1d1f52'], [1, '#3a2f6e']], cloud: 'rgba(196,204,248,0.2)',
    hills: ['#27406a', '#1f3f4b', '#1a3a33'], stem: '#3c7a55', leaf: '#468c60',
    petals: ['#f37aa9', '#e8ebf7', '#b89dff', '#f6b56e'], center: '#ffd24a',
    trail: '255,241,190', colors: 192,
  }, nightSky()),
};

// Runs in the browser. Kept free of closures so it can be serialised.
function drawFrame({ W, H, frame, t, bee, trail, pal, mask }) {
  const canvas = document.getElementById('c');
  // CPU-backed: a GPU canvas in headless Chromium can lose its context mid-run.
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const ink = '#2d2a26';
  const TAU = Math.PI * 2;

  const sky = ctx.createLinearGradient(0, 0, 0, H * 0.72);
  pal.sky.forEach(function (stop) { sky.addColorStop(stop[0], stop[1]); });
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, H);

  if (pal.night) {
    pal.stars.forEach(function (s) {
      const glint = s.twinkle ? 0.55 + 0.45 * Math.sin(TAU * (t * s.twinkle + s.phase)) : 1;
      ctx.fillStyle = 'rgba(255,255,255,' + (s.a * glint).toFixed(3) + ')';
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, TAU);
      ctx.fill();
    });
    const halo = ctx.createRadialGradient(W * 0.84, H * 0.2, 0, W * 0.84, H * 0.2, H * 0.26);
    halo.addColorStop(0, 'rgba(250,240,200,0.30)');
    halo.addColorStop(1, 'rgba(250,240,200,0)');
    ctx.fillStyle = halo;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#f6efd2';
    ctx.beginPath();
    ctx.arc(W * 0.84, H * 0.2, H * 0.075, 0, TAU);
    ctx.fill();
    ctx.fillStyle = 'rgba(196,184,150,0.35)';
    [[-8, -6, 6], [9, 4, 4.5], [-3, 11, 3.5]].forEach(function (c) {
      ctx.beginPath();
      ctx.arc(W * 0.84 + c[0], H * 0.2 + c[1], c[2], 0, TAU);
      ctx.fill();
    });
  } else {
    const sun = ctx.createRadialGradient(W * 0.84, H * 0.2, 0, W * 0.84, H * 0.2, H * 0.24);
    sun.addColorStop(0, 'rgba(255,244,190,1)');
    sun.addColorStop(0.35, 'rgba(255,236,150,0.95)');
    sun.addColorStop(0.36, 'rgba(255,240,180,0.35)');
    sun.addColorStop(1, 'rgba(255,240,180,0)');
    ctx.fillStyle = sun;
    ctx.fillRect(0, 0, W, H);
  }

  function cloud(cx, cy, s) {
    ctx.fillStyle = pal.cloud;
    ctx.beginPath();
    [[0, 0, 26], [28, -10, 30], [58, 0, 24], [30, 8, 26], [-22, 8, 18], [80, 8, 16]].forEach(function (p) {
      ctx.moveTo(cx + (p[0] + p[2]) * s, cy + p[1] * s);
      ctx.arc(cx + p[0] * s, cy + p[1] * s, p[2] * s, 0, TAU);
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
  hill(pal.hills[0], 0.7, 0.06, 1.6, 0.4);
  hill(pal.hills[1], 0.8, 0.05, 2.2, 2.1);
  hill(pal.hills[2], 0.9, 0.035, 3.1, 0.9);

  function flower(x, stemH, petal, color, s) {
    const top = H - stemH;
    ctx.strokeStyle = pal.stem;
    ctx.lineWidth = 3 * s;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x, H + 4);
    ctx.quadraticCurveTo(x - 6 * s, H - stemH / 2, x, top);
    ctx.stroke();
    ctx.fillStyle = pal.leaf;
    ctx.beginPath();
    ctx.ellipse(x + 8 * s, H - stemH * 0.42, 9 * s, 4 * s, -0.5, 0, TAU);
    ctx.fill();
    ctx.fillStyle = color;
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * TAU;
      ctx.beginPath();
      ctx.arc(x + Math.cos(a) * petal * s, top + Math.sin(a) * petal * s, petal * 0.78 * s, 0, TAU);
      ctx.fill();
    }
    ctx.fillStyle = pal.center;
    ctx.beginPath();
    ctx.arc(x, top, petal * 0.72 * s, 0, TAU);
    ctx.fill();
  }
  [[0.07, 78, 9, 0], [0.19, 58, 8, 1], [0.31, 88, 10, 2], [0.46, 62, 8, 3],
   [0.6, 84, 9, 0], [0.73, 56, 8, 1], [0.86, 80, 10, 2], [0.96, 60, 8, 3]].forEach(function (f) {
    flower(W * f[0], f[1], f[2], pal.petals[f[3]], 1);
  });

  if (pal.night) {
    pal.fireflies.forEach(function (f) {
      const x = (f.x + 0.012 * Math.sin(TAU * (t + f.phase))) * W;
      const y = (f.y + 0.02 * Math.sin(TAU * (2 * t + f.phase))) * H;
      const glow = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(TAU * (2 * t + f.phase)));
      const g = ctx.createRadialGradient(x, y, 0, x, y, 11);
      g.addColorStop(0, 'rgba(226,255,130,' + (0.5 * glow).toFixed(3) + ')');
      g.addColorStop(1, 'rgba(226,255,130,0)');
      ctx.fillStyle = g;
      ctx.fillRect(x - 11, y - 11, 22, 22);
      ctx.fillStyle = 'rgba(248,255,196,' + glow.toFixed(3) + ')';
      ctx.beginPath();
      ctx.arc(x, y, 2.2, 0, TAU);
      ctx.fill();
    });
  }

  // A mask is the bee alone, so the scenery drawn so far is cleared.
  if (mask) ctx.clearRect(0, 0, W, H);

  // Dotted flight trail, fading towards its tail.
  if (!mask) trail.forEach(function (p, i) {
    ctx.fillStyle = 'rgba(' + pal.trail + ',' + (0.15 + 0.6 * (i / trail.length)).toFixed(3) + ')';
    ctx.beginPath();
    ctx.arc(p.x * W, p.y * H, 2.6, 0, TAU);
    ctx.fill();
  });

  if (pal.night && !mask) {
    // A soft glow keeps the bee's dark head from sinking into the night sky.
    const g = ctx.createRadialGradient(bee.x * W, bee.y * H, 0, bee.x * W, bee.y * H, 62);
    g.addColorStop(0, 'rgba(255,214,120,0.24)');
    g.addColorStop(1, 'rgba(255,214,120,0)');
    ctx.fillStyle = g;
    ctx.fillRect(bee.x * W - 62, bee.y * H - 62, 124, 124);
  }

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
    ctx.ellipse(0, 0, 15 * s, 9 * s, 0, 0, TAU);
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
  ctx.ellipse(0, 0, 27 * s, 19 * s, 0, 0, TAU);
  ctx.fillStyle = '#ffc83d';
  ctx.fill();
  ctx.clip();
  ctx.fillStyle = ink;
  [-13, 1].forEach(function (x) { ctx.fillRect(x * s, -20 * s, 7 * s, 40 * s); });
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.beginPath();
  ctx.ellipse(-2 * s, -9 * s, 16 * s, 5 * s, -0.1, 0, TAU);
  ctx.fill();
  ctx.restore();
  ctx.strokeStyle = ink;
  ctx.lineWidth = 2.4;
  ctx.beginPath();
  ctx.ellipse(0, 0, 27 * s, 19 * s, 0, 0, TAU);
  ctx.stroke();

  ctx.fillStyle = ink;
  ctx.beginPath();
  ctx.arc(25 * s, -2 * s, 13 * s, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = ink;
  ctx.lineWidth = 2;
  [[26, -24, 20], [32, -21, 30]].forEach(function (a) {
    ctx.beginPath();
    ctx.moveTo(24 * s, -12 * s);
    ctx.quadraticCurveTo(a[2] * s, -26 * s, a[0] * s, a[1] * s);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(a[0] * s, a[1] * s, 2.6 * s, 0, TAU);
    ctx.fill();
  });
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(29 * s, -5 * s, 4.6 * s, 0, TAU);
  ctx.fill();
  ctx.fillStyle = ink;
  ctx.beginPath();
  ctx.arc(30.5 * s, -5 * s, 2.3 * s, 0, TAU);
  ctx.fill();
  ctx.fillStyle = '#ff9db5';
  ctx.beginPath();
  ctx.arc(31 * s, 3 * s, 2.4 * s, 0, TAU);
  ctx.fill();

  if (wingUp) wing(-2, -24, -0.2, 0.85); else wing(0, -12, 0.45, 0.85);
  ctx.restore();

  if (mask) {
    // One bit a pixel, first pixel in the high bit, as numpy.packbits writes them.
    const alpha = ctx.getImageData(0, 0, W, H).data, bits = new Uint8Array(Math.ceil(W * H / 8));
    for (let i = 0; i < W * H; i++) if (alpha[i * 4 + 3] >= 128) bits[i >> 3] |= 128 >> (i & 7);
    if (!bits.some(Boolean)) throw new Error('No bee in mask ' + frame);
    return Array.from(bits);
  }
  if (ctx.getImageData(0, 0, 1, 1).data[3] !== 255) throw new Error('Canvas lost frame ' + frame);
  return canvas.toDataURL('image/png');
}

const round4 = v => +v.toFixed(4);

// Caption preset. Position is the top-center of the text box; it rides just
// above the bee. Keyframes every other frame keep the timeline readable.
function captionPreset() {
  const motion = [];
  for (let f = 0; f < FRAMES; f += 2) motion.push(keyframe(f));
  motion.push(keyframe(FRAMES - 1));
  function keyframe(frame) {
    const p = beeAt(frame / FRAMES);
    return { frame, x: round4(p.x), y: round4(p.y - 0.27) };
  }
  return {
    text: 'BZZZ!', fontSize: 46, fontFamily: 'Impact', fontWeight: 700,
    color: '#ffffff', strokeColor: '#000000', strokeWidth: 3, align: 'center',
    boxWidth: 0.3, boxHeight: 0.17, x: motion[0].x, y: motion[0].y, motion,
  };
}

// Where the bee is on every frame, and how far from its center a tap still
// counts as the bee: what the tracker would report for it.
function subject() {
  const path = [];
  for (let f = 0; f < FRAMES; f++) {
    const p = beeAt(f / FRAMES);
    path.push({ frame: f, x: round4(p.x), y: round4(p.y) });
  }
  return { name: 'bee', radius: { x: 0.085, y: 0.115 }, path };
}

async function renderSample(variant) {
  fs.mkdirSync(OUT, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sample-gif-'));
  const browser = await chromium.launch({ args: ['--disable-gpu'] });
  const pal = PALETTES[variant];
  try {
    const page = await browser.newPage();
    await page.setContent(`<canvas id="c" width="${W}" height="${H}"></canvas>`);
    for (let i = 0; i < FRAMES; i++) {
      const t = i / FRAMES;
      const trail = [];
      for (let k = 14; k >= 1; k--) trail.push(beeAt(t - k * 0.012 - 0.02));
      const url = await page.evaluate(drawFrame, { W, H, frame: i, t, bee: beeAt(t), trail, pal });
      fs.writeFileSync(path.join(tmp, `f${String(i).padStart(3, '0')}.png`),
        Buffer.from(url.split(',')[1], 'base64'));
    }
  } finally {
    await browser.close();
  }

  // Ordered dithering is identical in every frame, so the static scenery
  // encodes once and each frame only stores what moves.
  const gif = path.join(OUT, variant === 'day' ? 'bee.gif' : `bee-${variant}.gif`);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(1000 / DELAY_MS),
    '-i', path.join(tmp, 'f%03d.png'), '-vf',
    `split[a][b];[a]palettegen=max_colors=${pal.colors}:stats_mode=full[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`,
    '-loop', '0', gif]);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`${path.basename(gif)} ${(fs.statSync(gif).size / 1024).toFixed(0)} KB, ${FRAMES} frames`);
}

// The bee's outline on every frame, packed like the segmentation service's
// masks (backend/tracker/segmentation.py), so Remove Background works on the
// sample without it. Both scenes share the bee, so one file serves both.
async function renderMasks() {
  const browser = await chromium.launch({ args: ['--disable-gpu'] });
  const frames = [];
  try {
    const page = await browser.newPage();
    await page.setContent(`<canvas id="c" width="${W}" height="${H}"></canvas>`);
    for (let i = 0; i < FRAMES; i++) {
      const t = i / FRAMES;
      frames.push(Buffer.from(await page.evaluate(drawFrame,
        { W, H, frame: i, t, bee: beeAt(t), trail: [], pal: PALETTES.day, mask: true })));
    }
  } finally {
    await browser.close();
  }
  const header = Buffer.from(JSON.stringify({ version: 1, width: W, height: H, frames: FRAMES }));
  const size = Buffer.alloc(4);
  size.writeUInt32LE(header.length);
  const file = path.join(OUT, 'bee.masks.gz');
  fs.writeFileSync(file, zlib.gzipSync(Buffer.concat([size, header, ...frames]), { level: 9 }));
  console.log(`bee.masks.gz ${(fs.statSync(file).size / 1024).toFixed(0)} KB, ${FRAMES} frames`);
}

function writePreset() {
  const preset = {
    variants: {
      day: { gif: '/samples/bee.gif', filename: 'sample-bee.gif' },
      night: { gif: '/samples/bee-night.gif', filename: 'sample-bee-night.gif' },
    },
    subject: subject(),
    captions: [captionPreset()],
  };
  fs.writeFileSync(path.join(OUT, 'bee.json'), JSON.stringify(preset) + '\n');
}

async function exportDemo(variant) {
  const port = 3190 + Math.floor(Math.random() * 100);
  const server = spawn('npx', ['serve', 'frontend', '-l', String(port)], { cwd: ROOT, stdio: 'ignore' });
  const browser = await chromium.launch({ args: ['--disable-gpu'] });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sample-demo-'));
  const base = variant === 'day' ? 'bee-demo' : `bee-${variant}-demo`;
  try {
    const page = await browser.newPage();
    await page.addInitScript(() => localStorage.setItem('gc_cookie_consent', 'rejected'));
    for (let attempt = 0; ; attempt++) {
      try { await page.goto(`http://localhost:${port}/gif-editor/edit/?sample=${variant}`); break; }
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
    const mp4 = path.join(OUT, base + '.mp4'), webm = path.join(OUT, base + '.webm');
    const poster = path.join(OUT, base + '.webp');
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
    console.log(`${base}.mp4 ${kb(mp4)}, .webm ${kb(webm)}, poster ${kb(poster)}`);
  } finally {
    await browser.close();
    server.kill();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// Steps can be named to run only those, e.g. `masks`; the default is all of them.
(async function main() {
  const steps = process.argv.slice(2);
  const run = step => !steps.length || steps.includes(step);
  if (run('gifs')) for (const variant of Object.keys(PALETTES)) await renderSample(variant);
  if (run('preset')) writePreset();
  if (run('masks')) await renderMasks();
  if (run('demos')) for (const variant of Object.keys(PALETTES)) await exportDemo(variant);
})().catch(function (err) { console.error(err); process.exit(1); });
