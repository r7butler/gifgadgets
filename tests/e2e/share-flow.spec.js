// @ts-check
const { test, expect } = require("@playwright/test");
const path = require("path");

const FIXTURES = path.join(__dirname, "fixtures");

test.describe("Share Flow", () => {
  test("share button triggers share modal with mocked API", async ({ page }) => {
    // Mock the share presign + finalize endpoints
    await page.route("**/api/share/presign", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          upload_url: "https://s3.test.com/presigned-put",
          slug: "test-captioned-abc12345",
          title: "Test GIF",
          content_type: "image/gif",
        }),
      });
    });

    await page.route("**/api/share/finalize", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          slug: "test-captioned-abc12345",
          share_url: "https://gifwidgets.com/g/test-captioned-abc12345.html",
          gif_url: "https://cdn.gifwidgets.com/share/test-captioned-abc12345.gif",
        }),
      });
    });

    // Mock the presigned PUT (the actual S3 upload)
    await page.route("https://s3.test.com/**", async (route) => {
      await route.fulfill({ status: 200 });
    });

    // Mock the share endpoint (legacy base64 path)
    await page.route("**/api/share", async (route) => {
      const request = route.request();
      if (request.url().includes("/presign") || request.url().includes("/finalize")) {
        return; // Let the specific routes handle these
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          slug: "test-captioned-abc12345",
          share_url: "https://gifwidgets.com/g/test-captioned-abc12345.html",
          gif_url: "https://cdn.gifwidgets.com/share/test-captioned-abc12345.gif",
        }),
      });
    });

    await page.goto("/gif-editor/edit/");

    // Upload a GIF
    const fileInput = page.locator("#file-input");
    await fileInput.setInputFiles(path.join(FIXTURES, "test.gif"));
    await expect(page.locator("#preview-canvas")).toBeVisible({ timeout: 10_000 });

    // Click share button
    const shareBtn = page.locator("#btn-share");
    await shareBtn.click();

    // Share consent modal should appear (first step before sharing)
    await expect(page.locator("#share-consent-modal")).toBeVisible({ timeout: 10_000 });
  });

  test("GIF editor has share button in header", async ({ page }) => {
    await page.goto("/gif-editor/edit/");
    await expect(page.locator("#btn-share")).toBeAttached();
  });

  test("GIF maker has share button in header", async ({ page }) => {
    await page.goto("/gif-maker/edit/");
    await expect(page.locator("#btn-share")).toBeAttached();
  });
});
