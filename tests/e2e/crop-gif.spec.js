// @ts-check
const { test, expect } = require("@playwright/test");
const path = require("path");

const FIXTURES = path.join(__dirname, "fixtures");

test.describe("Crop GIF", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/crop-gif/edit/");
  });

  test("upload screen visible on load", async ({ page }) => {
    await expect(page.locator("#upload-screen")).toBeVisible();
    await expect(page.locator("#file-input")).toBeAttached();
  });

  test("upload GIF shows editor screen", async ({ page }) => {
    const fileInput = page.locator("#file-input");
    await fileInput.setInputFiles(path.join(FIXTURES, "test.gif"));

    await expect(page.locator("#editor-screen")).toBeVisible({ timeout: 10_000 });
  });

  test("canvas and crop overlay render after upload", async ({ page }) => {
    const fileInput = page.locator("#file-input");
    await fileInput.setInputFiles(path.join(FIXTURES, "test.gif"));

    await expect(page.locator("#preview-canvas")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("#crop-overlay")).toBeAttached();
  });

  test("crop controls are visible after upload", async ({ page }) => {
    const fileInput = page.locator("#file-input");
    await fileInput.setInputFiles(path.join(FIXTURES, "test.gif"));
    await expect(page.locator("#editor-screen")).toBeVisible({ timeout: 10_000 });

    await expect(page.locator("#inp-x")).toBeVisible();
    await expect(page.locator("#inp-y")).toBeVisible();
    await expect(page.locator("#inp-w")).toBeVisible();
    await expect(page.locator("#inp-h")).toBeVisible();
    await expect(page.locator("#btn-crop")).toBeVisible();
  });

  test("reset crop button exists", async ({ page }) => {
    const fileInput = page.locator("#file-input");
    await fileInput.setInputFiles(path.join(FIXTURES, "test.gif"));
    await expect(page.locator("#editor-screen")).toBeVisible({ timeout: 10_000 });

    await expect(page.locator("#btn-reset-crop")).toBeVisible();
  });
});
