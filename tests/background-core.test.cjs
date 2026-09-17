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
