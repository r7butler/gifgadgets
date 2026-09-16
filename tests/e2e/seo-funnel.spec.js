const { test, expect } = require('@playwright/test');
const path = require('path');
const fixture = path.join(__dirname, 'fixtures/test.jpg');
async function events(page) {
  return page.evaluate(() => (window.dataLayer || []).filter(e => e[0] === 'event').map(e => [e[1], e[2]]));
}
async function convert(page) {
  await page.locator('#file-input').setInputFiles(fixture);
  await page.locator('#btn-convert').click();
  await expect(page.locator('#conv-result')).toBeVisible();
}
test.beforeEach(async ({ page }) => {
  // Test event dispatch without contacting Google or creating production analytics.
  await page.route('https://www.googletagmanager.com/**', route => route.fulfill({ body: '' }));
});
test('consented conversion emits a private, ordered funnel and stops after revocation', async ({ page }) => {
  await page.goto('/photo-converter/jpg-to-png/?private=never-send');
  await page.locator('#cookie-accept').click();
  await convert(page);
  const logged = await events(page);
  expect(logged.map(e => e[0])).toEqual(['file_accepted', 'editor_ready', 'export_started', 'export_completed']);
  for (const [, params] of logged) {
    expect(Object.keys(params).sort()).toEqual(['duration_ms', 'page_location', 'size_bucket', 'tool_name']);
    expect(params.tool_name).toBe('jpg-to-png');
    expect(params.duration_ms).toBeGreaterThanOrEqual(0);
    expect(params.size_bucket).toBe('under_1mb');
    expect(params.page_location).not.toContain('?');
  }
  expect(JSON.stringify(logged)).not.toContain('test.jpg');
  await page.locator('#analytics-settings').click();
  await page.locator('#cookie-reject').click();
  await convert(page);
  expect(await events(page)).toEqual(logged);
});
test('rejected tasks are not queued or replayed after accepting', async ({ page }) => {
  await page.goto('/photo-converter/jpg-to-png/');
  await page.locator('#cookie-reject').click();
  await convert(page);
  expect(await events(page)).toEqual([]);
  await page.locator('#analytics-settings').click();
  await page.locator('#cookie-accept').click();
  expect(await events(page)).toEqual([]);
});
test('unsupported output is a failure, not an export completion', async ({ page }) => {
  await page.goto('/photo-converter/jpg-to-webp/');
  await page.locator('#cookie-accept').click();
  await page.evaluate(() => { HTMLCanvasElement.prototype.toBlob = cb => cb(new Blob(['png'], { type: 'image/png' })); });
  page.on('dialog', dialog => dialog.accept());
  await page.locator('#file-input').setInputFiles(fixture);
  await page.locator('#btn-convert').click();
  await expect.poll(async () => (await events(page)).map(e => e[0])).toContain('tool_failure');
  expect((await events(page)).map(e => e[0])).not.toContain('export_completed');
  await expect(page.locator('#conv-result')).toBeHidden();
});
test('export spans finish once and tracking has a separate funnel', async ({ page }) => {
  await page.goto('/gif-editor/edit/');
  await page.locator('#cookie-accept').click();
  await page.evaluate(() => {
    GWFunnel.accepted(500);
    const exp = GWFunnel.exportStarted(); exp.fail('timeout'); exp.complete();
    const tracking = GWFunnel.trackingStarted(); tracking.complete(); tracking.complete();
  });
  expect((await events(page)).map(e => e[0])).toEqual([
    'file_accepted', 'export_started', 'tool_failure', 'tracking_started', 'tracking_completed'
  ]);
});
test('video controls wait for initialization even when frame callbacks never arrive', async ({ page }) => {
  await page.addInitScript(() => {
    HTMLVideoElement.prototype.requestVideoFrameCallback = () => 1;
    HTMLVideoElement.prototype.cancelVideoFrameCallback = () => {};
    HTMLVideoElement.prototype.play = () => Promise.resolve();
  });
  await page.goto('/video-to-gif/edit/');
  await page.locator('#cookie-accept').click();
  await page.locator('#file-input').setInputFiles(path.join(__dirname, 'fixtures/test.mp4'));
  await expect(page.locator('#editor-screen')).toBeVisible();
  await expect(page.locator('#btn-convert')).toBeDisabled();
  await expect.poll(() => page.evaluate(() => {
    const video = document.querySelector('video');
    if (video.error) return 'codec-unavailable';
    return document.querySelector('#btn-convert').disabled ? 'initializing' : 'ready';
  }), { timeout: 5000 }).not.toBe('initializing');
  if (await page.locator('video').evaluate(video => !!video.error)) {
    // Some Playwright Firefox installs can read MP4 metadata but lack its decoder.
    // An error must not turn into a false ready event when the fallback timer fires.
    await page.waitForTimeout(1700);
    await expect(page.locator('#btn-convert')).toBeDisabled();
    expect((await events(page)).map(e => e[0])).toEqual(['file_accepted', 'tool_failure']);
    return;
  }
  await expect(page.locator('#btn-convert')).toBeEnabled();
  expect((await events(page)).map(e => e[0])).toEqual(['file_accepted', 'editor_ready']);
  await page.locator('#btn-convert').click();
  await expect(page.locator('#btn-dl-modal')).toBeVisible({ timeout: 20000 });
  expect((await events(page)).map(e => e[0])).toEqual([
    'file_accepted', 'editor_ready', 'export_started', 'export_completed'
  ]);
});
