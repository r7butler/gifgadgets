// @ts-check
const { test, expect } = require("@playwright/test");
const path = require("path");

const FIXTURES = path.join(__dirname, "fixtures");

test.describe("Image Editor", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/image-editor/edit/");
  });

  test("upload zone visible on load", async ({ page }) => {
    await expect(page.locator("#upload-zone")).toBeVisible();
    await expect(page.locator("#file-input")).toBeAttached();
  });

  test("upload JPG shows canvas", async ({ page }) => {
    const fileInput = page.locator("#file-input");
    await fileInput.setInputFiles(path.join(FIXTURES, "test.jpg"));

    const canvas = page.locator("#preview-canvas");
    await expect(canvas).toBeVisible({ timeout: 10_000 });
  });

  test("upload PNG shows canvas", async ({ page }) => {
    const fileInput = page.locator("#file-input");
    await fileInput.setInputFiles(path.join(FIXTURES, "test.png"));

    const canvas = page.locator("#preview-canvas");
    await expect(canvas).toBeVisible({ timeout: 10_000 });
  });

  test("download button is in header", async ({ page }) => {
    const downloadBtn = page.locator("#btn-download");
    await expect(downloadBtn).toBeAttached();
  });

  test("export format selector exists", async ({ page }) => {
    const fileInput = page.locator("#file-input");
    await fileInput.setInputFiles(path.join(FIXTURES, "test.jpg"));
    await expect(page.locator("#preview-canvas")).toBeVisible({ timeout: 10_000 });

    const formatSelect = page.locator("#sel-export-format");
    await expect(formatSelect).toBeAttached();
  });
});
