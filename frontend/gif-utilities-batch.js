/* Shares compositing, palettes and encoding with the batch-one worker. */
'use strict';
const BATCH_TOOLS = ['extract-frames', 'remove-gif-frames', 'gif-frame-rate', 'compress-gif', 'gif-canvas', 'combine-gifs'];
const BATCH_MEMORY = 96 * 1024 * 1024;
function inspectGif(bytes) {
  check(bytes.length <= 40 * 1024 * 1024, 'Choose files totaling less than 40 MB.');
  const parsed = blocks(bytes), reader = new GifReader(bytes);
  const count = reader.numFrames(), width = reader.width, height = reader.height;
  check(count && width && height, 'The GIF has no usable frames.');
  const memory = width * height * 4 * (count + 3);
  check(memory <= BATCH_MEMORY, 'This GIF exceeds the decoded memory limit. Resize or shorten it first.');
  return {bytes, parsed, reader, width, height, count, memory};
}
function frameSelection(text, count) {
  check(typeof text === 'string' && text.trim().length && text.length <= 10000, 'Enter frame numbers or ranges, such as 2, 4-6.');
  const selected = new Set();
  for (const part of text.split(',')) {
    const match = part.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    check(match, 'Use comma-separated frame numbers or ranges, such as 2, 4-6.');
    const first = Number(match[1]), last = Number(match[2] || match[1]);
    check(first >= 1 && last >= first && last <= count, 'A frame number is outside this GIF.');
    for (let n = first; n <= last; n++) selected.add(n - 1);
  }
  return selected;
}
function fitPixels(pixels, width, height, outW, outH, opts) {
  const out = new Uint8Array(outW * outH * 4);
  const bg = opts.background || 'transparent';
  check(bg === 'transparent' || /^#[0-9a-f]{6}$/i.test(bg), 'Choose a valid background color.');
  if (bg !== 'transparent') {
    const rgb = parseInt(bg.slice(1), 16), fill = [rgb >> 16, (rgb >> 8) & 255, rgb & 255, 255];
    for (let p = 0; p < out.length; p += 4) out.set(fill, p);
  }
  const mode = opts.fit || 'pad';
  check(['pad', 'contain', 'cover'].includes(mode), 'Choose a canvas fitting mode.');
  const scale = mode === 'pad' ? 1 : mode === 'cover' ? Math.max(outW / width, outH / height) : Math.min(outW / width, outH / height);
  check(mode !== 'pad' || (outW >= width && outH >= height), 'Padding needs a canvas at least as large as every source. Choose Fit inside to resize.');
  const left = (outW - width * scale) / 2, top = (outH - height * scale) / 2;
  for (let y = 0; y < outH; y++) for (let x = 0; x < outW; x++) {
    const sx = Math.floor((x + .5 - left) / scale), sy = Math.floor((y + .5 - top) / scale);
    if (sx < 0 || sy < 0 || sx >= width || sy >= height) continue;
    const p = (sy * width + sx) * 4;
    if (pixels[p + 3]) out.set(pixels.subarray(p, p + 4), (y * outW + x) * 4);
  }
  return out;
}
function encodeBatch(frames, width, height, loop, colors = 256) {
  check(frames.length && width * height * 4 * (frames.length + 3) <= BATCH_MEMORY, 'The output canvas and frame count exceed the memory limit.');
  return encodeFrames(frames, width, height, {loop, colors, limit: BATCH_MEMORY});
}
/** How long a frame is shown: browsers play delays under 2 hundredths of a second at 10. */
function playedDelay(delay) { return delay < 2 ? 10 : delay; }

/**
 * Keep an animation's length at a lower frame rate. Frames are sampled at
 * even steps of 100 / fps hundredths of a second; each kept frame is the one
 * on screen at its step and holds until the next. Timing is whole hundredths,
 * so rates that do not divide 100 alternate frame times to average out.
 */
function lowerFrameRate(frames, fps) {
  const delays = frames.map(f => playedDelay(f.delay)), total = delays.reduce((n, d) => n + d, 0);
  const current = frames.length * 100 / total, shown = Math.round(current * 10) / 10;
  check(fps < current - 1e-9, 'This GIF plays at about ' + shown + ' fps. Choose a lower frame rate; a higher one would need new frames drawn in between.');
  const kept = [], step = 100 / fps;
  let source = 0, start = 0;
  for (let k = 0; Math.round(k * step) < total; k++) {
    const at = Math.round(k * step), until = Math.min(total, Math.round((k + 1) * step));
    while (start + delays[source] <= at) start += delays[source++];
    const last = kept[kept.length - 1];
    if (last && last.source === source) last.delay += until - at;
    else kept.push({pixels: frames[source].pixels, delay: until - at, source});
  }
  return {kept, current: shown, seconds: total / 100};
}

function stripComments(info) {
  const pieces = [info.parsed.header, ...info.parsed.list.filter(b => !(b[0] === 33 && b[1] === 254)), new Uint8Array([59])];
  const bytes = new Uint8Array(pieces.reduce((n, p) => n + p.length, 0)); let offset = 0;
  pieces.forEach(p => {bytes.set(p, offset); offset += p.length;});
  return {bytes, quantized:false};
}
function transformBatch(bytes, opts, extra = []) {
  check(extra.length <= 19, 'Combine at most 20 GIFs at once.');
  check(bytes.length + extra.reduce((sum, b) => sum + b.byteLength, 0) <= 40 * 1024 * 1024, 'Choose files totaling less than 40 MB.');
  const infos = [inspectGif(bytes), ...extra.map(b => inspectGif(new Uint8Array(b)))];
  check(infos.reduce((sum, info) => sum + info.memory, 0) <= BATCH_MEMORY, 'These files together exceed the decoded memory limit.');
  const info = infos[0];
  if (opts.tool === 'compress-gif' && opts.compression === 'metadata') {
    const result = stripComments(info);
    return {...result, originalSize:bytes.length, message: result.bytes.length < bytes.length ? 'Removed GIF comments; image data is unchanged.' : 'No removable comments. Original image data retained.'};
  }
  let frames = decodeFrames(bytes, info.reader, info.parsed);
  if (opts.tool === 'extract-frames') {
    const selected = opts.extract === 'all' ? new Set(frames.map((_,i) => i)) : frameSelection(String(opts.selection), frames.length);
    check(selected.size <= 500, 'Export at most 500 frames at once. Choose a smaller range.');
    frames = frames.map((f, i) => ({...f, number:i + 1})).filter((_,i) => selected.has(i));
    return {frames, width:info.width, height:info.height};
  }
  if (opts.tool === 'remove-gif-frames') {
    const remove = frameSelection(opts.selection, frames.length);
    check(remove.size < frames.length, 'Keep at least one frame.');
    check(['preserve','shorten'].includes(opts.duration), 'Choose a duration mode.');
    const kept = []; let leading = 0;
    frames.forEach((frame, i) => {
      if (!remove.has(i)) { kept.push({...frame, delay:frame.delay + leading}); leading = 0; }
      else if (opts.duration === 'preserve') {
        if (kept.length) kept[kept.length - 1].delay += frame.delay;
        else leading += frame.delay;
      }
    });
    return encodeBatch(kept, info.width, info.height, info.reader.loopCount());
  }
  if (opts.tool === 'gif-frame-rate') {
    const fps = Number(opts.fps);
    check(Number.isFinite(fps) && fps >= 1 && fps <= 50, 'Choose a frame rate from 1 to 50 frames per second.');
    const {kept, current, seconds} = lowerFrameRate(frames, fps);
    const result = encodeBatch(kept, info.width, info.height, info.reader.loopCount());
    return {...result, originalSize: bytes.length,
      message: 'Kept ' + kept.length + ' of ' + frames.length + ' frames (about ' + current + ' fps to ' + fps + ' fps); the animation still runs ' + seconds.toFixed(2) + ' s.'};
  }
  if (opts.tool === 'compress-gif') {
    const colors = Number(opts.colors);
    check([16,32,64,128,256].includes(colors), 'Choose 16, 32, 64, 128 or 256 colors.');
    const candidate = encodeBatch(frames, info.width, info.height, info.reader.loopCount(), colors);
    const best = stripComments(info);
    return candidate.bytes.length < best.bytes.length
      ? {...candidate, originalSize:bytes.length, message:'Compare the result with the original before downloading. Color reduction can affect gradients and detail.'}
      : {...best, originalSize:bytes.length, message:'Re-encoding did not improve the size. Kept the smaller original image data.'};
  }
  check(['gif-canvas','combine-gifs'].includes(opts.tool), 'Unknown GIF operation.');
  if (opts.tool === 'combine-gifs') check(infos.length >= 2, 'Choose at least two GIFs to combine.');
  const width = Number(opts.width), height = Number(opts.height);
  check(Number.isInteger(width) && Number.isInteger(height) && width >= 1 && height >= 1 && width <= 4096 && height <= 4096, 'Canvas dimensions must be whole numbers from 1 to 4096.');
  const count = infos.reduce((n, i) => n + i.count, 0);
  check(width * height * 4 * (count + 3) + infos.reduce((n, i) => n + i.memory, 0) <= BATCH_MEMORY, 'The combined source and output canvases exceed the memory limit.');
  let all = frames.map(f => ({...f, pixels:fitPixels(f.pixels, info.width, info.height, width, height, opts)}));
  for (const next of infos.slice(1)) {
    const decoded = decodeFrames(next.bytes, next.reader, next.parsed);
    all.push(...decoded.map(f => ({...f, pixels:fitPixels(f.pixels,next.width,next.height,width,height,opts)})));
  }
  let loop = info.reader.loopCount();
  if (opts.tool === 'combine-gifs') {
    const repeats = Number(opts.repeats);
    check(Number.isInteger(repeats) && repeats >= -1 && repeats <= 65535, 'Choose a valid repeat count.');
    loop = repeats === -1 ? null : repeats;
    const speed = Number(opts.rate || 1);
    check(speed >= .1 && speed <= 10, 'Speed must be between 0.1 and 10.');
    all.forEach(f => { if (f.delay) f.delay = Math.max(1, Math.round(f.delay / speed)); });
  }
  return encodeBatch(all, width, height, loop);
}
