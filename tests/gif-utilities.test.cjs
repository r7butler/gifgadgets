const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {GifWriter, GifReader} = require('../frontend/vendor/omggif.js');
const context = vm.createContext({console, Uint8Array, Uint8ClampedArray, postMessage() {}});
context.self = context;
context.importScripts = (...paths) => paths.forEach(p => vm.runInContext(fs.readFileSync('frontend' + p, 'utf8'), context));
vm.runInContext(fs.readFileSync('frontend/gif-utilities-worker.js', 'utf8'), context);
function fixture() {
  const data = new Uint8Array(4096), w = new GifWriter(data, 3, 2, {loop: 2});
  const palette = [0, 0xff0000, 0x00ff00, 0x0000ff];
  w.addFrame(0, 0, 3, 2, [1,2,0,3,1,0], {palette, transparent:0, delay:7, disposal:1});
  w.addFrame(1, 0, 1, 1, [3], {palette, transparent:0, delay:13, disposal:3});
  w.addFrame(0, 1, 1, 1, [2], {palette, transparent:0, delay:25, disposal:2});
  return data.slice(0, w.end());
}
function run(options, data = fixture()) { return context.transform(data, options).bytes; }
function pixels(bytes, i) { const r = new GifReader(bytes), p = new Uint8Array(r.width * r.height * 4); r.decodeAndBlitFrameRGBA(i,p); return p; }
test('speed changes timing only; looping edits preserve image blocks', () => {
  const original = fixture(), output = run({tool:'gif-speed',rate:2});
  const r = new GifReader(output);
  assert.deepEqual([0,1,2].map(i => r.frameInfo(i).delay), [4,7,13]);
  assert.equal(r.loopCount(),2);
  const images = b => Array.from(context.blocks(b).list).filter(b=>b[0]===44).map(b=>Buffer.from(b));
  assert.deepEqual(images(output),images(original));
  for (const repeats of [-1,0,3,65535]) {
    const b = run({tool:'gif-loop',repeats});
    assert.equal(new GifReader(b).loopCount(),repeats === -1 ? null : repeats);
    assert.deepEqual(images(b),images(original));
  }
});
test('reverse and trim preserve composed pixels, disposal and variable timing', () => {
  const baseline = run({tool:'trim-gif',start:1,end:3});
  const reversed = run({tool:'reverse-gif'}), r = new GifReader(reversed);
  assert.equal(r.numFrames(),3); assert.equal(r.loopCount(),2);
  for (let i=0;i<3;i++) assert.deepEqual(pixels(reversed,i),pixels(baseline,2-i));
  assert.deepEqual([0,1,2].map(i=>r.frameInfo(i).delay),[25,13,7]);
  const trimmed = run({tool:'trim-gif',start:2,end:3});
  assert.deepEqual(pixels(trimmed,0),pixels(baseline,1));
  assert.deepEqual(Array.from(pixels(baseline,2).slice(4,8)),[0,255,0,255]); // disposal 3 restored green
  assert.deepEqual(Array.from(pixels(baseline,0).slice(8,12)),[0,0,0,0]);
  assert.equal(new GifReader(run({tool:'reverse-gif',boomerang:true})).numFrames(),4);
});
test('rotation and flips map actual pixels and preserve timing', () => {
  const normal = pixels(run({tool:'trim-gif',start:1,end:3}),0);
  for (const angle of [90,180,270]) {
    const bytes = run({tool:'rotate-gif',angle}), r = new GifReader(bytes), out = pixels(bytes,0);
    assert.equal(r.width,angle===180?3:2); assert.equal(r.height,angle===180?2:3);
    assert.equal(r.frameInfo(1).delay,13);
    for(let y=0;y<2;y++) for(let x=0;x<3;x++) {
      const dx=angle===90?1-y:angle===180?2-x:y, dy=angle===90?x:angle===180?1-y:2-x;
      assert.deepEqual(out.slice((dy*r.width+dx)*4,(dy*r.width+dx)*4+4),normal.slice((y*3+x)*4,(y*3+x)*4+4));
    }
  }
  for(const axis of ['horizontal','vertical']) {
    const out=pixels(run({tool:'flip-gif',axis}),0);
    for(let y=0;y<2;y++) for(let x=0;x<3;x++) {
      const dx=axis==='horizontal'?2-x:x,dy=axis==='vertical'?1-y:y;
      assert.deepEqual(out.slice((dy*3+dx)*4,(dy*3+dx)*4+4),normal.slice((y*3+x)*4,(y*3+x)*4+4));
    }
  }
});
test('rejects malformed input, invalid ranges and excessive decoded memory', () => {
  assert.throws(()=>run({tool:'reverse-gif'},new Uint8Array([1,2])));
  assert.throws(()=>run({tool:'gif-speed',rate:0}));
  assert.throws(()=>run({tool:'trim-gif',start:3,end:2}));
  const huge=fixture(); huge[6]=255;huge[7]=255;huge[8]=255;huge[9]=255;
  assert.throws(()=>run({tool:'reverse-gif'},huge),/memory/);
});
test('single-frame and zero-delay GIFs retain their timing and do not gain frames', () => {
  const buffer = new Uint8Array(1024), writer = new GifWriter(buffer,1,1);
  writer.addFrame(0,0,1,1,[0],{palette:[0,0xffffff],delay:0});
  const bytes = buffer.slice(0,writer.end());
  for (const options of [{tool:'gif-speed',rate:3},{tool:'reverse-gif',boomerang:true},{tool:'trim-gif',start:1,end:1}]) {
    const r=new GifReader(run(options,bytes));
    assert.equal(r.numFrames(),1);assert.equal(r.frameInfo(0).delay,0);assert.equal(r.loopCount(),null);
  }
});
test('color reduction handles composed frames exceeding 256 colors', () => {
  const rgba = new Uint8Array(300*4);
  for(let i=0;i<299;i++) {rgba[i*4]=i%256;rgba[i*4+1]=Math.floor(i/256)*100;rgba[i*4+2]=i%17;rgba[i*4+3]=255;}
  const result=context.paletteFrame(rgba);
  assert.equal(result.quantized,true); assert.equal(result.transparent,0); assert.equal(result.indexed[299],0);
  assert.ok(result.palette.length<=256);
  for(let i=0;i<299;i++) assert.ok(result.indexed[i]>0 && result.indexed[i]<result.palette.length);
});
test('restore-background disposal clears the prior frame rectangle', () => {
  const buffer=new Uint8Array(2048),writer=new GifWriter(buffer,2,1);
  const palette=[0,0xff0000,0x00ff00,0x0000ff];
  writer.addFrame(0,0,1,1,[1],{palette,transparent:0,disposal:2,delay:10});
  writer.addFrame(1,0,1,1,[2],{palette,transparent:0,disposal:1,delay:20});
  const bytes=run({tool:'trim-gif',start:2,end:2},buffer.slice(0,writer.end()));
  assert.deepEqual(Array.from(pixels(bytes,0)),[0,0,0,0,0,255,0,255]);
});
