const { test, expect } = require('@playwright/test');
const path = require('path');

async function mockSharing(page) {
  const requests = [];
  await page.route('**/api/share/presign', async route => {
    const metadata = route.request().postDataJSON();
    requests.push(metadata);
    await route.fulfill({ json: {
      ...metadata, slug: 'test-captioned-' + 'a'.repeat(32),
      upload_url: 'https://s3.test.com/upload',
    } });
  });
  await page.route('https://s3.test.com/upload', async route => {
    expect(route.request().method()).toBe('PUT');
    await route.fulfill({ status: 200 });
  });
  await page.route('**/api/share/finalize', async route => {
    expect(route.request().postDataJSON().slug).toBe('test-captioned-' + 'a'.repeat(32));
    await route.fulfill({ json: {
      share_url: 'https://gifwidgets.com/g/test.html',
      gif_url: 'https://gifwidgets.com/share/test.gif',
    } });
  });
  return requests;
}

test('5 MB Unicode GIF and 39 MB GIF retain direct sharing support', async ({ page }) => {
  const requests = await mockSharing(page);
  await page.goto('/gif-editor/edit/');
  for (const size of [5, 39]) {
    const result = await page.evaluate(async mb => {
      const blob = new Blob(['GIF89a', new Uint8Array(mb * 1024 * 1024)], { type: 'image/gif' });
      return shareGif(blob, '你好 🐱', '猫.gif');
    }, size);
    expect(result.share_url).toBe('https://gifwidgets.com/g/test.html');
  }
  expect(requests).toHaveLength(2);
  expect(requests.every(r => r.title === '你好 🐱' && r.filename === '猫.gif')).toBe(true);
});

for (const tool of ['gif-resizer', 'crop-gif', 'gif-maker']) {
  test(`${tool} completes its existing share flow through /api`, async ({ page }) => {
    const requests = await mockSharing(page);
    await page.goto(`/${tool}/edit/`);
    await page.locator('input[type=file]').first().setInputFiles(path.join(__dirname, 'fixtures/test.gif'));
    if (tool !== 'gif-maker') {
      await page.locator(tool === 'gif-resizer' ? '#btn-resize' : '#btn-crop').click();
      await page.locator('#result-modal-close').click();
    }
    await expect(page.locator('#btn-share')).toBeEnabled();
    await page.locator('#btn-share').click();
    await expect(page.locator('#share-consent-modal')).toBeVisible();
    await page.locator('#share-consent-yes').click();
    await expect(page.locator('#share-url')).toHaveValue('https://gifwidgets.com/g/test.html', { timeout: 20000 });
    expect(requests).toHaveLength(1);
  });
}
