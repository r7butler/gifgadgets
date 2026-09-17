/* Local-only GIF transformations. Original timing is kept in centiseconds. */
'use strict';
self.window = self;
importScripts('/vendor/omggif.js', '/gifenc.browser.js');

function check(value, message) { if (!value) throw new Error(message); }
function blocks(bytes) {
  check(bytes.length >= 14 && /^GIF8[79]a$/.test(String.fromCharCode(...bytes.slice(0, 6))), 'Choose a valid GIF file.');
  let p = 13 + ((bytes[10] & 128) ? 3 * (2 << (bytes[10] & 7)) : 0);
  const header = bytes.slice(0, p), list = [];
  function skip() {
    while (true) {
      check(p < bytes.length, 'Truncated GIF data.');
      const n = bytes[p++];
      if (!n) break;
      p += n; check(p <= bytes.length, 'Truncated GIF data.');
    }
  }
  while (p < bytes.length) {
    const start = p, marker = bytes[p++];
    if (marker === 59) return {header, list};
    if (marker === 33) { check(p < bytes.length, 'Truncated extension.'); p++; skip(); }
    else if (marker === 44) {
      check(p + 9 <= bytes.length, 'Truncated image.');
      const packed = bytes[p + 8]; p += 9;
      if (packed & 128) p += 3 * (2 << (packed & 7));
      p++; skip();
    } else throw new Error('Invalid GIF block.');
    list.push(bytes.slice(start, p));
  }
  throw new Error('GIF is missing its end marker.');
}

function metadata(bytes, parsed, opts) {
  let list = parsed.list;
  if (opts.tool === 'gif-speed') {
    const rate = Number(opts.rate);
    check(Number.isFinite(rate) && rate >= 0.1 && rate <= 10, 'Speed must be between 0.1 and 10.');
    list = list.map(block => {
      if (block[0] === 33 && block[1] === 249) {
        check(block.length === 8 && block[2] === 4, 'Invalid frame timing.');
        const old = block[4] | block[5] << 8;
        // Zero-delay frames keep their encoded delay; viewers choose a fallback.
        const delay = old === 0 ? 0 : Math.max(1, Math.round(old / rate));
        check(delay <= 65535, 'That speed exceeds the GIF frame-delay limit.');
        block[4] = delay & 255; block[5] = delay >> 8;
      }
      return block;
    });
  } else {
    const repeats = Number(opts.repeats);
    check(Number.isInteger(repeats) && repeats >= -1 && repeats <= 65535, 'Choose a valid repeat count.');
    list = list.filter(block => !(block[0] === 33 && block[1] === 255 &&
      ['NETSCAPE2.0', 'ANIMEXTS1.0'].includes(String.fromCharCode(...block.slice(3, 14)))));
    if (repeats !== -1) list.unshift(new Uint8Array([33,255,11,78,69,84,83,67,65,80,69,50,46,48,3,1,repeats & 255,repeats >> 8,0]));
  }
  const size = parsed.header.length + list.reduce((sum, b) => sum + b.length, 0) + 1;
  const out = new Uint8Array(size); let p = 0;
  for (const part of [parsed.header, ...list, new Uint8Array([59])]) { out.set(part, p); p += part.length; }
  // New extensions are legal in GIF89a.
  out[4] = 57;
  return out;
}

function paletteFrame(rgba) {
  const palette = [], colors = new Map(), indexed = new Uint8Array(rgba.length / 4);
  const transparent = rgba.some((v, i) => i % 4 === 3 && v === 0);
  if (transparent) palette.push(0);
  let overflow = false;
  for (let i = 0; i < indexed.length; i++) {
    if (!rgba[i * 4 + 3]) { indexed[i] = 0; continue; }
    const color = rgba[i * 4] << 16 | rgba[i * 4 + 1] << 8 | rgba[i * 4 + 2];
    if (!colors.has(color)) { if (palette.length === 256) { overflow = true; break; } colors.set(color, palette.length); palette.push(color); }
    indexed[i] = colors.get(color);
  }
  if (overflow) {
    const quantized = gifenc.quantize(rgba, transparent ? 255 : 256, {});
    const mapped = gifenc.applyPalette(rgba, quantized);
    palette.length = 0;
    if (transparent) palette.push(0);
    quantized.forEach(c => palette.push(c[0] << 16 | c[1] << 8 | c[2]));
    for (let i = 0; i < indexed.length; i++) indexed[i] = transparent && !rgba[i * 4 + 3] ? 0 : mapped[i] + (transparent ? 1 : 0);
  }
  let n = 2; while (n < palette.length) n *= 2;
  while (palette.length < n) palette.push(0);
  return {indexed, palette, transparent: transparent ? 0 : undefined, quantized: overflow};
}

function transform(bytes, opts) {
  check(bytes.length <= 40 * 1024 * 1024, 'Choose a GIF under 40 MB.');
  const parsed = blocks(bytes), reader = new GifReader(bytes);
  const width = reader.width, height = reader.height, count = reader.numFrames();
  check(count > 0 && width > 0 && height > 0, 'The GIF contains no usable frames.');
  check(width * height * 4 * (count + 3) <= 96 * 1024 * 1024, 'This GIF needs too much decoded memory. Resize it or use a shorter animation first.');
  if (opts.tool === 'gif-speed' || opts.tool === 'gif-loop') return {bytes: metadata(bytes, parsed, opts), quantized: false};
  check(['reverse-gif','rotate-gif','flip-gif','trim-gif'].includes(opts.tool), 'Unknown GIF operation.');
  let order = Array.from({length: count}, (_, i) => i);
  if (opts.tool === 'reverse-gif') order = opts.boomerang ? order.concat(order.slice(1, -1).reverse()) : order.reverse();
  if (opts.tool === 'trim-gif') {
    const start = Number(opts.start), end = Number(opts.end);
    check(Number.isInteger(start) && Number.isInteger(end) && start >= 1 && end <= count && end >= start, 'Choose a valid inclusive frame range.');
    order = order.slice(start - 1, end);
  }
  const angle = Number(opts.angle || 90), axis = opts.axis || 'horizontal';
  if (opts.tool === 'rotate-gif') check([90,180,270].includes(angle), 'Choose a quarter-turn rotation.');
  if (opts.tool === 'flip-gif') check(['horizontal','vertical'].includes(axis), 'Choose a flip direction.');
  const swap = opts.tool === 'rotate-gif' && angle !== 180;
  const outW = swap ? height : width, outH = swap ? width : height;
  const composed = new Uint8Array(width * height * 4), frames = [];
  const bgOffset = 13 + bytes[11] * 3;
  const background = (bytes[10] & 128) && bgOffset + 2 < parsed.header.length
    ? new Uint8Array([bytes[bgOffset], bytes[bgOffset + 1], bytes[bgOffset + 2], 255]) : new Uint8Array(4);
  if (reader.frameInfo(0).transparent_index === null) for (let p = 0; p < composed.length; p += 4) composed.set(background, p);
  for (let i = 0; i < count; i++) {
    const info = reader.frameInfo(i);
    check(info.x + info.width <= width && info.y + info.height <= height, 'Frame extends beyond the GIF canvas.');
    const prior = info.disposal === 3 ? composed.slice() : null;
    const pixels = new Uint8Array(composed.length); reader.decodeAndBlitFrameRGBA(i, pixels);
    for (let p = 0; p < pixels.length; p += 4) if (pixels[p + 3]) composed.set(pixels.subarray(p, p + 4), p);
    frames.push({pixels: composed.slice(), delay: info.delay});
    if (info.disposal === 2) {
      const fill = info.transparent_index === null ? background : new Uint8Array(4);
      for (let y = info.y; y < info.y + info.height; y++) for (let x = info.x; x < info.x + info.width; x++) composed.set(fill, (y * width + x) * 4);
    }
    else if (prior) composed.set(prior);
    postMessage({progress: Math.round((i + 1) / count * 40)});
  }
  const capacity = order.length * (width * height * 3 + 1024) + 1024;
  check(capacity <= 96 * 1024 * 1024, 'The output would require too much memory. Try a shorter animation.');
  const buffer = new Uint8Array(capacity);
  const writer = new GifWriter(buffer, outW, outH, {loop: reader.loopCount()});
  let quantized = false;
  order.forEach((frameIndex, k) => {
    const frame = frames[frameIndex]; let pixels = frame.pixels;
    if (opts.tool === 'rotate-gif' || opts.tool === 'flip-gif') {
      pixels = new Uint8Array(frame.pixels.length);
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        let dx = x, dy = y;
        if (opts.tool === 'flip-gif') { dx = axis === 'horizontal' ? width - 1 - x : x; dy = axis === 'vertical' ? height - 1 - y : y; }
        else if (angle === 90) { dx = height - 1 - y; dy = x; }
        else if (angle === 180) { dx = width - 1 - x; dy = height - 1 - y; }
        else { dx = y; dy = width - 1 - x; }
        pixels.set(frame.pixels.subarray((y * width + x) * 4, (y * width + x) * 4 + 4), (dy * outW + dx) * 4);
      }
    }
    const pal = paletteFrame(pixels); quantized ||= pal.quantized;
    writer.addFrame(0, 0, outW, outH, pal.indexed, {palette: pal.palette, transparent: pal.transparent, delay: frame.delay, disposal: 2});
    postMessage({progress: 40 + Math.round((k + 1) / order.length * 60)});
  });
  const end = writer.end(); check(end <= capacity, 'Encoded output exceeds the memory limit.');
  return {bytes: buffer.slice(0, end), quantized};
}

self.onmessage = function(event) {
  try { const result = transform(new Uint8Array(event.data.buffer), event.data.options); postMessage(result, [result.bytes.buffer]); }
  catch (error) { postMessage({error: error.message}); }
};
