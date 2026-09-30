/* Pure mask/timing helpers shared by the worker, the GIF editor and tests. */
(function (root) {
  function readMasks(buffer, count) {
    const bytes = new Uint8Array(buffer);
    if (bytes.length < 5) throw Error('Incomplete segmentation result.');
    const size = new DataView(buffer).getUint32(0, true);
    if (size > 4096 || size + 4 > bytes.length) throw Error('Invalid mask header.');
    const meta = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + size)));
    if (meta.version !== 1 || meta.frames !== count || !Number.isInteger(meta.width) || !Number.isInteger(meta.height) || meta.width < 1 || meta.height < 1 || meta.width > 1024 || meta.height > 1024) throw Error('Masks do not match this file.');
    const stride = Math.ceil(meta.width * meta.height / 8);
    if (bytes.length !== 4 + size + stride * count) throw Error('Segmentation is missing one or more frames.');
    return {...meta, stride, bytes: bytes.subarray(4 + size)};
  }
  function cutout(pixels, width, height, masks, frame) {
    const result = new Uint8ClampedArray(pixels);
    const offset = frame * masks.stride;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const index = Math.floor(y * masks.height / height) * masks.width + Math.floor(x * masks.width / width);
      if (!(masks.bytes[offset + (index >> 3)] & (128 >> (index & 7)))) result[(y * width + x) * 4 + 3] = 0;
    }
    return result;
  }
  // Split on both foreground and background boundaries, preserving total length.
  // Background repeats to fill one foreground cycle. No frame-count truncation.
  function* timeline(foreground, background) {
    if (!background || background.length === 1) {
      for (let i = 0; i < foreground.length; i++) yield {foreground:i, background:0, delay:foreground[i].delay};
      return;
    }
    let fi = 0, bi = 0, fleft = foreground[0].delay || 10, bleft = background[0].delay || 10;
    while (fi < foreground.length) {
      const delay = Math.min(fleft, bleft);
      yield {foreground:fi, background:bi, delay};
      fleft -= delay; bleft -= delay;
      if (!fleft) { fi++; if (fi < foreground.length) fleft = foreground[fi].delay || 10; }
      if (!bleft) { bi = (bi + 1) % background.length; bleft = background[bi].delay || 10; }
    }
  }
  // A frame map [a, b, c, d, e, f] takes normalised coordinates in one frame
  // geometry to another: x' = a·x + b·y + c, y' = d·x + e·y + f. The GIF editor
  // keeps one from its current frames back to the frames a mask was made for,
  // so rotating, flipping or cropping the frames carries their cutout along.
  const IDENTITY = [1, 0, 0, 0, 1, 0];
  /** The map that applies `inner`, then `outer`. */
  function compose(outer, inner) {
    const [a, b, c, d, e, f] = outer, [p, q, r, s, t, u] = inner;
    return [a * p + b * s, a * q + b * t, a * r + b * u + c, d * p + e * s, d * q + e * t, d * r + e * u + f];
  }
  function invert(map) {
    const [a, b, c, d, e, f] = map, det = a * e - b * d;
    return [e / det, -b / det, (b * f - c * e) / det, -d / det, a / det, (c * d - a * f) / det];
  }
  function mapPoint(map, x, y) {
    return {x: map[0] * x + map[1] * y + map[2], y: map[3] * x + map[4] * y + map[5]};
  }
  /**
   * Where a point of the frames after an edit was before it. Edits are
   * {rotate: 90|270} (clockwise), {flip: 'h'|'v'}, or {crop: {x, y, w, h,
   * width, height}} in pixels of the frames before cropping. Resizing keeps
   * normalised coordinates, so it has no entry.
   */
  function undoMap(edit) {
    if (edit.rotate === 90) return [0, 1, 0, -1, 0, 1];
    if (edit.rotate === 270) return [0, -1, 1, 1, 0, 0];
    if (edit.flip === 'h') return [-1, 0, 1, 0, 1, 0];
    if (edit.flip === 'v') return [1, 0, 0, 0, -1, 1];
    if (edit.crop) {
      const c = edit.crop;
      return [c.w / c.width, 0, c.x / c.width, 0, c.h / c.height, c.y / c.height];
    }
    return IDENTITY.slice();
  }
  /**
   * cutout() for frames that may have been edited since the masks were made:
   * each pixel's centre is taken through `map` to the mask's geometry. Writes
   * into `out` (the same length as `pixels`) so repeated renders reuse it.
   */
  function cutoutMapped(pixels, out, width, height, masks, frame, map) {
    out.set(pixels);
    const mw = masks.width, mh = masks.height, bytes = masks.bytes, offset = frame * masks.stride;
    // The map is linear, so its x and y terms are tabulated once per axis.
    const xu = new Float64Array(width), xv = new Float64Array(width);
    const yu = new Float64Array(height), yv = new Float64Array(height);
    for (let x = 0; x < width; x++) { const u = (x + 0.5) / width; xu[x] = map[0] * u * mw; xv[x] = map[3] * u * mh; }
    for (let y = 0; y < height; y++) { const v = (y + 0.5) / height; yu[y] = (map[1] * v + map[2]) * mw; yv[y] = (map[4] * v + map[5]) * mh; }
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const mx = Math.min(mw - 1, Math.max(0, Math.floor(xu[x] + yu[y])));
        const my = Math.min(mh - 1, Math.max(0, Math.floor(xv[x] + yv[y])));
        const index = my * mw + mx;
        if (!(bytes[offset + (index >> 3)] & (128 >> (index & 7)))) out[(y * width + x) * 4 + 3] = 0;
      }
    }
    return out;
  }
  // gif.js makes one color transparent, found by nearest match in each frame's
  // palette, so it must be a color the picture never comes near: the first of
  // these with no kept pixel within 48 levels a channel, else the farthest.
  const KEYS = [0xff00ff, 0x00ff00, 0x00ffff, 0xffff00, 0x0000ff, 0xff0000], CLEAR = 3 * 48 * 48;
  function keyColor(frames) {
    const total = frames.reduce((sum, pixels) => sum + pixels.length / 4, 0);
    const step = 4 * Math.max(1, Math.floor(total / 200000));
    let best = KEYS[0], farthest = -1;
    for (const key of KEYS) {
      const r = key >> 16 & 255, g = key >> 8 & 255, b = key & 255;
      let nearest = Infinity;
      for (const pixels of frames) {
        for (let p = 0; p < pixels.length && nearest > farthest; p += step) {
          if (pixels[p + 3] < 128) continue;
          nearest = Math.min(nearest, (pixels[p] - r) ** 2 + (pixels[p + 1] - g) ** 2 + (pixels[p + 2] - b) ** 2);
        }
      }
      if (nearest >= CLEAR) return key;
      if (nearest > farthest) { best = key; farthest = nearest; }
    }
    return best;
  }
  /** GIF transparency is all or nothing: paint mostly-clear pixels `key`, make the rest opaque. */
  function keyOut(pixels, key) {
    const r = key >> 16 & 255, g = key >> 8 & 255, b = key & 255;
    for (let p = 0; p < pixels.length; p += 4) {
      if (pixels[p + 3] < 128) { pixels[p] = r; pixels[p + 1] = g; pixels[p + 2] = b; }
      pixels[p + 3] = 255;
    }
    return pixels;
  }
  root.BackgroundCore = {readMasks, cutout, timeline, IDENTITY, compose, invert, mapPoint, undoMap, cutoutMapped, keyColor, keyOut};
})(typeof self === 'undefined' ? globalThis : self);
