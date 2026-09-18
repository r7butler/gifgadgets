/* Shared GIF parsing, disposal-aware decoding and palette mapping. */
function check(value, message) { if (!value) throw new Error(message); }
function blocks(bytes, copy = true) {
  check(bytes.length >= 14 && /^GIF8[79]a$/.test(String.fromCharCode(...bytes.slice(0, 6))), 'Choose a valid GIF file.');
  let p = 13 + ((bytes[10] & 128) ? 3 * (2 << (bytes[10] & 7)) : 0);
  const part = (start, end) => copy ? bytes.slice(start, end) : bytes.subarray(start, end);
  const header = part(0, p), list = [];
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
    list.push(part(start, p));
  }
  throw new Error('GIF is missing its end marker.');
}

function paletteFrame(rgba, maxColors = 256) {
  const palette = [], colors = new Map(), indexed = new Uint8Array(rgba.length / 4);
  const transparent = rgba.some((v, i) => i % 4 === 3 && v === 0);
  if (transparent) palette.push(0);
  let overflow = false;
  for (let i = 0; i < indexed.length; i++) {
    if (!rgba[i * 4 + 3]) { indexed[i] = 0; continue; }
    const color = rgba[i * 4] << 16 | rgba[i * 4 + 1] << 8 | rgba[i * 4 + 2];
    if (!colors.has(color)) { if (palette.length === maxColors) { overflow = true; break; } colors.set(color, palette.length); palette.push(color); }
    indexed[i] = colors.get(color);
  }
  if (overflow) {
    // This bundled gifenc API consumes packed ABGR pixels, not RGBA bytes.
    // Pack explicitly so subarray offsets and platform byte order are safe.
    const packed = new Uint32Array(indexed.length);
    for (let i = 0; i < packed.length; i++) {
      const p = i * 4;
      packed[i] = rgba[p] | rgba[p + 1] << 8 | rgba[p + 2] << 16 | rgba[p + 3] << 24;
    }
    const quantized = gifenc.quantize(packed, maxColors - (transparent ? 1 : 0), {});
    const mapped = gifenc.applyPalette(packed, quantized);
    palette.length = 0;
    if (transparent) palette.push(0);
    quantized.forEach(c => palette.push(c[0] << 16 | c[1] << 8 | c[2]));
    for (let i = 0; i < indexed.length; i++) indexed[i] = transparent && !rgba[i * 4 + 3] ? 0 : mapped[i] + (transparent ? 1 : 0);
  }
  let n = 2; while (n < palette.length) n *= 2;
  while (palette.length < n) palette.push(0);
  return {indexed, palette, transparent: transparent ? 0 : undefined, quantized: overflow};
}

// Yields a borrowed pixel buffer, valid until the iterator advances. Streaming
// consumers can render it immediately; consumers retaining frames must copy it.
function* decodeFrameStream(bytes, reader, parsed) {
  const width = reader.width, height = reader.height, count = reader.numFrames();
  const composed = new Uint8Array(width * height * 4), pixels = new Uint8Array(composed.length);
  let prior;
  const bgOffset = 13 + bytes[11] * 3;
  const background = (bytes[10] & 128) && bgOffset + 2 < parsed.header.length
    ? new Uint8Array([bytes[bgOffset], bytes[bgOffset + 1], bytes[bgOffset + 2], 255]) : new Uint8Array(4);
  if (reader.frameInfo(0).transparent_index === null) for (let p = 0; p < composed.length; p += 4) composed.set(background, p);
  for (let i = 0; i < count; i++) {
    const info = reader.frameInfo(i);
    check(info.x + info.width <= width && info.y + info.height <= height, 'Frame extends beyond the GIF canvas.');
    if (info.disposal === 3) { prior ||= new Uint8Array(composed.length); prior.set(composed); }
    pixels.fill(0); reader.decodeAndBlitFrameRGBA(i, pixels);
    for (let p = 0; p < pixels.length; p += 4) if (pixels[p + 3]) composed.set(pixels.subarray(p, p + 4), p);
    yield {pixels: composed, delay: info.delay};
    if (info.disposal === 2) {
      const fill = info.transparent_index === null ? background : new Uint8Array(4);
      for (let y = info.y; y < info.y + info.height; y++) for (let x = info.x; x < info.x + info.width; x++) composed.set(fill, (y * width + x) * 4);
    }
    else if (info.disposal === 3) composed.set(prior);
  }
}

// Forward reads reuse decoder buffers. Going backwards (a background loop or a
// second export) starts a fresh pass, preserving disposal without caching frames.
function createFrameCursor(bytes, reader, parsed) {
  let iterator, current, index = -1;
  return wanted => {
    check(Number.isInteger(wanted) && wanted >= 0 && wanted < reader.numFrames(), 'Invalid GIF frame.');
    if (!iterator || wanted < index) { iterator = decodeFrameStream(bytes, reader, parsed); index = -1; }
    while (index < wanted) { current = iterator.next().value; index++; }
    return current.pixels;
  };
}

function decodeFrames(bytes, reader, parsed) {
  const frames = [];
  for (const frame of decodeFrameStream(bytes, reader, parsed)) {
    frames.push({pixels: frame.pixels.slice(), delay: frame.delay});
    postMessage({progress: Math.round(frames.length / reader.numFrames() * 40)});
  }
  return frames;
}
