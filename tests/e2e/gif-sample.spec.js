// @ts-check
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { GifReader } = require('../../frontend/vendor/omggif.js');

const FIXTURE = path.join(__dirname, 'fixtures/test.gif');
const SAMPLE = path.join(__dirname, '../../frontend/samples');
const preset = JSON.parse(fs.readFileSync(path.join(SAMPLE, 'bee.json'), 'utf8'));

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('gc_cookie_consent', 'rejected'));
});

function frames(buffer) {
  const reader = new GifReader(new Uint8Array(buffer));
  const out = [];
  for (let i = 0; i < reader.numFrames(); i++) {
    const pixels = new Uint8Array(reader.width * reader.height * 4);
    if (i > 0) pixels.set(out[i - 1]);
    reader.decodeAndBlitFrameRGBA(i, pixels);
    out.push(pixels);
  }
  return { width: reader.width, height: reader.height, out };
}

/** Pixels that clearly changed inside a box centred on a normalised point. */
function changedAround(a, b, width, height, point) {
  const cx = Math.round(point.x * width), cy = Math.round(point.y * height) + 22;
  let changed = 0;
  for (let y = cy - 18; y < cy + 18; y++) {
    for (let x = cx - 40; x < cx + 40; x++) {
      const i = (y * width + x) * 4;
      if (Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2])) > 80) changed++;
    }
  }
  return changed;
}

test('both caption landing pages open the sample without an upload', async ({ page }) => {
  for (const landing of ['/gif-editor/', '/add-text-to-gif/']) {
    await page.goto(landing);
    await page.locator('#sample-cta').click();
    await expect(page).toHaveURL(new RegExp(landing + 'edit/\\?sample=1$'));
    await expect(page.locator('#editor-workspace')).toBeVisible();
    await expect(page.locator('#sample-bar')).toBeVisible();
    const state = await page.evaluate(() => ({ isSample: GC.state.isSample, frames: GC.state.frames.length,
      captions: GC.state.captions.map(c => ({ text: c.text, keyframes: c.motion.length })), edited: GC.hasEdits() }));
    expect(state).toEqual({ isSample: true, frames: 40, captions: [{ text: 'BZZZ!', keyframes: preset.captions[0].motion.length }], edited: false });
  }
});

test('the sample edits and exports like any GIF, caption motion included', async ({ page }) => {
  await page.goto('/gif-editor/edit/');
  await page.locator('#btn-try-sample').click();
  await expect(page.locator('#editor-workspace')).toBeVisible();
  await expect(page.locator('#chk-watermark')).toBeChecked();
  await page.locator('.caption-list-item').first().click();
  await page.locator('#cap-text').fill('BUZZ OFF');
  expect(await page.evaluate(() => GC.hasEdits())).toBe(true);

  await page.locator('#btn-download').click();
  await expect(page.locator('#download-modal')).toBeVisible({ timeout: 30_000 });
  const downloading = page.waitForEvent('download');
  await page.locator('#btn-dl-download').click();
  const exported = frames(fs.readFileSync(await (await downloading).path()));
  const source = frames(fs.readFileSync(path.join(SAMPLE, 'bee.gif')));
  expect([exported.width, exported.height, exported.out.length]).toEqual([640, 360, 40]);

  // The caption is burned in where its keyframes put it, and has left that spot ten frames later.
  const start = preset.captions[0].motion[0], later = preset.captions[0].motion.find(k => k.frame === 10);
  expect(changedAround(exported.out[0], source.out[0], 640, 360, start)).toBeGreaterThan(150);
  expect(changedAround(exported.out[10], source.out[10], 640, 360, start)).toBeLessThan(40);
  expect(changedAround(exported.out[10], source.out[10], 640, 360, later)).toBeGreaterThan(150);
});

test('Follow an Object on the sample explains itself and never calls the tracker', async ({ page }) => {
  const trackerCalls = [];
  page.on('request', request => { if (request.url().includes('/api/track')) trackerCalls.push(request.url()); });
  await page.goto('/gif-editor/edit/?sample=1');
  await expect(page.locator('#editor-workspace')).toBeVisible();
  await page.locator('.caption-list-item').first().click();
  await page.locator('#btn-track-with-ai').click();
  await expect(page.locator('#sample-bar-text')).toContainText('AI tracking runs on your own GIFs');
  await expect(page.locator('#tracking-bar')).toBeHidden();
  expect(trackerCalls).toEqual([]);
});

test('switching from the sample to your own GIF asks only once there are edits', async ({ page }) => {
  await page.goto('/gif-editor/edit/?sample=1');
  await expect(page.locator('#editor-workspace')).toBeVisible();
  const choosing = page.waitForEvent('filechooser');
  await page.locator('#btn-sample-own').click();
  await (await choosing).setFiles(FIXTURE);
  await expect(page.locator('#sample-bar')).toBeHidden();
  expect(await page.evaluate(() => [GC.state.gifFilename, GC.state.isSample, GC.state.captions.length])).toEqual(['test.gif', false, 0]);

  await page.locator('#btn-new').click();
  await page.locator('[data-confirm-accept]').click();
  await page.locator('#btn-try-sample').click();
  await expect(page.locator('#sample-bar')).toBeVisible();
  await page.locator('.caption-list-item').first().click();
  await page.locator('#cap-text').fill('Keep me');
  await page.locator('#btn-sample-own').click();
  await expect(page.locator('[data-confirm-accept]')).toBeVisible();
  await page.locator('[data-confirm-cancel]').click();
  expect(await page.evaluate(() => GC.state.captions[0].text)).toBe('Keep me');
});

test('a saved draft is offered before the sample can replace it', async ({ page }) => {
  await page.goto('/gif-editor/edit/');
  await page.locator('#file-input').setInputFiles(FIXTURE);
  await expect(page.locator('#editor-workspace')).toBeVisible();
  await page.locator('#on-image-caption-toggle').click();
  await page.locator('#btn-add-caption').click();
  await page.locator('#cap-text').fill('My real work');
  await expect.poll(async () => { await page.evaluate(() => GC.saveDraft()); return page.evaluate(() => GC.hasUnsavedDraft()); }).toBe(false);

  await page.goto('/gif-editor/edit/?sample=1');
  await expect(page.locator('#draft-restore-modal')).toBeVisible();
  await page.locator('#draft-restore').click();
  await expect(page.locator('#editor-workspace')).toBeVisible();
  expect(await page.evaluate(() => [GC.state.captions[0].text, GC.state.isSample])).toEqual(['My real work', false]);

  await page.goto('/gif-editor/edit/?sample=1');
  await page.locator('#draft-discard').click();
  await expect(page.locator('#sample-bar')).toBeVisible();
  expect(await page.evaluate(() => GC.state.captions[0].text)).toBe('BZZZ!');
});

test('a failed sample download is reported and can be retried', async ({ page }) => {
  await page.route('**/samples/bee.gif', route => route.abort());
  await page.goto('/gif-editor/edit/?sample=1');
  await expect(page.locator('#sample-status')).toContainText('could not be loaded');
  await expect(page.locator('#upload-zone')).toBeVisible();
  await expect(page.locator('#loading-overlay')).toBeHidden();
  await page.unroute('**/samples/bee.gif');
  await page.locator('#btn-try-sample').click();
  await expect(page.locator('#editor-workspace')).toBeVisible();
  await expect(page.locator('#sample-status')).toBeEmpty();
});

test('the sample waits for a press of play when reduced motion is requested', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/gif-editor/edit/?sample=1');
  await expect(page.locator('#editor-workspace')).toBeVisible();
  expect(await page.evaluate(() => GC.state.isPlaying)).toBe(false);
});
