const { test, expect } = require('@playwright/test');
const path = require('node:path');
const fixtures = path.join(__dirname, 'fixtures');

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('gc_cookie_consent', 'rejected'));
});

async function clickTimeline(page) {
  const scrubber = page.locator('#frame-scrubber');
  const box = await scrubber.boundingBox();
  await scrubber.click({ position: { x: box.width * 0.7, y: box.height / 2 } });
  return scrubber;
}

test('video timeline clicks, dragging and keyboard seeks hold position until Play', async ({ page }) => {
  await page.goto('/video-to-gif/edit/');
  await page.locator('#file-input').setInputFiles(path.join(fixtures, 'video-500-frames.mp4'));
  await expect(page.locator('#editor-screen')).toBeVisible();
  await expect(page.locator('#btn-convert')).toBeEnabled();
  await page.locator('#sl-fps').fill('10');
  await page.locator('#inp-out').fill('0:05.0');
  await page.locator('#inp-out').dispatchEvent('change');
  const video = page.locator('#preview-video');
  await page.locator('#btn-play-pause').click();
  await expect.poll(() => video.evaluate(v => v.paused)).toBe(false);
  const scrubber = await clickTimeline(page);
  await expect.poll(() => video.evaluate(v => v.paused && !v.seeking)).toBe(true);
  const time = await video.evaluate(v => v.currentTime);
  expect(time).toBeGreaterThan(5); // Seeking outside the trim must not loop back.
  await page.waitForTimeout(400); // Catch resumed playback and queued timeupdate events.
  expect(await video.evaluate(v => v.currentTime)).toBeCloseTo(time, 3);

  const box = await scrubber.boundingBox();
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => video.evaluate(v => v.paused && !v.seeking)).toBe(true);
  expect(await video.evaluate(v => v.currentTime)).toBeGreaterThan(15);
  expect(await video.evaluate(v => v.currentTime)).toBeLessThan(25);

  await scrubber.fill('28');
  await scrubber.press('ArrowRight'); // 29 / 10 can round below frame 29.
  await expect.poll(() => video.evaluate(v => !v.seeking)).toBe(true);
  await page.waitForTimeout(200);
  await expect(scrubber).toHaveValue('29');
  expect(await video.evaluate(v => v.currentTime)).toBeCloseTo(2.9, 3);
  await page.locator('#btn-next-frame').click();
  await expect(scrubber).toHaveValue('30');
  await page.locator('#btn-play-pause').click();
  await expect.poll(() => video.evaluate(v => v.currentTime)).toBeGreaterThan(3.05);
  const trimTrack = page.locator('#trim-track');
  const trackBox = await trimTrack.boundingBox();
  await trimTrack.click({ position: { x: trackBox.width * 0.8, y: trackBox.height / 2 } });
  await expect.poll(() => video.evaluate(v => v.paused && !v.seeking)).toBe(true);
  expect(await video.evaluate(v => v.currentTime)).toBeGreaterThan(35);
});

for (const route of ['/gif-editor/edit/', '/editor.html']) {
  test(route + ' holds a selected GIF frame and resumes only on Play', async ({ page }) => {
    await page.goto(route);
    await page.locator('#file-input').setInputFiles(path.join(fixtures, 'test-animated.gif'));
    await expect(page.locator('#preview-canvas')).toBeVisible();
    await expect.poll(() => page.evaluate(() => GC.state.frames.length)).toBeGreaterThan(1);
    await page.evaluate(() => { if (!GC.state.isPlaying) GC.play(); });
    const scrubber = await clickTimeline(page);
    await expect.poll(() => page.evaluate(() => GC.state.isPlaying)).toBe(false);
    const selected = await scrubber.inputValue();
    await page.waitForTimeout(400);
    await expect(scrubber).toHaveValue(selected);
    await page.locator('#btn-play-pause').click();
    await expect.poll(() => page.evaluate(() => GC.state.isPlaying)).toBe(true);
    await page.locator('#btn-next-frame').click();
    await expect.poll(() => page.evaluate(() => GC.state.isPlaying)).toBe(false);
  });
}

test('GIF Maker already holds manually selected frames', async ({ page }) => {
  await page.goto('/gif-maker/edit/');
  await page.locator('#file-input').setInputFiles(path.join(fixtures, 'test-animated.gif'));
  await expect(page.locator('#editor-screen')).toBeVisible();
  await expect(page.locator('#frame-scrubber')).not.toHaveAttribute('max', '0');
  if (await page.locator('#play-icon').isVisible()) await page.locator('#btn-play-pause').click();
  const scrubber = await clickTimeline(page);
  await expect(page.locator('#play-icon')).toBeVisible();
  const selected = await scrubber.inputValue();
  await page.waitForTimeout(400);
  await expect(scrubber).toHaveValue(selected);
});
