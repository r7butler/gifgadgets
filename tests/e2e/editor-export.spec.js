// @ts-check
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { GifWriter, GifReader } = require('../../frontend/vendor/omggif.js');

const SAMPLE = path.join(__dirname, '../../frontend/samples/bee.gif');

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('gc_cookie_consent', 'rejected'));
});

async function openEditor(page, file) {
  await page.goto('/gif-editor/edit/');
  await page.locator('#file-input').setInputFiles(file);
  await expect(page.locator('#editor-workspace')).toBeVisible();
}

/** Export through GC.exportGif and return the GIF bytes. */
async function exportGif(page) {
  const bytes = await page.evaluate(() => new Promise(resolve => GC.exportGif({
    onBlob: blob => blob.arrayBuffer().then(buffer => resolve(Array.from(new Uint8Array(buffer)))),
  })));
  return Buffer.from(bytes);
}

/** FNV-1a over RGBA bytes, so frames can be compared without moving them. */
function hash(data) {
  let h = 0x811c9dc5;
  for (let i = 0; i < data.length; i++) h = Math.imul(h ^ data[i], 16777619) >>> 0;
  return h;
}

/**
 * Each frame of an exported GIF as shown. The export keeps every frame on
 * screen for the next to draw over, so drawing frames in turn onto one canvas
 * is how a viewer shows them.
 */
function shownFrames(bytes) {
  const reader = new GifReader(bytes), canvas = new Uint8Array(reader.width * reader.height * 4), frames = [];
  for (let i = 0; i < reader.numFrames(); i++) {
    expect(reader.frameInfo(i).disposal).toBe(1);
    reader.decodeAndBlitFrameRGBA(i, canvas);
    frames.push({ hash: hash(canvas), delay: reader.frameInfo(i).delay });
  }
  return frames;
}

test('an unedited export shows exactly the frames the editor shows, at about the original size', async ({ page }) => {
  // gif.js wrote every frame whole and re-picked its colours: 1,168 KB for this 150 KB GIF.
  const source = fs.readFileSync(SAMPLE);
  await openEditor(page, SAMPLE);
  await page.evaluate(() => { GC.state.hideWatermark = true; });
  const bytes = await exportGif(page);
  expect(bytes.length).toBeLessThan(source.length * 1.2);

  const expected = await page.evaluate(() => GC.state.frames.map(frame => {
    let h = 0x811c9dc5;
    for (let i = 0; i < frame.imageData.data.length; i++) h = Math.imul(h ^ frame.imageData.data[i], 16777619) >>> 0;
    return { hash: h, delay: Math.round(frame.delay / 10) };
  }));
  expect(shownFrames(bytes)).toEqual(expected);
});

test('Compression Level and Lossy make the export smaller', async ({ page }) => {
  await openEditor(page, SAMPLE);
  const plain = (await exportGif(page)).length;
  await page.locator('#other-options-toggle').click();
  await page.locator('#chk-compress').check();
  await page.locator('#compress-quality').evaluate(el => { el.value = '30'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  const fewerColors = (await exportGif(page)).length;
  await page.locator('#chk-lossy').check();
  const lossy = (await exportGif(page)).length;
  expect(fewerColors).toBeLessThan(plain);
  expect(lossy).toBeLessThan(fewerColors);
});

test('transparent areas of a GIF stay transparent in the export', async ({ page }) => {
  // A 6×4 GIF, clear on its left half: gif.js filled clear pixels with black.
  const bytes = new Uint8Array(4096), writer = new GifWriter(bytes, 6, 4, { loop: 0 });
  for (const color of [1, 2]) {
    const pixels = new Uint8Array(24).map((_, i) => (i % 6 < 3 ? 0 : color));
    writer.addFrame(0, 0, 6, 4, pixels, { palette: [0, 0xff0000, 0x00ff00, 0x0000ff], transparent: 0, delay: 10, disposal: 2 });
  }
  await openEditor(page, { name: 'clear.gif', mimeType: 'image/gif', buffer: Buffer.from(bytes.slice(0, writer.end())) });
  await page.evaluate(() => { GC.state.hideWatermark = true; });
  const reader = new GifReader(await exportGif(page)), frame = new Uint8Array(6 * 4 * 4);
  expect(reader.numFrames()).toBe(2);
  for (let i = 0; i < 2; i++) {
    frame.fill(0);
    reader.decodeAndBlitFrameRGBA(i, frame);
    expect(frame[3]).toBe(0);                    // left half: clear
    expect(Array.from(frame.slice(20, 24))).toEqual(i ? [0, 255, 0, 255] : [255, 0, 0, 255]);
  }
});
