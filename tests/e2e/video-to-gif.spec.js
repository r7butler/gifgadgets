// @ts-check
const { test, expect } = require("@playwright/test");
const path = require("path");

const FIXTURES = path.join(__dirname, "fixtures");

test.describe("Video to GIF", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/video-to-gif/edit/");
  });

  test("upload screen visible on load", async ({ page }) => {
    await expect(page.locator("#upload-screen")).toBeVisible();
    await expect(page.locator("#file-input")).toBeAttached();
  });

  test("upload MP4 shows editor screen", async ({ page }) => {
    const fileInput = page.locator("#file-input");
    await fileInput.setInputFiles(path.join(FIXTURES, "test.mp4"));

    await expect(page.locator("#editor-screen")).toBeVisible({ timeout: 10_000 });
  });

  test("video preview loads after upload", async ({ page }) => {
    const fileInput = page.locator("#file-input");
    await fileInput.setInputFiles(path.join(FIXTURES, "test.mp4"));

    const video = page.locator("#preview-video");
    await expect(video).toBeVisible({ timeout: 10_000 });
  });

  test("convert button is present", async ({ page }) => {
    const fileInput = page.locator("#file-input");
    await fileInput.setInputFiles(path.join(FIXTURES, "test.mp4"));
    await expect(page.locator("#editor-screen")).toBeVisible({ timeout: 10_000 });

    const convertBtn = page.locator("#btn-convert");
    await expect(convertBtn).toBeVisible();
  });

  test("FPS slider adjusts value", async ({ page }) => {
    const fileInput = page.locator("#file-input");
    await fileInput.setInputFiles(path.join(FIXTURES, "test.mp4"));
    await expect(page.locator("#editor-screen")).toBeVisible({ timeout: 10_000 });

    const slider = page.locator("#sl-fps");
    await slider.fill("15");
    const display = page.locator("#val-fps");
    await expect(display).toHaveText("15");
  });

  test("maximum clip length reflects the 500-frame limit", async ({ page }) => {
    const fileInput = page.locator("#file-input");
    await fileInput.setInputFiles(path.join(FIXTURES, "test.mp4"));
    await expect(page.locator("#editor-screen")).toBeVisible({ timeout: 10_000 });

    await page.locator("#sl-fps").fill("10");
    await expect(page.locator("#max-length-hint")).toHaveText("(Max length: 50s)");
  });
});

test("encodes exactly 500 frames into a readable GIF", async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto("/video-to-gif/edit/");
  await page.getByRole("button", { name: "Reject", exact: true }).click();
  await page.locator("#file-input").setInputFiles(path.join(FIXTURES, "video-500-frames.mp4"));
  await expect(page.locator("#editor-screen")).toBeVisible();
  await expect(page.locator("#btn-convert")).toBeEnabled({ timeout: 15_000 });
  await page.locator("#sl-fps").fill("10");
  await page.locator("#inp-out").fill("0:50.0");
  await page.locator("#inp-out").dispatchEvent("change");
  await expect(page.locator("#memory-estimate")).toContainText("500 frames");
  await page.locator("#btn-convert").click();
  await expect(page.locator("#result-gif")).toBeVisible({ timeout: 150_000 });
  const bytes = await page.locator("#result-gif").evaluate(async img =>
    Array.from(new Uint8Array(await (await fetch(img.src)).arrayBuffer())));
  const { GifReader } = require("../../frontend/vendor/omggif.js");
  const reader = new GifReader(Buffer.from(bytes));
  // A frame identical to the one before is stored once and held for both, so
  // the GIF can have fewer frames than were captured, but plays all 500.
  let length = 0;
  for (let i = 0; i < reader.numFrames(); i++) length += reader.frameInfo(i).delay;
  expect(length).toBe(500 * 10);
  expect(reader.numFrames()).toBeLessThanOrEqual(500);
  expect(reader.width).toBe(120);
  expect(reader.height).toBe(80);
  // Each frame stores what changed, so the last is shown by drawing them in turn.
  const pixels = new Uint8Array(reader.width * reader.height * 4);
  for (let i = 0; i < reader.numFrames(); i++) reader.decodeAndBlitFrameRGBA(i, pixels);
  expect(pixels.some(value => value !== 0)).toBe(true);
});

test("warns before a large conversion and reduces portrait memory by output size", async ({ page }) => {
  await page.goto("/video-to-gif/edit/");
  await page.getByRole("button", { name: "Reject", exact: true }).click();
  await page.locator("#file-input").setInputFiles(path.join(FIXTURES, "video-500-frames.mp4"));
  await expect(page.locator("#editor-screen")).toBeVisible();
  await expect(page.locator("#btn-convert")).toBeEnabled({ timeout: 15_000 });
  // Simulate portrait metadata without allocating a large video in this UI test.
  await page.locator("#preview-video").evaluate(video => {
    Object.defineProperty(video, "videoWidth", { value: 1080 });
    Object.defineProperty(video, "videoHeight", { value: 1920 });
  });
  await page.locator("#sl-fps").fill("10");
  await page.locator("#inp-out").fill("0:50.0");
  await page.locator("#inp-out").dispatchEvent("change");
  await page.locator("#sl-width").fill("480");
  await expect(page.locator("#memory-estimate")).toContainText("780.9 MiB");
  await expect(page.locator("#memory-warning")).toBeVisible();
  await page.locator("#btn-convert").click();
  const memoryModal = page.locator("#memory-modal");
  await expect(memoryModal).toBeVisible();
  await expect(memoryModal).toContainText("Reducing output size is recommended.");
  await page.keyboard.press("Escape");
  await expect(memoryModal).toBeHidden();
  await expect(page.locator("#btn-convert")).toBeFocused();
  await expect(page.locator("#loading-overlay")).toBeHidden();
  await page.locator("#btn-reduce-size").click();
  await expect(page.locator("#sl-width")).toHaveValue("240");
  await expect(page.locator("#memory-estimate")).toContainText("195.5 MiB");
  await expect(page.locator("#memory-warning")).toBeHidden();
  await page.locator("#chk-crop").check();
  await page.locator("#crop-w").fill("120");
  await page.locator("#crop-w").dispatchEvent("change");
  await page.locator("#crop-h").fill("80");
  await page.locator("#crop-h").dispatchEvent("change");
  await expect(page.locator("#memory-estimate")).toContainText("120×80");
});

for (const reduce of [false, true]) {
  test(`memory modal continues with ${reduce ? "reduced" : "original"} dimensions`, async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('gc_cookie_consent', 'rejected'));
    // Lower only the advisory threshold so both real encoding paths can be
    // exercised with a small fixture instead of allocating hundreds of MiB.
    await page.route('**/video-to-gif/edit/', async route => {
      const response = await route.fetch();
      const body = (await response.text()).replace(
        'var RAW_MEMORY_WARNING = 256 * 1024 * 1024;',
        'var RAW_MEMORY_WARNING = 1 * 1024 * 1024;');
      await route.fulfill({ response, body });
    });
    const nativeDialogs = [];
    page.on('dialog', async dialog => { nativeDialogs.push(dialog.message()); await dialog.dismiss(); });
    await page.goto('/video-to-gif/edit/');
    await page.locator('#file-input').setInputFiles(path.join(FIXTURES, 'video-memory-choice.mp4'));
    await expect(page.locator('#editor-screen')).toBeVisible();
    await expect(page.locator('#btn-convert')).toBeEnabled();
    await page.locator('#sl-fps').fill('10');
    await page.locator('#btn-convert').click();
    const modal = page.locator('#memory-modal');
    await expect(modal).toBeVisible();
    await expect(page.locator('#loading-overlay')).toBeHidden();
    // Both long button labels must fit a phone-sized viewport.
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await modal.evaluate(el => el.scrollWidth <= innerWidth)).toBe(true);
    await modal.getByRole('button', {
      name: reduce ? 'Continue with reduced output size' : 'Continue as is',
      exact: true
    }).click();
    await expect(modal).toBeHidden();
    await expect(page.locator('#result-gif')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('#sl-width')).toHaveValue(reduce ? '240' : '480');
    const bytes = await page.locator('#result-gif').evaluate(async img =>
      Array.from(new Uint8Array(await (await fetch(img.src)).arrayBuffer())));
    const { GifReader } = require('../../frontend/vendor/omggif.js');
    const reader = new GifReader(Buffer.from(bytes));
    expect([reader.width, reader.height]).toEqual(reduce ? [240, 160] : [480, 320]);
    expect(reader.numFrames()).toBeGreaterThan(0);
    expect(nativeDialogs).toEqual([]);
  });
}
