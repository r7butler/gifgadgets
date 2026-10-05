// @ts-check
// "Save to Photos" appears on touch devices that can share the export, and never on desktop.
const { test, expect, devices } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const { GifReader } = require('../../frontend/vendor/omggif.js');

const FIXTURES = path.join(__dirname, 'fixtures');

// Record what the page hands the share sheet, and count programmatic downloads.
// `outcome` is the DOMException name share() rejects with, or 'ok'.
async function stubShare(page, outcome = 'ok', supported = true) {
  await page.addInitScript(({ outcome, supported }) => {
    window.__shared = [];
    window.__downloads = 0;
    Object.defineProperty(navigator, 'canShare', { configurable: true,
      value: supported ? data => !!(data && data.files && data.files.length) : undefined });
    Object.defineProperty(navigator, 'share', { configurable: true, value: data => {
      window.__shared.push(data.files);
      return outcome === 'ok' ? Promise.resolve() : Promise.reject(new DOMException('stub', outcome));
    } });
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (this.hasAttribute('download')) window.__downloads++;
      return click.call(this);
    };
  }, { outcome, supported });
}

const shared = page => page.evaluate(() => window.__shared.map(files =>
  files.map(file => ({ name: file.name, type: file.type, size: file.size }))));

async function trimGif(page) {
  await page.goto('/trim-gif/');
  await page.locator('#utility-file').setInputFiles(path.join(FIXTURES, 'test-animated.gif'));
  await expect(page.locator('#utility-apply')).toBeEnabled();
  await page.locator('#utility-start').fill('2');
  await page.locator('#utility-apply').click();
  await expect(page.locator('#utility-download')).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  // The consent banner would cover tool controls on a phone-sized screen.
  await page.addInitScript(() => localStorage.setItem('gc_cookie_consent', 'rejected'));
  // WebKit routes blob: URLs too, and they have no hostname.
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    return url.hostname === 'localhost' || url.protocol === 'blob:' ? route.continue() : route.abort();
  });
});

test.describe('on a phone', () => {
  const iPhone = devices['iPhone 13'];
  test.use({ viewport: iPhone.viewport, userAgent: iPhone.userAgent, deviceScaleFactor: iPhone.deviceScaleFactor,
    isMobile: true, hasTouch: true });
  test.skip(({ browserName }) => browserName === 'firefox', 'Firefox has no mobile emulation');

  test('Trim GIF hands the trimmed GIF to the share sheet', async ({ page }) => {
    await stubShare(page);
    await trimGif(page);
    const save = page.locator('#utility-save');
    await expect(save).toBeVisible();
    await expect(save).toHaveText('Save to Photos');
    await save.click();
    expect(await shared(page)).toEqual([[expect.objectContaining({ name: 'trim-gif.gif', type: 'image/gif' })]]);
    const bytes = await page.evaluate(async () => Array.from(new Uint8Array(await window.__shared[0][0].arrayBuffer())));
    const source = new GifReader(fs.readFileSync(path.join(FIXTURES, 'test-animated.gif')));
    expect(new GifReader(Buffer.from(bytes)).numFrames()).toBe(source.numFrames() - 1);
    expect(await page.evaluate(() => window.__downloads)).toBe(0);
  });

  test('changing settings hides the stale Save to Photos button', async ({ page }) => {
    await stubShare(page);
    await trimGif(page);
    await expect(page.locator('#utility-save')).toBeVisible();
    await page.locator('#utility-start').fill('1');
    await expect(page.locator('#utility-save')).toBeHidden();
  });

  test('dismissing the share sheet does not download', async ({ page }) => {
    await stubShare(page, 'AbortError');
    await trimGif(page);
    await page.locator('#utility-save').click();
    await expect.poll(() => page.evaluate(() => window.__shared.length)).toBe(1);
    expect(await page.evaluate(() => window.__downloads)).toBe(0);
  });

  test('a share sheet that fails to open falls back to a download', async ({ page }) => {
    await stubShare(page, 'NotAllowedError');
    await trimGif(page);
    const download = page.waitForEvent('download');
    await page.locator('#utility-save').click();
    expect((await download).suggestedFilename()).toBe('trim-gif.gif');
  });

  test('without Web Share support only Download is offered', async ({ page }) => {
    await stubShare(page, 'ok', false);
    await trimGif(page);
    await expect(page.locator('#utility-save')).toBeHidden();
  });

  test('extracted frames are saved as images, not as the ZIP', async ({ page }) => {
    await stubShare(page);
    await page.goto('/photo-converter/gif-to-png/');
    await page.locator('#utility-file').setInputFiles(path.join(FIXTURES, 'test-animated.gif'));
    await expect(page.locator('#utility-apply')).toBeEnabled();
    await page.locator('#utility-extract').selectOption('all');
    await page.locator('#utility-apply').click();
    const save = page.locator('#utility-save');
    await expect(save).toHaveText('Save all to Photos');
    await save.click();
    const [files] = await shared(page);
    expect(files.length).toBeGreaterThan(1);
    for (const file of files) expect(file).toMatchObject({ type: 'image/png', name: expect.stringMatching(/^frame-\d+\.png$/) });
  });

  test('photo converters offer Save to Photos for the converted image', async ({ page }) => {
    await stubShare(page);
    await page.goto('/photo-converter/jpg-to-png/');
    await page.locator('#file-input').setInputFiles(path.join(FIXTURES, 'test.jpg'));
    await page.locator('#btn-convert').click();
    const save = page.locator('#btn-save-photos');
    await expect(save).toBeVisible();
    await save.click();
    expect(await shared(page)).toEqual([[expect.objectContaining({ name: 'test.png', type: 'image/png' })]]);
  });

  test('Crop GIF result modal uses the same Save to Photos', async ({ page }) => {
    await stubShare(page);
    await page.goto('/crop-gif/edit/');
    await page.locator('#file-input').setInputFiles(path.join(FIXTURES, 'test.gif'));
    await expect(page.locator('#editor-screen')).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: 'Toggle editor menu' }).click();
    await page.locator('#btn-crop').click();
    const save = page.locator('#btn-save-photos');
    await expect(save).toBeVisible({ timeout: 15_000 });
    await save.click();
    expect(await shared(page)).toEqual([[expect.objectContaining({ name: expect.stringMatching(/-cropped\.gif$/), type: 'image/gif' })]]);
  });
});

test.describe('on desktop', () => {
  test('Trim GIF offers a single Download button', async ({ page }) => {
    // Web Share is stubbed in, so only the pointer type keeps the button away.
    await stubShare(page);
    await trimGif(page);
    await expect(page.locator('#utility-save')).toBeHidden();
  });

  test('Crop GIF result modal keeps Save to Photos hidden', async ({ page }) => {
    await stubShare(page);
    await page.goto('/crop-gif/edit/');
    await page.locator('#file-input').setInputFiles(path.join(FIXTURES, 'test.gif'));
    await expect(page.locator('#editor-screen')).toBeVisible({ timeout: 10_000 });
    await page.locator('#btn-crop').click();
    await expect(page.locator('#btn-dl-modal')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#btn-save-photos')).toBeHidden();
  });
});
