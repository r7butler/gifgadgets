const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const {GifWriter,GifReader}=require('../frontend/vendor/omggif.js');
const context=vm.createContext({postMessage(){}});
vm.runInContext(fs.readFileSync('frontend/gif-codec.js','utf8'),context);
function fixture() {
  const bytes=new Uint8Array(4096),writer=new GifWriter(bytes,3,2,{loop:2});
  const palette=[0,0xff0000,0x00ff00,0x0000ff];
  writer.addFrame(0,0,3,2,[1,2,0,3,1,0],{palette,transparent:0,delay:7,disposal:1});
  writer.addFrame(1,0,1,1,[3],{palette,transparent:0,delay:13,disposal:3});
  writer.addFrame(0,1,1,1,[2],{palette,transparent:0,delay:25,disposal:2});
  writer.addFrame(2,1,1,1,[1],{palette,transparent:0,delay:4,disposal:1});
  return bytes.slice(0,writer.end());
}
test('streaming disposal restores prior pixels, clears rectangles, and restarts on rewind',()=>{
  const bytes=fixture(),reader=new GifReader(bytes),parsed=context.blocks(bytes,false);
  const cursor=context.createFrameCursor(bytes,reader,parsed);
  const first=cursor(0),firstCopy=first.slice();
  assert.deepEqual(Array.from(first.slice(4,8)),[0,255,0,255]);
  assert.equal(cursor(1),first,'forward decoding must reuse the pixel buffer');
  assert.deepEqual(Array.from(first.slice(4,8)),[0,0,255,255]);
  assert.deepEqual(Array.from(cursor(2).slice(4,8)),[0,255,0,255]);
  assert.deepEqual(Array.from(cursor(3).slice(12,16)),[0,0,0,0]);
  assert.deepEqual(Array.from(cursor(0)),Array.from(firstCopy));
  assert.deepEqual(Array.from(cursor(3).slice(20,24)),[255,0,0,255]);
  assert.throws(()=>cursor(-1),/Invalid GIF frame/);
});
test('collecting frames still owns distinct snapshots and preserves delays',()=>{
  const bytes=fixture(),reader=new GifReader(bytes),frames=context.decodeFrames(bytes,reader,context.blocks(bytes));
  assert.deepEqual(Array.from(frames,f=>f.delay),[7,13,25,4]);
  assert.notEqual(frames[0].pixels.buffer,frames[1].pixels.buffer);
  assert.deepEqual(Array.from(frames[0].pixels.slice(4,8)),[0,255,0,255]);
  assert.deepEqual(Array.from(frames[1].pixels.slice(4,8)),[0,0,255,255]);
});
test('read-only block parsing retains views instead of duplicating the compressed file',()=>{
  const bytes=fixture(),views=context.blocks(bytes,false),copies=context.blocks(bytes);
  assert.equal(views.header.buffer,bytes.buffer);
  for(let i=0;i<views.list.length;i++){
    assert.equal(views.list[i].buffer,bytes.buffer);
    assert.notEqual(copies.list[i].buffer,bytes.buffer);
    assert.deepEqual(Array.from(views.list[i]),Array.from(copies.list[i]));
  }
});
