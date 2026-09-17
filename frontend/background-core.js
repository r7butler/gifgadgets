/* Pure mask/timing helpers shared by the worker and tests. */
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
  root.BackgroundCore = {readMasks, cutout, timeline};
})(typeof self === 'undefined' ? globalThis : self);
