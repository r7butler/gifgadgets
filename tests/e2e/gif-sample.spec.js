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

/** Enter tracking with a fresh caption parked at `spot` on frame 0, pick `placement`, then tap `tap`. */
async function trackFromFrameZero(page, spot, tap, placement = 'keep') {
  await page.evaluate(() => { GC.pause(); GC.seekFrame(0); });
  await page.locator('#btn-add-caption').click();
  await page.evaluate(spot => Object.assign(GC.state.captions[1], spot), spot);
  await page.locator('#btn-track-with-ai').click();
  await page.locator(`#track-place-modal [data-placement="${placement}"]`).click();
  await expect(page.locator('#tracking-bar')).toContainText(
    placement === 'keep' ? 'keeps its place relative to it' : 'goes on top of it');
  const box = await page.locator('#preview-canvas').boundingBox();
  await page.mouse.click(box.x + tap.x * box.width, box.y + tap.y * box.height);
  await expect.poll(() => page.evaluate(() => GC.state.captions[1].motion.length)).toBe(40);
  return page.evaluate(() => GC.state.captions[1].motion);
}

/** The middle of the caption's drawn pixels on `frame`, as fractions of the GIF. */
function drawnMiddle(page, frame) {
  return page.evaluate(frame => {
    const canvas = document.createElement('canvas');
    canvas.width = GC.state.width;
    canvas.height = GC.state.height;
    const ctx = canvas.getContext('2d');
    GC.drawCaption(ctx, GC.state.captions[1], frame);
    const alpha = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let left = Infinity, right = -1, top = Infinity, bottom = -1;
    for (let y = 0; y < canvas.height; y++) {
      for (let x = 0; x < canvas.width; x++) {
        if (alpha[(y * canvas.width + x) * 4 + 3] < 128) continue;
        left = Math.min(left, x); right = Math.max(right, x);
        top = Math.min(top, y); bottom = Math.max(bottom, y);
      }
    }
    return { x: (left + right + 1) / 2 / canvas.width, y: (top + bottom + 1) / 2 / canvas.height };
  }, frame);
}

test('Follow an Object on the sample tracks the bee without the GPU tracker', async ({ page }) => {
  const trackerCalls = [];
  page.on('request', request => { if (request.url().includes('/api/track')) trackerCalls.push(request.url()); });
  await page.goto('/gif-editor/edit/?sample=1');
  await expect(page.locator('#editor-workspace')).toBeVisible();
  const bee = preset.subject.path;
  const motion = await trackFromFrameZero(page, { x: 0.5, y: 0.2 }, bee[0]);
  await expect(page.locator('#sample-bar-text')).toContainText('It follows the bee now');
  // The caption keeps the spot it was given and moves as the bee moves.
  for (const frame of [0, 10, 25]) {
    const k = motion.find(k => k.frame === frame);
    expect(k.x).toBeCloseTo(0.5 + bee[frame].x - bee[0].x, 3);
    expect(k.y).toBeCloseTo(0.2 + bee[frame].y - bee[0].y, 3);
  }
  expect(trackerCalls).toEqual([]);
});

test('Follow an Object still finds the bee after the sample is rotated', async ({ page }) => {
  await page.goto('/gif-editor/edit/?sample=1');
  await expect(page.locator('#editor-workspace')).toBeVisible();
  await page.evaluate(() => document.querySelector('#adj-rotate-cw').click());
  // A clockwise turn takes (x, y) to (1 - y, x).
  const turned = preset.subject.path.map(p => ({ x: 1 - p.y, y: p.x }));
  const motion = await trackFromFrameZero(page, { x: 0.2, y: 0.5 }, turned[0]);
  await expect(page.locator('#sample-bar-text')).toContainText('It follows the bee now');
  for (const frame of [0, 10, 25]) {
    const k = motion.find(k => k.frame === frame);
    expect(k.x).toBeCloseTo(0.2 + turned[frame].x - turned[0].x, 3);
    expect(k.y).toBeCloseTo(0.5 + turned[frame].y - turned[0].y, 3);
  }
});

test('tapping still scenery on the sample leaves the caption where it is', async ({ page }) => {
  await page.goto('/gif-editor/edit/?sample=1');
  await expect(page.locator('#editor-workspace')).toBeVisible();
  const motion = await trackFromFrameZero(page, { x: 0.3, y: 0.3 }, { x: 0.07, y: 0.78 });
  await expect(page.locator('#sample-bar-text')).toContainText('Try tapping the bee');
  expect(new Set(motion.map(k => k.x + ',' + k.y))).toEqual(new Set(['0.3,0.3']));
});

test('On top of the object centers the caption on the bee as it flies', async ({ page }) => {
  await page.goto('/gif-editor/edit/?sample=1');
  await expect(page.locator('#editor-workspace')).toBeVisible();
  const bee = preset.subject.path;
  // Parked far from the bee, and tapped off its middle: the caption still lands on the bee.
  await trackFromFrameZero(page, { x: 0.15, y: 0.1, text: 'HELLO' }, { x: bee[0].x + 0.03, y: bee[0].y + 0.03 }, 'center');
  for (const frame of [0, 10, 25]) {
    const middle = await drawnMiddle(page, frame);
    expect(Math.abs(middle.x - bee[frame].x)).toBeLessThan(0.02);
    expect(Math.abs(middle.y - bee[frame].y)).toBeLessThan(0.02);
  }
});

test('a saved choice skips the question until Change asks again', async ({ page }) => {
  const modal = page.locator('#track-place-modal');
  const remember = page.locator('#track-place-remember');
  const bar = page.locator('#tracking-bar');
  await page.goto('/gif-editor/edit/?sample=1');
  await expect(page.locator('#editor-workspace')).toBeVisible();
  await page.locator('.caption-list-item').first().click();
  await page.locator('#btn-track-with-ai').click();
  await expect(remember).not.toBeChecked();
  await remember.check();
  await modal.locator('[data-placement="center"]').click();
  await expect(modal).toBeHidden();
  await expect(bar).toContainText('The caption goes on top of it.');
  await page.locator('#btn-cancel-tracking').click();

  // Remembered on the next visit.
  await page.reload();
  await expect(page.locator('#editor-workspace')).toBeVisible();
  await page.locator('.caption-list-item').first().click();
  await page.locator('#btn-track-with-ai').click();
  await expect(bar).toContainText('The caption goes on top of it.');
  await expect(modal).toBeHidden();

  // Change shows the saved choice; unticking the box goes back to asking.
  await page.locator('#btn-tracking-placement').click();
  await expect(remember).toBeChecked();
  await expect(modal.locator('[data-placement="center"] .track-place-current')).toBeVisible();
  await expect(modal.locator('[data-placement="keep"] .track-place-current')).toBeHidden();
  await remember.uncheck();
  await modal.locator('[data-placement="keep"]').click();
  await expect(bar).toContainText('The caption keeps its place relative to it.');
  expect(await page.evaluate(() => localStorage.getItem('gc_track_placement'))).toBeNull();
  await page.locator('#btn-cancel-tracking').click();
  await page.locator('#btn-track-with-ai').click();
  await expect(modal).toBeVisible();
});

test('backing out of the question changes nothing', async ({ page }) => {
  const modal = page.locator('#track-place-modal');
  await page.goto('/gif-editor/edit/?sample=1');
  await expect(page.locator('#editor-workspace')).toBeVisible();
  await page.locator('.caption-list-item').first().click();
  const motion = await page.evaluate(() => JSON.stringify(GC.state.captions[0].motion));

  await page.locator('#btn-track-with-ai').click();
  await expect(modal.locator('.modal-title')).toHaveText('How should the caption follow the object?');
  await expect(modal.locator('[data-placement="keep"]')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(modal).toBeHidden();
  await expect(page.locator('#tracking-bar')).toBeHidden();
  await expect(page.locator('#btn-track-with-ai')).toBeFocused();
  expect(await page.evaluate(() => GC.state._trackingMode)).toBeFalsy();

  // Backing out of Change keeps tracking mode and its choice.
  await page.locator('#btn-track-with-ai').click();
  await modal.locator('[data-placement="keep"]').click();
  await page.locator('#btn-tracking-placement').click();
  await modal.locator('#track-place-modal-cancel').click();
  await expect(page.locator('#tracking-bar')).toContainText('keeps its place relative to it');
  expect(await page.evaluate(() => GC.state._trackingMode.placement)).toBe('keep');
  await page.locator('#btn-cancel-tracking').click();
  expect(await page.evaluate(() => JSON.stringify(GC.state.captions[0].motion))).toBe(motion);

  // Image overlays get the same question.
  await page.evaluate(() => GC.startTrackingMode({ id: 'overlay-test', motion: [] }, 'overlay'));
  await expect(modal.locator('.modal-title')).toHaveText('How should the image follow the object?');
});

test('a double-click neither dismisses the question nor taps the GIF behind it', async ({ page }) => {
  const modal = page.locator('#track-place-modal');
  await page.goto('/gif-editor/edit/?sample=1');
  await expect(page.locator('#editor-workspace')).toBeVisible();
  await page.locator('.caption-list-item').first().click();
  await page.locator('#btn-track-with-ai').dblclick();
  await expect(modal).toBeVisible();
  // The choice sits over the canvas, so the second click lands on the GIF.
  const choice = await modal.locator('[data-placement="keep"]').boundingBox();
  const canvas = await page.locator('#preview-canvas').boundingBox();
  for (const [axis, size] of [['x', 'width'], ['y', 'height']]) {
    const middle = choice[axis] + choice[size] / 2;
    expect(middle).toBeGreaterThan(canvas[axis]);
    expect(middle).toBeLessThan(canvas[axis] + canvas[size]);
  }
  await modal.locator('[data-placement="keep"]').dblclick();
  await expect(modal).toBeHidden();
  await expect(page.locator('#tracking-bar')).toBeVisible();
  expect(await page.evaluate(() => GC.state._trackingMode && GC.state._trackingMode.placement)).toBe('keep');
});

test('the dark theme opens the night sample, unless the link asks for one', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('gw-theme', 'dark'));
  await page.goto('/gif-editor/edit/?sample=1');
  await expect(page.locator('#editor-workspace')).toBeVisible();
  expect(await page.evaluate(() => GC.state.gifFilename)).toBe('sample-bee-night.gif');
  await page.goto('/gif-editor/edit/?sample=day');
  await expect(page.locator('#editor-workspace')).toBeVisible();
  expect(await page.evaluate(() => GC.state.gifFilename)).toBe('sample-bee.gif');
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
