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

// The order a visitor reaches for them: text first, then images, then the rest.
const SECTIONS = {
  "/gif-editor/edit/": ["On-Image Captions", "Box Caption", "Image Overlays", "Background", "Adjustments", "Other Options"],
  "/add-text-to-gif/edit/": ["On-Image Captions", "Box Caption", "Image Overlays", "Background", "Other Options"],
  "/image-editor/edit/": ["On-Image Captions", "Box Caption", "Image Overlays", "Adjustments", "Other Options"],
  "/add-text-to-image/edit/": ["On-Image Captions", "Box Caption", "Other Options"],
};
for (const [editor, sections] of Object.entries(SECTIONS)) {
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    test(`${editor} lists its sections in order (${viewport.width}px)`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto(editor);
      await page.locator("#file-input").setInputFiles(path.join(FIXTURES, editor.includes("image") ? "test.png" : "test.gif"));
      await expect(page.locator("#editor-workspace")).toBeVisible();
      await expect(page.locator(".sidebar-section > .section-toggle:visible")).toHaveText(sections);
    });
  }
}

test("on a phone the timeline sits under the playback bar, once there is something to time", async ({ page }) => {
  // It used to come after every sidebar section, so dragging a caption's
  // timing scrolled the GIF out of view.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/gif-editor/edit/");
  await page.locator("#file-input").setInputFiles(path.join(FIXTURES, "test.gif"));
  await expect(page.locator("#editor-workspace")).toBeVisible();
  const timeline = page.locator("#editor-timeline");
  await expect(timeline).toBeHidden();

  await page.locator("#on-image-caption-toggle").click();
  await page.locator("#btn-add-caption").click();
  await expect(timeline).toBeVisible();
  const order = await page.evaluate(() => [".playback-controls", "#editor-timeline", "#editor-sidebar"]
    .map(selector => document.querySelector(selector).getBoundingClientRect()));
  expect(order[1].top).toBeGreaterThanOrEqual(order[0].bottom - 1);
  expect(order[2].top).toBeGreaterThanOrEqual(order[1].bottom - 1);
  // Opened, its track and the GIF fit on screen together.
  await page.locator("#timeline-toggle").click();
  await page.locator("#timeline svg").scrollIntoViewIfNeeded();
  await expect(page.locator("#timeline svg")).toBeInViewport({ ratio: 1 });
  await expect(page.locator("#preview-canvas")).toBeInViewport({ ratio: 1 });

  // Deleting the only caption hides it again; an image overlay brings it back.
  await page.locator("#btn-delete-caption").click();
  await page.locator("#delete-modal-confirm").click();
  await expect(timeline).toBeHidden();
  await page.locator("#overlay-toggle").click();
  await page.locator("#overlay-file-input").setInputFiles(path.join(FIXTURES, "test.png"));
  await expect(timeline).toBeVisible();

  // Wider, it runs along the bottom again, and shows even with nothing to time.
  await page.locator("#btn-delete-overlay").click();
  await expect.poll(() => page.evaluate(() => GC.state.overlays.length)).toBe(0);
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(timeline).toBeVisible();
  // The browser reports the wider screen after the resize, so wait for the move.
  await expect.poll(() => page.evaluate(() => document.querySelector("#editor-timeline").getBoundingClientRect().top -
    document.querySelector(".editor-main").getBoundingClientRect().bottom)).toBeGreaterThanOrEqual(-1);
});

test("the download dialog links to more GIF utilities in a new tab", async ({ page }) => {
  await page.goto("/gif-editor/edit/");
  await page.locator("#file-input").setInputFiles(path.join(FIXTURES, "test.gif"));
  await expect(page.locator("#editor-workspace")).toBeVisible();
  await page.locator("#btn-download").click();
  const explore = page.locator("#download-modal .explore-more:visible");
  await expect(explore).toBeVisible({ timeout: 30_000 });
  await expect(explore).toHaveText("Explore more GIF utilities");
  await expect(explore).toHaveAttribute("href", "/#gif-utilities");
  await expect(explore).toHaveAttribute("target", "_blank");
});

test("an exported frame is an image, so its dialog links to the image utilities", async ({ page }) => {
  await page.goto("/gif-editor/edit/");
  await page.locator("#file-input").setInputFiles(path.join(FIXTURES, "test.gif"));
  await expect(page.locator("#editor-workspace")).toBeVisible();
  await page.evaluate(() => GC.pause());
  await page.locator("#btn-save-frame").click();
  const explore = page.locator("#download-modal .explore-more:visible");
  await expect(page.locator("#download-modal .modal-title")).toHaveText("Frame exported!");
  await expect(explore).toHaveText("Explore more image utilities");
  await expect(explore).toHaveAttribute("href", "/#image-tools");

  // A GIF from the same dialog goes back to the GIF utilities.
  await page.locator("#download-modal-close").click();
  await page.locator("#btn-download").click();
  await expect(page.locator("#download-modal .modal-title")).toHaveText("Your GIF is ready!", { timeout: 30_000 });
  await expect(explore).toHaveText("Explore more GIF utilities");
});
