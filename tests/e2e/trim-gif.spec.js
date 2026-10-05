// @ts-check
// The Trim GIF timeline: dragging and typing agree, and the export holds exactly the chosen frames.
const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const { GifWriter, GifReader } = require('../../frontend/vendor/omggif.js');

// Six frames whose delays (10, 20, … 60 cs) identify them in the export.
function fixture() {
  const bytes = new Uint8Array(8192), writer = new GifWriter(bytes, 4, 2, { loop: 0 });
  for (let i = 0; i < 6; i++) {
    writer.addFrame(0, 0, 4, 2, [i % 4, 1, 2, 3, 3, 2, 1, i % 4],
      { palette: [0x000000, 0xff0000, 0x00ff00, 0x0000ff], delay: (i + 1) * 10 });
  }
  return Buffer.from(bytes.slice(0, writer.end()));
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('gc_cookie_consent', 'rejected'));
  // WebKit routes blob: URLs too, and they have no hostname.
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    return url.hostname === 'localhost' || url.protocol === 'blob:' ? route.continue() : route.abort();
  });
  await page.goto('/trim-gif/');
  await page.locator('#utility-file').setInputFiles({ name: 'six.gif', mimeType: 'image/gif', buffer: fixture() });
  await expect(page.locator('#utility-trim')).toBeVisible();
});

// Drag on the timeline from one frame boundary (0–6) to another.
async function drag(page, from, to) {
  const box = await page.locator('#utility-trim-frames').boundingBox();
  const at = boundary => box.x + boundary * box.width / 6;
  const y = box.y + box.height / 2;
  await page.mouse.move(at(from), y);
  await page.mouse.down();
  await page.mouse.move(at(to), y, { steps: 5 });
  await page.mouse.up();
}

async function exportedDelays(page) {
  await page.locator('#utility-apply').click();
  const waiting = page.waitForEvent('download');
  await page.locator('#utility-download').click();
  const reader = new GifReader(fs.readFileSync(await (await waiting).path()));
  return Array.from({ length: reader.numFrames() }, (_, i) => reader.frameInfo(i).delay);
}

test('the preview replaces the static GIF once frames are ready', async ({ page }) => {
  await expect(page.locator('#utility-trim-preview')).toBeVisible();
  await expect(page.locator('#utility-original')).toBeHidden();
  await expect(page.locator('#utility-trim-summary')).toHaveText('Frames 1–6 · 6 of 6 · 2.1 s');
});

test('dragging both handles sets the inputs and the export keeps exactly those frames', async ({ page }) => {
  await drag(page, 0, 1);
  await drag(page, 6, 4);
  await expect(page.locator('#utility-start')).toHaveValue('2');
  await expect(page.locator('#utility-end')).toHaveValue('4');
  await expect(page.locator('#utility-trim-summary')).toHaveText('Frames 2–4 · 3 of 6 · 0.9 s');
  expect(await exportedDelays(page)).toEqual([20, 30, 40]);
});

test('dragging the selection moves it without changing its length', async ({ page }) => {
  await page.locator('#utility-start').fill('2');
  await page.locator('#utility-end').fill('3');
  await drag(page, 2.5, 4.5);
  await expect(page.locator('#utility-start')).toHaveValue('4');
  await expect(page.locator('#utility-end')).toHaveValue('5');
  expect(await exportedDelays(page)).toEqual([40, 50]);
});

test('typed frame numbers move the window', async ({ page }) => {
  await page.locator('#utility-start').fill('3');
  await page.locator('#utility-end').fill('6');
  await expect(page.locator('#utility-trim-summary')).toHaveText('Frames 3–6 · 4 of 6 · 1.8 s');
  const left = await page.locator('#utility-trim-window').evaluate(el => parseFloat(el.style.left));
  expect(left).toBeCloseTo(2 / 6 * 100, 3);
});

test('an edge cannot shrink the selection below one frame', async ({ page }) => {
  await drag(page, 6, 0);
  await expect(page.locator('#utility-start')).toHaveValue('1');
  await expect(page.locator('#utility-end')).toHaveValue('1');
  expect(await exportedDelays(page)).toEqual([10]);
});

test('pressing a handle without moving it keeps the current result', async ({ page }) => {
  await page.locator('#utility-start').fill('2');
  await page.locator('#utility-apply').click();
  await expect(page.locator('#utility-download')).toBeVisible();
  await drag(page, 1, 1);
  await expect(page.locator('#utility-download')).toBeVisible();
  await expect(page.locator('#utility-start')).toHaveValue('2');
});

test('reduced motion starts the preview paused', async ({ browser }) => {
  const context = await browser.newContext({ reducedMotion: 'reduce' });
  const page = await context.newPage();
  await page.goto('/trim-gif/');
  await page.locator('#utility-file').setInputFiles({ name: 'six.gif', mimeType: 'image/gif', buffer: fixture() });
  await expect(page.locator('#utility-trim-play')).toHaveAttribute('aria-label', 'Play preview');
  await page.locator('#utility-trim-play').click();
  await expect(page.locator('#utility-trim-play')).toHaveAttribute('aria-label', 'Pause preview');
  await context.close();
});
