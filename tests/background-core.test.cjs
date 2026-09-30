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

/*
 * The GIF editor keeps a cutout in the geometry its masks were made for and
 * follows later edits with frame maps. These simulate each edit the way the
 * editor's canvas code moves pixels, then check every pixel still finds its
 * own mask bit.
 */
const {IDENTITY,compose,invert,mapPoint,undoMap,cutoutMapped}=globalThis.BackgroundCore;
function labelled(width,height) {
  return {width,height,at:Array.from({length:width*height},(_,i)=>({x:i%width,y:Math.floor(i/width)}))};
}
function edited(image,edit) {
  const {width:w,height:h,at}=image, get=(x,y)=>at[y*w+x];
  if(edit.rotate===90) return {width:h,height:w,at:Array.from({length:w*h},(_,i)=>{const x=i%h,y=Math.floor(i/h);return get(y,h-1-x);})};
  if(edit.rotate===270) return {width:h,height:w,at:Array.from({length:w*h},(_,i)=>{const x=i%h,y=Math.floor(i/h);return get(w-1-y,x);})};
  if(edit.flip==='h') return {width:w,height:h,at:at.map((_,i)=>get(w-1-i%w,Math.floor(i/w)))};
  if(edit.flip==='v') return {width:w,height:h,at:at.map((_,i)=>get(i%w,h-1-Math.floor(i/w)))};
  const c=edit.crop;
  return {width:c.w,height:c.h,at:Array.from({length:c.w*c.h},(_,i)=>get(c.x+i%c.w,c.y+Math.floor(i/c.w)))};
}
function patternMask(width,height) {
  // Irregular, so a mirrored or transposed lookup cannot pass by symmetry.
  const keep=(x,y)=>(x*7+y*3+x*y)%5<2, bits=new Uint8Array(Math.ceil(width*height/8));
  for(let y=0;y<height;y++) for(let x=0;x<width;x++) if(keep(x,y)) { const i=y*width+x; bits[i>>3]|=128>>(i&7); }
  return {mask:readMasks(maskOf(bits,{width,height}),1),keep};
}

test('a cutout follows the frames through rotations, flips and crops',()=>{
  const {mask,keep}=patternMask(7,5);
  const chains=[[{rotate:90}],[{rotate:270}],[{flip:'h'}],[{flip:'v'}],
    [{rotate:90},{flip:'h'},{crop:{x:1,y:2,w:3,h:4}}],
    [{crop:{x:2,y:1,w:4,h:3}},{rotate:270},{rotate:270},{flip:'v'}]];
  for(const chain of chains) {
    let image=labelled(7,5), map=IDENTITY;
    for(const edit of chain) {
      if(edit.crop) edit.crop={...edit.crop,width:image.width,height:image.height};
      image=edited(image,edit); map=compose(map,undoMap(edit));
    }
    const pixels=new Uint8ClampedArray(image.width*image.height*4).fill(255);
    const out=cutoutMapped(pixels,new Uint8ClampedArray(pixels.length),image.width,image.height,mask,0,map);
    assert.deepEqual(alpha(out),image.at.map(p=>keep(p.x,p.y)?255:0),JSON.stringify(chain));
  }
});

test('frame maps compose and invert', ()=>{
  const map=[[{rotate:90}],[{flip:'h'}],[{crop:{x:3,y:1,w:5,h:2,width:9,height:4}}]]
    .reduce((m,[edit])=>compose(m,undoMap(edit)),IDENTITY);
  const round=m=>m.map(v=>Math.round(v*1e9)/1e9+0);
  assert.deepEqual(round(compose(map,invert(map))),IDENTITY);
  const p=mapPoint(map,0.25,0.75), back=mapPoint(invert(map),p.x,p.y);
  assert.ok(Math.abs(back.x-0.25)<1e-9 && Math.abs(back.y-0.75)<1e-9);
  assert.deepEqual(undoMap({resize:true}),IDENTITY);
});

test('the mapped cutout matches the plain one before any edit, and leaves the source intact',()=>{
  const mask=readMasks(maskOf([0b10010000]),1);
  const source=new Uint8ClampedArray(4*4*4).fill(255);
  const out=cutoutMapped(source,new Uint8ClampedArray(source.length),4,4,mask,0,IDENTITY);
  assert.deepEqual(alpha(out),alpha(cutout(source,4,4,mask,0)));
  assert.ok(alpha(source).every(a=>a===255));
});

test('the transparency key avoids colors the picture uses, and keying is all or nothing',()=>{
  const {keyColor,keyOut}=globalThis.BackgroundCore;
  const frame=(...colors)=>new Uint8ClampedArray(colors.flatMap(([r,g,b,a=255])=>[r,g,b,a]));
  // Magenta is the default; a magenta subject moves the key elsewhere.
  assert.equal(keyColor([frame([10,20,30])]),0xff00ff);
  assert.notEqual(keyColor([frame([250,5,250]),frame([200,40,210])]),0xff00ff);
  // Cleared pixels do not count: they are what the key stands for.
  assert.equal(keyColor([frame([255,0,255,0],[10,20,30])]),0xff00ff);
  const pixels=keyOut(frame([1,2,3,0],[4,5,6,127],[7,8,9,128],[10,11,12,255]),0x00ff00);
  assert.deepEqual(Array.from(pixels),[0,255,0,255, 0,255,0,255, 7,8,9,255, 10,11,12,255]);
});
