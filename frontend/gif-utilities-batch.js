/* Shares compositing, palettes and encoding with the batch-one worker. */
'use strict';
const BATCH_TOOLS = ['extract-frames', 'remove-gif-frames', 'gif-frame-rate', 'compress-gif', 'gif-canvas', 'combine-gifs'];
// The largest GIF, or set of GIFs to combine, that the tools accept.
const MAX_FILE = 100 * 1024 * 1024;
// Frames kept in memory together: Reverse, and frames to extract.
const BATCH_MEMORY = 96 * 1024 * 1024;
// The encoded result, which for a large source can be larger than the source.
const OUTPUT_MEMORY = 256 * 1024 * 1024;
// Every other tool streams: about eight working copies of one frame at a time.
const FRAME_MEMORY = 256 * 1024 * 1024;
function checkFrameSize(width, height) {
  check(width * height * 4 * 8 <= FRAME_MEMORY, 'Each ' + width + ' × ' + height + ' frame needs more memory than this tool allows. Resize the GIF first.');
}
function inspectGif(bytes) {
  check(bytes.length <= MAX_FILE, 'Choose files totaling less than 100 MB.');
  const parsed = blocks(bytes, false), reader = new GifReader(bytes);
  const count = reader.numFrames(), width = reader.width, height = reader.height;
  check(count && width && height, 'The GIF has no usable frames.');
  checkFrameSize(width, height);
  return {bytes, parsed, reader, width, height, count};
}
/**
 * Build a GIF from frames decoded in order and written as they come, so only
 * a few frames are in memory however long the animation is. Each source
 * names the frames it keeps (a Map of frame index to delay) and, optionally,
 * how their pixels change; decoding stops after its last kept frame.
 */
function streamGif(sources, width, height, opts) {
  const gif = createGifEncoder(width, height, {...opts, limit: OUTPUT_MEMORY});
  sources.forEach(({info, delays, change = pixels => pixels}, s) => {
    eachChosenFrame(info, delays, (pixels, i) => gif.add(change(pixels), delays.get(i)),
      (i, last) => postMessage({progress: Math.round((s + (i + 1) / (last + 1)) * 100 / sources.length)}));
  });
  const {bytes, quantized} = gif.finish();
  return {bytes, quantized};
}
/**
 * Decode frames in order and call visit(pixels, index) for those in `chosen`
 * (a Set, or a Map keyed by index), stopping after the last; tick(index,
 * last) runs for every frame decoded. `pixels` is valid only during the call.
 */
function eachChosenFrame(info, chosen, visit, tick) {
  let last = -1;
  for (const i of chosen.keys()) if (i > last) last = i;
  let i = 0;
  for (const frame of decodeFrameStream(info.bytes, info.reader, info.parsed)) {
    if (chosen.has(i)) visit(frame.pixels, i);
    tick(i, last);
    if (i++ === last) break;
  }
}
/** Every frame of a GIF at its own delay, for streamGif. */
function allFrames(info, delay = d => d) {
  const delays = new Map();
  for (let i = 0; i < info.count; i++) delays.set(i, delay(info.reader.frameInfo(i).delay));
  return delays;
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
  const out = new Uint8Array(outW * outH * 4), out32 = new Uint32Array(out.buffer);
  const from = new Uint32Array(pixels.buffer, pixels.byteOffset, width * height);
  const bg = opts.background || 'transparent';
  check(bg === 'transparent' || /^#[0-9a-f]{6}$/i.test(bg), 'Choose a valid background color.');
  if (bg !== 'transparent') {
    const rgb = parseInt(bg.slice(1), 16);
    out32.fill(new Uint32Array(new Uint8Array([rgb >> 16, (rgb >> 8) & 255, rgb & 255, 255]).buffer)[0]);
  }
  const mode = opts.fit || 'pad';
  check(['pad', 'contain', 'cover'].includes(mode), 'Choose a canvas fitting mode.');
  const scale = mode === 'pad' ? 1 : mode === 'cover' ? Math.max(outW / width, outH / height) : Math.min(outW / width, outH / height);
  check(mode !== 'pad' || (outW >= width && outH >= height), 'Padding needs a canvas at least as large as every source. Choose Fit inside to resize.');
  const left = (outW - width * scale) / 2, top = (outH - height * scale) / 2;
  for (let y = 0; y < outH; y++) for (let x = 0; x < outW; x++) {
    const sx = Math.floor((x + .5 - left) / scale), sy = Math.floor((y + .5 - top) / scale);
    if (sx < 0 || sy < 0 || sx >= width || sy >= height) continue;
    const k = sy * width + sx;
    if (pixels[k * 4 + 3]) out32[y * outW + x] = from[k];
  }
  return out;
}
/** How long a frame is shown: browsers play delays under 2 hundredths of a second at 10. */
function playedDelay(delay) { return delay < 2 ? 10 : delay; }

/**
 * Keep an animation's length at a lower frame rate. Frames are sampled at
 * even steps of 100 / fps hundredths of a second; each kept frame is the one
 * on screen at its step and holds until the next. Timing is whole hundredths,
 * so rates that do not divide 100 alternate frame times to average out.
 */
function lowerFrameRate(sourceDelays, fps) {
  const delays = sourceDelays.map(playedDelay), total = delays.reduce((n, d) => n + d, 0);
  const current = delays.length * 100 / total, shown = Math.round(current * 10) / 10;
  check(fps < current - 1e-9, 'This GIF plays at about ' + shown + ' fps. Choose a lower frame rate; a higher one would need new frames drawn in between.');
  const kept = [], step = 100 / fps;
  let source = 0, start = 0;
  for (let k = 0; Math.round(k * step) < total; k++) {
    const at = Math.round(k * step), until = Math.min(total, Math.round((k + 1) * step));
    while (start + delays[source] <= at) start += delays[source++];
    const last = kept[kept.length - 1];
    if (last && last.source === source) last.delay += until - at;
    else kept.push({delay: until - at, source});
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
  check(bytes.length + extra.reduce((sum, b) => sum + b.byteLength, 0) <= MAX_FILE, 'Choose files totaling less than 100 MB.');
  const infos = [inspectGif(bytes), ...extra.map(b => inspectGif(new Uint8Array(b)))];
  const info = infos[0], loop = info.reader.loopCount();
  const delayOf = i => info.reader.frameInfo(i).delay;
  if (opts.tool === 'compress-gif' && opts.compression === 'metadata') {
    const result = stripComments(info);
    return {...result, originalSize:bytes.length, message: result.bytes.length < bytes.length ? 'Removed GIF comments; image data is unchanged.' : 'No removable comments. Original image data retained.'};
  }
  if (opts.tool === 'extract-frames') {
    const selected = opts.extract === 'all' ? new Set(Array.from({length: info.count}, (_, i) => i)) : frameSelection(String(opts.selection), info.count);
    check(selected.size <= 500, 'Export at most 500 frames at once. Choose a smaller range.');
    check(selected.size * info.width * info.height * 4 <= BATCH_MEMORY, 'Those frames need more memory than this tool allows. Export fewer at once.');
    const frames = [];
    eachChosenFrame(info, selected, (pixels, i) => frames.push({pixels: pixels.slice(), delay: delayOf(i), number: i + 1}),
      (i, last) => postMessage({progress: Math.round((i + 1) * 100 / (last + 1))}));
    return {frames, width:info.width, height:info.height};
  }
  if (opts.tool === 'remove-gif-frames') {
    const remove = frameSelection(opts.selection, info.count);
    check(remove.size < info.count, 'Keep at least one frame.');
    check(['preserve','shorten'].includes(opts.duration), 'Choose a duration mode.');
    // Timing comes from the frame headers, so kept frames are written as they are decoded.
    const delays = new Map(); let leading = 0, last = -1;
    for (let i = 0; i < info.count; i++) {
      if (!remove.has(i)) { delays.set(i, delayOf(i) + leading); leading = 0; last = i; }
      else if (opts.duration === 'preserve') {
        if (last >= 0) delays.set(last, delays.get(last) + delayOf(i));
        else leading += delayOf(i);
      }
    }
    return streamGif([{info, delays}], info.width, info.height, {loop});
  }
  if (opts.tool === 'gif-frame-rate') {
    const fps = Number(opts.fps);
    check(Number.isFinite(fps) && fps >= 1 && fps <= 50, 'Choose a frame rate from 1 to 50 frames per second.');
    const {kept, current, seconds} = lowerFrameRate(Array.from({length: info.count}, (_, i) => delayOf(i)), fps);
    const result = streamGif([{info, delays: new Map(kept.map(k => [k.source, k.delay]))}], info.width, info.height, {loop});
    return {...result, originalSize: bytes.length,
      message: 'Kept ' + kept.length + ' of ' + info.count + ' frames (about ' + current + ' fps to ' + fps + ' fps); the animation still runs ' + seconds.toFixed(2) + ' s.'};
  }
  if (opts.tool === 'compress-gif') {
    const colors = Number(opts.colors);
    check([16,32,64,128,256].includes(colors), 'Choose 16, 32, 64, 128 or 256 colors.');
    const candidate = streamGif([{info, delays: allFrames(info)}], info.width, info.height, {loop, colors});
    const best = stripComments(info);
    return candidate.bytes.length < best.bytes.length
      ? {...candidate, originalSize:bytes.length, message:'Compare the result with the original before downloading. Color reduction can affect gradients and detail.'}
      : {...best, originalSize:bytes.length, message:'Re-encoding did not improve the size. Kept the smaller original image data.'};
  }
  check(['gif-canvas','combine-gifs'].includes(opts.tool), 'Unknown GIF operation.');
  if (opts.tool === 'combine-gifs') check(infos.length >= 2, 'Choose at least two GIFs to combine.');
  const width = Number(opts.width), height = Number(opts.height);
  check(Number.isInteger(width) && Number.isInteger(height) && width >= 1 && height >= 1 && width <= 4096 && height <= 4096, 'Canvas dimensions must be whole numbers from 1 to 4096.');
  checkFrameSize(width, height);
  let output = loop, delay = d => d;
  if (opts.tool === 'combine-gifs') {
    const repeats = Number(opts.repeats);
    check(Number.isInteger(repeats) && repeats >= -1 && repeats <= 65535, 'Choose a valid repeat count.');
    output = repeats === -1 ? null : repeats;
    const speed = Number(opts.rate || 1);
    check(speed >= .1 && speed <= 10, 'Speed must be between 0.1 and 10.');
    delay = d => d ? Math.max(1, Math.round(d / speed)) : d;
  }
  const sources = (opts.tool === 'combine-gifs' ? infos : [info]).map(source => ({
    info: source, delays: allFrames(source, delay),
    change: pixels => fitPixels(pixels, source.width, source.height, width, height, opts),
  }));
  return streamGif(sources, width, height, {loop: output});
}
