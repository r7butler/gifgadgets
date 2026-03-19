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
});
