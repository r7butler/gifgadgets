// @ts-check
const { test, expect } = require('@playwright/test');

// A rejected upload used to be reported only in the sidebar status line,
// which sits below the fold on most of these pages, so the drop zone just
// stayed there and the upload looked broken. The GIF tools are covered in
// gif-utilities.spec.js.

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('gc_cookie_consent', 'rejected'));
});

const text = { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') };
// A 1×1 PNG, enough for a page to accept the file.
const onePng = { name: 'one.png', mimeType: 'image/png', buffer: Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64') };

const REJECTED = [
  ['bulk-resize-images', text, '“notes.txt” is not a PNG, JPG, WebP, GIF, BMP or AVIF image.'],
  ['image-contact-sheet', onePng, 'Choose at least two images for a contact sheet.'],
  ['trim-video', text, 'Choose an MP4, MOV or WebM file up to 100 MB.'],
  ['gif-to-mp4', text, 'Choose a GIF file up to 100 MB.'],
  ['remove-image-background', text, 'Choose a supported file up to 100 MB.'],
  ['remove-gif-background', { name: 'renamed.gif', mimeType: 'image/gif', buffer: Buffer.from('not a gif') }, 'Choose a valid GIF file.'],
];

for (const viewport of [{ width: 1280, height: 720 }, { width: 390, height: 844 }]) {
  for (const [slug, file, reason] of REJECTED) {
    test(`${slug} says why a file was rejected beside the drop zone (${viewport.width}px)`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto('/' + slug + '/');
      await page.locator('#utility-file').setInputFiles(file);
      const message = page.locator('#utility-upload-error');
      await expect(message).toHaveText(reason);
      await expect(message).toBeInViewport();
      await expect(page.locator('#utility-upload')).toBeVisible();
    });
  }
}

for (const [slug, reason] of [
  ['bulk-resize-images', 'Drop image files from your device.'],
  ['trim-video', 'Drop a video file from your device.'],
  ['gif-to-mp4', 'Drop a GIF file from your device.'],
  ['remove-image-background', 'Drop an image file from your device.'],
  ['remove-gif-background', 'Drop a GIF file from your device.'],
]) {
  test(`${slug} explains a drop that carries no file`, async ({ page }) => {
    await page.goto('/' + slug + '/');
    // An image dragged from a web page carries a link, not a file.
    await page.locator('#utility-upload').evaluate(element => {
      const transfer = new DataTransfer();
      transfer.setData('text/uri-list', 'https://example.com/picture.png');
      element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    });
    await expect(page.locator('#utility-upload-error')).toHaveText(reason);
  });
}

test('a video that cannot be read brings back the drop zone with the reason', async ({ page }) => {
  test.setTimeout(90000);
  await page.goto('/trim-video/');
  await page.locator('#utility-file').setInputFiles({ name: 'clip.mp4', mimeType: 'video/mp4', buffer: Buffer.from('not a video') });
  const message = page.locator('#utility-upload-error');
  await expect(message).toHaveText('No readable video stream found. Try another file.', { timeout: 60000 });
  await expect(message).toBeInViewport();
  await expect(page.locator('#utility-upload')).toBeVisible();
  await expect(page.locator('#utility-original-wrap')).toBeHidden();
  await expect(page.locator('#utility-apply')).toBeDisabled();
});

test('an image the background tool cannot decode says so beside the drop zone', async ({ page }) => {
  await page.goto('/remove-image-background/');
  await page.locator('#utility-file').setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: Buffer.from('not a png') });
  await expect(page.locator('#utility-upload-error')).toHaveText('This image could not be read. Try another PNG, JPG or WebP file.');
  await expect(page.locator('#utility-upload')).toBeVisible();
  // A good file clears the message.
  await page.locator('#utility-file').setInputFiles(onePng);
  await expect(page.locator('#utility-original-wrap')).toBeVisible();
  await expect(page.locator('#utility-upload-error')).toBeHidden();
});
