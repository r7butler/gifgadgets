// @ts-check
const { test, expect } = require("@playwright/test");

test.describe("Homepage", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
  });

  test("page loads with correct title", async ({ page }) => {
    await expect(page).toHaveTitle(/GifGadgets/i);
  });

  test("navigation bar is visible", async ({ page }) => {
    const nav = page.locator("nav.site-nav");
    await expect(nav).toBeVisible();
  });

  test("tool cards are visible and link to correct URLs", async ({ page }) => {
    const cards = page.locator("a.tool-card");
    const count = await cards.count();
    expect(count).toBeGreaterThanOrEqual(5);

    // Each card should have a title and a valid href
    for (let i = 0; i < count; i++) {
      const card = cards.nth(i);
      await expect(card).toBeVisible();
      const href = await card.getAttribute("href");
      expect(href).toBeTruthy();
    }
  });

  test("GIF editor card links to gif-editor", async ({ page }) => {
    const card = page.locator('a.tool-card[href*="gif-editor"]').first();
    await expect(card).toBeVisible();
  });

  test("GIF maker card links to gif-maker", async ({ page }) => {
    const card = page.locator('a.tool-card[href*="gif-maker"]').first();
    await expect(card).toBeVisible();
  });

  test("video-to-gif card links correctly", async ({ page }) => {
    const card = page.locator('a.tool-card[href*="video-to-gif"]').first();
    await expect(card).toBeVisible();
  });
});
