const { test, expect } = require('@playwright/test');
const path = require('path');

test('image caption tool is featured, loads a photo, and exports text and caption bars', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('gc_cookie_consent', 'rejected'));
  await page.goto('/');
  const links = await page.locator('#image-tools .tool-card').evaluateAll(nodes => nodes.map(n => n.getAttribute('href')));
  expect(links.slice(0, 4)).toEqual(['/image-editor/', '/add-text-to-image/', '/remove-image-background/', '/change-image-background/']);
  expect(new Set(links).size).toBe(links.length);
  await page.locator('#image-tools a[href="/add-text-to-image/"]').click();
  await expect(page).toHaveTitle(/Add Text to Image.*Photo Caption/);
  await expect(page.locator('h1')).toHaveText('Add Text to Image');
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', /\/add-text-to-image\/$/);
  const schema = await page.locator('script[type="application/ld+json"]').evaluateAll(nodes => nodes.map(n => JSON.parse(n.textContent)));
  expect(schema.find(s => s['@type'] === 'FAQPage').mainEntity.length).toBe(6);
  await page.locator('#hero-file-input').setInputFiles(path.join(__dirname, 'fixtures/test.png'));
  await expect(page).toHaveURL(/\/add-text-to-image\/edit\/\?source=imgcap/);
  await expect(page.locator('#editor-workspace')).toBeVisible();
  await expect(page.locator('#adj-section')).toBeHidden();
  await expect(page.locator('#overlay-section')).toBeHidden();
  await page.locator('#on-image-caption-toggle').click();
  await page.locator('#btn-add-caption').click();
  await page.locator('#cap-text').fill('Photo caption');
  await page.locator('#cap-font').selectOption('Arial');
  await page.locator('#btn-add-caption').click();
  await page.locator('#cap-text').fill('Second caption');
  expect(await page.evaluate(() => GC.state.captions.map(c => c.text))).toEqual(['Photo caption', 'Second caption']);
  await page.locator('#box-caption-toggle').click();
  for (const position of ['top', 'bottom']) {
    await page.locator('#btn-add-box-' + position).click();
    await page.locator('#box-' + position + '-text').fill(position + ' caption');
  }
  await page.locator('#other-options-toggle').click();
  await page.locator('#sel-export-format').selectOption('image/png');
  await page.locator('#chk-watermark').uncheck();
  await page.locator('#btn-download').click();
  await expect(page.locator('#download-modal')).toBeVisible();
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#btn-dl-download').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.png$/);
  expect(await download.failure()).toBeNull();
  const bytes = require('fs').readFileSync(await download.path());
  expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  const dimensions = await page.evaluate(() => ({ width: GC.state.width, height: GC.state.height }));
  expect(bytes.readUInt32BE(16)).toBe(dimensions.width);
  expect(bytes.readUInt32BE(20)).toBeGreaterThan(dimensions.height);
});
