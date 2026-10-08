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
 * The picture as the preview shows it without selection handles, or as
 * GC[exportFn] exports it, with the first caption's box in its pixels.
 */
function renderedPicture(page, exportFn) {
  return page.evaluate(async (exportFn) => {
    let source = GC.canvas;
    const selected = [GC.state.selectedCaptionId, GC.state.selectedOverlayId];
    if (exportFn) {
      if (GC.state.isStillImage) GC.state.exportFormat = 'image/png';
      const blob = await new Promise(resolve => GC[exportFn]({ onBlob: resolve }));
      source = await createImageBitmap(blob);
    } else {
      GC.state.selectedCaptionId = GC.state.selectedOverlayId = null;
      GC.renderCurrentFrame();
    }
    const canvas = document.createElement('canvas');
    canvas.width = source.width; canvas.height = source.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(source, 0, 0);
    [GC.state.selectedCaptionId, GC.state.selectedOverlayId] = selected;
    GC.renderCurrentFrame();
    const box = GC.getCaptionBBox(GC.ctx, GC.state.captions[0], 0);
    box.y += GC.getFrameOffsetY();
    return { width: canvas.width, data: Array.from(ctx.getImageData(0, 0, canvas.width, canvas.height).data), box };
  }, exportFn);
}

/**
 * Count the caption box's pixels by color — red, the gray picture, or
 * anything else — keeping those `from` to `to` pixels in from its edge.
 */
function tally({ width, data, box }, from = 0, to = Infinity) {
  const counts = { red: 0, gray: 0, other: 0 };
  const left = Math.round(box.x), top = Math.round(box.y), w = Math.round(box.w), h = Math.round(box.h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const depth = Math.min(x, y, w - 1 - x, h - 1 - y);
      if (depth < from || depth >= to) continue;
      const i = ((top + y) * width + left + x) * 4, r = data[i], g = data[i + 1], b = data[i + 2];
      if (r > 200 && g < 60 && b < 60) counts.red++;
      else if (Math.abs(r - 128) < 12 && Math.abs(g - 128) < 12 && Math.abs(b - 128) < 12) counts.gray++;
      else counts.other++;
    }
  }
  return counts;
}

/** Set a control's value the way a person dragging or picking it would. */
function setControl(page, selector, value) {
  return page.locator(selector).evaluate((el, value) => {
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}

/** The first caption as a 144×80 box, 48 px from the left and 40 px down. */
async function placeCaption(page, text) {
  await page.locator('#cap-text').fill(text);
  await page.evaluate(() => {
    Object.assign(GC.state.captions[0], { x: 0.5, y: 0.25, boxWidth: 0.6, boxHeight: 0.5, fontSize: 200 });
    GC.renderCurrentFrame();
  });
}

/** The first caption box's corners — TL, TR, BL, BR — on the current frame, turned with the box. */
function captionCorners(page) {
  return page.evaluate(() => {
    const cap = GC.state.captions[0], b = GC.getCaptionBBox(GC.ctx, cap, GC.state.currentFrame);
    const rad = (cap.rotation || 0) * Math.PI / 180, cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    return [[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([sx, sy]) => {
      const dx = sx * b.w / 2, dy = sy * b.h / 2;
      return { x: cx + dx * Math.cos(rad) - dy * Math.sin(rad), y: cy + dx * Math.sin(rad) + dy * Math.cos(rad) };
    });
  });
}

/**
 * Drag one of the selected caption's handles — corner 0-3 (TL, TR, BL, BR)
 * or edge 0-3 (top, right, bottom, left) — by (dx, dy) picture pixels along
 * the box's own axes.
 */
async function dragHandle(page, kind, index, dx, dy) {
  const [from, to] = await page.evaluate(([kind, index, dx, dy]) => {
    const cap = GC.state.captions[0], b = GC.getCaptionBBox(GC.ctx, cap, GC.state.currentFrame);
    const hs = GC.HANDLE_SIZE, rad = (cap.rotation || 0) * Math.PI / 180;
    const corner = GC.getSelectionCorners(b)[index];
    const handle = kind === 'corner' ? { x: corner.x + hs / 2, y: corner.y + hs / 2 } : GC.getEdgeHandles(b)[index];
    const r = GC.canvas.getBoundingClientRect(), size = GC.getCompositeSize();
    const onPage = (x, y) => {
      const ox = x - (b.x + b.w / 2), oy = y - (b.y + b.h / 2);
      const px = b.x + b.w / 2 + ox * Math.cos(rad) - oy * Math.sin(rad);
      const py = b.y + b.h / 2 + ox * Math.sin(rad) + oy * Math.cos(rad) + GC.getFrameOffsetY();
      return { x: r.left + px * r.width / size.w, y: r.top + py * r.height / size.h };
    };
    return [onPage(handle.x, handle.y), onPage(handle.x + dx, handle.y + dy)];
  }, [kind, index, dx, dy]);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 6 });
  await page.mouse.up();
}

function expectSamePoint(actual, expected) {
  expect(Math.abs(actual.x - expected.x)).toBeLessThan(0.5);
  expect(Math.abs(actual.y - expected.y)).toBeLessThan(0.5);
}

function notRed(picture) {
  const counts = tally(picture);
  return counts.gray + counts.other;
}

for (const editor of EDITORS) {
  test.describe(editor.name, () => {
    test('bring to front moves an image over a caption and the caption back over it', async ({ page }) => {
      await openWithCaption(page, editor);
      await placeCaption(page, 'WWWW');
      await expect(page.locator('#btn-cap-bring-front')).toBeDisabled();

      // A red image big enough to cover the whole picture.
      await page.locator('#overlay-toggle').click();
      await page.locator('#overlay-file-input').setInputFiles(await solidPng(page, 'red.png', 100, 100, '#ff0000'));
      await expect(page.locator('#overlay-editor')).toBeVisible();
      await page.evaluate(() => {
        Object.assign(GC.state.overlays[0], { x: 0.5, y: 0.5, scale: 4, scaleX: 4, scaleY: 4 });
        GC.renderCurrentFrame();
      });
      if (editor.exportFn === 'exportGif') await page.waitForFunction(() => GC.state._workerBlobUrl);

      // A new image goes behind the captions, as before layers existed.
      expect(notRed(await renderedPicture(page))).toBeGreaterThan(0);
      await expect(page.locator('#btn-ov-bring-front')).toBeEnabled();

      await page.locator('#btn-ov-bring-front').click();
      await expect(page.locator('#btn-ov-bring-front')).toBeDisabled();
      expect(notRed(await renderedPicture(page))).toBe(0);
      expect(notRed(await renderedPicture(page, editor.exportFn))).toBe(0);

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
      expect(notRed(await renderedPicture(page))).toBeGreaterThan(0);
      expect(notRed(await renderedPicture(page, editor.exportFn))).toBeGreaterThan(0);

      await page.evaluate(() => GC.selectCaption(null));
      await page.mouse.click(point.x, point.y);
      expect(await page.evaluate(() => GC.state.selectedCaptionId)).toBe('cap-1');
    });

    test('resizing a caption from a corner or edge keeps the opposite one in place', async ({ page }) => {
      await openWithCaption(page, editor);
      await placeCaption(page, 'WWWW');

      // Bottom-right corner in: the top-left corner stays put.
      let before = await captionCorners(page);
      await dragHandle(page, 'corner', 3, -30, -20);
      let after = await captionCorners(page);
      expectSamePoint(after[0], before[0]);
      expect(after[3].x).toBeLessThan(before[3].x - 10);
      expect(after[3].y).toBeLessThan(before[3].y - 5);

      // Top-left corner in: the bottom-right corner stays put.
      before = after;
      await dragHandle(page, 'corner', 0, 20, 10);
      after = await captionCorners(page);
      expectSamePoint(after[3], before[3]);
      expect(after[0].x).toBeGreaterThan(before[0].x + 5);

      // Top edge down: the bottom edge stays put, and the top follows the pointer.
      before = after;
      await dragHandle(page, 'edge', 0, 0, 12);
      after = await captionCorners(page);
      expectSamePoint(after[2], before[2]);
      expectSamePoint(after[3], before[3]);
      expect(Math.abs(after[0].y - before[0].y - 12)).toBeLessThan(1.5);

      // Right edge in: the left edge stays put.
      before = after;
      await dragHandle(page, 'edge', 1, -15, 0);
      after = await captionCorners(page);
      expectSamePoint(after[0], before[0]);
      expectSamePoint(after[2], before[2]);
      expect(Math.abs(before[1].x - after[1].x - 15)).toBeLessThan(1.5);
    });

    test('a turned, right-aligned caption keeps its opposite corner while resized', async ({ page }) => {
      await openWithCaption(page, editor);
      await placeCaption(page, 'WWWW');
      await page.evaluate(() => {
        Object.assign(GC.state.captions[0], { rotation: 30, align: 'right', x: 0.75 });
        GC.renderCurrentFrame();
      });
      const before = await captionCorners(page);
      await dragHandle(page, 'corner', 3, -30, -20);
      const after = await captionCorners(page);
      expectSamePoint(after[0], before[0]);
      expect(Math.hypot(after[3].x - after[0].x, after[3].y - after[0].y))
        .toBeLessThan(Math.hypot(before[3].x - before[0].x, before[3].y - before[0].y) - 10);

      await dragHandle(page, 'edge', 3, 15, 0);
      const narrowed = await captionCorners(page);
      expectSamePoint(narrowed[1], after[1]);
      expectSamePoint(narrowed[3], after[3]);
    });

    test('a box outline frames the caption box, clear of its text, in preview and export', async ({ page }) => {
      await openWithCaption(page, editor);
      await placeCaption(page, 'WWWW');
      if (editor.exportFn === 'exportGif') await page.waitForFunction(() => GC.state._workerBlobUrl);
      await expect(page.locator('#cap-box-outline-width')).toHaveValue('0');
      expect(tally(await renderedPicture(page), 0, 6).red).toBe(0);

      await setControl(page, '#cap-box-outline-color', '#ff0000');
      await setControl(page, '#cap-box-outline-width', '6');
      await expect(page.locator('#cap-box-outline-width-val')).toHaveText('6');

      // The outline fills the box's outer 6 px; the next 6 px stay empty, so
      // the text and its own outline never touch it.
      for (const picture of [await renderedPicture(page), await renderedPicture(page, editor.exportFn)]) {
        const ring = tally(picture, 0, 6);
        expect(ring.gray + ring.other).toBe(0);
        expect(tally(picture, 6, 10)).toEqual({ red: 0, gray: expect.any(Number), other: 0 });
        expect(tally(picture, 10).other).toBeGreaterThan(0);
      }

      // The controls show a caption's own outline when it is selected again.
      await page.locator('#btn-add-caption').click();
      await expect(page.locator('#cap-box-outline-width')).toHaveValue('0');
      await page.locator('#caption-list .caption-list-item').first().click();
      await expect(page.locator('#cap-box-outline-width')).toHaveValue('6');
      await expect(page.locator('#cap-box-outline-color')).toHaveValue('#ff0000');

      await setControl(page, '#cap-box-outline-width', '0');
      expect(tally(await renderedPicture(page), 0, 6).red).toBe(0);
    });
  });
}

test('resizing a moving caption keeps its corner on this frame and its path shape', async ({ page }) => {
  await openWithCaption(page, EDITORS[0]);
  await placeCaption(page, 'WWWW');
  await page.evaluate(() => {
    GC.state.captions[0].motion = [{ frame: 0, x: 0.5, y: 0.25 }, { frame: 1, x: 0.6, y: 0.3 }];
    GC.seekFrame(0);
  });
  const before = await captionCorners(page);
  await dragHandle(page, 'corner', 3, -30, -20);
  expectSamePoint((await captionCorners(page))[0], before[0]);
  const [k0, k1] = await page.evaluate(() => GC.state.captions[0].motion);
  expect(k1.x - k0.x).toBeCloseTo(0.1, 6);
  expect(k1.y - k0.y).toBeCloseTo(0.05, 6);
});
