/* Shared GIF parsing, disposal-aware decoding and palette mapping. */
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
    const quantized = gifenc.quantize(rgba, maxColors - (transparent ? 1 : 0), {});
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

function decodeFrames(bytes, reader, parsed) {
  const width = reader.width, height = reader.height, count = reader.numFrames();
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
  return frames;
}

