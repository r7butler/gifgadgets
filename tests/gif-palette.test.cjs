const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const {GifReader} = require('../frontend/vendor/omggif.js');
const context = vm.createContext({}); context.window = context;
vm.runInContext(fs.readFileSync('frontend/gifenc.browser.js', 'utf8') + fs.readFileSync('frontend/gif-codec.js', 'utf8'), context);

for (const transparent of [false, true]) test(`quantized GIF preserves spatial colors with transparency=${transparent}`, () => {
  // Offset deliberately is not aligned to a Uint32 boundary.
  const rgba = new Uint8Array(32 * 32 * 4 + 1).subarray(1);
  for (let i = 0; i < 1024; i++) rgba.set([40 + i % 32 * 6, 60 + Math.floor(i / 32) * 5, 200, transparent && i % 32 > 27 ? 0 : 255], i * 4);
  const mapped = context.paletteFrame(rgba);
  assert.equal(mapped.quantized, true);
  const encoder = context.gifenc.GIFEncoder();
  encoder.writeFrame(mapped.indexed, 32, 32, {palette: mapped.palette.map(c => [c >> 16 & 255, c >> 8 & 255, c & 255]), transparent, transparentIndex: 0});
  encoder.finish();
  const reader = new GifReader(encoder.bytes()), output = new Uint8Array(rgba.length);
  reader.decodeAndBlitFrameRGBA(0, output);
  let error = 0, channels = 0;
  for (let p = 0; p < rgba.length; p += 4) {
    assert.equal(output[p + 3], rgba[p + 3]);
    if (!rgba[p + 3]) continue;
    for (let c = 0; c < 3; c++) { error += Math.abs(output[p + c] - rgba[p + c]); channels++; }
    assert.ok(Math.abs(output[p + 2] - 200) < 10, 'blue must not become red');
  }
  assert.ok(error / channels < 5, `Mean channel error: ${error / channels}`);
});
