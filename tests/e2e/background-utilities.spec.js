const {test,expect}=require('@playwright/test');
const {GifWriter,GifReader}=require('../../frontend/vendor/omggif.js');
const fs=require('node:fs'),zlib=require('node:zlib');
test.setTimeout(60000);
function gifFile(background=false,width=4,height=2) {
  const bytes=Buffer.alloc(2048), writer=new GifWriter(bytes,width,height,{loop:2});
  const palette=[0,0xff0000,0x00ff00,0x0000ff];
  writer.addFrame(0,0,width,height,new Uint8Array(width*height).fill(background?3:1),{palette,delay:background?5:7,disposal:2});
  writer.addFrame(0,0,width,height,new Uint8Array(width*height).fill(2),{palette,delay:background?5:13,disposal:2});
  return {name:'source.gif',mimeType:'image/gif',buffer:bytes.subarray(0,writer.end())};
}
async function pngFile(page,color='red',width=4,height=2) {
  const b64=await page.evaluate(({color,width,height})=>{const c=document.createElement('canvas');c.width=width;c.height=height;const ctx=c.getContext('2d');ctx.fillStyle=color;ctx.fillRect(0,0,width,height);return c.toDataURL().split(',')[1];},{color,width,height});
  return {name:'image.png',mimeType:'image/png',buffer:Buffer.from(b64,'base64')};
}
async function service(page,frames=1,{running=false,fail=false,mask=0b11001100}={}) {
  const calls=[];let cancelled=false;
  const header=Buffer.from(JSON.stringify({version:1,width:4,height:2,frames}));
  const bytes=Buffer.alloc(4+header.length+frames);bytes.writeUInt32LE(header.length);header.copy(bytes,4);bytes.fill(mask,4+header.length);
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
async function background(page,file) {
  await expect(page.locator('#utility-background-options')).toBeEnabled();
  await page.locator('#utility-background').setInputFiles(file);
  // File change dispatch is asynchronous in WebKit. Wait for this file, not
  // the previous result's identical ready message.
  await expect(page.locator('#utility-background-name')).toHaveText(file.name);
  await expect(page.locator('#utility-background-options')).toBeEnabled();
  await expect(page.locator('#utility-status')).toContainText('Ready to download');
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
  await background(page,await pngFile(page,'blue'));
  await expect(page.locator('#utility-status')).toContainText('Ready to download');
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
  await background(page,gifFile(true));
  await expect(page.locator('#utility-status')).toContainText('Ready to download');await expect(page.locator('#utility-download')).toBeVisible();
  const reader=new GifReader(await download(page));
  expect(reader.numFrames()).toBe(5);expect(reader.loopCount()).toBe(2);
  expect(Array.from({length:5},(_,i)=>reader.frameInfo(i).delay)).toEqual([5,2,3,5,5]);
  for(let i=0;i<5;i++){
    const pixels=new Uint8Array(32);reader.decodeAndBlitFrameRGBA(i,pixels);
    expect(Array.from(pixels.slice(0,4))).toEqual(i<2?[255,0,0,255]:[0,255,0,255]);
    expect(Array.from(pixels.slice(8,12))).toEqual(i===0||i===3?[0,0,255,255]:[0,255,0,255]);
  }
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
  await background(page,await pngFile(page,'blue'));
  await expect(page.locator('#utility-status')).toContainText('Ready to download');
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
  await page.locator('#utility-exclude').click();
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

for (const slug of ['remove-image-background','change-image-background','remove-gif-background','swap-gif-background']) {
  test(`${slug}: click guidance, selection overlay, and refinement`,async({page},testInfo)=>{
    const isGif=slug.includes('gif');const server=await service(page,isGif?2:1);
    await load(page,slug,isGif?gifFile(false,128,64):await pngFile(page,'red',128,64));
    await page.locator('#utility-exclude').click();
    await expect(page.locator('#utility-exclude')).toHaveAttribute('aria-pressed','true');
    const canvas=page.locator('#utility-canvas'),box=await canvas.boundingBox();
    await canvas.click({position:{x:box.width*.75,y:box.height*.5}});
    await segment(page);
    await expect(page.locator('#utility-overlay-wrap')).toBeVisible();
    if (slug==='swap-gif-background') {
      await page.locator('summary').click();
      await page.evaluate(()=>window.scrollTo(0,0));
      await page.screenshot({path:testInfo.outputPath('desktop.png'),fullPage:true});
      await page.setViewportSize({width:390,height:844});
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
      await page.screenshot({path:testInfo.outputPath('mobile.png'),fullPage:true});
      await page.setViewportSize({width:1280,height:720});
    }
    const highlighted=await canvas.evaluate(c=>Array.from(c.getContext('2d').getImageData(0,0,1,1).data));
    expect(highlighted[1]).toBeGreaterThan(50);
    await page.locator('#utility-overlay').uncheck();
    expect(await canvas.evaluate(c=>Array.from(c.getContext('2d').getImageData(0,0,1,1).data))).toEqual([255,0,0,255]);
    const point=server.calls.find(c=>c.kind==='submit').body.objects[0].points[1];
    expect(point.label).toBe(0);
    // Browsers round pointer coordinates to viewport pixels.
    expect(Math.abs(point.x-.75)).toBeLessThanOrEqual(1/box.width);
    expect(Math.abs(point.y-.5)).toBeLessThanOrEqual(1/box.height);
    await page.locator('#utility-add-object').click();
    await expect(page.locator('#utility-keep')).toHaveAttribute('aria-pressed','true');
    await canvas.click({position:{x:box.width*.25,y:box.height*.5}});
    await expect(page.locator('#utility-download')).toBeHidden();
    await expect(page.locator('#utility-overlay-wrap')).toBeHidden();
    await expect(page.locator('#utility-status')).toContainText('Selection changed');
  });
}

test('swapping a GIF with a colorful image preserves colors, positions, and frames',async({page})=>{
  const server=await service(page,2);
  const bytes=Buffer.alloc(8192),writer=new GifWriter(bytes,64,32,{loop:2});
  for(const index of [0,1]) writer.addFrame(0,0,64,32,new Uint8Array(64*32).fill(index),{palette:[0xff0000,0x00ff00],delay:9,disposal:2});
  await load(page,'swap-gif-background',{name:'colors.gif',mimeType:'image/gif',buffer:bytes.subarray(0,writer.end())});
  await segment(page);
  const b64=await page.evaluate(()=>{
    const c=document.createElement('canvas');c.width=64;c.height=32;const ctx=c.getContext('2d'),im=ctx.createImageData(64,32);
    for(let y=0;y<32;y++)for(let x=0;x<64;x++)im.data.set([40+x*3,60+y*5,200,255],(y*64+x)*4);
    ctx.putImageData(im,0,0);return c.toDataURL().split(',')[1];
  });
  await background(page,{name:'gradient.png',mimeType:'image/png',buffer:Buffer.from(b64,'base64')});
  await expect(page.locator('#utility-status')).toContainText('Ready to download');
  const reader=new GifReader(await download(page));
  expect(reader.numFrames()).toBe(2);expect(reader.loopCount()).toBe(2);
  for(let i=0;i<2;i++){
    const pixels=new Uint8Array(64*32*4);reader.decodeAndBlitFrameRGBA(i,pixels);
    expect(reader.frameInfo(i).delay).toBe(9);
    const p=(16*64+16)*4;
    expect(Array.from(pixels.slice(p,p+4))).toEqual(i?[0,255,0,255]:[255,0,0,255]);
    for(const [x,y] of [[40,4],[52,16],[60,28]]) {
      const offset=(y*64+x)*4,expected=[40+x*3,60+y*5,200];
      expected.forEach((value,c)=>expect(Math.abs(pixels[offset+c]-value)).toBeLessThan(12));
    }
  }
  expect(server.calls.filter(c=>c.kind==='submit')).toHaveLength(1);
});

test('color changes refresh automatically and replacing the source resets file background mode',async({page})=>{
  const server=await service(page);await load(page,'change-image-background');await segment(page);
  await page.locator('#utility-color').fill('#0000ff');
  await expect(page.locator('#utility-status')).toContainText('Ready to download');
  expect((await pngPixels(page,await download(page))).slice(8,12)).toEqual([0,0,255,255]);
  await background(page,await pngFile(page,'green'));
  await expect(page.locator('#utility-background-name')).toHaveText('image.png');
  await expect(page.locator('#utility-new')).toBeEnabled();
  await expect(page.locator('#utility-status')).toContainText('Ready to download');
  expect(server.calls.filter(c=>c.kind==='submit')).toHaveLength(1);
  await page.locator('#utility-file').setInputFiles(await pngFile(page));
  await expect(page.locator('#utility-status')).toContainText('Select the objects');
  await expect(page.locator('#utility-background-mode')).toHaveValue('color');
  await page.locator('#utility-add-point').click();await segment(page);
});

test('empty masks explain how to retry instead of showing a blank background as success',async({page})=>{
  await service(page);await load(page,'remove-image-background');
  const header=Buffer.from(JSON.stringify({version:1,width:4,height:2,frames:1}));
  const bytes=Buffer.alloc(5+header.length);bytes.writeUInt32LE(header.length);header.copy(bytes,4);
  await page.route('**/mock-masks',route=>route.fulfill({status:200,body:zlib.gzipSync(bytes)}));
  await page.locator('#utility-segment').click();
  await expect(page.locator('#utility-status')).toContainText('No subject was found');
  await expect(page.locator('#utility-download')).toBeHidden();
  await expect(page.locator('#utility-options')).toBeEnabled();
});

test('GIF removal preserves multicolor coalesced frames with different local palettes',async({page})=>{
  await service(page,2,{mask:255});
  const bytes=Buffer.alloc(20000),writer=new GifWriter(bytes,64,32,{loop:0});
  const paletteA=Array.from({length:256},(_,i)=>i<<16|100<<8|200);
  const paletteB=Array.from({length:256},(_,i)=>i<<16|200<<8|100);
  writer.addFrame(0,0,64,32,Uint8Array.from({length:2048},(_,i)=>i%256),{palette:paletteA,delay:8,disposal:1});
  writer.addFrame(32,0,32,32,Uint8Array.from({length:1024},(_,i)=>i%256),{palette:paletteB,delay:12,disposal:1});
  await load(page,'remove-gif-background',{name:'local-palettes.gif',mimeType:'image/gif',buffer:bytes.subarray(0,writer.end())});await segment(page);
  const reader=new GifReader(await download(page)),pixels=new Uint8Array(8192);reader.decodeAndBlitFrameRGBA(1,pixels);
  expect(reader.numFrames()).toBe(2);expect(reader.frameInfo(1).delay).toBe(12);
  for(const [x,y] of [[8,4],[20,12],[40,20],[56,28]]){
    const expected=x<32?[(y*64+x)%256,100,200]:[(y*32+x-32)%256,200,100];
    expected.forEach((v,c)=>expect(Math.abs(pixels[(y*64+x)*4+c]-v)).toBeLessThan(10));
  }
});

function longGif(width=512,height=512,count=270) {
  const bytes=Buffer.alloc(2*1024*1024),writer=new GifWriter(bytes,width,height,{loop:2});
  const pixels=new Uint8Array(width*height);
  for(let i=0;i<count;i++){
    pixels.fill(i%2);
    writer.addFrame(0,0,width,height,pixels,{palette:[0xff0000,0x00ff00],delay:7,disposal:2});
  }
  return bytes.subarray(0,writer.end());
}

test('a 39 MB GIF whose expanded frames exceed 256 MiB loads as source and replacement',async({page})=>{
  const gif=longGif();
  // A valid comment brings the compressed file to 39 MB without expensive test
  // noise generation. The 270 real frames already exceed the old RGBA budget.
  const commentBlocks=Math.ceil((39*1024*1024-gif.length)/256);
  const bytes=Buffer.alloc(gif.length+3+commentBlocks*256);
  gif.copy(bytes,0,0,gif.length-1);let p=gif.length-1;
  bytes[p++]=33;bytes[p++]=254;
  for(let i=0;i<commentBlocks;i++){bytes[p]=255;p+=256;}
  bytes[p++]=0;bytes[p++]=59;
  expect(bytes.length).toBeLessThan(100*1024*1024);
  expect(512*512*4*(270+3)).toBeGreaterThan(256*1024*1024);
  const file={name:'39mb.gif',mimeType:'image/gif',buffer:bytes.subarray(0,p)};
  await load(page,'swap-gif-background',file);
  await expect(page.locator('#utility-info')).toContainText('270 frames');
  await page.locator('#utility-background-mode').selectOption('file');
  await page.locator('#utility-background').setInputFiles(file);
  await expect(page.locator('#utility-background-name')).toHaveText('39mb.gif');
  await expect(page.locator('#utility-status')).toContainText('Background ready');
  await expect(page.locator('#utility-options')).toBeEnabled();
});

test('streamed frames all export and can be re-exported under a bounded pixel budget',async({page})=>{
  // Lower the worker budget to exercise the former limit quickly with actual
  // decoding/encoding. The old 19 RGBA frames need >1 MiB; streaming needs <1 MiB.
  await page.route('**/background-worker.js',async route=>{
    const response=await route.fetch();
    await route.fulfill({response,body:(await response.text()).replace('256 * 1024 * 1024','1024 * 1024')});
  });
  const server=await service(page,16),file={name:'streamed.gif',mimeType:'image/gif',buffer:longGif(128,128,16)};
  await load(page,'remove-gif-background',file);await segment(page);
  for(let pass=0;pass<2;pass++){
    const reader=new GifReader(await download(page));
    expect(reader.numFrames()).toBe(16);expect(reader.loopCount()).toBe(2);
    for(let i=0;i<16;i++){
      const pixels=new Uint8Array(128*128*4);reader.decodeAndBlitFrameRGBA(i,pixels);
      expect(Array.from(pixels.slice(0,4))).toEqual(i%2?[0,255,0,255]:[255,0,0,255]);
      expect(pixels[(96*4)+3]).toBe(0);expect(reader.frameInfo(i).delay).toBe(7);
    }
    if(!pass){await page.locator('#utility-apply').click();await expect(page.locator('#utility-download')).toBeVisible();}
  }
  expect(server.calls.filter(c=>c.kind==='submit')).toHaveLength(1);
});

test('dimension limits distinguish editing memory from the file-size limit and allow recovery',async({page})=>{
  const bytes=Buffer.from(gifFile().buffer);bytes.writeUInt16LE(65535,6);bytes.writeUInt16LE(65535,8);
  await page.goto('/remove-gif-background/');
  await page.locator('#utility-file').setInputFiles({name:'huge-dimensions.gif',mimeType:'image/gif',buffer:bytes});
  await expect(page.locator('#utility-status')).toContainText('100 MB limit is for file size');
  await expect(page.locator('#utility-status')).toContainText('65535 × 65535');
  await expect(page.locator('#utility-upload')).toBeEnabled();
  await page.locator('#utility-file').setInputFiles(gifFile());
  await expect(page.locator('#utility-status')).toContainText('Select the objects');
});

for(const slug of ['remove-image-background','change-image-background','remove-gif-background','swap-gif-background']) {
  test(`${slug}: exclude-only selection explains and recovers without losing points`,async({page})=>{
    const isGif=slug.includes('gif'),server=await service(page,isGif?2:1);
    await load(page,slug,isGif?gifFile():undefined);
    await page.locator('#utility-clear').click();
    await page.locator('#utility-exclude').click();
    await expect(page.locator('#utility-selection-help')).toContainText('needs a Keep point');
    await page.locator('#utility-add-point').click();
    await expect(page.locator('#utility-selection-warning')).toContainText('only has Exclude points');
    await page.locator('#utility-segment').click();
    expect(server.calls).toHaveLength(0);
    await expect(page.locator('#utility-keep')).toHaveAttribute('aria-pressed','true');
    await expect(page.locator('#utility-points')).toContainText('1 point');
    await page.locator('#utility-x').fill('50');
    await page.locator('#utility-add-point').click();
    await expect(page.locator('#utility-selection-warning')).toBeHidden();
    await segment(page);
    expect(server.calls.find(c=>c.kind==='submit').body.objects[0].points.map(p=>p.label)).toEqual([0,1]);
  });
}

test('missing Keep recovery selects the correct subject and preserves other subjects',async({page})=>{
  const server=await service(page);await load(page,'remove-image-background');
  await page.locator('#utility-add-object').click();
  await page.locator('#utility-exclude').click();await page.locator('#utility-add-point').click();
  await page.locator('#utility-object').selectOption('0');
  await page.locator('#utility-segment').click();
  await expect(page.locator('#utility-object')).toHaveValue('1');
  await expect(page.locator('#utility-selection-warning')).toContainText('Subject 2');
  expect(server.calls).toHaveLength(0);
  await page.locator('#utility-add-point').click();await segment(page);
  expect(server.calls.find(c=>c.kind==='submit').body.objects.map(o=>o.points.map(p=>p.label))).toEqual([[1],[0,1]]);
});
