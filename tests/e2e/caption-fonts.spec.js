const { test, expect } = require('@playwright/test');
const path = require('path');

test('web caption fonts load on use, and the preview and exports draw them', async ({ page }) => {
  // Hold the font files back so an export can start before they arrive.
  let releaseFonts;
  const fontsHeld = new Promise(resolve => { releaseFonts = resolve; });
  const requested = [];
  await page.route('**/vendor/fonts/*.woff2', async route => {
    requested.push(new URL(route.request().url()).pathname);
    await fontsHeld;
    await route.continue();
  });
  await page.addInitScript(() => {
    localStorage.setItem('gc_cookie_consent', 'rejected');
    window.pngHash = blob => blob.arrayBuffer()
      .then(bytes => crypto.subtle.digest('SHA-256', bytes))
      .then(digest => Array.from(new Uint8Array(digest), x => x.toString(16).padStart(2, '0')).join(''));
  });
  await page.goto('/add-text-to-image/');
  await page.locator('#hero-file-input').setInputFiles(path.join(__dirname, 'fixtures/test.png'));
  await expect(page.locator('#editor-workspace')).toBeVisible();
  await page.evaluate(() => { GC.state.exportFormat = 'image/png'; });

  const options = await page.locator('#cap-font option').evaluateAll(nodes => nodes.map(n => n.value));
  expect(options).toEqual(expect.arrayContaining(['TikTok Sans', 'Montserrat']));
  for (const position of ['top', 'bottom']) {
    await expect(page.locator('#box-' + position + '-font option[value="TikTok Sans"]')).toHaveCount(1);
    await expect(page.locator('#box-' + position + '-font option[value="Montserrat"]')).toHaveCount(1);
  }

  const exportHash = () => page.evaluate(() => new Promise(resolve => {
    GC.exportImage({ onBlob: blob => pngHash(blob).then(resolve) });
  }));
  const previewHash = () => page.evaluate(() => new Promise(resolve => {
    GC.ctx.canvas.toBlob(blob => pngHash(blob).then(resolve), 'image/png');
  }));

  await page.locator('#on-image-caption-toggle').click();
  await page.locator('#btn-add-caption').click();
  await page.locator('#cap-text').fill('Fonts');
  expect(requested).toEqual([]);

  await page.locator('#cap-font').selectOption('TikTok Sans');
  await expect.poll(() => requested).toContain('/vendor/fonts/tiktok-sans-latin-700-normal.woff2');
  const fallbackPreview = await previewHash();
  const earlyExport = exportHash();
  releaseFonts();
  const waitedExport = await earlyExport;

  // The preview redraws by itself once the font lands.
  await expect.poll(previewHash).not.toBe(fallbackPreview);
  // The export started mid-download matches one made after the font loaded.
  expect(await exportHash()).toBe(waitedExport);
  // And the font is what changed the pixels.
  await page.locator('#cap-font').selectOption('Arial');
  expect(await exportHash()).not.toBe(waitedExport);

  await page.locator('#cap-font').selectOption('Montserrat');
  await page.locator('#cap-bold').uncheck();
  await expect.poll(() => requested).toContain('/vendor/fonts/montserrat-latin-400-normal.woff2');
  await expect.poll(() => page.evaluate(() => document.fonts.check('400 40px Montserrat', 'Fonts'))).toBe(true);
});
