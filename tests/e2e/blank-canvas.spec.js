const { test, expect } = require('@playwright/test');

// Tiny local images keep these tests independent of fixtures and remote hosts.
async function photo(page, color, name = 'panel.png') {
  const url = await page.evaluate(color => {
    const c = document.createElement('canvas'); c.width = 80; c.height = 40;
    const ctx = c.getContext('2d'); ctx.fillStyle = color; ctx.fillRect(0, 0, 80, 40);
    return c.toDataURL('image/png');
  }, color);
  return { name, mimeType: 'image/png', buffer: Buffer.from(url.split(',')[1], 'base64') };
}

async function openCanvas(page, tool, width = 600, height = 800) {
  await page.goto(`/${tool}/edit/#blank-canvas`);
  await expect(page.locator('#blank-canvas')).toHaveJSProperty('open', true);
  await page.locator('#blank-canvas-width').fill(String(width));
  await page.locator('#blank-canvas-height').fill(String(height));
  await page.locator('#btn-create-blank-canvas').click();
  await expect(page.locator('#editor-workspace')).toBeVisible();
}

async function exportedPixels(page) {
  return page.evaluate(() => new Promise((resolve, reject) => {
    GC.exportImage({ onBlob: async (blob, filename) => {
      try {
        const img = await createImageBitmap(blob);
        const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
        const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0); img.close();
        resolve({ width: c.width, height: c.height, type: blob.type, filename,
          corner: Array.from(ctx.getImageData(0, 0, 1, 1).data),
          panel: Array.from(ctx.getImageData(Math.floor(c.width / 2), Math.floor(c.height * .65), 1, 1).data) });
      } catch (err) { reject(err); }
    }});
  }));
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.addInitScript(() => localStorage.setItem('gc_cookie_consent', 'rejected'));
});

for (const tool of ['image-editor', 'add-text-to-image']) {
  test(`${tool}: landing blank link, two photos, draggable text, PNG export`, async ({ page }) => {
    await page.goto(`/${tool}/`);
    await page.locator('#blank-canvas-cta').click();
    await expect(page).toHaveURL(new RegExp(`/${tool}/edit/#blank-canvas$`));
    await expect(page.locator('#blank-canvas')).toHaveJSProperty('open', true);
    await page.locator('#blank-canvas-width').fill('600');
    await page.locator('#blank-canvas-height').fill('800');
    await page.locator('#btn-create-blank-canvas').click();
    await expect(page.locator('#editor-workspace')).toBeVisible();
    expect(await page.evaluate(() => ({ frames: GC.state.frames.length,
      still: GC.state.isStillImage, captions: GC.state.captions.length,
      pixel: Array.from(GC.state.frames[0].imageData.data.slice(0, 4)) })))
      .toEqual({ frames: 1, still: true, captions: 0, pixel: [255, 255, 255, 255] });
    await expect(page.locator('#btn-add-overlay')).toBeVisible();
    await page.locator('#overlay-file-input').setInputFiles(await photo(page, '#ff0000', 'first.png'));
    await expect.poll(() => page.evaluate(() => GC.state.overlays.length)).toBe(1);
    await page.locator('#overlay-file-input').setInputFiles(await photo(page, '#0000ff', 'second.png'));
    await expect.poll(() => page.evaluate(() => GC.state.overlays.length)).toBe(2);

    const bounds = await page.locator('#preview-canvas').boundingBox();
    // New overlays start at (0.1, 0.1). Move the selected second photo down.
    await page.mouse.move(bounds.x + bounds.width * .1, bounds.y + bounds.height * .1);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width * .5, bounds.y + bounds.height * .65, { steps: 8 });
    await page.mouse.up();
    expect(await page.evaluate(() => GC.state.overlays[1].y)).toBeCloseTo(.65, 1);
    await page.locator('#btn-add-caption').click();
    await page.locator('#cap-text').fill('First panel');
    await page.locator('#btn-add-caption').click();
    await page.locator('#cap-text').fill('Second panel');
    // Move the selected caption to the space between the two photos.
    const start = await page.evaluate(() => {
      const cap = GC.findCaption(GC.state.selectedCaptionId);
      return { x: cap.x, y: cap.y };
    });
    await page.mouse.move(bounds.x + bounds.width * start.x, bounds.y + bounds.height * start.y);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width * .5, bounds.y + bounds.height * .45, { steps: 8 });
    await page.mouse.up();
    expect(await page.evaluate(() => GC.state.captions[1].y)).toBeCloseTo(.45, 1);
    const output = await exportedPixels(page);
    expect(output).toMatchObject({ width: 600, height: 800, type: 'image/png',
      corner: [255, 255, 255, 255], panel: [0, 0, 255, 255] });
    expect(output.filename).toMatch(/blank-canvas.*\.png$/);
    await page.locator('#btn-download').click();
    await expect(page.locator('#download-modal')).toBeVisible();
  });

  test(`${tool}: presets, custom background, validation, and transparency`, async ({ page }) => {
    await page.goto(`/${tool}/edit/#blank-canvas`);
    await page.locator('#blank-canvas-preset').selectOption('1080x1920');
    await expect(page.locator('#blank-canvas-height')).toHaveValue('1920');
    await page.locator('#blank-canvas-width').fill('0');
    await page.locator('#btn-create-blank-canvas').click();
    expect(await page.evaluate(() => GC.state.frames.length)).toBe(0);
    await page.locator('#blank-canvas-width').fill('4097');
    expect(await page.locator('#blank-canvas-width').evaluate(el => el.checkValidity())).toBe(false);
    expect(await page.evaluate(() => {
      try { GC.createBlankCanvas({ width: 4097, height: 10 }); return false; }
      catch (_) { return GC.state.frames.length === 0; }
    })).toBe(true);
    await page.locator('#blank-canvas-width').fill('320');
    await page.locator('#blank-canvas-height').fill('480');
    await expect(page.locator('#blank-canvas-preset')).toHaveValue('custom');
    await page.locator('#blank-canvas-color').fill('#12ab34');
    await page.locator('#btn-create-blank-canvas').click();
    expect((await exportedPixels(page)).corner).toEqual([18, 171, 52, 255]);
    await page.locator('#btn-new').click();
    await page.locator('[data-confirm-accept]').click();
    await expect(page.locator('#upload-zone')).toBeVisible();
    await page.locator('#blank-canvas-transparent').check();
    await expect(page.locator('#blank-canvas-color')).toBeDisabled();
    await page.locator('#btn-create-blank-canvas').click();
    expect((await exportedPixels(page)).corner).toEqual([0, 0, 0, 0]);
  });

  test(`${tool}: New clears layers and box bars; normal photo upload still works`, async ({ page }) => {
    await openCanvas(page, tool);
    await page.locator('#btn-add-caption').click();
    await page.locator('#overlay-file-input').setInputFiles(await photo(page, '#00ff00'));
    await expect.poll(() => page.evaluate(() => GC.state.overlays.length)).toBe(1);
    await page.locator('#box-caption-toggle').click();
    await page.locator('#btn-add-box-top').click();
    await page.locator('#btn-new').click();
    await page.locator('[data-confirm-accept]').click();
    await expect(page.locator('#upload-zone')).toBeVisible();
    await page.locator('#blank-canvas-width').fill('300');
    await page.locator('#btn-create-blank-canvas').click();
    expect(await page.evaluate(() => ({ captions: GC.state.captions.length,
      overlays: GC.state.overlays.length, top: GC.state.boxCaptionTop,
      width: GC.canvas.width, height: GC.canvas.height })))
      .toEqual({ captions: 0, overlays: 0, top: null, width: 300, height: 800 });
    await page.locator('#btn-new').click();
    await page.locator('[data-confirm-accept]').click();
    await expect(page.locator('#upload-zone')).toBeVisible();
    await page.locator('#file-input').setInputFiles(await photo(page, '#00ff00', 'uploaded.png'));
    await expect(page.locator('#editor-workspace')).toBeVisible();
    expect(await page.evaluate(() => [GC.state.width, GC.state.height, GC.state.gifFilename]))
      .toEqual([80, 40, 'uploaded.png']);
  });

  test(`${tool}: reload restores a blank composition with editable layers`, async ({ page }) => {
    await openCanvas(page, tool, 400, 600);
    await page.locator('#btn-add-caption').click();
    await page.locator('#cap-text').fill('Keep this caption');
    await page.locator('#overlay-file-input').setInputFiles(await photo(page, '#0000ff'));
    await expect.poll(() => page.evaluate(() => GC.state.overlays.length)).toBe(1);
    await page.waitForFunction(() => !GC.hasUnsavedDraft());
    await page.reload();
    await page.locator('#draft-restore').click();
    await expect(page.locator('#editor-workspace')).toBeVisible();
    expect(await page.evaluate(() => ({ width: GC.state.width, height: GC.state.height,
      text: GC.state.captions[0].text, photos: GC.state.overlays.length, format: GC.state.exportFormat })))
      .toEqual({ width: 400, height: 600, text: 'Keep this caption', photos: 1, format: 'image/png' });
  });

  test(`${tool}: mobile canvas controls fit without horizontal overflow`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 667 });
    await page.goto(`/${tool}/edit/#blank-canvas`);
    await expect(page.locator('#btn-create-blank-canvas')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.locator('#btn-create-blank-canvas').click();
    await expect(page.locator('#btn-add-overlay')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
}
