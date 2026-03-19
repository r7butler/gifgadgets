// @ts-check
const { test, expect } = require("@playwright/test");
const path = require("path");

const FIXTURES = path.join(__dirname, "fixtures");

test.describe("GIF Editor", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/gif-editor/edit/");
  });

  test("upload zone is visible on load", async ({ page }) => {
    await expect(page.locator("#upload-zone")).toBeVisible();
    await expect(page.locator("#file-input")).toBeAttached();
  });

  test("upload GIF shows canvas", async ({ page }) => {
    const fileInput = page.locator("#file-input");
    await fileInput.setInputFiles(path.join(FIXTURES, "test.gif"));

    const canvas = page.locator("#preview-canvas");
    await expect(canvas).toBeVisible({ timeout: 10_000 });
  });

  test("add caption button creates a caption entry", async ({ page }) => {
    const fileInput = page.locator("#file-input");
    await fileInput.setInputFiles(path.join(FIXTURES, "test.gif"));
    await expect(page.locator("#preview-canvas")).toBeVisible({ timeout: 10_000 });

    // Open sidebar if collapsed
    const sidebarToggle = page.locator("#sidebar-toggle");
    if (await sidebarToggle.isVisible()) {
      await sidebarToggle.click();
    }

    // Expand on-image caption section if collapsed
    const captionToggle = page.locator("#on-image-caption-toggle");
    if (await captionToggle.isVisible()) {
      await captionToggle.click();
    }

    const addBtn = page.locator("#btn-add-caption");
    await addBtn.click();

    // Caption editor should appear
    await expect(page.locator("#caption-editor")).toBeVisible();
  });

  test("download button is in header", async ({ page }) => {
    const downloadBtn = page.locator("#btn-download");
    await expect(downloadBtn).toBeAttached();
  });

  test("share button is in header", async ({ page }) => {
    const shareBtn = page.locator("#btn-share");
    await expect(shareBtn).toBeAttached();
  });
});
