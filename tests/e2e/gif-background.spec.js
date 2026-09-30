// @ts-check
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { GifWriter, GifReader } = require('../../frontend/vendor/omggif.js');

const SAMPLE = path.join(__dirname, '../../frontend/samples');
const preset = JSON.parse(fs.readFileSync(path.join(SAMPLE, 'bee.json'), 'utf8'));

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('gc_cookie_consent', 'rejected'));
});

/** A GIF whose left half is red and right half blue, on every frame. */
function splitGif(width = 40, height = 20, count = 3) {
  const bytes = Buffer.alloc(64 * 1024), writer = new GifWriter(bytes, width, height, { loop: 0 });
  const pixels = new Uint8Array(width * height).map((_, i) => (i % width < width / 2 ? 0 : 1));
  for (let i = 0; i < count; i++) writer.addFrame(0, 0, width, height, pixels, { palette: [0xff0000, 0x0000ff], delay: 10 });
  return { name: 'split.gif', mimeType: 'image/gif', buffer: bytes.subarray(0, writer.end()) };
}

/** A solid-color GIF, one frame per color, for backdrops. */
function colorGif(colors, delay = 8) {
  const bytes = Buffer.alloc(16 * 1024), writer = new GifWriter(bytes, 8, 8, { loop: 0 });
  colors.forEach(color => writer.addFrame(0, 0, 8, 8, new Uint8Array(64), { palette: [color, 0], delay }));
  return { name: 'backdrop.gif', mimeType: 'image/gif', buffer: bytes.subarray(0, writer.end()) };
}

/**
 * The segmentation service, answering with masks that keep the left half of
 * every frame: after `polls` status checks, or never when `running`.
 */
async function service(page, frames, { running = false, polls = 0 } = {}) {
  const calls = [];
  // WebKit does not show Playwright the body of a Blob upload, so the page keeps it.
  await page.addInitScript(() => {
    const send = window.fetch;
    window.uploads = [];
    window.fetch = function (input, init) {
      if (init && init.method === 'PUT') window.uploads.push(init.body);
      return send.apply(this, arguments);
    };
  });
  const header = Buffer.from(JSON.stringify({ version: 1, width: 2, height: 1, frames }));
  const masks = Buffer.alloc(4 + header.length + frames);
  masks.writeUInt32LE(header.length);
  header.copy(masks, 4);
  masks.fill(0b10000000, 4 + header.length);
  await page.route('**/mock-upload', route => route.fulfill({ status: 200, body: '' }));
  await page.route('**/mock-masks', route => route.fulfill({ status: 200, contentType: 'application/gzip', body: zlib.gzipSync(masks) }));
  let checks = 0;
  await page.route('**/api/segment/*', async route => {
    const kind = route.request().url().split('/').pop();
    calls.push({ kind, body: route.request().postDataJSON() });
    const busy = running || (kind === 'status' && checks++ < polls);
    const results = {
      presign: { job_id: 'a'.repeat(32), upload_url: 'http://localhost:3000/mock-upload' },
      submit: { state: 'running' },
      status: busy ? { state: 'running', frame: 1, frames } : { state: 'complete', mask_url: 'http://localhost:3000/mock-masks' },
      cancel: { state: 'cancelled' },
    };
    await route.fulfill({ status: 200, json: results[kind] });
  });
  return {
    calls,
    upload: async index => Buffer.from(await page.evaluate(async index =>
      Array.from(new Uint8Array(await window.uploads[index].arrayBuffer())), index)),
  };
}

/** Every request to the segmentation service, which the sample must never make. */
function segmentCalls(page) {
  const calls = [];
  page.on('request', request => { if (request.url().includes('/api/segment')) calls.push(request.url()); });
  return calls;
}

async function openSample(page) {
  await page.goto('/gif-editor/edit/?sample=day');
  await expect(page.locator('#editor-workspace')).toBeVisible();
  await page.evaluate(() => { GC.pause(); GC.seekFrame(0); });
  await page.locator('#background-toggle').click();
}

async function openGif(page, file) {
  await page.goto('/gif-editor/edit/');
  await page.locator('#file-input').setInputFiles(file);
  await expect(page.locator('#editor-workspace')).toBeVisible();
  await page.locator('#background-toggle').click();
}

async function removeWith(page, text) {
  await page.locator('#bg-prompt').fill(text);
  await page.locator('#btn-bg-remove').click();
  await expect.poll(() => page.evaluate(() => !!GC.state.cutout)).toBe(true);
}

/** The preview's pixel at a point given in fractions of the GIF, on the current frame. */
function pixel(page, x, y) {
  return page.evaluate(([x, y]) => {
    GC.renderCurrentFrame();
    return Array.from(GC.ctx.getImageData(Math.floor(x * GC.state.width), Math.floor(y * GC.state.height), 1, 1).data);
  }, [x, y]);
}

/** Press a control inside a collapsed sidebar section. */
function press(page, selector) {
  return page.evaluate(selector => document.querySelector(selector).click(), selector);
}

async function exportGif(page) {
  await page.locator('#btn-download').click();
  await expect(page.locator('#download-modal')).toBeVisible({ timeout: 30_000 });
  const downloading = page.waitForEvent('download');
  await page.locator('#btn-dl-download').click();
  const reader = new GifReader(new Uint8Array(fs.readFileSync(await (await downloading).path())));
  const frame = index => {
    const pixels = new Uint8Array(reader.width * reader.height * 4);
    reader.decodeAndBlitFrameRGBA(index, pixels);
    return (x, y) => Array.from(pixels.slice(4 * (Math.floor(y * reader.height) * reader.width + Math.floor(x * reader.width)), 4 * (Math.floor(y * reader.height) * reader.width + Math.floor(x * reader.width)) + 4));
  };
  return { reader, frame };
}

test('the sample cuts out the bee without the GPU, and exports a transparent GIF', async ({ page }) => {
  const calls = segmentCalls(page);
  await openSample(page);
  await expect(page.locator('#bg-privacy')).toContainText('nothing is uploaded');
  await expect(page.locator('#bg-privacy')).toContainText('only the bee can be cut out');
  await removeWith(page, 'bee');
  await expect(page.locator('#bg-status')).toHaveText('The bee is cut out. Choose what goes behind it.');
  await expect(page.locator('#bg-behind')).toBeVisible();
  await expect(page.locator('#btn-bg-remove')).toBeHidden();
  const bee = preset.subject.path;
  // Sky is gone and the bee is not, on this frame and later ones.
  for (const frame of [0, 17]) {
    await page.evaluate(frame => GC.seekFrame(frame), frame);
    expect((await pixel(page, 0.05, 0.3))[3]).toBe(0);
    expect((await pixel(page, bee[frame].x, bee[frame].y))[3]).toBe(255);
  }

  const { reader, frame } = await exportGif(page);
  expect(reader.numFrames()).toBe(40);
  for (const index of [0, 17]) {
    const at = frame(index);
    expect(at(0.05, 0.3)[3], 'sky').toBe(0);
    expect(at(0.1, 0.9)[3], 'flowers').toBe(0);
    expect(at(bee[index].x, bee[index].y)[3], 'bee').toBe(255);
  }
  expect(calls).toEqual([]);
});

test('tapping the bee cuts it out; tapping scenery says what the sample can do', async ({ page }) => {
  await openSample(page);
  const canvas = await page.locator('#preview-canvas').boundingBox();
  const tap = (x, y) => page.mouse.click(canvas.x + x * canvas.width, canvas.y + y * canvas.height);

  await page.locator('#btn-bg-pick').click();
  await expect(page.locator('#cutout-bar')).toBeVisible();
  await tap(0.1, 0.2);
  await expect(page.locator('#bg-points')).toHaveText('1 point · 1 subject');
  await page.locator('#btn-bg-remove').click();
  await expect(page.locator('#bg-status')).toContainText('Only the bee has a cutout built into this sample. Tap the bee.');
  expect(await page.evaluate(() => GC.state.cutout)).toBeNull();

  // A subject with only Exclude points is sent back for a Keep point, still picking.
  await page.locator('#btn-bg-clear').click();
  await page.locator('#btn-bg-pick').click();
  await page.locator('#btn-cutout-exclude').click();
  await tap(0.1, 0.2);
  await page.locator('#btn-bg-remove').click();
  await expect(page.locator('#bg-status')).toContainText('Subject 1 only has Exclude points');
  await expect(page.locator('#cutout-bar')).toBeVisible();
  await expect(page.locator('#btn-cutout-keep')).toHaveAttribute('aria-pressed', 'true');

  await page.locator('#btn-bg-clear').click();
  const bee = preset.subject.path[0];
  await tap(bee.x, bee.y);
  await page.locator('#btn-cutout-done').click();
  await expect(page.locator('#cutout-bar')).toBeHidden();
  await page.locator('#btn-bg-remove').click();
  await expect.poll(() => page.evaluate(() => !!GC.state.cutout)).toBe(true);
});

test('a color, an image or a GIF can go behind the subject', async ({ page }) => {
  await openSample(page);
  await removeWith(page, 'bee');
  const sky = [0.05, 0.3];

  await page.locator('input[name="bg-mode"][value="color"]').check();
  await page.locator('#bg-color').evaluate(el => { el.value = '#00ff00'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  expect(await pixel(page, ...sky)).toEqual([0, 255, 0, 255]);

  // Two frames of 80 ms, the sample's own pace: the backdrop changes with it.
  await page.locator('input[name="bg-mode"][value="image"]').check();
  expect((await pixel(page, ...sky))[3], 'nothing yet, until a file is chosen').toBe(0);
  await page.locator('#bg-image-input').setInputFiles(colorGif([0xff0000, 0x0000ff]));
  await expect(page.locator('#bg-image-name')).toHaveText('backdrop.gif');
  expect(await pixel(page, ...sky)).toEqual([255, 0, 0, 255]);
  await page.evaluate(() => GC.seekFrame(1));
  expect(await pixel(page, ...sky)).toEqual([0, 0, 255, 255]);
  await page.evaluate(() => GC.seekFrame(2));
  expect(await pixel(page, ...sky)).toEqual([255, 0, 0, 255]);

  await page.locator('input[name="bg-mode"][value="none"]').check();
  expect((await pixel(page, ...sky))[3]).toBe(0);
});

test('your own GIF is uploaded as edited, and the cutout follows later edits', async ({ page }) => {
  const server = await service(page, 3);
  await openGif(page, splitGif());
  await expect(page.locator('#bg-privacy')).toContainText('uploads this GIF');
  // Rotated first: red is now on top, and the service must see it that way.
  await press(page, '#adj-rotate-cw');
  await removeWith(page, '  the  red half ');
  expect(server.calls.map(call => call.kind)).toEqual(['presign', 'submit', 'status']);
  expect(server.calls[1].body).toEqual({ job_id: 'a'.repeat(32), text: 'the red half' });
  const uploaded = new GifReader(new Uint8Array(await server.upload(0)));
  expect([uploaded.width, uploaded.height, uploaded.numFrames()]).toEqual([20, 40, 3]);

  // The masks keep the left half of what was uploaded.
  expect((await pixel(page, 0.25, 0.5))[3]).toBe(255);
  expect((await pixel(page, 0.75, 0.5))[3]).toBe(0);
  await press(page, '#adj-flip-h');
  expect((await pixel(page, 0.25, 0.5))[3]).toBe(0);
  expect((await pixel(page, 0.75, 0.5))[3]).toBe(255);
  // Cropping to the kept half leaves nothing cut away.
  await page.evaluate(() => {
    GC.state.cropActive = true;
    GC.state.cropRect = { x: 10, y: 0, w: 10, h: 40 };
    document.querySelector('#btn-apply-crop').click();
  });
  expect(await page.evaluate(() => [GC.state.width, GC.state.height])).toEqual([10, 40]);
  expect((await pixel(page, 0.1, 0.5))[3]).toBe(255);
  expect((await pixel(page, 0.9, 0.5))[3]).toBe(255);
  expect(server.calls.filter(call => call.kind === 'submit')).toHaveLength(1);
});

test('an edit made while the job runs carries over to its cutout', async ({ page }) => {
  await service(page, 3, { polls: 1 });
  await openGif(page, splitGif());
  await page.locator('#bg-prompt').fill('red');
  await page.locator('#btn-bg-remove').click();
  await expect(page.locator('#bg-status')).toContainText('Finding objects', { timeout: 15_000 });
  await press(page, '#adj-flip-h');
  await expect.poll(() => page.evaluate(() => !!GC.state.cutout), { timeout: 15_000 }).toBe(true);
  // The masks keep the left half of the frames as uploaded, which is now on the right.
  expect((await pixel(page, 0.25, 0.5))[3]).toBe(0);
  expect((await pixel(page, 0.75, 0.5))[3]).toBe(255);
});

test('your own GIF exports with transparency where the background was', async ({ page }) => {
  await service(page, 3);
  await openGif(page, splitGif());
  await page.evaluate(() => {
    const box = document.querySelector('#chk-watermark');
    box.checked = false;
    box.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await removeWith(page, 'red');
  const { reader, frame } = await exportGif(page);
  expect([reader.width, reader.height, reader.numFrames()]).toEqual([40, 20, 3]);
  for (const index of [0, 2]) {
    expect(frame(index)(0.25, 0.5)).toEqual([255, 0, 0, 255]);
    expect(frame(index)(0.75, 0.5)[3]).toBe(0);
  }
});

test('cancelling stops the job on the server too', async ({ page }) => {
  const server = await service(page, 3, { running: true });
  await openGif(page, splitGif());
  await page.locator('#bg-prompt').fill('red');
  await page.locator('#btn-bg-remove').click();
  await expect(page.locator('#bg-status')).toContainText('Finding objects', { timeout: 15_000 });
  await page.locator('#btn-bg-cancel').click();
  await expect(page.locator('#bg-status')).toHaveText('Cancelled. Nothing was changed.');
  expect(server.calls.map(call => call.kind)).toContain('cancel');
  expect(await page.evaluate(() => GC.state.cutout)).toBeNull();
  await expect(page.locator('#btn-bg-remove')).toBeEnabled();
});

test('the original background comes back, and changing the selection offers an update', async ({ page }) => {
  await openSample(page);
  await removeWith(page, 'bee');
  await page.locator('#btn-bg-restore').click();
  expect(await page.evaluate(() => GC.state.cutout)).toBeNull();
  expect((await pixel(page, 0.05, 0.3))[3]).toBe(255);
  await expect(page.locator('#btn-bg-remove')).toHaveText('Remove background');
  await page.locator('#btn-bg-remove').click();
  await expect.poll(() => page.evaluate(() => !!GC.state.cutout)).toBe(true);
  await page.locator('#bg-prompt').fill('bees');
  await expect(page.locator('#btn-bg-remove')).toHaveText('Update the cutout');
});

test('the cutout follows the sample through a rotation', async ({ page }) => {
  await openSample(page);
  await removeWith(page, 'bee');
  await press(page, '#adj-rotate-cw');
  // On frame 10 the bee is off to the right. A clockwise turn takes (x, y) to
  // (1 - y, x): the bee is kept where it went, and where it was is now sky.
  await page.evaluate(() => GC.seekFrame(10));
  const bee = preset.subject.path[10];
  expect((await pixel(page, 1 - bee.y, bee.x))[3]).toBe(255);
  expect((await pixel(page, bee.x, bee.y))[3]).toBe(0);
});

test('a draft keeps the cutout and what is behind it', async ({ page }) => {
  await openSample(page);
  await removeWith(page, 'bee');
  await page.locator('input[name="bg-mode"][value="color"]').check();
  await page.locator('#bg-color').evaluate(el => { el.value = '#00ff00'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await expect.poll(() => page.evaluate(() => GC.hasUnsavedDraft()), { timeout: 10_000 }).toBe(false);

  await page.reload();
  await page.locator('#draft-restore').click();
  await expect(page.locator('#editor-workspace')).toBeVisible();
  expect(await page.evaluate(() => [!!GC.state.cutout, GC.state.backdrop.mode, GC.state.cutoutPrompt.text]))
    .toEqual([true, 'color', 'bee']);
  expect(await pixel(page, 0.05, 0.3)).toEqual([0, 255, 0, 255]);
  await page.locator('#background-toggle').click();
  await expect(page.locator('#bg-behind')).toBeVisible();
  await expect(page.locator('#bg-prompt')).toHaveValue('bee');
});

test('on a phone, tapping modes bring the preview into view', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 700 });
  const inView = async () => {
    const box = await page.locator('#preview-canvas').boundingBox();
    return box.y >= 0 && box.y + box.height <= 700;
  };
  await openSample(page);
  // The sidebar sits below the preview here, so its buttons scroll it away.
  await page.locator('#btn-bg-pick').scrollIntoViewIfNeeded();
  expect(await inView()).toBe(false);
  await page.locator('#btn-bg-pick').click();
  await expect.poll(inView).toBe(true);
  await page.locator('#btn-cutout-done').click();

  await page.locator('.caption-list-item').first().click();
  await page.locator('#btn-track-with-ai').scrollIntoViewIfNeeded();
  expect(await inView()).toBe(false);
  await page.locator('#btn-track-with-ai').click();
  await page.locator('#track-place-modal [data-placement="keep"]').click();
  await expect.poll(inView).toBe(true);
});
