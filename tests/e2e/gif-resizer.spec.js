// @ts-check
const { test, expect } = require("@playwright/test");
const path = require("path");

const FIXTURES = path.join(__dirname, "fixtures");

test.describe("GIF Resizer", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/gif-resizer/edit/");
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

  test("canvas renders after upload", async ({ page }) => {
    const fileInput = page.locator("#file-input");
    await fileInput.setInputFiles(path.join(FIXTURES, "test.gif"));

    const canvas = page.locator("#preview-canvas");
    await expect(canvas).toBeVisible({ timeout: 10_000 });
  });

  test("resize controls are visible after upload", async ({ page }) => {
    const fileInput = page.locator("#file-input");
    await fileInput.setInputFiles(path.join(FIXTURES, "test.gif"));
    await expect(page.locator("#editor-screen")).toBeVisible({ timeout: 10_000 });

    await expect(page.locator("#inp-width")).toBeVisible();
    await expect(page.locator("#inp-height")).toBeVisible();
    await expect(page.locator("#btn-resize")).toBeVisible();
  });

  test("aspect ratio lock is checked by default", async ({ page }) => {
    const fileInput = page.locator("#file-input");
    await fileInput.setInputFiles(path.join(FIXTURES, "test.gif"));
    await expect(page.locator("#editor-screen")).toBeVisible({ timeout: 10_000 });

    const lockCheckbox = page.locator("#chk-lock");
    await expect(lockCheckbox).toBeChecked();
  });
});
