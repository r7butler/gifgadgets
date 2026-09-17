// @ts-check
const { test, expect } = require("@playwright/test");
const path = require("path");

const FIXTURES = path.join(__dirname, "fixtures");

/**
 * Parameterized tests for all photo converters.
 * Each converter has the same UI pattern:
 *   upload via #file-input → #btn-convert enables → click convert → #conv-result appears
 */
const converters = [
  { name: "JPG to PNG", path: "/photo-converter/jpg-to-png/", input: "test.jpg" },
  { name: "PNG to JPG", path: "/photo-converter/png-to-jpg/", input: "test.png" },
  { name: "JPG to WebP", path: "/photo-converter/jpg-to-webp/", input: "test.jpg" },
  { name: "PNG to WebP", path: "/photo-converter/png-to-webp/", input: "test.png" },
  { name: "WebP to JPG", path: "/photo-converter/webp-to-jpg/", input: "test.webp" },
  // GIF to PNG is now the frame extractor and uses the shared GIF utility UI.
  // Its PNG and ZIP output is covered by gif-utilities.spec.js.
  { name: "SVG to PNG", path: "/photo-converter/svg-to-png/", input: "test.svg" },
  // HEIC conversion uses heic2any from CDN and requires a real HEIC file,
  // so we only test page load (no upload/conversion test).
  { name: "HEIC to JPG", path: "/photo-converter/heic-to-jpg/", input: null },
];

for (const converter of converters) {
  test.describe(`Photo Converter: ${converter.name}`, () => {
    test("page loads with file input", async ({ page }) => {
      await page.goto(converter.path);
      await expect(page.locator("#file-input")).toBeAttached();
      await expect(page.locator(".conv-drop-zone")).toBeVisible();
    });

    if (converter.input) {
      test("upload enables convert button", async ({ page }) => {
        await page.goto(converter.path);
        const fileInput = page.locator("#file-input");
        await fileInput.setInputFiles(path.join(FIXTURES, converter.input));

        // File info should appear and convert button should enable
        await expect(page.locator("#file-info")).toBeVisible({ timeout: 10_000 });
        await expect(page.locator("#btn-convert")).toBeEnabled({ timeout: 5_000 });
      });

      test("conversion produces the requested format or reports unsupported encoding", async ({ page }) => {
        await page.goto(converter.path);
        const fileInput = page.locator("#file-input");
        await fileInput.setInputFiles(path.join(FIXTURES, converter.input));

        const expectedType = converter.path.includes('to-webp') ? 'image/webp'
          : converter.path.includes('to-jpg') ? 'image/jpeg' : 'image/png';
        const supported = await page.evaluate(type => new Promise(resolve => {
          const canvas = document.createElement('canvas');
          canvas.width = canvas.height = 1;
          canvas.toBlob(blob => resolve(blob && blob.type === type), type);
        }), expectedType);
        const unsupportedDialog = supported ? null : page.waitForEvent('dialog').then(async dialog => {
          const message = dialog.message();
          await dialog.accept();
          return message;
        });
        // Wait for convert button to enable, then click it
        const convertBtn = page.locator("#btn-convert");
        await expect(convertBtn).toBeEnabled({ timeout: 10_000 });
        await convertBtn.click();

        if (!supported) {
          expect(await unsupportedDialog).toContain('could not produce the requested format');
          await expect(page.locator('#conv-result')).toBeHidden();
          await expect(convertBtn).toBeEnabled();
          return;
        }

        // Wait for result section
        const result = page.locator("#conv-result");
        await expect(result).toBeVisible({ timeout: 20_000 });

        // Download button should be present
        const downloadBtn = page.locator("#btn-download");
        await expect(downloadBtn).toBeVisible();
        const outputType = await page.locator('#result-img').evaluate(async img =>
          (await (await fetch(img.src)).blob()).type);
        expect(outputType).toBe(expectedType);
      });
    }
  });
}
