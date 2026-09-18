const {test,expect}=require('@playwright/test');
const {GifWriter,GifReader}=require('../../frontend/vendor/omggif.js');
const fs=require('node:fs'),zlib=require('node:zlib');
test.setTimeout(60000);
function gifFile(background=false) {
  const bytes=Buffer.alloc(2048), writer=new GifWriter(bytes,4,2,{loop:2});
  const palette=[0,0xff0000,0x00ff00,0x0000ff];
  writer.addFrame(0,0,4,2,new Uint8Array(8).fill(background?3:1),{palette,delay:background?5:7,disposal:2});
  writer.addFrame(0,0,4,2,new Uint8Array(8).fill(2),{palette,delay:background?5:13,disposal:2});
  return {name:'source.gif',mimeType:'image/gif',buffer:bytes.subarray(0,writer.end())};
}
async function pngFile(page,color='red',width=4,height=2) {
  const b64=await page.evaluate(({color,width,height})=>{const c=document.createElement('canvas');c.width=width;c.height=height;const ctx=c.getContext('2d');ctx.fillStyle=color;ctx.fillRect(0,0,width,height);return c.toDataURL().split(',')[1];},{color,width,height});
  return {name:'image.png',mimeType:'image/png',buffer:Buffer.from(b64,'base64')};
}
async function service(page,frames=1,{running=false,fail=false}={}) {
  const calls=[];let cancelled=false;
  const header=Buffer.from(JSON.stringify({version:1,width:4,height:2,frames}));
  const bytes=Buffer.alloc(4+header.length+frames);bytes.writeUInt32LE(header.length);header.copy(bytes,4);bytes.fill(0b11001100,4+header.length);
  await page.route('**/mock-upload',route=>route.fulfill({status:200,body:''}));
  await page.route('**/mock-masks',route=>route.fulfill({status:200,contentType:'application/gzip',body:zlib.gzipSync(bytes)}));
  await page.route('**/api/segment/*',async route=>{
    const kind=route.request().url().split('/').pop(); calls.push({kind,body:route.request().postDataJSON()});
    if(fail && kind==='presign') return route.fulfill({status:503,json:{error:'Background removal is temporarily unavailable.'}});
    const results={presign:{job_id:'a'.repeat(32),upload_url:'http://localhost:3000/mock-upload'},submit:{state:'running'},status:running?{state:'running'}:{state:'complete',mask_url:'http://localhost:3000/mock-masks'},cancel:{state:'cancelled'}};
    if(kind==='cancel')cancelled=true;
    await route.fulfill({status:200,json:results[kind]});
  });
  return {calls,isCancelled:()=>cancelled};
}
async function load(page,slug,file) {
  await page.goto('/'+slug+'/');
  await page.locator('#utility-file').setInputFiles(file || await pngFile(page));
  await expect(page.locator('#utility-status')).toContainText('Select the objects');
  await page.locator('summary').click();
  await page.locator('#utility-x').fill('25');
  await page.locator('#utility-add-point').click();
}
async function segment(page) {
  await page.locator('#utility-segment').click();
  await expect(page.locator('#utility-download')).toBeVisible({timeout:20000});
}
async function download(page) {
  const pending=page.waitForEvent('download');await page.locator('#utility-download').click();
  return fs.readFileSync(await (await pending).path());
}
async function pngPixels(page,bytes) {
  return page.evaluate(async b64=>{const img=new Image();img.src='data:image/png;base64,'+b64;await img.decode();const c=document.createElement('canvas');c.width=img.width;c.height=img.height;const ctx=c.getContext('2d');ctx.drawImage(img,0,0);return Array.from(ctx.getImageData(0,0,c.width,c.height).data);},bytes.toString('base64'));
}
test('image cutout exports actual transparency and submits multiple objects',async({page})=>{
  const server=await service(page);
  await load(page,'remove-image-background');
  await page.locator('#utility-add-object').click();
  await page.locator('#utility-add-point').click();
  await segment(page);
  const bytes=await download(page),pixels=await pngPixels(page,bytes);
  expect(pixels.slice(0,4)).toEqual([255,0,0,255]);expect(pixels[11]).toBe(0);
  expect(server.calls.find(c=>c.kind==='submit').body.objects).toHaveLength(2);
  await page.locator('#utility-undo').click();
  await expect(page.locator('#utility-download')).toBeHidden();
  await expect(page.locator('#utility-apply')).toBeDisabled();
});
test('image background changes reuse masks and never upload replacement',async({page})=>{
  const server=await service(page);await load(page,'change-image-background');await segment(page);
  await page.locator('#utility-background').setInputFiles(await pngFile(page,'blue'));
  await expect(page.locator('#utility-status')).toContainText('Background ready');
  await page.locator('#utility-apply').click();
  await expect(page.locator('#utility-download')).toBeVisible();
  const pixels=await pngPixels(page,await download(page));
  expect(pixels.slice(0,4)).toEqual([255,0,0,255]);expect(pixels.slice(8,12)).toEqual([0,0,255,255]);
  expect(server.calls.filter(c=>c.kind==='submit')).toHaveLength(1);
});
test('GIF cutout retains frames, loop, delay and transparent pixels',async({page})=>{
  await service(page,2);await load(page,'remove-gif-background',gifFile());await segment(page);
  const reader=new GifReader(await download(page));
  expect(reader.numFrames()).toBe(2);expect(reader.loopCount()).toBe(2);
  expect([reader.frameInfo(0).delay,reader.frameInfo(1).delay]).toEqual([7,13]);
  for(let i=0;i<2;i++){const rgba=new Uint8Array(32);reader.decodeAndBlitFrameRGBA(i,rgba);expect(rgba[3]).toBe(255);expect(rgba[11]).toBe(0);}
});
test('animated GIF background splits both timelines and retains total duration',async({page})=>{
  const server=await service(page,2);await load(page,'swap-gif-background',gifFile());await segment(page);
  await page.locator('#utility-background').setInputFiles(gifFile(true));
  await expect(page.locator('#utility-status')).toContainText('Background ready');
  await page.locator('#utility-apply').click();await expect(page.locator('#utility-download')).toBeVisible();
  const reader=new GifReader(await download(page));
  expect(reader.numFrames()).toBe(5);expect(reader.loopCount()).toBe(2);
  expect(Array.from({length:5},(_,i)=>reader.frameInfo(i).delay)).toEqual([5,2,3,5,5]);
  const first=new Uint8Array(32),second=new Uint8Array(32);reader.decodeAndBlitFrameRGBA(0,first);reader.decodeAndBlitFrameRGBA(1,second);
  expect(Array.from(first.slice(8,12))).toEqual([0,0,255,255]);expect(Array.from(second.slice(8,12))).toEqual([0,255,0,255]);
  expect(server.calls.filter(c=>c.kind==='submit')).toHaveLength(1);
});
test('cancelling asks the server to terminate compute and permits another selection',async({page})=>{
  const server=await service(page,2,{running:true});await load(page,'remove-gif-background',gifFile());
  await page.locator('#utility-segment').click();await expect(page.locator('#utility-status')).toContainText('Finding objects');
  await page.locator('#utility-cancel').click();await expect(page.locator('#utility-status')).toHaveText('Processing cancelled.');
  expect(server.isCancelled()).toBeTruthy();await expect(page.locator('#utility-options')).toBeEnabled();
  await expect(page.locator('#utility-download')).toBeHidden();
});
test('service failure is visible and mobile tools do not overflow',async({page})=>{
  await page.setViewportSize({width:390,height:844});await service(page,1,{fail:true});await load(page,'remove-image-background');
  await page.locator('#utility-segment').click();await expect(page.locator('#utility-status')).toContainText('temporarily unavailable');
  await expect(page.locator('#utility-options')).toBeEnabled();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
});

test('transient polling failure recovers without starting another GPU job',async({page})=>{
  const server=await service(page);let polls=0;
  await page.route('**/api/segment/status',async route=>{
    if(++polls===1) return route.fulfill({status:503,json:{error:'Temporary connection failure'}});
    return route.fallback();
  });
  await load(page,'remove-image-background');await segment(page);
  expect(polls).toBe(2);
  expect(server.calls.filter(c=>c.kind==='submit')).toHaveLength(1);
  expect(server.isCancelled()).toBeFalsy();
  expect((await pngPixels(page,await download(page)))[11]).toBe(0);
});

test('incomplete masks fail visibly instead of exporting an unprocessed frame',async({page})=>{
  await service(page,1);await load(page,'remove-gif-background',gifFile());
  await page.locator('#utility-segment').click();
  await expect(page.locator('#utility-status')).toContainText('Masks do not match');
  await expect(page.locator('#utility-download')).toBeHidden();
  await expect(page.locator('#utility-apply')).toBeDisabled();
  await expect(page.locator('#utility-options')).toBeEnabled();
});

test('failed replacement cannot silently reuse the previous background',async({page})=>{
  await service(page);await load(page,'change-image-background');await segment(page);
  await page.locator('#utility-background').setInputFiles(await pngFile(page,'blue'));
  await expect(page.locator('#utility-status')).toContainText('Background ready');
  await page.locator('#utility-background').setInputFiles({name:'broken.png',mimeType:'image/png',buffer:Buffer.from('broken')});
  await expect(page.locator('#utility-background-options')).toBeEnabled();
  await expect(page.locator('#utility-background-name')).toBeEmpty();
  await page.locator('#utility-apply').click();
  await expect(page.locator('#utility-status')).toContainText('Choose a replacement background');
  await expect(page.locator('#utility-download')).toBeHidden();
});

test('cancelling local export can reuse masks for another export',async({page})=>{
  const server=await service(page);
  // Keep the real worker and codecs, but delay its next export so cancellation
  // is deterministic rather than depending on CPU speed or a huge fixture.
  await page.route('**/background-worker.js',async route=>{
    const response=await route.fetch();
    await route.fulfill({response,body:(await response.text())+'\nconst handle=self.onmessage; self.onmessage=async e=>{if(e.data.type==="export")await new Promise(r=>setTimeout(r,500));return handle(e);};'});
  });
  await load(page,'remove-image-background');await segment(page);
  // Cancel a finished-mask re-export; it must terminate and rebuild the worker.
  await page.evaluate(()=>{
    document.getElementById('utility-apply').click();
    document.getElementById('utility-cancel').click();
  });
  await expect(page.locator('#utility-status')).toHaveText('Processing cancelled.');
  await page.locator('#utility-apply').click();
  await expect(page.locator('#utility-download')).toBeVisible();
  expect((await pngPixels(page,await download(page)))[11]).toBe(0);
  expect(server.calls.filter(c=>c.kind==='submit')).toHaveLength(1);
});

test('exclude points and clear selection enforce a fresh segmentation',async({page})=>{
  const server=await service(page);await load(page,'remove-image-background');
  await page.locator('#utility-point-mode').selectOption('0');
  await page.locator('#utility-x').fill('75');await page.locator('#utility-add-point').click();
  await segment(page);
  expect(server.calls.find(c=>c.kind==='submit').body.objects[0].points.map(p=>p.label)).toEqual([1,0]);
  await page.locator('#utility-clear').click();
  await page.locator('#utility-segment').click();
  await expect(page.locator('#utility-status')).toContainText('Add at least one keep point');
  await expect(page.locator('#utility-download')).toBeHidden();
  expect(server.calls.filter(c=>c.kind==='submit')).toHaveLength(1);
});

test('portrait selection stays beside controls and fits a mobile viewport',async({page})=>{
  await page.setViewportSize({width:1440,height:1000});
  await page.goto('/change-image-background/');
  await load(page,'change-image-background',await pngFile(page,'red',900,1400));
  const canvas=await page.locator('#utility-canvas').boundingBox();
  const preview=await page.locator('#utility-original-wrap .utility-preview-image').boundingBox();
  expect(canvas.height).toBeLessThanOrEqual(401);
  expect(canvas.y-preview.y).toBeLessThan(2);
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
  expect((await page.locator('#utility-canvas').boundingBox()).height).toBeLessThanOrEqual(401);
});

test('late status response cannot overwrite a new selection after cancellation',async({page})=>{
  await service(page,1,{running:true});
  let release, arrived;
  const waiting=new Promise(resolve=>{arrived=resolve;});
  const gate=new Promise(resolve=>{release=resolve;});
  await page.route('**/api/segment/status',async route=>{
    arrived();await gate;
    await route.fulfill({status:200,json:{state:'running'}});
  });
  await load(page,'remove-image-background');
  await page.locator('#utility-segment').click();await waiting;
  await page.locator('#utility-cancel').click();
  await expect(page.locator('#utility-status')).toHaveText('Processing cancelled.');
  await page.locator('#utility-file').setInputFiles(await pngFile(page,'blue'));
  await expect(page.locator('#utility-status')).toContainText('Select the objects');
  release();
  // Allow the delayed response handler to run before checking the newer UI.
  await page.waitForResponse('**/api/segment/status');
  await page.waitForTimeout(100);
  await expect(page.locator('#utility-status')).toContainText('Select the objects');
  await expect(page.locator('#utility-cancel')).toBeHidden();
});
