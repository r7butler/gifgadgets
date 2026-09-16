/* Synthetic local baselines, not competitor claims. No production analytics or uploads. */
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { performance } = require('perf_hooks');
const root = path.resolve(__dirname, '../..');
function animation(width, height, count) {
  const context = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'frontend/gifenc.browser.js'), 'utf8'), context);
  const encoder = context.window.gifenc.GIFEncoder();
  const palette = [[20, 25, 40], [245, 245, 250], [255, 80, 90], [50, 160, 240]];
  for (let frame = 0; frame < count; frame++) {
    const pixels = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      pixels[y * width + x] = (x > frame * 7 % width && x < frame * 7 % width + 50 && y > 30 && y < 80)
        ? 2 : y < 20 ? 3 : (Math.floor(x / 24) + Math.floor(y / 24)) % 2;
    }
    encoder.writeFrame(pixels, width, height, { palette, delay: 100, repeat: 0 });
  }
  encoder.finish();
  return Buffer.from(encoder.bytes());
}
const cases = [
  { name: 'small-flat', width: 320, height: 180, frames: 24 },
  { name: 'medium-flat', width: 640, height: 360, frames: 60 }
];
for (const sample of cases) for (const tool of ['gif-resizer', 'crop-gif', 'gif-editor']) {
  test(`${tool} ${sample.name}`, async ({ page }, testInfo) => {
    const input = animation(sample.width, sample.height, sample.frames);
    const inputPath = testInfo.outputPath('input.gif');
    fs.writeFileSync(inputPath, input);
    await run(page, testInfo, tool, inputPath, sample);
  });
}
test('video-to-gif fixture', async ({ page }, testInfo) => {
  await run(page, testInfo, 'video-to-gif', path.join(root, 'tests/e2e/fixtures/test.mp4'));
});
async function run(page, testInfo, tool, input, sample) {
  await page.route('https://www.googletagmanager.com/**', route => route.fulfill({ body: '' }));
  await page.addInitScript(() => localStorage.setItem('gc_cookie_consent', 'accepted'));
  const pageStarted = performance.now();
  await page.goto(`/${tool}/edit/`);
  const pageLoadMs = performance.now() - pageStarted;
  const started = performance.now();
  await page.locator('#file-input').setInputFiles(input);
  await expect(page.locator(tool === 'gif-editor' ? '#editor-workspace' : '#editor-screen')).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window.dataLayer || []).some(e => e[1] === 'editor_ready'))).toBe(true);
  const readyMs = performance.now() - started;
  if (tool === 'gif-resizer') {
    await page.locator('#inp-width').fill(String(sample.width / 2));
    await page.locator('#inp-width').dispatchEvent('input');
  } else if (tool === 'crop-gif') {
    await page.locator('#inp-w').fill(String(sample.width / 2));
    await page.locator('#inp-w').dispatchEvent('input');
  } else if (tool === 'gif-editor') {
    // Fixed text, same placement/settings each run; no AI tracking requests.
    await page.evaluate(() => {
      GC.state.captions.push({ id: 'benchmark', text: 'Benchmark', x: 0.5, y: 0.5,
        fontSize: 24, fontFamily: 'Arial', fontWeight: 700, align: 'center', color: '#ffffff', strokeColor: '#000000',
        strokeWidth: 2, startFrame: 0, endFrame: GC.state.frames.length - 1, motion: [] });
    });
  }
  const exportStart = performance.now();
  await page.locator(tool === 'gif-resizer' ? '#btn-resize' : tool === 'crop-gif' ? '#btn-crop' : tool === 'video-to-gif' ? '#btn-convert' : '#btn-download').click();
  const downloadButton = page.locator(tool === 'gif-editor' ? '#btn-dl-download' : '#btn-dl-modal');
  await expect(downloadButton).toBeVisible({ timeout: 90000 });
  const exportMs = performance.now() - exportStart;
  const downloadEvent = page.waitForEvent('download');
  await downloadButton.click();
  const download = await downloadEvent;
  const output = testInfo.outputPath('output.gif');
  await download.saveAs(output);
  const totalMs = performance.now() - started;
  const bytes = fs.readFileSync(output);
  expect(bytes.subarray(0, 3).toString()).toBe('GIF');
  expect(bytes.length).toBeGreaterThan(20);
  const funnel = await page.evaluate(() => (window.dataLayer || []).filter(e => e[0] === 'event').map(e => e[1]));
  expect(funnel).toEqual(['file_accepted', 'editor_ready', 'export_started', 'export_completed']);
  const result = { tool, sample: sample || 'test.mp4', browser: testInfo.project.name,
    page_load_ms: Math.round(pageLoadMs), ready_ms: Math.round(readyMs),
    export_ms: Math.round(exportMs), task_to_saved_file_ms: Math.round(totalMs),
    input_bytes: fs.statSync(input).size, output_bytes: bytes.length,
    width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8),
    scope: 'local synthetic; not a visual-quality or competitor comparison' };
  if (sample) {
    expect(result.width).toBe(tool === 'gif-editor' ? sample.width : sample.width / 2);
    expect(result.height).toBe(tool === 'gif-resizer' ? sample.height / 2 : sample.height);
  }
  await testInfo.attach('benchmark.json', { body: JSON.stringify(result, null, 2), contentType: 'application/json' });
  fs.writeFileSync(testInfo.outputPath('benchmark.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
}
