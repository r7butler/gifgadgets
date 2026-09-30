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

test.describe("Homepage demo", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("gc_cookie_consent", "rejected"));
  });

  const clip = variant => `.home-demo-video[data-variant="${variant}"]`;
  const paused = (page, variant) => page.locator(clip(variant)).evaluate(v => v.paused);

  test("shows real exports and opens the same sample in the editor", async ({ page }) => {
    await page.goto("/");
    for (const video of await page.locator(".home-demo-video").all()) {
      const urls = [await video.getAttribute("poster"), ...(await video.locator("source").evaluateAll(s => s.map(e => e.getAttribute("src"))))];
      for (const url of urls) expect((await page.request.get(url)).status(), url).toBe(200);
    }
    await page.locator(".home-demo-cta").click();
    await expect(page).toHaveURL(/\/gif-editor\/edit\/\?sample=1$/);
    await expect(page.locator("#sample-bar")).toBeVisible();
  });

  test("plays while visible, and stays paused once the visitor pauses it", async ({ page }) => {
    await page.goto("/");
    const toggle = page.locator("#home-demo-toggle");
    await expect(page.locator(clip("day"))).toBeVisible();
    await expect.poll(() => paused(page, "day")).toBe(false);
    await expect(toggle).toHaveAttribute("aria-label", "Pause animation");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-label", "Play animation");
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(300);
    expect(await paused(page, "day")).toBe(true);
  });

  test("the dark theme swaps in the night clip and keeps it playing", async ({ page }) => {
    await page.goto("/");
    await expect.poll(() => paused(page, "day")).toBe(false);
    await page.locator("button.theme-toggle").click();
    await expect(page.locator(clip("night"))).toBeVisible();
    await expect(page.locator(clip("day"))).toBeHidden();
    await expect.poll(() => paused(page, "night")).toBe(false);
    expect(await paused(page, "day")).toBe(true);
  });

  test("waits for a press of play when reduced motion is requested", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    const toggle = page.locator("#home-demo-toggle");
    await expect(toggle).toHaveAttribute("aria-label", "Play animation");
    await page.waitForTimeout(500);
    expect(await paused(page, "day")).toBe(true);
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-label", "Pause animation");
  });
});

test.describe("Homepage discovery", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("gc_cookie_consent", "rejected"));
    await page.goto("/");
  });

  test("quick start links open real tool pages", async ({ page }) => {
    const links = page.locator(".home-quick-list a");
    expect(await links.count()).toBeGreaterThanOrEqual(4);
    for (const href of await links.evaluateAll(as => as.map(a => a.getAttribute("href")))) {
      expect((await page.request.get(href)).status(), href).toBe(200);
    }
  });

  test("category shortcuts land each section below the sticky nav", async ({ page }) => {
    const navHeight = await page.locator("nav.site-nav").evaluate(n => n.getBoundingClientRect().height);
    for (const chip of await page.locator(".home-jump-list a").all()) {
      const target = (await chip.getAttribute("href")).slice(1);
      await chip.click();
      await expect(page).toHaveURL(new RegExp("#" + target + "$"));
      const heading = page.locator(`#${target} h2`);
      await expect(heading).toBeInViewport();
      expect(await heading.evaluate(h => h.getBoundingClientRect().top)).toBeGreaterThanOrEqual(navHeight);
    }
  });

  test("the full directory stays under one heading per category", async ({ page }) => {
    await expect(page.locator("main h2.home-section-title")).toHaveText(["GIF Tools", "Image Tools", "Video Tools", "Photo Format Converters"]);
    expect(await page.locator("main a.tool-card").count()).toBeGreaterThanOrEqual(30);
  });

  test("phone layout never scrolls sideways", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 780 });
    await page.reload();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  });
});
