const {test, expect} = require('@playwright/test');
const fs = require('node:fs');
const {GifWriter, GifReader} = require('../../frontend/vendor/omggif.js');
function fixture() {
  const bytes = new Uint8Array(4096), writer = new GifWriter(bytes,3,2,{loop:2});
  for (const [i,delay] of [7,13,25].entries()) writer.addFrame(0,0,3,2,[i+1,0,1,2,3,0],{palette:[0,0xff0000,0x00ff00,0x0000ff],transparent:0,delay,disposal:2});
  return Buffer.from(bytes.slice(0,writer.end()));
}
test.beforeEach(async ({page}) => {
  await page.route('**/*', route => new URL(route.request().url()).hostname === 'localhost' ? route.continue() : route.abort());
});
test('themed upload area supports dropping a GIF and choosing a replacement', async ({page}, testInfo) => {
  await page.goto('/gif-speed/');
  await page.locator('#utility-upload').evaluate((element, bytes) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(bytes)], 'dropped.gif', {type: 'image/gif'}));
    element.dispatchEvent(new DragEvent('drop', {bubbles:true, cancelable:true, dataTransfer:transfer}));
  }, Array.from(fixture()));
  await expect(page.locator('#utility-upload')).toBeHidden();
  await expect(page.locator('#utility-original-wrap')).toBeVisible();
  const picker = page.waitForEvent('filechooser'); await page.locator('#utility-new').click();
  await (await picker).setFiles({name:'replacement.gif',mimeType:'image/gif',buffer:fixture()});
  await page.locator('#utility-apply').click(); await expect(page.locator('#utility-download')).toBeVisible();
  await page.evaluate(() => { document.documentElement.setAttribute('data-theme', 'dark'); window.scrollTo(0, 0); });
  await page.screenshot({path:testInfo.outputPath('utility-dark-result.png'),fullPage:true,animations:'disabled'});
});
for (const viewport of [{width:1280, height:720}, {width:390, height:844}]) {
  test(`a GIF that cannot be opened says why beside the drop zone (${viewport.width}px)`, async ({page}) => {
    // Remove frames has the tallest settings panel, which hid its status line below the fold.
    await page.setViewportSize(viewport);
    await page.goto('/remove-gif-frames/');
    const message = page.locator('#utility-upload-error');
    // A 4096×4096 frame needs more working memory than allowed, though the file is tiny.
    const huge = new Uint8Array(4096), writer = new GifWriter(huge, 4096, 4096, {loop:0});
    writer.addFrame(0, 0, 1, 1, [0], {palette:[0, 0xffffff]});
    await page.locator('#utility-file').setInputFiles({name:'huge.gif', mimeType:'image/gif', buffer:Buffer.from(huge.slice(0, writer.end()))});
    await expect(message).toHaveText('Each 4096 × 4096 frame needs more memory than this tool allows. Resize the GIF first.');
    await expect(message).toBeInViewport();
    await expect(page.locator('#utility-upload')).toBeVisible();

    await page.locator('#utility-file').setInputFiles({name:'renamed.gif', mimeType:'image/gif', buffer:Buffer.from('not a gif')});
    await expect(message).toHaveText('Choose a valid GIF file.');

    // A drag from a web page carries a link, not a file.
    await page.locator('#utility-upload').evaluate(element => {
      const transfer = new DataTransfer();
      transfer.setData('text/uri-list', 'https://example.com/cat.gif');
      element.dispatchEvent(new DragEvent('drop', {bubbles:true, cancelable:true, dataTransfer:transfer}));
    });
    await expect(message).toHaveText('Drop a GIF file from your device.');

    await page.locator('#utility-file').setInputFiles({name:'good.gif', mimeType:'image/gif', buffer:fixture()});
    await expect(page.locator('#utility-original-wrap')).toBeVisible();
    await expect(message).toBeHidden();
  });
}
/** The 3-frame fixture padded past `size` bytes with a comment block. */
function paddedGif(size) {
  const gif = fixture(), parts = [gif.subarray(0, gif.length - 1), Buffer.from([0x21, 0xfe])];
  for (let left = size; left > 0; left -= 255) {
    const n = Math.min(255, left), block = Buffer.alloc(n + 1, 0x20); block[0] = n; parts.push(block);
  }
  parts.push(Buffer.from([0, 0x3b]));
  return Buffer.concat(parts);
}

test('GIF tools take files up to 100 MB', async ({page}, testInfo) => {
  // Playwright passes files over 50 MB by path, so these are written out first.
  const big = testInfo.outputPath('big.gif'), tooBig = testInfo.outputPath('too-big.gif');
  fs.writeFileSync(big, paddedGif(60 * 1024 * 1024));
  fs.writeFileSync(tooBig, paddedGif(101 * 1024 * 1024));
  await page.goto('/compress-gif/');
  await expect(page.locator('#utility-upload small')).toHaveText('Animated GIF · Up to 100 MB');
  await page.locator('#utility-file').setInputFiles(tooBig);
  await expect(page.locator('#utility-upload-error')).toHaveText('Choose files totaling less than 100 MB.');
  await page.locator('#utility-file').setInputFiles(big);
  await expect(page.locator('#utility-info')).toHaveText('3 × 2 · 3 frames');
  await page.locator('#utility-compression').selectOption('metadata');
  await page.locator('#utility-apply').click();
  await expect(page.locator('#utility-status')).toContainText('Removed GIF comments', {timeout:60000});
});

test('a long GIF past the old memory limit works, except in Reverse, which says why', async ({page}) => {
  // 200 frames of 480×270: about 105 MB decoded. Every tool used to refuse it at upload.
  const w = 480, h = 270, bytes = new Uint8Array(200 * 4096 + 65536), writer = new GifWriter(bytes, w, h, {loop:0});
  for (let i = 0; i < 200; i++) {
    const pixels = new Uint8Array(w * h), left = (i * 2) % (w - 20);
    for (let y = 100; y < 120; y++) pixels.fill(1, y * w + left, y * w + left + 20);
    writer.addFrame(0, 0, w, h, pixels, {palette:[0x336699, 0xffcc00], delay:4});
  }
  const file = {name:'long.gif', mimeType:'image/gif', buffer:Buffer.from(bytes.slice(0, writer.end()))};

  await page.goto('/remove-gif-frames/');
  await page.locator('#utility-file').setInputFiles(file);
  await expect(page.locator('#utility-info')).toHaveText('480 × 270 · 200 frames');
  await expect(page.locator('#utility-upload-error')).toBeHidden();
  await page.locator('#utility-apply').click();
  await expect(page.locator('#utility-download')).toBeVisible({timeout:60000});
  const waiting = page.waitForEvent('download'); await page.locator('#utility-download').click();
  expect(new GifReader(fs.readFileSync(await (await waiting).path())).numFrames()).toBe(199);

  await page.goto('/reverse-gif/');
  await page.locator('#utility-file').setInputFiles(file);
  await expect(page.locator('#utility-upload-error')).toHaveText(/^Reversing holds every frame in memory at once/);
});

for (const tool of ['gif-speed','gif-loop','reverse-gif','rotate-gif','flip-gif','trim-gif']) {
  test(tool + ' downloads a real transformed animation', async ({page}) => {
    await page.goto('/' + tool + '/');
    await page.locator('#utility-file').setInputFiles({name:'private.gif',mimeType:'image/gif',buffer:fixture()});
    if (tool === 'trim-gif') await page.locator('#utility-start').fill('2');
    await page.locator('#utility-apply').click();
    await expect(page.locator('#utility-download')).toBeVisible();
    const waiting = page.waitForEvent('download'); await page.locator('#utility-download').click();
    const download = await waiting, bytes = fs.readFileSync(await download.path()), reader = new GifReader(bytes);
    expect(reader.numFrames()).toBe(tool==='trim-gif'?2:3);
    expect(reader.width).toBe(tool==='rotate-gif'?2:3);
    expect(reader.height).toBe(tool==='rotate-gif'?3:2);
    expect(reader.loopCount()).toBe(tool==='gif-loop'?0:2);
    expect(reader.frameInfo(0).delay).toBe(tool==='gif-speed'?4:tool==='reverse-gif'?25:tool==='trim-gif'?13:7);
    const rgba = new Uint8Array(reader.width*reader.height*4); reader.decodeAndBlitFrameRGBA(0,rgba);
    expect(Array.from(rgba).some((v,i)=>i%4===3 && v===0)).toBe(true);
    expect(await page.locator('link[rel="canonical"]').getAttribute('href')).toBe('https://gifgadgets.com/'+tool+'/');
  });
}
test('invalid input and invalid settings recover without a stale download', async ({page}) => {
  await page.goto('/trim-gif/');
  await page.locator('#utility-file').setInputFiles({name:'bad.gif',mimeType:'image/gif',buffer:Buffer.from('not a GIF')});
  await expect(page.locator('#utility-status')).toContainText('valid GIF');
  await expect(page.locator('#utility-apply')).toBeDisabled();
  await page.locator('#utility-file').setInputFiles({name:'okay.gif',mimeType:'image/gif',buffer:fixture()});
  await page.locator('#utility-start').fill('3'); await page.locator('#utility-end').fill('1');
  await page.locator('#utility-apply').click(); await expect(page.locator('#utility-status')).toContainText('valid inclusive');
  await page.locator('#utility-end').fill('3'); await page.locator('#utility-apply').click();
  await expect(page.locator('#utility-download')).toBeVisible();
  await page.locator('#utility-start').fill('1'); await expect(page.locator('#utility-download')).toBeHidden();
});
test('mobile layout, consented events, and cancelled processing', async ({page}) => {
  await page.setViewportSize({width:390,height:844});
  await page.goto('/gif-speed/?private=do-not-record');
  await page.evaluate(()=> {window.GWAnalyticsAllowed=()=>true; window.utilityEvents=[]; window.gtag=(...args)=>window.utilityEvents.push(args);});
  await page.locator('#utility-file').setInputFiles({name:'private.gif',mimeType:'image/gif',buffer:fixture()});
  await page.locator('#utility-apply').click(); await expect(page.locator('#utility-download')).toBeVisible();
  const events=await page.evaluate(()=>window.utilityEvents);
  expect(events.map(e=>e[1])).toEqual(['file_accepted','editor_ready','export_started','export_completed']);
  expect(events.every(e=>e[2].tool_name==='gif-speed')).toBe(true);
  expect(JSON.stringify(events)).not.toContain('private');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  await page.evaluate(()=> {window.Worker=class {postMessage(){} terminate(){}};});
  await page.locator('#utility-apply').click(); await page.locator('#utility-cancel').click();
  await expect(page.locator('#utility-status')).toHaveText('Cancelled. You can change settings and try again.');
  await expect(page.locator('#utility-apply')).toBeEnabled(); await expect(page.locator('#utility-download')).toBeHidden();
});

test('continues locally into another utility without selecting the GIF again', async ({page}) => {
  await page.goto('/gif-speed/');
  await page.locator('#utility-file').setInputFiles({name:'input.gif',mimeType:'image/gif',buffer:fixture()});
  await page.locator('#utility-apply').click();
  await expect(page.locator('#utility-continue-wrap')).toBeVisible();
  await page.locator('#utility-next').selectOption('/reverse-gif/?continue=1');
  await page.locator('#utility-continue').click();
  await expect(page).toHaveURL(/reverse-gif/); await expect(page.locator('#utility-apply')).toBeEnabled();
  await page.locator('#utility-apply').click(); await expect(page.locator('#utility-download')).toBeVisible();
  const waiting=page.waitForEvent('download');await page.locator('#utility-download').click();
  const downloaded=await waiting,reader=new GifReader(fs.readFileSync(await downloaded.path()));
  expect([0,1,2].map(i=>reader.frameInfo(i).delay)).toEqual([13,7,4]);
});

test('revoked consent prevents utility events', async ({page}) => {
  await page.goto('/gif-loop/');
  await page.evaluate(()=> {window.GWAnalyticsAllowed=()=>false;window.utilityEvents=[];window.gtag=(...args)=>window.utilityEvents.push(args);});
  await page.locator('#utility-file').setInputFiles({name:'input.gif',mimeType:'image/gif',buffer:fixture()});
  await page.locator('#utility-loop-mode').selectOption('once');
  await page.locator('#utility-apply').click();await expect(page.locator('#utility-download')).toBeVisible();
  expect(await page.evaluate(()=>window.utilityEvents)).toEqual([]);
  const waiting=page.waitForEvent('download');await page.locator('#utility-download').click();
  const downloaded=await waiting;
  expect(new GifReader(fs.readFileSync(await downloaded.path())).loopCount()).toBe(null);
});

for (const target of ['/gif-resizer/edit/', '/gif-editor/edit/?source=local']) {
  test('hands off a result to ' + target, async ({page}) => {
    await page.goto('/rotate-gif/');
    await page.locator('#utility-file').setInputFiles({name:'input.gif',mimeType:'image/gif',buffer:fixture()});
    await page.locator('#utility-apply').click();await expect(page.locator('#utility-continue-wrap')).toBeVisible();
    await page.locator('#utility-next').selectOption(target);await page.locator('#utility-continue').click();
    await expect(page).toHaveURL('http://localhost:3000' + target);
    if (target.includes('resizer')) {
      await expect(page.locator('#inp-width')).toHaveValue('2');
      await expect(page.locator('#btn-resize')).toBeEnabled();
    } else await expect.poll(()=>page.evaluate(()=>window.GC && GC.state.frames.length)).toBe(3);
  });
}

// ── Batch two ────────────────────────────────────────────
for (const tool of ['remove-gif-frames', 'compress-gif', 'gif-canvas']) {
  test(tool + ' downloads a real transformed animation', async ({page}) => {
    await page.goto('/' + tool + '/');
    await page.locator('#utility-file').setInputFiles({name:'private.gif',mimeType:'image/gif',buffer:fixture()});
    if (tool === 'gif-canvas') {
      await page.locator('#utility-width').fill('8');
      await page.locator('#utility-height').fill('6');
    }
    await page.locator('#utility-apply').click();
    await expect(page.locator('#utility-download')).toBeVisible();
    const waiting = page.waitForEvent('download'); await page.locator('#utility-download').click();
    const download = await waiting, bytes = fs.readFileSync(await download.path());
    const reader = new GifReader(bytes);
    // Decoding the download proves real GIF bytes, not an empty or stale blob.
    expect(reader.numFrames()).toBe(tool === 'remove-gif-frames' ? 2 : 3);
    expect(reader.width).toBe(tool === 'gif-canvas' ? 8 : 3);
    expect(reader.height).toBe(tool === 'gif-canvas' ? 6 : 2);
    expect(await page.locator('link[rel="canonical"]').getAttribute('href')).toBe('https://gifgadgets.com/' + tool + '/');
  });
}

test('gif-frame-rate lowers the frame rate, keeps the length and refuses to raise it', async ({page}) => {
  // 10 opaque frames of 4 hundredths each: 25 fps for 0.4 s, a different pixel lit in each.
  const bytes = new Uint8Array(8192), writer = new GifWriter(bytes, 8, 4, {loop:0});
  const palette = [0x808080, 0xff0000, 0x00ff00, 0x0000ff];
  for (let i = 0; i < 10; i++) {
    const pixels = new Uint8Array(32); pixels[i % 8] = 1 + i % 3;
    writer.addFrame(0, 0, 8, 4, pixels, {palette, delay:4});
  }
  await page.goto('/gif-frame-rate/');
  await page.locator('#utility-file').setInputFiles({name:'clip.gif', mimeType:'image/gif', buffer:Buffer.from(bytes.slice(0, writer.end()))});
  await expect(page.locator('#utility-info')).toHaveText('8 × 4 · 10 frames · about 25 fps');
  await expect(page.locator('#utility-fps')).toHaveValue('12');

  await page.locator('#utility-fps').fill('30');
  await page.locator('#utility-apply').click();
  await expect(page.locator('#utility-status')).toHaveText(/about 25 fps\. Choose a lower frame rate/);

  await page.locator('#utility-fps').fill('10');
  await page.locator('#utility-apply').click();
  await expect(page.locator('#utility-download')).toBeVisible();
  await expect(page.locator('#utility-status')).toContainText('Kept 4 of 10 frames');
  await expect(page.locator('#utility-status')).toContainText(/% (smaller|larger)\)/);
  const waiting = page.waitForEvent('download'); await page.locator('#utility-download').click();
  const reader = new GifReader(fs.readFileSync(await (await waiting).path()));
  expect(reader.numFrames()).toBe(4);
  expect([0, 1, 2, 3].map(i => reader.frameInfo(i).delay)).toEqual([10, 10, 10, 10]);
  expect(await page.locator('link[rel="canonical"]').getAttribute('href')).toBe('https://gifgadgets.com/gif-frame-rate/');
});

for (const tool of ['reverse-gif', 'remove-gif-frames']) {
  test(tool + ' keeps a typical GIF near its original size', async ({page}) => {
    // The sample stores only what changes between frames, as most GIFs do.
    // Writing every frame whole made these results 7-8 times the original.
    const sample = fs.readFileSync(require('path').join(__dirname, '../../frontend/samples/bee.gif'));
    await page.goto('/' + tool + '/');
    await page.locator('#utility-file').setInputFiles({name:'bee.gif', mimeType:'image/gif', buffer:sample});
    await page.locator('#utility-apply').click();
    await expect(page.locator('#utility-download')).toBeVisible({timeout:30000});
    const waiting = page.waitForEvent('download'); await page.locator('#utility-download').click();
    const bytes = fs.readFileSync(await (await waiting).path()), reader = new GifReader(bytes);
    expect(reader.numFrames()).toBe(tool === 'reverse-gif' ? 40 : 39);
    expect(bytes.length).toBeLessThan(sample.length * 1.3);
  });
}

test('combine-gifs joins two uploads into one animation', async ({page}) => {
  await page.goto('/combine-gifs/');
  await page.locator('#utility-file').setInputFiles([
    {name:'first.gif', mimeType:'image/gif', buffer:fixture()},
    {name:'second.gif', mimeType:'image/gif', buffer:fixture()},
  ]);
  await page.locator('#utility-width').fill('3');
  await page.locator('#utility-height').fill('2');
  await page.locator('#utility-apply').click();
  await expect(page.locator('#utility-download')).toBeVisible();
  const waiting = page.waitForEvent('download'); await page.locator('#utility-download').click();
  const reader = new GifReader(fs.readFileSync(await (await waiting).path()));
  expect(reader.numFrames()).toBe(6);   // both inputs play in sequence
  expect(reader.width).toBe(3);
});

test('extract-frames exports a PNG for one frame and a ZIP for several', async ({page}) => {
  await page.goto('/photo-converter/gif-to-png/');
  await page.locator('#utility-file').setInputFiles({name:'private.gif',mimeType:'image/gif',buffer:fixture()});
  await page.locator('#utility-apply').click();
  await expect(page.locator('#utility-download')).toBeVisible();

  // Default selection is a single frame, which should download as a plain PNG.
  let waiting = page.waitForEvent('download');
  await page.locator('#utility-download').click();
  const single = fs.readFileSync(await (await waiting).path());
  expect(Array.from(single.subarray(0, 8))).toEqual([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]);

  // Several frames should come back as a ZIP instead.
  await page.locator('#utility-extract').selectOption('all');
  await page.locator('#utility-apply').click();
  await expect(page.locator('#utility-download')).toBeVisible();
  waiting = page.waitForEvent('download');
  await page.locator('#utility-download').click();
  const many = fs.readFileSync(await (await waiting).path());
  expect(Array.from(many.subarray(0, 2))).toEqual([0x50, 0x4b]);   // "PK"
  expect(await page.locator('link[rel="canonical"]').getAttribute('href'))
    .toBe('https://gifgadgets.com/photo-converter/gif-to-png/');
});
test('Explore more GIF utilities comes with the download and opens the home page in a new tab', async ({page}) => {
  await page.goto('/gif-speed/');
  const explore = page.locator('.explore-more');
  await page.locator('#utility-file').setInputFiles({name:'clip.gif',mimeType:'image/gif',buffer:fixture()});
  await expect(page.locator('#utility-original-wrap')).toBeVisible();
  await expect(explore).toBeHidden();
  await page.locator('#utility-apply').click();
  await expect(page.locator('#utility-download')).toBeVisible();
  await expect(explore).toBeVisible();
  await expect(explore).toHaveText('Explore more GIF utilities');
  const opened = page.context().waitForEvent('page');
  await explore.click();
  const home = await opened;
  await home.waitForLoadState();
  expect(new URL(home.url()).pathname + new URL(home.url()).hash).toBe('/#gif-utilities');
  expect(page.url()).toContain('/gif-speed/');
});
