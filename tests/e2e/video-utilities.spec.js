const {test, expect} = require('@playwright/test');
const {execFileSync} = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const fixture = path.join(__dirname, 'fixtures/video-tools-audio.mp4');
const probe = file => JSON.parse(execFileSync('ffprobe', ['-v','error','-show_streams','-show_format','-of','json',file]));
const decoded = file => execFileSync('ffmpeg', ['-v','error','-i',file,'-map','0:v:0','-f','framemd5','-']).toString().split('\n').filter(x => x && !x.startsWith('#')).map(x => x.split(',').pop().trim());
test.setTimeout(120000);
async function load(page, slug, file = fixture) {
  await page.goto('/' + slug + '/');
  await page.locator('#utility-file').setInputFiles(file);
  await expect(page.locator('#utility-status')).toHaveText('Ready to export.', {timeout: 60000});
}
async function output(page) {
  await page.locator('#utility-apply').click();
  await expect(page.locator('#utility-download')).toBeVisible({timeout: 60000});
  const downloaded = page.waitForEvent('download');
  await page.locator('#utility-download').click();
  return (await downloaded).path();
}
test('GIF to MP4 exports one cycle as H.264', async ({page}) => {
  const source = path.join(__dirname, 'fixtures/test-animated.gif');
  await load(page, 'gif-to-mp4', source);
  const file = await output(page), info = probe(file);
  expect(info.streams[0].codec_name).toBe('h264');
  expect(info.streams.every(s => s.codec_type !== 'audio')).toBeTruthy();
  expect(+info.format.duration).toBeCloseTo(+probe(source).format.duration, 0);
  expect(decoded(file).length).toBeGreaterThan(1);
});
test('trim exports selected duration and keeps audio', async ({page}) => {
  await load(page, 'trim-video');
  await page.locator('#utility-start').fill('0.5');
  await page.locator('#utility-end').fill('1.5');
  const file = await output(page), info = probe(file);
  expect(+info.format.duration).toBeCloseTo(1, 1);
  expect(info.streams.some(s => s.codec_name === 'aac')).toBeTruthy();
  expect(decoded(file)).toHaveLength(10);
  await page.locator('#utility-end').fill('0.2');
  await expect(page.locator('#utility-download')).toBeHidden();
  await page.locator('#utility-apply').click();
  await expect(page.locator('#utility-status')).toContainText('end time must follow');
});
test('mute removes audio and preserves decoded video exactly', async ({page}) => {
  await load(page, 'mute-video');
  const file = await output(page), info = probe(file);
  expect(info.streams).toHaveLength(1);
  expect(info.streams[0].codec_type).toBe('video');
  expect(decoded(file)).toEqual(decoded(fixture));
});
test('frame extraction saves the selected frame at original dimensions', async ({page}) => {
  await load(page, 'video-frame-extractor');
  await page.locator('#utility-start').fill('1');
  const file = await output(page), bytes = fs.readFileSync(file);
  expect(bytes.subarray(0,8).toString('hex')).toBe('89504e470d0a1a0a');
  expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual([96,64]);
  const expected = execFileSync('ffmpeg',['-v','error','-ss','1','-i',fixture,'-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','-']);
  const actual = execFileSync('ffmpeg',['-v','error','-i',file,'-f','rawvideo','-pix_fmt','rgb24','-']);
  expect(actual.length).toBe(expected.length);
  const meanError = actual.reduce((sum, value, i) => sum + Math.abs(value - expected[i]), 0) / actual.length;
  // Native and WASM FFmpeg versions can round YUV-to-RGB conversion differently.
  expect(meanError).toBeLessThan(2);
  const first = execFileSync('ffmpeg',['-v','error','-i',fixture,'-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','-']);
  const firstError = actual.reduce((sum, value, i) => sum + Math.abs(value - first[i]), 0) / actual.length;
  expect(firstError).toBeGreaterThan(5);
});
test('mobile layout, lazy engine, invalid file, cancellation and retry', async ({page}) => {
  await page.setViewportSize({width:390,height:844});
  const engineRequests = [];
  page.on('request', r => { if (r.url().includes('ffmpeg-core')) engineRequests.push(r.url()); });
  await page.goto('/mute-video/');
  expect(engineRequests).toHaveLength(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.locator('#utility-file').setInputFiles({name:'bad.mp4',mimeType:'video/mp4',buffer:Buffer.from('broken')});
  await expect(page.locator('#utility-status')).toContainText('No readable video', {timeout:60000});
  await page.locator('#utility-file').setInputFiles(fixture);
  await page.locator('#utility-cancel').click();
  await expect(page.locator('#utility-status')).toContainText('cancelled');
  await page.locator('#utility-file').setInputFiles(fixture);
  await expect(page.locator('#utility-status')).toHaveText('Ready to export.', {timeout:60000});
  await output(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});
test('GIF transparency becomes black and odd dimensions are padded', async ({page}) => {
  const {GifWriter} = require('../../frontend/vendor/omggif.js');
  const bytes = Buffer.alloc(2048);
  const writer = new GifWriter(bytes, 5, 3, {palette:[0xffffff,0xff0000],loop:0});
  writer.addFrame(0,0,5,3,new Uint8Array(15),{delay:20,transparent:0});
  writer.addFrame(0,0,5,3,new Uint8Array(15),{delay:20,transparent:0});
  await load(page, 'gif-to-mp4', {name:'transparent.gif',mimeType:'image/gif',buffer:bytes.subarray(0,writer.end())});
  const file = await output(page), info = probe(file);
  expect([info.streams[0].width,info.streams[0].height]).toEqual([6,4]);
  const rgb = execFileSync('ffmpeg',['-v','error','-i',file,'-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','-']);
  expect(Math.max(...rgb)).toBeLessThan(5);
});
test('WebM muting keeps the WebM container and video frames', async ({page}, testInfo) => {
  const source = testInfo.outputPath('source.webm');
  execFileSync('ffmpeg',['-v','error','-y','-i',fixture,'-c:v','libvpx','-c:a','libvorbis',source]);
  await load(page, 'mute-video', source);
  const file = await output(page), info = probe(file);
  expect(info.format.format_name).toContain('webm');
  expect(info.streams).toHaveLength(1);
  expect(decoded(file)).toEqual(decoded(source));
});
test('workspace fits desktop and mobile in both themes', async ({page}, testInfo) => {
  await load(page, 'trim-video');
  await output(page);
  for (const width of [1280,390]) {
    await page.setViewportSize({width,height:900});
    for (const theme of ['light','dark']) {
      await page.evaluate(theme => document.documentElement.setAttribute('data-theme',theme),theme);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({path:testInfo.outputPath(`workspace-${width}-${theme}.png`),fullPage:true,animations:'disabled'});
    }
  }
});
