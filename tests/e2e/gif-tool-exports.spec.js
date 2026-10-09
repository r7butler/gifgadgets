// @ts-check
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { GifReader } = require('../../frontend/vendor/omggif.js');

// Crop, Resize and GIF Maker used gif.js, which wrote every frame whole:
// cropping the 150 KB sample to its full size gave 1,168 KB, and resizing it
// to 320 px wide gave 441 KB. Video to GIF is covered in video-to-gif.spec.js.
const SAMPLE = path.join(__dirname, '../../frontend/samples/bee.gif');

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('gc_cookie_consent', 'rejected'));
});

/** The GIF the result modal shows, as a GifReader plus its size in bytes. */
async function result(page) {
  await expect(page.locator('#result-gif')).toBeVisible({ timeout: 60000 });
  const bytes = Buffer.from(await page.locator('#result-gif').evaluate(async img =>
    Array.from(new Uint8Array(await (await fetch(img.src)).arrayBuffer()))));
  return { reader: new GifReader(bytes), size: bytes.length };
}

/** Total playing time of a GIF, in hundredths of a second. */
function length(reader) {
  let total = 0;
  for (let i = 0; i < reader.numFrames(); i++) total += reader.frameInfo(i).delay;
  return total;
}

test('Crop exports only what changes, at about the original size', async ({ page }) => {
  const source = new GifReader(fs.readFileSync(SAMPLE));
  await page.goto('/crop-gif/edit/');
  await page.locator('#file-input').setInputFiles(SAMPLE);
  await expect(page.locator('#editor-screen')).toBeVisible();
  await page.locator('#btn-crop').click();
  const { reader, size } = await result(page);
  expect([reader.width, reader.height]).toEqual([source.width, source.height]);
  expect(length(reader)).toBe(length(source));
  expect(size).toBeLessThan(fs.statSync(SAMPLE).size * 1.3);
  // After the first frame, each stores only its changes and stays on screen.
  expect(reader.frameInfo(1).disposal).toBe(1);
  expect(reader.frameInfo(1).width * reader.frameInfo(1).height).toBeLessThan(source.width * source.height);
});

test('Resize exports a smaller GIF than the original', async ({ page }) => {
  const source = new GifReader(fs.readFileSync(SAMPLE));
  await page.goto('/gif-resizer/edit/');
  await page.locator('#file-input').setInputFiles(SAMPLE);
  await expect(page.locator('#editor-screen')).toBeVisible();
  await page.locator('#inp-width').fill('320');
  await page.locator('#inp-width').dispatchEvent('input');
  await page.locator('#btn-resize').click();
  const { reader, size } = await result(page);
  expect([reader.width, reader.height]).toEqual([320, 180]);
  expect(length(reader)).toBe(length(source));
  expect(size).toBeLessThan(fs.statSync(SAMPLE).size);
});

test('GIF Maker keeps the loop count, frame delays and crossfades', async ({ page }) => {
  await page.goto('/gif-maker/edit/');
  // Three solid images, drawn by the browser.
  const images = await page.evaluate(() => ['#ff0000', '#00ff00', '#0000ff'].map((color, i) => {
    const canvas = document.createElement('canvas');
    canvas.width = 120; canvas.height = 80;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = color; ctx.fillRect(0, 0, 120, 80);
    return { name: 'frame' + i + '.png', data: canvas.toDataURL('image/png').split(',')[1] };
  }));
  await page.locator('#file-input').setInputFiles(images.map(image =>
    ({ name: image.name, mimeType: 'image/png', buffer: Buffer.from(image.data, 'base64') })));
  await expect(page.locator('#editor-screen')).toBeVisible();
  await page.locator('#sel-loop').selectOption('3');

  await page.locator('#btn-make').click();
  let { reader } = await result(page);
  expect(reader.numFrames()).toBe(3);
  expect(reader.loopCount()).toBe(3);
  expect([0, 1, 2].map(i => reader.frameInfo(i).delay)).toEqual([50, 50, 50]);
  const pixels = new Uint8Array(120 * 80 * 4);
  reader.decodeAndBlitFrameRGBA(0, pixels);
  expect(Array.from(pixels.slice(0, 4))).toEqual([255, 0, 0, 255]);

  // Five blends between each pair of images, sharing the image's time.
  await page.locator('#result-modal-close').click();
  await page.locator('#chk-crossfade').check();
  await page.locator('#btn-make').click();
  ({ reader } = await result(page));
  expect(reader.numFrames()).toBe(3 + 2 * 5);
});
