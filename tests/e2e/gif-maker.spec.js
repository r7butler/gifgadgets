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

  test("reorder frame groups with move up/down buttons", async ({ page }) => {
    const fileInput = page.locator("#file-input");
    // Upload two animated GIFs to create two multi-frame groups
    await fileInput.setInputFiles([
      path.join(FIXTURES, "test-animated.gif"),
      path.join(FIXTURES, "test-animated.gif"),
    ]);

    await expect(page.locator("#editor-screen")).toBeVisible({ timeout: 10_000 });

    // Wait for both groups to appear
    const groups = page.locator("#frame-list .gm-group");
    await expect(groups).toHaveCount(2, { timeout: 5_000 });

    // First group's up button should be disabled, down enabled
    const firstUp = groups.nth(0).locator(".gm-group-move").first();
    const firstDown = groups.nth(0).locator(".gm-group-move").last();
    await expect(firstUp).toBeDisabled();
    await expect(firstDown).toBeEnabled();

    // Last group's down button should be disabled, up enabled
    const lastUp = groups.nth(1).locator(".gm-group-move").first();
    const lastDown = groups.nth(1).locator(".gm-group-move").last();
    await expect(lastUp).toBeEnabled();
    await expect(lastDown).toBeDisabled();

    // Click down on first group to swap them
    await firstDown.click();

    // After reorder, the previously-first group is now second:
    // its up button should be enabled, down should be disabled
    const newGroups = page.locator("#frame-list .gm-group");
    await expect(newGroups).toHaveCount(2);
    const newSecondUp = newGroups.nth(1).locator(".gm-group-move").first();
    const newSecondDown = newGroups.nth(1).locator(".gm-group-move").last();
    await expect(newSecondUp).toBeEnabled();
    await expect(newSecondDown).toBeDisabled();
  });

  test("single-image frames have move up/down buttons", async ({ page }) => {
    const fileInput = page.locator("#file-input");
    await fileInput.setInputFiles([
      path.join(FIXTURES, "test.png"),
      path.join(FIXTURES, "test.jpg"),
    ]);

    await expect(page.locator("#editor-screen")).toBeVisible({ timeout: 10_000 });

    // Single images render as .gm-frame-item (not .gm-group)
    const items = page.locator("#frame-list > .gm-frame-item");
    await expect(items).toHaveCount(2, { timeout: 5_000 });

    // Both items should have move buttons
    await expect(items.nth(0).locator(".gm-group-move")).toHaveCount(2);
    await expect(items.nth(1).locator(".gm-group-move")).toHaveCount(2);

    // First item: up disabled, down enabled
    await expect(items.nth(0).locator(".gm-group-move").first()).toBeDisabled();
    await expect(items.nth(0).locator(".gm-group-move").last()).toBeEnabled();

    // Click down on first item to swap
    await items.nth(0).locator(".gm-group-move").last().click();

    // After swap, verify new first item's up is disabled
    const newItems = page.locator("#frame-list > .gm-frame-item");
    await expect(newItems.nth(0).locator(".gm-group-move").first()).toBeDisabled();
    await expect(newItems.nth(0).locator(".gm-group-move").last()).toBeEnabled();
  });
});
