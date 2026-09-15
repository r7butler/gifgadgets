const { test, expect } = require('@playwright/test');
const path = require('path');
const fixture = path.join(__dirname, 'fixtures/test.gif');

async function openEditor(page, options = {}) {
  if (!options.analytics) await page.addInitScript(() => localStorage.setItem('gc_cookie_consent', 'rejected'));
  await page.goto('/gif-editor/edit/');
  await page.locator('#file-input').setInputFiles(fixture);
  await expect(page.locator('#editor-workspace')).toBeVisible();
}

test('dialog focus, Tab, Escape and Space preserve keyboard operation', async ({ page }) => {
  await openEditor(page);
  await page.locator('#btn-share').click();
  const modal = page.locator('#share-consent-modal');
  await expect(modal).toBeVisible();
  expect(await page.evaluate(() => document.querySelector('#share-consent-modal').contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Shift+Tab');
  expect(await page.evaluate(() => document.querySelector('#share-consent-modal').contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(modal).toBeHidden();
  await expect(page.locator('#btn-share')).toBeFocused();
  await page.keyboard.press('Space');
  await expect(modal).toBeVisible();
  expect(await page.evaluate(() => GC.state.isPlaying)).toBe(false);
});

test('draft restores captions, timing, crop and pixel edits; New clears it', async ({ page }) => {
  await openEditor(page);
  expect(await page.evaluate(() => GC.hasUnsavedDraft())).toBe(false);
  await page.locator('#on-image-caption-toggle').click();
  await page.locator('#btn-add-caption').click();
  await page.evaluate(() => {
    GC.state.captions[0].text = 'Recover me';
    GC.state.captions[0].motion = [{ frame: 0, x: 0.2, y: 0.4 }];
    GC.state.cropActive = true;
    GC.state.cropRect = { x: 0, y: 0, w: 5, h: 5 };
    GC.state.adjustments.brightness = 12;
    const original = GC.state.frames[0].imageData;
    GC.state.frames[0].imageData = new ImageData(new Uint8ClampedArray(original.data), original.width, original.height);
    GC.state.frames[0].imageData.data[0] = 123;
  });
  await expect.poll(async () => {
    await page.evaluate(() => GC.saveDraft());
    return page.evaluate(() => GC.hasUnsavedDraft());
  }).toBe(false);
  await page.reload();
  await expect(page.locator('#draft-restore-modal')).toBeVisible();
  await page.locator('#draft-restore').click();
  await expect(page.locator('#editor-workspace')).toBeVisible();
  const state = await page.evaluate(() => ({ text: GC.state.captions[0].text, motion: GC.state.captions[0].motion,
    pixel: GC.state.frames[0].imageData.data[0], crop: GC.state.cropRect, dirty: GC.hasUnsavedDraft(), brightness: document.querySelector('#adj-brightness')?.value }));
  expect(state.text).toBe('Recover me');
  expect(state.motion[0].x).toBe(0.2);
  expect(state.crop.w).toBe(5);
  expect(state.pixel).toBe(123);
  expect(state.dirty).toBe(false);
  await page.locator('#btn-new').click();
  await page.locator('[data-confirm-accept]').click();
  await expect(page.locator('#upload-zone')).toBeVisible();
  await page.reload();
  await expect(page.locator('#draft-restore-modal')).toHaveCount(0);
});

test('unavailable draft storage never blocks editing; warns only after edits', async ({ page }) => {
  await page.addInitScript(() => {
    const open = indexedDB.open.bind(indexedDB);
    indexedDB.open = function (name, version) {
      if (name === 'gifwidgets_editor_drafts') throw new Error('Storage unavailable');
      return open(name, version);
    };
  });
  await openEditor(page);
  expect(await page.evaluate(() => GC.hasUnsavedDraft())).toBe(false);
  await page.locator('#on-image-caption-toggle').click();
  await page.locator('#btn-add-caption').click();
  expect(await page.evaluate(() => GC.hasUnsavedDraft())).toBe(true);
  const prevented = await page.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event); return event.defaultPrevented;
  });
  expect(prevented).toBe(true);
});

test('worker and yielding fallback preserve GIF disposal and timing', async ({ page }) => {
  await openEditor(page);
  const result = await page.evaluate(async () => {
    const bytes = new Uint8Array(10000);
    const writer = new GifWriter(bytes, 4, 4, { palette: [0x000000, 0xff0000, 0x00ff00, 0x0000ff] });
    writer.addFrame(0, 0, 4, 4, new Uint8Array(16).fill(1), { delay: 7, disposal: 1 });
    writer.addFrame(1, 1, 2, 2, new Uint8Array(4).fill(2), { delay: 3, disposal: 3 });
    writer.addFrame(0, 0, 1, 1, new Uint8Array([3]), { delay: 2, disposal: 2 });
    writer.addFrame(3, 3, 1, 1, new Uint8Array([2]), { delay: 9 });
    const buffer = bytes.slice(0, writer.end()).buffer;
    const worker = await GC.decodeGifBuffer(buffer);
    const fallback = await GC.decodeGifBuffer(buffer, false);
    GC.hideLoading();
    return { same: worker.every((frame, i) => frame.imageData.data.every((x, j) => x === fallback[i].imageData.data[j])),
      delays: worker.map(f => f.delay),
      restored: Array.from(worker[2].imageData.data.slice(20, 24)),
      cleared: Array.from(worker[3].imageData.data.slice(0, 4)) };
  });
  expect(result.same).toBe(true);
  expect(result.delays).toEqual([70, 30, 20, 90]);
  expect(result.restored).toEqual([255, 0, 0, 255]);
  expect(result.cleared).toEqual([0, 0, 0, 0]);
});

test('GIF exceeding the removed 128 MB budget loads without quality reduction', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Large memory regression runs once; compositing is checked in every browser.');
  await openEditor(page);
  const result = await page.evaluate(async () => {
    const bytes = new Uint8Array(4000000);
    const writer = new GifWriter(bytes, 1024, 1024, { palette: [0, 0xffffff] });
    const pixels = new Uint8Array(1024 * 1024);
    for (let i = 0; i < 34; i++) writer.addFrame(0, 0, 1024, 1024, pixels, { delay: 10 });
    let ticks = 0;
    const timer = setInterval(() => ticks++, 10);
    const frames = await GC.decodeGifBuffer(bytes.slice(0, writer.end()).buffer);
    GC.state.frames = frames; GC.state.width = 1024; GC.state.height = 1024;
    let writes = 0;
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === 'frames') writes++;
      return put.apply(this, args);
    };
    await GC.saveDraft();
    const mediaWrites = writes;
    GC.state.captions = [{ id: 'cap-1', text: 'Metadata-only save', motion: [] }];
    await GC.saveDraft();
    IDBObjectStore.prototype.put = put;
    clearInterval(timer); GC.hideLoading();
    return { count: frames.length, width: frames[0].imageData.width, ticks, mediaWrites, writes, unsaved: GC.hasUnsavedDraft() };
  });
  expect(result.count).toBe(34);
  expect(result.width).toBe(1024);
  expect(result.ticks).toBeGreaterThan(0);
  expect(result.mediaWrites).toBe(34);
  expect(result.writes).toBe(34);
  expect(result.unsaved).toBe(false);
});

test('analytics waits for choice, remembers rejection and can be changed', async ({ page }) => {
  let requests = 0;
  await page.route('https://www.googletagmanager.com/**', route => { requests++; return route.fulfill({ body: '' }); });
  await page.goto('/');
  await expect(page.locator('#cookie-consent')).toBeVisible();
  expect(requests).toBe(0);
  await page.locator('#cookie-reject').click();
  await page.reload();
  await expect(page.locator('#cookie-consent')).toHaveCount(0);
  expect(requests).toBe(0);
  await page.locator('#analytics-settings').click();
  await page.locator('#cookie-accept').click();
  await expect.poll(() => requests).toBe(1);
  await page.reload();
  await expect.poll(() => requests).toBe(2);
  await expect(page.locator('#cookie-consent')).toHaveCount(0);
});

test('an explicit new-file handoff takes precedence over a saved draft', async ({ page, browserName }) => {
  await openEditor(page);
  await page.locator('#on-image-caption-toggle').click();
  await page.locator('#btn-add-caption').click();
  await expect.poll(async () => { await page.evaluate(() => GC.saveDraft()); return page.evaluate(() => GC.hasUnsavedDraft()); }).toBe(false);
  if (browserName === 'webkit') {
    // This local WebKit build cannot persist Blob/File objects in IndexedDB.
    // Stub only that pre-existing handoff I/O; exercise real initialization,
    // draft precedence, FileReader and decoding with the same file bytes.
    const bytes = await page.locator('#file-input').evaluate(async input => Array.from(new Uint8Array(await input.files[0].arrayBuffer())));
    await page.addInitScript(bytes => {
      document.addEventListener('DOMContentLoaded', () => {
        GC.loadGifFromIndexedDB = () => GC.loadGifFromFile(new File([new Uint8Array(bytes)], 'test.gif', { type: 'image/gif' }));
      });
    }, bytes);
  } else {
  await page.evaluate(async () => {
    // Use an actual file-picker File, just as the landing-page handoff does.
    const file = document.querySelector('#file-input').files[0];
    await new Promise((resolve, reject) => {
      const request = indexedDB.open('gifwidgets', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('files');
      request.onsuccess = () => {
        const tx = request.result.transaction('files', 'readwrite');
        tx.objectStore('files').put(file, 'pending'); tx.oncomplete = resolve;
        tx.onerror = event => reject(new Error(event.target.error?.name + ': ' + event.target.error?.message));
      };
    });
  });
  }
  await page.goto('/gif-editor/edit/?source=local');
  await expect(page.locator('#editor-workspace')).toBeVisible();
  await expect(page.locator('#draft-restore-modal')).toHaveCount(0);
  expect(await page.evaluate(() => GC.state.gifFilename)).toBe('test.gif');
  expect(await page.evaluate(() => GC.state.captions.length)).toBe(0);
});

test('image draft restores export settings and can be discarded', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('gc_cookie_consent', 'rejected'));
  await page.goto('/image-editor/edit/');
  await page.locator('#file-input').setInputFiles(path.join(__dirname, 'fixtures/test.jpg'));
  await expect(page.locator('#editor-workspace')).toBeVisible();
  await page.evaluate(() => { GC.state.exportFormat = 'image/webp'; GC.state.exportQuality = 0.75; });
  await expect.poll(async () => { await page.evaluate(() => GC.saveDraft()); return page.evaluate(() => GC.hasUnsavedDraft()); }).toBe(false);
  await page.reload();
  await page.locator('#draft-restore').click();
  await expect(page.locator('#sel-export-format')).toHaveValue('image/webp');
  await expect(page.locator('#sl-export-quality')).toHaveValue('75');
  await page.reload();
  await page.locator('#draft-discard').click();
  await expect(page.locator('#draft-restore-modal')).toHaveCount(0);
  await expect(page.locator('#upload-zone')).toBeVisible();
  await page.reload();
  await expect(page.locator('#draft-restore-modal')).toHaveCount(0);
});

test('mobile analytics choices fit and remain accessible in the editor menu', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/gif-editor/edit/');
  await expect(page.locator('#cookie-consent')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('#cookie-reject').click();
  await page.getByRole('button', { name: 'Toggle editor menu' }).click();
  await page.locator('#analytics-settings').click();
  await expect(page.locator('#cookie-consent')).toBeVisible();
});
