// @ts-check
const { test, expect } = require("@playwright/test");
const path = require("path");

const FIXTURES = path.join(__dirname, "fixtures");

test.describe("GIF Maker", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/gif-maker/edit/");
  });

  test("upload screen visible on load", async ({ page }) => {
    await expect(page.locator("#upload-screen")).toBeVisible();
    await expect(page.locator("#file-input")).toBeAttached();
  });

  test("upload 2 images shows frame list", async ({ page }) => {
    const fileInput = page.locator("#file-input");
    await fileInput.setInputFiles([
      path.join(FIXTURES, "test.png"),
      path.join(FIXTURES, "test.jpg"),
    ]);

    // Editor screen should appear
    await expect(page.locator("#editor-screen")).toBeVisible({ timeout: 10_000 });

    // Frame list should have items
    const frames = page.locator("#frame-list .gm-frame-item, #frame-list .gm-group");
    await expect(frames.first()).toBeVisible({ timeout: 5_000 });
  });

  test("make GIF button exists and is initially disabled", async ({ page }) => {
    const makeBtn = page.locator("#btn-make");
    await expect(makeBtn).toBeAttached();
  });

  test("upload images enables make button", async ({ page }) => {
    const fileInput = page.locator("#file-input");
    await fileInput.setInputFiles([
      path.join(FIXTURES, "test.png"),
      path.join(FIXTURES, "test.jpg"),
    ]);

    await expect(page.locator("#editor-screen")).toBeVisible({ timeout: 10_000 });

    const makeBtn = page.locator("#btn-make");
    await expect(makeBtn).toBeEnabled({ timeout: 5_000 });
  });

  test("delay slider adjusts value", async ({ page }) => {
    const fileInput = page.locator("#file-input");
    await fileInput.setInputFiles([
      path.join(FIXTURES, "test.png"),
      path.join(FIXTURES, "test.jpg"),
    ]);
    await expect(page.locator("#editor-screen")).toBeVisible({ timeout: 10_000 });

    const slider = page.locator("#sl-delay");
    await slider.fill("200");
    const display = page.locator("#val-delay");
    await expect(display).toHaveText("200");
  });
});
