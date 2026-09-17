const {test, expect} = require('@playwright/test');
const fs = require('node:fs');
const zlib = require('node:zlib');

/* ── Fixtures and decoders ──────────────────────────────────────────────
   Images are built here rather than committed so each test can state the
   exact dimensions it expects back. */
function crc32(bytes) {
  let crc = -1;
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
  return (crc ^ -1) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0); out.write(type, 4, 'ascii'); data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
/* A truecolour PNG. `noise` makes an incompressible image, which is what a
   compression test needs — a flat colour would shrink no matter what we did. */
function png(width, height, colour = [220, 30, 90], noise = false) {
  const stride = width * 3 + 1, raw = Buffer.alloc(stride * height);
  let seed = 7;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const at = y * stride + 1 + x * 3;
    if (noise) { for (let c = 0; c < 3; c++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; raw[at + c] = seed >> 16 & 0xff; } }
    else { raw[at] = colour[0]; raw[at + 1] = colour[1]; raw[at + 2] = colour[2]; }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const file = (name, width, height, options = {}) =>
  ({name, mimeType: 'image/png', buffer: png(width, height, options.colour, options.noise)});

function pngSize(bytes) {
  expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}
function jpegSize(bytes) {
  expect(bytes.readUInt16BE(0)).toBe(0xffd8);
  for (let i = 2; i + 9 < bytes.length;) {
    if (bytes[i] !== 0xff) { i++; continue; }
    const marker = bytes[i + 1];
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
      return [bytes.readUInt16BE(i + 7), bytes.readUInt16BE(i + 5)];
    i += 2 + bytes.readUInt16BE(i + 2);
  }
  throw new Error('no JPEG frame header found');
}
/* The tools write stored (uncompressed) ZIPs, so entries read back directly. */
function unzip(buffer) {
  const entries = [];
  for (let at = 0; at + 30 <= buffer.length && buffer.readUInt32LE(at) === 0x04034b50;) {
    const size = buffer.readUInt32LE(at + 18);
    const nameLength = buffer.readUInt16LE(at + 26), extraLength = buffer.readUInt16LE(at + 28);
    const name = buffer.toString('utf8', at + 30, at + 30 + nameLength);
    const start = at + 30 + nameLength + extraLength;
    const bytes = buffer.subarray(start, start + size);
    expect(crc32(bytes)).toBe(buffer.readUInt32LE(at + 14));
    entries.push({name, bytes});
    at = start + size;
  }
  return entries;
}
async function download(page) {
  const waiting = page.waitForEvent('download');
  await page.locator('#utility-download').click();
  return fs.readFileSync(await (await waiting).path());
}

test.beforeEach(async ({page}) => {
  await page.route('**/*', route => new URL(route.request().url()).hostname === 'localhost' ? route.continue() : route.abort());
});

test('bulk resize fits every image inside the box without enlarging or distorting', async ({page}) => {
  await page.goto('/bulk-resize-images/');
  await page.locator('#utility-file').setInputFiles([
    file('wide.png', 40, 20), file('small.png', 10, 10), file('big.png', 200, 100)]);
  await expect(page.locator('#utility-info')).toContainText('3 images');
  await page.locator('#utility-width').fill('32');
  await page.locator('#utility-height').fill('32');
  await page.locator('#utility-apply').click();
  await expect(page.locator('#utility-download')).toBeVisible();
  const entries = unzip(await download(page));
  expect(entries.map(e => e.name)).toEqual(['wide.png', 'small.png', 'big.png']);
  expect(pngSize(entries[0].bytes)).toEqual([32, 16]);
  expect(pngSize(entries[1].bytes)).toEqual([10, 10]); // already smaller: left alone
  expect(pngSize(entries[2].bytes)).toEqual([32, 16]);
  // Each result is also offered individually, not only inside the archive.
  await expect(page.locator('#utility-results figure')).toHaveCount(3);
});

test('resize modes crop only when asked, and enlarge only when asked', async ({page}) => {
  await page.goto('/bulk-resize-images/');
  await page.locator('#utility-file').setInputFiles([file('wide.png', 40, 20)]);
  await page.locator('#utility-mode').selectOption('exact');
  await page.locator('#utility-width').fill('50');
  await page.locator('#utility-height').fill('50');
  await page.locator('#utility-apply').click();
  await expect(page.locator('#utility-download')).toBeVisible();
  expect(pngSize(await download(page))).toEqual([50, 50]);

  await page.locator('#utility-mode').selectOption('fit');
  await expect(page.locator('#utility-download')).toBeHidden();
  await page.locator('#utility-apply').click();
  await expect(page.locator('#utility-download')).toBeVisible();
  expect(pngSize(await download(page))).toEqual([40, 20]);
  await page.locator('#utility-enlarge').check();
  await page.locator('#utility-apply').click();
  await expect(page.locator('#utility-download')).toBeVisible();
  expect(pngSize(await download(page))).toEqual([50, 25]);

  await page.locator('#utility-mode').selectOption('percent');
  await expect(page.locator('#utility-width')).toBeDisabled();
  await page.locator('#utility-percent').fill('25');
  await page.locator('#utility-apply').click();
  await expect(page.locator('#utility-download')).toBeVisible();
  expect(pngSize(await download(page))).toEqual([10, 5]);
});

test('bulk convert rewrites the format and keeps the pixel dimensions', async ({page}) => {
  await page.goto('/bulk-convert-images/');
  await page.locator('#utility-file').setInputFiles([file('one.png', 24, 36), file('two.png', 12, 12)]);
  await page.locator('#utility-apply').click();
  await expect(page.locator('#utility-download')).toBeVisible();
  const entries = unzip(await download(page));
  expect(entries.map(e => e.name)).toEqual(['one.jpg', 'two.jpg']);
  expect(jpegSize(entries[0].bytes)).toEqual([24, 36]);
  expect(jpegSize(entries[1].bytes)).toEqual([12, 12]);

  const webpSupported = await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 4;
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp'));
    return !!blob && blob.type === 'image/webp';
  });
  await page.locator('#utility-format').selectOption('webp');
  await page.locator('#utility-apply').click();
  if (webpSupported) {
    await expect(page.locator('#utility-download')).toBeVisible();
    expect(unzip(await download(page)).map(e => e.name)).toEqual(['one.webp', 'two.webp']);
  } else {
    // A browser that cannot encode WebP must say so, not hand back a PNG named .webp.
    await expect(page.locator('#utility-status')).toContainText('cannot save WebP');
    await expect(page.locator('#utility-download')).toBeHidden();
  }
});

test('compression shrinks what it can and never returns a larger file', async ({page}) => {
  await page.goto('/bulk-compress-images/');
  const noisy = file('noisy.png', 160, 160, {noise: true});
  await page.locator('#utility-file').setInputFiles([noisy]);
  await page.locator('#utility-format').selectOption('jpg');
  await page.locator('#utility-quality').fill('40');
  await page.locator('#utility-apply').click();
  await expect(page.locator('#utility-download')).toBeVisible();
  const compressed = await download(page);
  expect(jpegSize(compressed)).toEqual([160, 160]);
  expect(compressed.length).toBeLessThan(noisy.buffer.length);
  await expect(page.locator('#utility-status')).toContainText('smaller');

  // Kept as PNG the browser may well produce a bigger file; the original wins.
  await page.locator('#utility-format').selectOption('keep');
  await page.locator('#utility-apply').click();
  await expect(page.locator('#utility-download')).toBeVisible();
  const kept = await download(page);
  expect(kept.length).toBeLessThanOrEqual(noisy.buffer.length);
  await expect(page.locator('#utility-status')).not.toContainText('larger');
});

test('contact sheet lays images out on one canvas at the computed size', async ({page}) => {
  await page.goto('/image-contact-sheet/');
  await page.locator('#utility-file').setInputFiles(
    [1, 2, 3, 4].map(n => file('shot-' + n + '.png', 60, 30, {colour: [n * 50, 40, 200]})));
  await page.locator('#utility-columns').fill('2');
  await page.locator('#utility-cell').fill('100');
  await page.locator('#utility-gap').fill('0');
  await page.locator('#utility-padding').fill('0');
  await page.locator('#utility-labels').uncheck();
  await page.locator('#utility-apply').click();
  await expect(page.locator('#utility-download')).toBeVisible();
  await expect(page.locator('#utility-result-wrap')).toBeVisible();
  expect(pngSize(await download(page))).toEqual([200, 200]);
  await expect(page.locator('#utility-status')).toContainText('200 × 200');

  // Labels add a strip under every row, so the sheet gets taller by exactly that.
  await page.locator('#utility-labels').check();
  await page.locator('#utility-apply').click();
  await expect(page.locator('#utility-download')).toBeVisible();
  expect(pngSize(await download(page))).toEqual([200, 244]);
});

test('refuses input it cannot handle and recovers without a stale download', async ({page}) => {
  await page.goto('/image-contact-sheet/');
  await page.locator('#utility-file').setInputFiles([file('only.png', 20, 20)]);
  await expect(page.locator('#utility-status')).toContainText('at least two images');
  await expect(page.locator('#utility-apply')).toBeDisabled();

  await page.goto('/bulk-resize-images/');
  await page.locator('#utility-file').setInputFiles({name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello')});
  await expect(page.locator('#utility-status')).toContainText('not a PNG, JPG, WebP, GIF, BMP or AVIF image');
  await expect(page.locator('#utility-apply')).toBeDisabled();

  await page.locator('#utility-file').setInputFiles([file('good.png', 20, 20)]);
  await page.locator('#utility-apply').click();
  await expect(page.locator('#utility-download')).toBeVisible();
  // Changing a setting must retract the previous result rather than leave it downloadable.
  await page.locator('#utility-width').fill('8');
  await expect(page.locator('#utility-download')).toBeHidden();
  await expect(page.locator('#utility-status')).toContainText('Settings changed');
});

test('mobile layout, canonical URL and consented analytics', async ({page}) => {
  await page.setViewportSize({width: 390, height: 844});
  await page.goto('/bulk-resize-images/?private=do-not-record');
  await page.evaluate(() => {
    window.GWAnalyticsAllowed = () => true; window.imageEvents = [];
    window.gtag = (...args) => window.imageEvents.push(args);
  });
  await page.locator('#utility-file').setInputFiles([file('private.png', 30, 30)]);
  await page.locator('#utility-apply').click();
  await expect(page.locator('#utility-download')).toBeVisible();
  const events = await page.evaluate(() => window.imageEvents);
  expect(events.map(e => e[1])).toEqual(['file_accepted', 'editor_ready', 'export_started', 'export_completed']);
  expect(events.every(e => e[2].tool_name === 'bulk-resize-images')).toBe(true);
  expect(JSON.stringify(events)).not.toContain('private');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(await page.locator('link[rel="canonical"]').getAttribute('href'))
    .toBe('https://gifgadgets.com/bulk-resize-images/');
  await expect(page.locator('.site-nav-links a', {hasText: 'Image Tools'})).toHaveAttribute('href', '/#image-tools');
});
