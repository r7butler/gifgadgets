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
