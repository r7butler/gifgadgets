// @ts-check
const { test, expect } = require('@playwright/test');
const { GifWriter } = require('../../frontend/vendor/omggif.js');

const EDITORS = [
  { name: 'GIF editor', path: '/gif-editor/edit/', exportFn: 'exportGif' },
  { name: 'image editor', path: '/image-editor/edit/', exportFn: 'exportImage' },
];

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('gc_cookie_consent', 'rejected'));
});

/** A solid gray GIF, large enough to grab caption handles on. */
function grayGif(width = 240, height = 160) {
  const bytes = Buffer.alloc(width * height + 4096), writer = new GifWriter(bytes, width, height, { loop: 0 });
  for (let i = 0; i < 2; i++) {
    writer.addFrame(0, 0, width, height, new Uint8Array(width * height), { palette: [0x808080, 0x000000], delay: 10 });
  }
  return { name: 'gray.gif', mimeType: 'image/gif', buffer: bytes.subarray(0, writer.end()) };
}

/** A solid-color PNG, drawn by the browser. */
async function solidPng(page, name, width, height, color) {
  const url = await page.evaluate(([w, h, c]) => {
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = c; ctx.fillRect(0, 0, w, h);
    return canvas.toDataURL('image/png');
  }, [width, height, color]);
  return { name, mimeType: 'image/png', buffer: Buffer.from(url.split(',')[1], 'base64') };
}

/** Open an editor on a 240×160 gray picture with one selected caption. */
async function openWithCaption(page, editor) {
  await page.goto(editor.path);
  const base = editor.exportFn === 'exportGif' ? grayGif() : await solidPng(page, 'gray.png', 240, 160, '#808080');
  await page.locator('#file-input').setInputFiles(base);
  await expect(page.locator('#editor-workspace')).toBeVisible();
  await page.locator('#on-image-caption-toggle').click();
  await page.locator('#btn-add-caption').click();
  await expect(page.locator('#caption-editor')).toBeVisible();
}

/** Page coordinates of a point given in picture pixels. */
function pagePoint(page, x, y) {
  return page.evaluate(([x, y]) => {
    const r = GC.canvas.getBoundingClientRect(), size = GC.getCompositeSize();
    return { x: r.left + x * r.width / size.w, y: r.top + (y + GC.getFrameOffsetY()) * r.height / size.h };
  }, [x, y]);
}

/**
 * Pixels inside the first caption's box, clear of its selection handles,
 * that are not the red overlay — in the preview, or in the exported file.
 */
function pixelsNotRed(page, exportFn) {
  return page.evaluate(async (exportFn) => {
    const box = GC.getCaptionBBox(GC.ctx, GC.state.captions[0], 0);
    let ctx = GC.ctx, offsetY = GC.getFrameOffsetY();
    if (exportFn) {
      const blob = await new Promise(resolve => GC[exportFn]({ onBlob: resolve }));
      const bitmap = await createImageBitmap(blob);
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width; canvas.height = bitmap.height;
      ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0);
    }
    const inset = 12;
    const data = ctx.getImageData(box.x + inset, box.y + offsetY + inset, box.w - 2 * inset, box.h - 2 * inset).data;
    let count = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (!(data[i] > 200 && data[i + 1] < 60 && data[i + 2] < 60)) count++;
    }
    return count;
  }, exportFn);
}

for (const editor of EDITORS) {
  test.describe(editor.name, () => {
    test('bring to front moves an image over a caption and the caption back over it', async ({ page }) => {
      await openWithCaption(page, editor);
      await page.locator('#cap-text').fill('WWWW');
      await page.evaluate(() => Object.assign(GC.state.captions[0], { x: 0.5, y: 0.25, boxWidth: 0.6, boxHeight: 0.5, fontSize: 200 }));
      await expect(page.locator('#btn-cap-bring-front')).toBeDisabled();

      // A red image big enough to cover the whole picture, handles and all.
      await page.locator('#overlay-toggle').click();
      await page.locator('#overlay-file-input').setInputFiles(await solidPng(page, 'red.png', 100, 100, '#ff0000'));
      await expect(page.locator('#overlay-editor')).toBeVisible();
      await page.evaluate(() => {
        Object.assign(GC.state.overlays[0], { x: 0.5, y: 0.5, scale: 4, scaleX: 4, scaleY: 4 });
        GC.renderCurrentFrame();
      });
      if (editor.exportFn === 'exportGif') await page.waitForFunction(() => GC.state._workerBlobUrl);

      // A new image goes behind the captions, as before layers existed.
      expect(await pixelsNotRed(page)).toBeGreaterThan(0);
      await expect(page.locator('#btn-ov-bring-front')).toBeEnabled();

      await page.locator('#btn-ov-bring-front').click();
      await expect(page.locator('#btn-ov-bring-front')).toBeDisabled();
      expect(await pixelsNotRed(page)).toBe(0);
      expect(await pixelsNotRed(page, editor.exportFn)).toBe(0);

      // With nothing selected, a click where they overlap picks the front one.
      const middle = await page.evaluate(() => {
        const box = GC.getCaptionBBox(GC.ctx, GC.state.captions[0], 0);
        GC.selectCaption(null);
        return { x: box.x + box.w / 2, y: box.y + box.h / 2 };
      });
      const point = await pagePoint(page, middle.x, middle.y);
      await page.mouse.click(point.x, point.y);
      expect(await page.evaluate(() => GC.state.selectedOverlayId)).toBe(await page.evaluate(() => GC.state.overlays[0].id));

      await page.locator('#caption-list .caption-list-item').click();
      await expect(page.locator('#btn-cap-bring-front')).toBeEnabled();
      await page.locator('#btn-cap-bring-front').click();
      await expect(page.locator('#btn-cap-bring-front')).toBeDisabled();
      expect(await pixelsNotRed(page)).toBeGreaterThan(0);
      expect(await pixelsNotRed(page, editor.exportFn)).toBeGreaterThan(0);

      await page.evaluate(() => GC.selectCaption(null));
      await page.mouse.click(point.x, point.y);
      expect(await page.evaluate(() => GC.state.selectedCaptionId)).toBe('cap-1');
    });
  });
}
