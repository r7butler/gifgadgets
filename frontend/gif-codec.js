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
  // Whole pixels at a time: copying through a subarray per pixel dominated decoding.
  const shown32 = new Uint32Array(composed.buffer), drawn32 = new Uint32Array(pixels.buffer);
  let prior;
  const bgOffset = 13 + bytes[11] * 3;
  const background = (bytes[10] & 128) && bgOffset + 2 < parsed.header.length
    ? new Uint8Array([bytes[bgOffset], bytes[bgOffset + 1], bytes[bgOffset + 2], 255]) : new Uint8Array(4);
  if (reader.frameInfo(0).transparent_index === null) for (let p = 0; p < composed.length; p += 4) composed.set(background, p);
  for (let i = 0; i < count; i++) {
    const info = reader.frameInfo(i);
    check(info.x + info.width <= width && info.y + info.height <= height, 'Frame extends beyond the GIF canvas.');
    if (info.disposal === 3) { prior ||= new Uint8Array(composed.length); prior.set(composed); }
    // The decoder writes only this frame's rectangle, and only its opaque pixels,
    // which are never 0 as words since their alpha is 255.
    for (let y = info.y; y < info.y + info.height; y++) drawn32.fill(0, y * width + info.x, y * width + info.x + info.width);
    reader.decodeAndBlitFrameRGBA(i, pixels);
    for (let y = info.y; y < info.y + info.height; y++) {
      for (let k = y * width + info.x, end = k + info.width; k < end; k++) if (drawn32[k]) shown32[k] = drawn32[k];
    }
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

/**
 * Write composed RGBA frames to a GIF one at a time, holding only what is on
 * screen and the frame waiting to be written, in an output buffer that grows.
 *
 * While nothing is clear, each frame after the first keeps only the rectangle
 * that differs from what is on screen, with unchanged pixels inside it left
 * clear, and stays on screen for the next to draw over. A frame that changes
 * nothing adds its time to the one before, unless either delay is under 2
 * hundredths (browsers play those at 10) or the sum would pass the GIF limit.
 * A pixel left on screen cannot be made clear again, so from the first frame
 * with a clear pixel on, frames are stored whole and cleared after showing.
 *
 * opts.loop: repeat count (0 forever, null once); opts.colors: most per frame;
 * opts.tolerance: how far a channel may move and still count as unchanged
 * (lossy; 0 keeps every change); opts.limit: largest output buffer, in bytes.
 */
function createGifEncoder(width, height, opts = {}) {
  const colors = opts.colors || 256, tolerance = opts.tolerance || 0, limit = opts.limit || Infinity;
  const full = {x: 0, y: 0, w: width, h: height};
  let buffer = new Uint8Array(Math.min(limit, 1024 + width * height * 2));
  const writer = new GifWriter(buffer, width, height, {loop: opts.loop});
  let shown = null, marks = null, pending = null, whole = false, quantized = false, written = 0;

  function write(step) {
    check(step.delay <= 65535, 'A retained frame exceeds the GIF delay limit. Remove fewer frames or choose Shorten.');
    // LZW spends at most 12 bits a pixel, plus block lengths, palette and headers.
    const position = writer.getOutputBufferPosition(), need = position + Math.ceil(step.rect.w * step.rect.h * 1.6) + 1024;
    if (need > buffer.length) {
      check(need <= limit, 'Output exceeds the memory limit.');
      const grown = new Uint8Array(Math.min(limit, Math.max(need, buffer.length * 2)));
      grown.set(buffer.subarray(0, position));
      buffer = grown; writer.setOutputBuffer(buffer);
    }
    const pal = step.pal || paletteFrame(step.pixels, colors); quantized ||= pal.quantized;
    writer.addFrame(step.rect.x, step.rect.y, step.rect.w, step.rect.h, pal.indexed,
      {palette: pal.palette, transparent: pal.transparent, delay: step.delay, disposal: step.disposal});
    written++;
  }
  function hasClear(pixels) {
    for (let p = 3; p < pixels.length; p += 4) if (pixels[p] !== 255) return true;
    return false;
  }
  return {
    /** Add the next composed frame. `pixels` may be reused by the caller afterwards. */
    add(pixels, delay) {
      if (!whole && hasClear(pixels)) {
        whole = true;
        // What is on screen is rewritten whole so it can be cleared before this frame.
        if (pending) pending = {pixels: shown, rect: full, delay: pending.delay, disposal: 2};
      }
      if (whole) {
        if (pending) { write(pending); pending = null; }
        write({pixels, rect: full, delay, disposal: 2});
        return;
      }
      if (!shown) {
        shown = pixels.slice(); marks = new Uint8Array(width * height);
        pending = {pixels: shown, rect: full, delay, disposal: 1};
        return;
      }
      // One pass marks each pixel a channel of which moved more than `tolerance`.
      let left = width, top = height, right = -1, bottom = -1;
      for (let y = 0, i = 0; y < height; y++) for (let x = 0; x < width; x++, i++) {
        const p = i * 4, r = pixels[p] - shown[p], g = pixels[p + 1] - shown[p + 1], b = pixels[p + 2] - shown[p + 2];
        marks[i] = r > tolerance || r < -tolerance || g > tolerance || g < -tolerance || b > tolerance || b < -tolerance ? 1 : 0;
        if (!marks[i]) continue;
        if (x < left) left = x; if (x > right) right = x;
        if (y < top) top = y; if (y > bottom) bottom = y;
      }
      if (right < 0) {
        if (delay >= 2 && pending.delay >= 2 && pending.delay + delay <= 65535) { pending.delay += delay; return; }
        left = top = right = bottom = 0;  // keep the frame as one unchanged pixel
      }
      const rect = {x: left, y: top, w: right - left + 1, h: bottom - top + 1};
      const region = new Uint8Array(rect.w * rect.h * 4);
      for (let y = 0; y < rect.h; y++) for (let x = 0; x < rect.w; x++) {
        const i = (rect.y + y) * width + rect.x + x;
        if (marks[i]) region.set(pixels.subarray(i * 4, i * 4 + 4), (y * rect.w + x) * 4);
      }
      // Pixels left clear take a palette slot. When that alone pushes the
      // rectangle past the palette, store it solid instead, every pixel as it
      // is now, so no colour has to be approximated.
      let pal = paletteFrame(region, colors), solid = false;
      if (pal.quantized) {
        const whole = new Uint8Array(rect.w * rect.h * 4);
        for (let y = 0; y < rect.h; y++) {
          const from = ((rect.y + y) * width + rect.x) * 4;
          whole.set(pixels.subarray(from, from + rect.w * 4), y * rect.w * 4);
        }
        const exact = paletteFrame(whole, colors);
        if (!exact.quantized) { pal = exact; solid = true; }
      }
      write(pending);  // before `shown` changes: the first frame's pixels are `shown`
      for (let y = 0; y < rect.h; y++) for (let x = 0; x < rect.w; x++) {
        const i = (rect.y + y) * width + rect.x + x;
        if (solid || marks[i]) shown.set(pixels.subarray(i * 4, i * 4 + 4), i * 4);
      }
      pending = {pal, rect, delay, disposal: 1};
    },
    /** Write the last frame and return {bytes, quantized, frames}. */
    finish() {
      if (pending) { write(pending); pending = null; }
      check(written > 0, 'The GIF contains no usable frames.');
      const end = writer.end();
      // A view, not a copy: callers hand the whole buffer over to the page.
      return {bytes: buffer.subarray(0, end), quantized, frames: written};
    },
  };
}

/** Encode composed frames ({pixels, delay}) held in memory, reporting progress from 40 to 100. */
function encodeFrames(frames, width, height, opts) {
  const encoder = createGifEncoder(width, height, opts);
  frames.forEach((frame, i) => {
    encoder.add(frame.pixels, frame.delay);
    postMessage({progress: 40 + Math.round((i + 1) * 60 / frames.length)});
  });
  const {bytes, quantized} = encoder.finish();
  return {bytes, quantized};
}
