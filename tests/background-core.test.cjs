const {test}=require('node:test');
const assert=require('node:assert/strict');
require('../frontend/background-core.js');
const {readMasks,cutout,timeline}=globalThis.BackgroundCore;
function masks(bytes,count=1) {
  const header=Buffer.from(JSON.stringify({version:1,width:2,height:2,frames:count}));
  const data=Buffer.alloc(4+header.length+bytes.length); data.writeUInt32LE(header.length); header.copy(data,4); Buffer.from(bytes).copy(data,4+header.length);
  return data.buffer.slice(data.byteOffset,data.byteOffset+data.byteLength);
}
test('bitpacked masks preserve foreground alpha and clear only rejected pixels',()=>{
  const source=new Uint8ClampedArray([255,0,0,255,0,255,0,128,0,0,255,255,255,255,255,0]);
  const out=cutout(source,2,2,readMasks(masks([0b11000000]),1),0);
  assert.deepEqual([out[3],out[7],out[11],out[15]],[255,128,0,0]);
  assert.equal(source[11],255);
});
test('masks reject missing frames and incorrect dimensions',()=>{
  assert.throws(()=>readMasks(masks([255],2),2),/missing/);
  assert.throws(()=>readMasks(masks([255]),2),/match/);
});
test('animated background timing merges boundaries and keeps foreground duration',()=>{
  const result=[...timeline([{delay:7},{delay:13}],[{delay:5},{delay:5}])];
  assert.deepEqual(result.map(f=>f.delay),[5,2,3,5,5]);
  assert.equal(result.reduce((sum,f)=>sum+f.delay,0),20);
  assert.deepEqual(result.map(f=>f.background),[0,1,1,0,1]);
  assert.deepEqual(result.map(f=>f.foreground),[0,0,1,1,1]);
});
test('no animation is silently capped and removal preserves zero delays',()=>{
  assert.equal([...timeline(Array.from({length:5001},()=>({delay:1})),null)].length,5001);
  assert.deepEqual([...timeline([{delay:0},{delay:3}],null)].map(f=>f.delay),[0,3]);
});

/* A mask of arbitrary dimensions, for the cases the 2x2 helper cannot express. */
function maskOf(bytes,{width=2,height=2,frames=1,version=1}={}) {
  const header=Buffer.from(JSON.stringify({version,width,height,frames}));
  const data=Buffer.alloc(4+header.length+bytes.length); data.writeUInt32LE(header.length); header.copy(data,4); Buffer.from(bytes).copy(data,4+header.length);
  return data.buffer.slice(data.byteOffset,data.byteOffset+data.byteLength);
}
const alpha=pixels=>Array.from(pixels).filter((_,i)=>i%4===3);

test('a mask smaller than the image is scaled across it, not applied to one corner',()=>{
  // The segmentation service caps masks at 1024px, so any larger image is
  // cut out through a mask coarser than itself. Foreground on one diagonal.
  const mask=readMasks(maskOf([0b10010000]),1);
  const out=cutout(new Uint8ClampedArray(4*4*4).fill(255),4,4,mask,0);
  assert.deepEqual(alpha(out),[255,255,0,0,
                              255,255,0,0,
                              0,0,255,255,
                              0,0,255,255]);
  // The same mask over a 2x1 image samples the top row only, without reading
  // past the end of the mask.
  assert.deepEqual(alpha(cutout(new Uint8ClampedArray(8).fill(255),2,1,mask,0)),[255,0]);
});

test('each frame is cut out with its own mask',()=>{
  // One mask per frame, opposite diagonals. Reading the wrong frame's mask
  // would not fail, it would quietly cut the wrong half out of the animation.
  const masks=readMasks(maskOf([0b10010000,0b01100000],{frames:2}),2);
  const opaque=()=>new Uint8ClampedArray(2*2*4).fill(255);
  assert.deepEqual(alpha(cutout(opaque(),2,2,masks,0)),[255,0,0,255]);
  assert.deepEqual(alpha(cutout(opaque(),2,2,masks,1)),[0,255,255,0]);
});

test('a mask that is not exactly what was asked for is refused, never guessed at',()=>{
  const cases=[
    [maskOf([0b11000000],{version:2}),/match/,'a newer mask format'],
    [maskOf([0b11000000],{width:0}),/match/,'a zero-width mask'],
    [maskOf([0b11000000],{width:2048,height:2048}),/match/,'a mask past the size cap'],
    [maskOf([0b11000000,0b11000000]),/missing/,'trailing bytes beyond one frame'],
    [new Uint8Array([1,2,3]).buffer,/Incomplete/,'a truncated response'],
  ];
  for (const [buffer,message,what] of cases) assert.throws(()=>readMasks(buffer,1),message,what);
  // A header length that runs past the payload must not read adjacent memory.
  const short=Buffer.alloc(8); short.writeUInt32LE(9000);
  assert.throws(()=>readMasks(short.buffer.slice(short.byteOffset,short.byteOffset+8),1),/Invalid mask header/);
});

test('a background shorter or longer than the foreground still covers it exactly',()=>{
  // A two-frame background under a longer foreground repeats to fill it.
  const short=[...timeline([{delay:10},{delay:10},{delay:10}],[{delay:5},{delay:5}])];
  assert.equal(short.reduce((sum,f)=>sum+f.delay,0),30,'the foreground duration is what plays');
  assert.deepEqual(short.map(f=>f.background),[0,1,0,1,0,1]);
  assert.deepEqual(short.map(f=>f.foreground),[0,0,1,1,2,2]);
  // A background longer than the foreground is simply cut off at the end.
  const long=[...timeline([{delay:4}],[{delay:3},{delay:3},{delay:3}])];
  assert.equal(long.reduce((sum,f)=>sum+f.delay,0),4);
  assert.deepEqual(long.map(f=>f.background),[0,1]);
  // A single-frame background is a still image and never splits the timeline.
  assert.deepEqual([...timeline([{delay:7},{delay:13}],[{delay:5}])].map(f=>f.delay),[7,13]);
});
