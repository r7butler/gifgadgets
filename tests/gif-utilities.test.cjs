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

// ── Batch two ────────────────────────────────────────────
function runBatch(options, data = fixture(), extra = []) {
  return context.transformBatch(data, options, extra);
}

test('extract-frames selects by range, exports all, and caps the count', () => {
  const picked = runBatch({tool:'extract-frames', extract:'selected', selection:'1,3'});
  // frames comes from the vm realm, so copy it before a strict deep compare.
  assert.deepEqual(Array.from(picked.frames, f => f.number), [1, 3]);
  assert.equal(picked.width, 3);
  assert.equal(picked.height, 2);
  // Composed RGBA, not raw frame deltas: every frame is a full canvas.
  picked.frames.forEach(f => assert.equal(f.pixels.length, 3 * 2 * 4));

  assert.equal(runBatch({tool:'extract-frames', extract:'all'}).frames.length, 3);
  assert.throws(() => runBatch({tool:'extract-frames', extract:'selected', selection:'4'}), /outside this GIF/);
  assert.throws(() => runBatch({tool:'extract-frames', extract:'selected', selection:''}), /frame numbers or ranges/);
});

test('remove-gif-frames preserves or shortens duration and keeps a frame', () => {
  // Fixture delays are 7, 13, 25 hundredths.
  const preserved = new GifReader(runBatch(
    {tool:'remove-gif-frames', selection:'2', duration:'preserve'}).bytes);
  assert.equal(preserved.numFrames(), 2);
  // The removed frame's time is added to the preceding retained frame.
  assert.deepEqual([0,1].map(i => preserved.frameInfo(i).delay), [7 + 13, 25]);

  const shortened = new GifReader(runBatch(
    {tool:'remove-gif-frames', selection:'2', duration:'shorten'}).bytes);
  assert.deepEqual([0,1].map(i => shortened.frameInfo(i).delay), [7, 25]);

  // A removed leading frame has nothing before it, so its time moves forward.
  const leading = new GifReader(runBatch(
    {tool:'remove-gif-frames', selection:'1', duration:'preserve'}).bytes);
  assert.equal(leading.frameInfo(0).delay, 7 + 13);

  assert.throws(() => runBatch({tool:'remove-gif-frames', selection:'1-3', duration:'shorten'}), /at least one frame/);
  assert.throws(() => runBatch({tool:'remove-gif-frames', selection:'2', duration:'nope'}), /duration mode/);
});

/**
 * An opaque 8×4 GIF whose frame i shows color i in the pixel at column i % 8,
 * on a gray field, so every frame differs from the last only in that spot.
 */
function frameRateFixture(delays) {
  const data = new Uint8Array(65536), w = new GifWriter(data, 8, 4, {loop: 0});
  const palette = [0x808080].concat(delays.map((_, i) => 0x010000 * (i + 1) + 0x40)), size = 2 ** Math.ceil(Math.log2(palette.length));
  while (palette.length < size) palette.push(0);
  delays.forEach((delay, i) => {
    const indexed = new Uint8Array(32); indexed[i % 8] = i + 1;
    w.addFrame(0, 0, 8, 4, indexed, {palette, delay});
  });
  return data.slice(0, w.end());
}
/** Composed RGBA of every frame, with each frame's timing and stored rectangle. */
function composed(bytes) {
  const reader = new GifReader(bytes);
  // decodeFrames comes from the vm realm, so copy it before strict deep compares.
  return Array.from(context.decodeFrames(bytes, reader, context.blocks(bytes))).map((f, i) => {
    const info = reader.frameInfo(i);
    return {pixels: Array.from(f.pixels), delay: f.delay, width: info.width, height: info.height, disposal: info.disposal};
  });
}

test('gif-frame-rate keeps the frame on screen at each step and the total length', () => {
  // 10 frames of 4 hundredths: 25 fps over 40 hundredths.
  const data = frameRateFixture(Array(10).fill(4)), source = composed(data);
  const out = runBatch({tool:'gif-frame-rate', fps:10}, data);
  const frames = composed(out.bytes);
  // Steps at 0, 10, 20 and 30 fall in frames 0, 2, 5 and 7.
  assert.deepEqual(frames.map(f => f.delay), [10, 10, 10, 10]);
  [0, 2, 5, 7].forEach((s, k) => assert.deepEqual(frames[k].pixels, source[s].pixels));
  assert.match(out.message, /Kept 4 of 10 frames .*0\.40 s/);
  assert.equal(out.originalSize, data.length);

  // 15 fps does not divide 100, so frame times alternate and still sum to the length.
  const fifteen = composed(runBatch({tool:'gif-frame-rate', fps:15}, frameRateFixture(Array(30).fill(4))).bytes).map(f => f.delay);
  assert.equal(fifteen.length, 18);
  assert.equal(fifteen.reduce((n, d) => n + d, 0), 120);
  assert.ok(fifteen.every(d => d === 6 || d === 7));
});

test('gif-frame-rate refuses to raise the rate and reads short delays as browsers play them', () => {
  const data = frameRateFixture(Array(10).fill(4));
  assert.throws(() => runBatch({tool:'gif-frame-rate', fps:25}, data), /about 25 fps\. Choose a lower frame rate/);
  assert.throws(() => runBatch({tool:'gif-frame-rate', fps:30}, data), /Choose a lower frame rate/);
  assert.throws(() => runBatch({tool:'gif-frame-rate', fps:0}, data), /from 1 to 50/);
  // Delays of 0 and 1 play at 10 hundredths, so these GIFs run at 10 fps.
  for (const delay of [0, 1]) {
    const frames = composed(runBatch({tool:'gif-frame-rate', fps:5}, frameRateFixture(Array(6).fill(delay))).bytes);
    assert.deepEqual(frames.map(f => f.delay), [20, 20, 20]);
  }
});

test('gif-frame-rate stores only what changes, unless the GIF has transparency', () => {
  const data = frameRateFixture(Array(10).fill(4)), source = composed(data);
  const frames = composed(runBatch({tool:'gif-frame-rate', fps:20}, data).bytes);
  // The first frame is whole; later ones are the one row that changed, left in place.
  assert.deepEqual([frames[0].width, frames[0].height], [8, 4]);
  assert.ok(frames.slice(1).every(f => f.height === 1));
  assert.ok(frames.every(f => f.disposal === 1));
  // Steps of 5 hundredths fall in frames 0, 1, 2, 3, 5, 6, 7, 8.
  [0, 1, 2, 3, 5, 6, 7, 8].forEach((s, k) => assert.deepEqual(frames[k].pixels, source[s].pixels));

  // The shared fixture has transparent pixels, so its frames stay whole and are cleared.
  const clear = composed(runBatch({tool:'gif-frame-rate', fps:3}).bytes);
  assert.ok(clear.every(f => f.width === 3 && f.height === 2 && f.disposal === 2));
});

test('gif-frame-rate merges kept frames that change nothing', () => {
  // Frames 0-3 are the same picture; the step at frame 2 adds nothing new.
  const data = new Uint8Array(4096), w = new GifWriter(data, 2, 1, {loop: 0});
  [[1, 1], [1, 1], [1, 1], [1, 1], [2, 1], [2, 2]].forEach(px => w.addFrame(0, 0, 2, 1, px, {palette: [0, 0xff0000, 0x00ff00, 0x0000ff], delay: 5}));
  const frames = composed(runBatch({tool:'gif-frame-rate', fps:10}, data.slice(0, w.end())).bytes);
  assert.deepEqual(frames.map(f => f.delay), [20, 10]);
});

/** A composed 8×4 frame turned or mirrored, written out independently of the worker. */
function turned(pixels, op) {
  const out = new Array(pixels.length), w = 8, h = 4;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [dx, dy, ow] = op === 90 ? [h - 1 - y, x, h] : op === 180 ? [w - 1 - x, h - 1 - y, w]
      : op === 270 ? [y, w - 1 - x, h] : op === 'horizontal' ? [w - 1 - x, y, w] : [x, h - 1 - y, w];
    for (let c = 0; c < 4; c++) out[(dy * ow + dx) * 4 + c] = pixels[(y * w + x) * 4 + c];
  }
  return out;
}
/** A composed 8×4 frame centred on a white 10×6 canvas. */
function padded(pixels) {
  const out = [];
  for (let y = 0; y < 6; y++) for (let x = 0; x < 10; x++) {
    const inside = x >= 1 && x < 9 && y >= 1 && y < 5, p = ((y - 1) * 8 + x - 1) * 4;
    out.push(...(inside ? pixels.slice(p, p + 4) : [255, 255, 255, 255]));
  }
  return out;
}

test('re-encoding tools store only what changes and still show the same pictures', () => {
  const data = frameRateFixture(Array(6).fill(5)), source = composed(data).map(f => f.pixels);
  const other = frameRateFixture(Array(3).fill(5).concat([7])), second = composed(other).map(f => f.pixels);
  const cases = [
    [{tool:'remove-gif-frames', selection:'2', duration:'preserve'}, [0, 2, 3, 4, 5].map(i => source[i]), [10, 5, 5, 5, 5]],
    [{tool:'trim-gif', start:2, end:4}, [1, 2, 3].map(i => source[i])],
    [{tool:'reverse-gif'}, source.slice().reverse()],
    [{tool:'reverse-gif', boomerang:true}, source.concat(source.slice(1, -1).reverse())],
    ...[90, 180, 270].map(angle => [{tool:'rotate-gif', angle}, source.map(p => turned(p, angle))]),
    ...['horizontal', 'vertical'].map(axis => [{tool:'flip-gif', axis}, source.map(p => turned(p, axis))]),
    [{tool:'gif-canvas', width:10, height:6, fit:'pad', background:'#ffffff'}, source.map(padded)],
    [{tool:'combine-gifs', width:8, height:4, fit:'pad', background:'transparent', repeats:0}, source.concat(second), null, [other.buffer]],
  ];
  for (const [opts, expected, delays, extra] of cases) {
    const run = ['trim-gif', 'reverse-gif', 'rotate-gif', 'flip-gif'].includes(opts.tool) ? context.transform(data, opts) : runBatch(opts, data, extra);
    const frames = composed(run.bytes), label = JSON.stringify(opts);
    assert.equal(frames.length, expected.length, label);
    frames.forEach((f, i) => assert.deepEqual(f.pixels, Array.from(expected[i]), label + ' frame ' + i));
    // Whole first frame, then only the changed rectangles, each left on screen.
    const [first, ...rest] = frames;
    assert.ok(rest.every(f => f.width * f.height < first.width * first.height && f.disposal === 1), label);
    if (delays) assert.deepEqual(frames.map(f => f.delay), delays, label);
  }
});

test('unchanged frames merge only where playback stays exactly the same', () => {
  // Three identical opaque frames: delays of 5 merge; delays of 0 or 1 play as 10, so they stay.
  const same = delay => {
    const data = new Uint8Array(4096), w = new GifWriter(data, 2, 1, {loop: 0});
    for (let i = 0; i < 3; i++) w.addFrame(0, 0, 2, 1, [1, 2], {palette: [0, 0xff0000, 0x00ff00, 0x0000ff], delay});
    return data.slice(0, w.end());
  };
  assert.deepEqual(composed(context.transform(same(5), {tool:'reverse-gif'}).bytes).map(f => f.delay), [15]);
  for (const delay of [0, 1]) {
    const frames = composed(context.transform(same(delay), {tool:'reverse-gif'}).bytes);
    assert.deepEqual(frames.map(f => f.delay), [delay, delay, delay]);
    assert.ok(frames.slice(1).every(f => f.width === 1 && f.height === 1));
  }
});

test('editing the sample GIF no longer multiplies its size, and compression now compresses', () => {
  // A typical GIF stores only what changes; writing whole frames made these up to 8× larger.
  const data = new Uint8Array(fs.readFileSync('frontend/samples/bee.gif'));
  for (const opts of [{tool:'remove-gif-frames', selection:'2', duration:'preserve'}, {tool:'reverse-gif'}, {tool:'rotate-gif', angle:90}]) {
    const run = opts.tool === 'remove-gif-frames' ? runBatch(opts, data) : context.transform(data, opts);
    assert.ok(run.bytes.length < data.length * 1.3, opts.tool + ': ' + run.bytes.length + ' vs ' + data.length);
  }
  const compressed = runBatch({tool:'compress-gif', compression:'colors', colors:64}, data);
  assert.match(compressed.message, /Compare the result/);
  assert.ok(compressed.bytes.length < data.length);
});

/**
 * 200 frames of 480×270 at 25 fps, a block moving across each: about 105 MB
 * decoded, past the old 96 MiB limit, though it is an ordinary 8 s clip.
 */
function longFixture(count = 200) {
  const w = 480, h = 270, data = new Uint8Array(count * 4096 + 65536), writer = new GifWriter(data, w, h, {loop: 0});
  for (let i = 0; i < count; i++) {
    const pixels = new Uint8Array(w * h), left = (i * 2) % (w - 20);
    for (let y = 100; y < 120; y++) pixels.fill(1, y * w + left, y * w + left + 20);
    writer.addFrame(0, 0, w, h, pixels, {palette: [0x336699, 0xffcc00], delay: 4});
  }
  return data.slice(0, writer.end());
}

test('long GIFs stream through the tools one frame at a time; Reverse still holds them all', () => {
  const data = longFixture(), frames = bytes => new GifReader(bytes).numFrames();
  assert.equal(frames(runBatch({tool:'remove-gif-frames', selection:'2-10', duration:'preserve'}, data).bytes), 191);
  assert.equal(frames(runBatch({tool:'gif-frame-rate', fps:5}, data).bytes), 40);
  const turned = new GifReader(context.transform(data, {tool:'rotate-gif', angle:90}).bytes);
  assert.deepEqual([turned.numFrames(), turned.width, turned.height], [200, 270, 480]);
  assert.equal(frames(context.transform(data, {tool:'trim-gif', start:101, end:200}).bytes), 100);
  assert.equal(frames(context.transform(data, {tool:'gif-speed', rate:2}).bytes), 200);
  assert.throws(() => context.transform(data, {tool:'reverse-gif'}), /Reversing holds every frame in memory/);
  // Frame size still matters: a 4096 × 4096 frame is refused before anything is decoded.
  const huge = new Uint8Array(4096), w = new GifWriter(huge, 4096, 4096, {loop: 0});
  w.addFrame(0, 0, 1, 1, [0], {palette: [0, 0xffffff]});
  assert.throws(() => context.transform(huge.slice(0, w.end()), {tool:'flip-gif'}), /4096 × 4096 frame needs more memory/);
});

/** A small GIF padded past `size` bytes with a comment, as metadata-heavy GIFs are. */
function paddedFixture(size) {
  const gif = fixture(), comment = [0x21, 0xfe];
  const padding = new Uint8Array(size + 2 + Math.ceil(size / 255) * 256 + 1);
  padding.set(comment);
  let p = 2;
  for (let left = size; left > 0; left -= 255) { const n = Math.min(255, left); padding[p] = n; p += n + 1; }
  padding[p++] = 0;  // end of the comment's sub-blocks
  const out = new Uint8Array(gif.length - 1 + p + 1);
  out.set(gif.subarray(0, gif.length - 1)); out.set(padding.subarray(0, p), gif.length - 1); out[out.length - 1] = 0x3b;
  return out;
}

test('frames that use all 256 colours keep them exactly when some pixels stay the same', () => {
  // 33×8 pixels. The first 8 never change; the other 256 show all 256 colours,
  // shifted along by one each frame. Every frame's change covers the whole
  // canvas, so leaving the first 8 clear would need a 257th palette slot.
  const palette = Array.from({length: 256}, (_, i) => (i * 0x9e3779) & 0xffffff);
  const data = new Uint8Array(65536), w = new GifWriter(data, 33, 8, {loop: 0});
  for (let f = 0; f < 4; f++) {
    w.addFrame(0, 0, 33, 8, Array.from({length: 264}, (_, k) => (k < 8 ? 0 : (k - 8 + f) % 256)), {palette, delay: 10});
  }
  const source = data.slice(0, w.end()), out = context.transform(source, {tool:'trim-gif', start:1, end:4});
  assert.equal(out.quantized, false);
  assert.deepEqual(composed(out.bytes).map(f => f.pixels), composed(source).map(f => f.pixels));
});

test('the GIF tools take files up to 100 MB', () => {
  const mb = 1024 * 1024;
  const big = paddedFixture(60 * mb), stripped = runBatch({tool:'compress-gif', compression:'metadata'}, big);
  assert.ok(big.length > 60 * mb && stripped.bytes.length < 4096);
  assert.equal(new GifReader(stripped.bytes).numFrames(), 3);
  assert.equal(new GifReader(context.transform(big, {tool:'reverse-gif'}).bytes).numFrames(), 3);
  const tooBig = paddedFixture(101 * mb);
  assert.throws(() => runBatch({tool:'compress-gif', compression:'metadata'}, tooBig), /less than 100 MB/);
  assert.throws(() => context.transform(tooBig, {tool:'gif-speed', rate:2}), /under 100 MB/);
});

test('compress-gif strips comments losslessly and never returns a larger file', () => {
  const data = fixture();
  const stripped = runBatch({tool:'compress-gif', compression:'metadata'}, data);
  assert.ok(stripped.bytes.length <= data.length);
  assert.equal(stripped.originalSize, data.length);
  // Image data must survive a metadata-only pass untouched.
  const imageBlocks = b => Array.from(context.blocks(b).list).filter(x => x[0] === 44).map(x => Buffer.from(x));
  assert.deepEqual(imageBlocks(stripped.bytes), imageBlocks(data));

  const reduced = runBatch({tool:'compress-gif', compression:'colors', colors:16}, data);
  assert.ok(reduced.bytes.length > 0);
  assert.match(reduced.message, /Compare the result|did not improve/);
  // Whichever branch wins, the tool must not hand back something bigger.
  assert.ok(reduced.bytes.length <= data.length || /did not improve/.test(reduced.message));
  assert.throws(() => runBatch({tool:'compress-gif', compression:'colors', colors:7}), /16, 32, 64, 128 or 256/);
});

test('gif-canvas resizes the output and honours background and fit', () => {
  const padded = new GifReader(runBatch({
    tool:'gif-canvas', width:8, height:6, fit:'pad', background:'transparent'}).bytes);
  assert.equal(padded.width, 8);
  assert.equal(padded.height, 6);
  assert.equal(padded.numFrames(), 3);

  const filled = runBatch({tool:'gif-canvas', width:8, height:6, fit:'contain', background:'#ff0000'});
  const px = new Uint8Array(8 * 6 * 4);
  new GifReader(filled.bytes).decodeAndBlitFrameRGBA(0, px);
  // A solid background must leave no transparent pixels behind.
  assert.ok(!Array.from({length: 8 * 6}, (_, i) => px[i * 4 + 3]).includes(0));

  assert.throws(() => runBatch({tool:'gif-canvas', width:0, height:6}), /whole numbers/);
  assert.throws(() => runBatch({tool:'gif-canvas', width:8, height:6, background:'red'}), /background color/);
});

test('combine-gifs joins inputs in order and applies speed and loop', () => {
  const second = fixture();
  const extra = [second.buffer.slice(second.byteOffset, second.byteOffset + second.byteLength)];
  const opts = {tool:'combine-gifs', width:3, height:2, fit:'pad',
                background:'transparent', repeats:-1, rate:1};

  const joined = new GifReader(runBatch(opts, fixture(), extra).bytes);
  assert.equal(joined.numFrames(), 6);          // 3 + 3, played sequentially
  assert.equal(joined.loopCount(), null);       // -1 means repeat forever

  const faster = new GifReader(runBatch({...opts, rate:2}, fixture(), extra).bytes);
  assert.deepEqual([0,1,2].map(i => faster.frameInfo(i).delay), [4, 7, 13]);

  const finite = new GifReader(runBatch({...opts, repeats:3}, fixture(), extra).bytes);
  assert.equal(finite.loopCount(), 3);

  assert.throws(() => runBatch(opts, fixture(), []), /at least two GIFs/);
  assert.throws(() => runBatch({...opts, rate:99}, fixture(), extra), /between 0.1 and 10/);
});

test('a corrupt GIF is rejected with a clear reason, never parsed past its end', () => {
  // gif-codec.js parses every upload for both the GIF tools and the background
  // tools, so a truncated file — an interrupted download, a partial upload —
  // has to stop at a guard rather than walk off the buffer or loop forever.
  const base = fixture();
  const header = base.slice(0, 13 + ((base[10] & 128) ? 3 * (2 << (base[10] & 7)) : 0));
  const after = tail => { const b = new Uint8Array(header.length + tail.length); b.set(header); b.set(tail, header.length); return b; };
  const cases = [
    [base.slice(0, base.length - 8), /Truncated GIF data/, 'cut off mid-frame'],
    [base.slice(0, base.length - 1), /missing its end marker/, 'no trailer byte'],
    [after([0x21]), /Truncated extension/, 'an extension introducer and nothing else'],
    [after([0x21, 0xF9]), /Truncated GIF data/, 'an extension with no block terminator'],
    [after([0x2C, 0, 0, 0, 0]), /Truncated image/, 'an image descriptor cut short'],
    [after([0x07]), /Invalid GIF block/, 'a block marker that means nothing'],
    [new Uint8Array(0), /valid GIF file/, 'an empty file'],
    [new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]), /valid GIF file/, 'a signature and no screen descriptor'],
  ];
  for (const [bytes, message, what] of cases) {
    assert.throws(() => context.blocks(bytes), message, what);
    // The tools reach the parser through transform(), which must fail the same way.
    assert.throws(() => run({tool: 'reverse-gif'}, bytes), message, what + ' via transform');
  }
});
