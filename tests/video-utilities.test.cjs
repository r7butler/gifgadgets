/* The video worker is a handful of FFmpeg argument lists, and those lists are
   the whole tool — a wrong flag is a wrong file. tests/e2e/video-utilities.spec.js
   proves the real engine produces real video; this proves the arguments,
   container choice and guards are right without downloading 32 MB of WASM. */
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

// Objects built inside the vm carry that realm's prototypes, which a strict
// deep compare rejects. Round-tripping them makes the comparison meaningful.
const plain = value => JSON.parse(JSON.stringify(value));

// What FFmpeg prints for `-i file` with no output: the worker reads the
// duration out of this and refuses anything with no video stream.
const PROBE = 'Input #0, mov,mp4\n  Duration: 00:00:02.50, start: 0.000000, bitrate: 500 kb/s\n'
  + '  Stream #0:0: Video: h264, yuv420p, 96x64\n  Stream #0:1: Audio: aac, 44100 Hz';

/* A worker running against a recording stand-in for ffmpeg-core. */
function spawn({log = PROBE, code = 0, output = new Uint8Array([0, 1, 2, 3])} = {}) {
  const calls = [], sent = [], files = new Map();
  let logger = () => {};
  const core = {
    ret: 0,
    setTimeout() {},
    reset() {},
    setLogger(fn) { logger = fn; },
    exec(...args) {
      calls.push(args);
      log.split('\n').forEach(message => logger({message}));
      const last = args[args.length - 1];
      // Real FFmpeg exits non-zero when asked to probe with no output file;
      // only a genuine export result is worth a return code.
      if (String(last).startsWith('output.')) { core.ret = code; if (!code) files.set(last, output); }
      else core.ret = 1;
    },
    FS: {
      writeFile: (name, bytes) => files.set(name, bytes),
      readFile: name => { if (!files.has(name)) throw Error('no such file: ' + name); return files.get(name); },
      unlink: name => { if (!files.delete(name)) throw Error('no such file: ' + name); }
    }
  };
  const context = vm.createContext({
    console, Uint8Array, DataView, TextDecoder, JSON, Math, Number, String, Error, btoa,
    URL, Promise, importScripts() {}, createFFmpegCore: async () => core
  });
  context.self = context;
  context.location = 'https://example.test/video-frame-extractor/';
  context.postMessage = (message) => sent.push(message);
  vm.runInContext(fs.readFileSync('frontend/video-utilities-worker.js', 'utf8'), context,
                  {filename: 'video-utilities-worker.js'});
  const send = data => context.self.onmessage({data});
  return {calls, sent, files, core, send, last: () => sent[sent.length - 1]};
}

/* A loaded worker, ready to export. */
async function loaded(options = {}, extension = 'mp4') {
  const w = spawn(options);
  await w.send({type: 'load', bytes: new Uint8Array([1, 2, 3]).buffer, extension});
  return w;
}

/* The argument list of the export, as one string for flag assertions. */
async function exported(tool, params = {}, options = {}, extension = 'mp4') {
  const w = await loaded(options, extension);
  await w.send({type: 'export', tool, start: 0, end: 1, ...params});
  return {worker: w, args: w.calls[1] || [], text: (w.calls[1] || []).join(' '), result: w.last()};
}

test('loading reports the duration and rejects anything without a video stream', async () => {
  const w = await loaded();
  assert.deepEqual(plain(w.last()), {type: 'loaded', info: {duration: 2.5}});
  // The probe's non-zero exit is FFmpeg's normal behaviour, not a failure.
  assert.deepEqual(plain(w.calls[0]), ['-nostdin', '-y', '-i', 'input.mp4']);
  assert.equal(w.files.get('input.mp4').length, 3, 'the source is written under its real extension');

  const hourLong = await loaded({log: 'Duration: 01:02:03.75\n  Stream #0:0: Video: vp9'});
  assert.equal(hourLong.last().info.duration, 3723.75);

  for (const log of ['Duration: 00:00:05.00\n  Stream #0:0: Audio: mp3', 'nothing useful here',
                     'Duration: 00:00:00.00\n  Stream #0:0: Video: h264']) {
    const bad = await loaded({log});
    assert.equal(bad.last().type, 'error', log);
    assert.match(bad.last().message, /No readable video stream|determine the animation duration/);
  }
});

test('exporting before a file is loaded fails instead of reusing a stale core', async () => {
  const w = spawn();
  await w.send({type: 'export', tool: 'mute-video', start: 0, end: 1});
  assert.deepEqual(plain(w.last()), {type: 'error', message: 'Choose a file first.'});
  assert.equal(w.calls.length, 0);
});

test('mute copies the video stream untouched and drops every audio track', async () => {
  const {text, result} = await exported('mute-video');
  assert.match(text, /-map 0:v:0/);
  assert.match(text, /-c:v copy/, 'muting must never re-encode the picture');
  assert.match(text, /-an/);
  assert.ok(!/libx264/.test(text), 'no encoder should be involved');
  assert.equal(result.mime, 'video/mp4');
  assert.equal(result.extension, 'mp4');
});

test('a muted WebM stays a WebM; every other container becomes MP4', async () => {
  for (const [source, expected] of [['webm', 'webm'], ['mp4', 'mp4'], ['mov', 'mp4']]) {
    const {args, result} = await exported('mute-video', {}, {}, source);
    assert.equal(result.extension, expected, source + ' muted to the wrong container');
    assert.equal(result.mime, 'video/' + expected);
    assert.equal(args[args.length - 1], 'output.' + expected);
  }
});

test('trim seeks to the start, keeps the requested span and carries optional audio', async () => {
  const {text} = await exported('trim-video', {start: 0.5, end: 1.75});
  assert.match(text, /-ss 0\.5/);
  assert.match(text, /-t 1\.25/, 'duration is end minus start, not the end time');
  // The trailing ? keeps a silent video from failing on a missing audio stream.
  assert.match(text, /-map 0:a:0\?/);
  assert.match(text, /-c:a aac/);
  assert.match(text, /-c:v libx264/);
});

test('trim refuses times outside the video or in the wrong order', async () => {
  for (const params of [{start: -1, end: 1}, {start: 2.5, end: 2.6}, {start: 3, end: 4},
                        {start: 1, end: 1}, {start: 1, end: 0.5}, {start: 0, end: 9},
                        // Just past the last frame: the tolerance is for rounding, not slack.
                        {start: 0, end: 2.6}, {start: 0, end: 3},
                        {start: NaN, end: 1}, {start: 0, end: NaN}]) {
    const {result, args} = await exported('trim-video', params);
    assert.equal(result.type, 'error', JSON.stringify(params) + ' was accepted');
    assert.equal(args.length, 0, 'a rejected range must not reach FFmpeg');
  }
  // The end may sit exactly on the final frame, within rounding tolerance.
  const {result} = await exported('trim-video', {start: 0, end: 2.5});
  assert.equal(result.type, 'result');
});

test('frame extraction takes one full-resolution PNG at the chosen second', async () => {
  const {text, args, result} = await exported('video-frame-extractor', {start: 1.5});
  // -ss before -i seeks rather than decoding everything up to that point.
  assert.ok(args.indexOf('-ss') < args.indexOf('-i'), 'seek must precede the input');
  assert.match(text, /-frames:v 1/);
  assert.ok(!/-vf|libx264|scale/.test(text), 'a still frame is never re-encoded or resized');
  assert.equal(result.mime, 'image/png');
  assert.equal(result.extension, 'png');
  for (const start of [-0.5, 2.5, 99, NaN]) {
    const bad = await exported('video-frame-extractor', {start});
    assert.equal(bad.result.type, 'error', start + ' was accepted');
  }
});

test('GIF to MP4 plays one cycle, flattens transparency to black and pads odd sizes', async () => {
  const {text, result} = await exported('gif-to-mp4', {}, {}, 'gif');
  assert.match(text, /-ignore_loop 1/, 'without this a looping GIF encodes forever');
  assert.match(text, /lutrgb=r=0:g=0:b=0:a=255/);
  assert.match(text, /overlay=shortest=1/);
  assert.match(text, /pad=ceil\(iw\/2\)\*2:ceil\(ih\/2\)\*2/, 'H.264 needs even dimensions');
  assert.match(text, /-pix_fmt yuv420p/);
  assert.match(text, /-an/, 'a GIF has no audio to carry');
  assert.equal(result.extension, 'mp4');
});

test('consecutive exports of different tools do not contaminate each other', async () => {
  const w = await loaded({}, 'gif');
  await w.send({type: 'export', tool: 'gif-to-mp4', start: 0, end: 1});
  await w.send({type: 'export', tool: 'trim-video', start: 0, end: 1});
  // The GIF path rewrites a filter entry, so a shared or hoisted argument array
  // would hand the next export a transparency overlay it never asked for.
  assert.ok(!w.calls[2].join(' ').includes('lutrgb'), 'the GIF overlay leaked into the next export');
  assert.match(w.calls[2].join(' '), /-vf pad=ceil\(iw\/2\)\*2/);
});

test('every export strips metadata and cleans up its output file', async () => {
  for (const [tool, extension] of [['mute-video', 'mp4'], ['trim-video', 'mp4'],
                                   ['video-frame-extractor', 'mp4'], ['gif-to-mp4', 'gif']]) {
    const {text, worker} = await exported(tool, {start: 0, end: 1}, {}, extension);
    assert.match(text, /-map_metadata -1/, tool + ' kept source metadata');
    // Left behind, a stale output would be returned by the next export.
    assert.ok(![...worker.files.keys()].some(name => name.startsWith('output.')), tool + ' left its output behind');
  }
});

test('an unknown tool, a failed encode and an empty result all surface as errors', async () => {
  const unknown = await exported('enhance-video');
  assert.deepEqual(plain(unknown.result), {type: 'error', message: 'Unknown video tool.'});

  const failed = await exported('mute-video', {}, {code: 1});
  assert.equal(failed.result.type, 'error');
  assert.match(failed.result.message, /Export failed or exceeded three minutes/);

  const empty = await exported('mute-video', {}, {output: new Uint8Array(0)});
  assert.deepEqual(plain(empty.result), {type: 'error', message: 'No frame or video was produced at that time.'});
  // A failed export must not leave a partial file for the next run to pick up.
  assert.ok(![...empty.worker.files.keys()].some(name => name.startsWith('output.')));
});

test('a successful export hands back the bytes it read', async () => {
  const bytes = new Uint8Array([9, 8, 7, 6, 5]);
  const {result} = await exported('mute-video', {}, {output: bytes});
  assert.equal(result.type, 'result');
  assert.deepEqual(Array.from(result.bytes), [9, 8, 7, 6, 5]);
});
