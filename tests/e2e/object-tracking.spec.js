// @ts-check
const { test, expect } = require('@playwright/test');
const path = require('path');

const FIXTURE = path.join(__dirname, 'fixtures/test.gif');

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('gc_cookie_consent', 'rejected');
    // Count the tracker worker's warmup replies as the editor receives them.
    window.warmupReplies = 0;
    const Native = window.Worker;
    window.Worker = class extends Native {
      constructor(...args) {
        super(...args);
        this.addEventListener('message', e => { if (e.data.type === 'warmup-done') window.warmupReplies++; });
      }
    };
  });
});

test('a late warmup reply leaves the tracking progress up until the keyframes arrive', async ({ page }) => {
  // The API wakes the GPU on the first warmup in a minute, which takes up to
  // 10 s, and answers later ones at once. Follow an Object sends two, so the
  // visitor can click while the first is still out. Its reply used to hide
  // the run's progress: the caption sat still, then jumped onto its path
  // whenever the keyframes came back.
  let releaseWarmup, releaseTrack, trackArrived;
  const warmupGate = new Promise(resolve => { releaseWarmup = resolve; });
  const trackGate = new Promise(resolve => { releaseTrack = resolve; });
  const trackSeen = new Promise(resolve => { trackArrived = resolve; });
  let warmups = 0, sent = [];
  await page.route('**/api/track/warmup', async route => {
    if (warmups++ === 0) await warmupGate;
    await route.fulfill({ json: { ok: true } });
  });
  await page.route('**/api/track/presign', route =>
    route.fulfill({ json: { upload_url: '/test-track-upload', s3_key: 'track/0123456789ab.json' } }));
  await page.route('**/test-track-upload', route => route.fulfill({ body: '' }));
  await page.route('**/api/track/submit', async route => {
    sent = route.request().postDataJSON().frame_indices;
    trackArrived();
    await trackGate;
    await route.fulfill({ json: { motion: sent.map(frame => ({ frame, x: 0.3, y: 0.4 + frame / 100 })) } });
  });

  await page.goto('/gif-editor/edit/');
  await page.locator('#file-input').setInputFiles(FIXTURE);
  await expect(page.locator('#editor-workspace')).toBeVisible();
  await page.locator('#on-image-caption-toggle').click();
  await page.locator('#btn-add-caption').click();
  await page.locator('#btn-track-with-ai').click();
  await page.locator('#track-place-modal [data-placement="keep"]').click();
  const loading = page.locator('#tracking-loading');
  // The second warmup's reply takes down "Loading tracker…".
  await expect.poll(() => page.evaluate(() => window.warmupReplies)).toBe(1);
  await expect(loading).toBeHidden();

  const box = await page.locator('#preview-canvas').boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await trackSeen;
  await expect(loading).toBeVisible();
  await expect(loading).toContainText('Creating motion keyframes');
  const motion = () => page.evaluate(() => GC.findCaption(GC.state.selectedCaptionId).motion.length);

  // The slow warmup answers while the keyframes are still being made.
  releaseWarmup();
  await expect.poll(() => page.evaluate(() => window.warmupReplies)).toBe(2);
  await expect(loading).toBeVisible();
  await expect(loading).toContainText('Creating motion keyframes');
  expect(await motion()).toBe(0);

  releaseTrack();
  await expect(loading).toBeHidden();
  expect(sent.length).toBeGreaterThan(1);
  expect(await motion()).toBe(sent.length);
});
