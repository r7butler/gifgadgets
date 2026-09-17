/* Single-thread FFmpeg stays inside a disposable worker; no cross-origin isolation needed. */
'use strict';
importScripts('/vendor/ffmpeg/ffmpeg-core.js');
let core, info, input;
const execute = args => {
  core.setTimeout(180000);
  core.exec('-nostdin', '-y', ...args);
  const code = core.ret;
  core.reset();
  return code;
};
self.onmessage = async ({data}) => {
  try {
    if (data.type === 'load') {
      core = await createFFmpegCore({mainScriptUrlOrBlob: '/vendor/ffmpeg/ffmpeg-core.js#' + btoa(JSON.stringify({wasmURL: new URL('/vendor/ffmpeg/ffmpeg-core.wasm', self.location).href}))});
      input = 'input.' + data.extension;
      core.FS.writeFile(input, new Uint8Array(data.bytes));
      let log = '';
      core.setLogger(({message}) => { log += message + '\n'; });
      execute(['-i', input]);
      const duration = log.match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (!duration || !/Video:/.test(log)) throw Error('No readable video stream found. Try another file.');
      info = {duration: +duration[1] * 3600 + +duration[2] * 60 + +duration[3]};
      if (!Number.isFinite(info.duration) || info.duration <= 0) throw Error('Could not determine the animation duration.');
      core.setLogger(() => {});
      self.postMessage({type: 'loaded', info});
      return;
    }
    const {tool, start, end} = data;
    if (!core) throw Error('Choose a file first.');
    const frame = tool === 'video-frame-extractor';
    if ((frame || tool === 'trim-video') && (!Number.isFinite(start) || start < 0 || start >= info.duration)) throw Error('Choose a start time within the video.');
    if (tool === 'trim-video' && (!Number.isFinite(end) || end <= start || end > info.duration + 0.001)) throw Error('End time must follow start time and stay within the video.');
    const extension = frame ? 'png' : tool === 'mute-video' && input.endsWith('.webm') ? 'webm' : 'mp4';
    const output = 'output.' + extension;
    let args;
    const encode = ['-vf','pad=ceil(iw/2)*2:ceil(ih/2)*2:color=black','-c:v','libx264','-preset','ultrafast','-crf','23','-pix_fmt','yuv420p','-movflags','+faststart'];
    if (frame) args = ['-ss', String(start), '-i', input, '-map', '0:v:0', '-frames:v', '1', '-threads', '1'];
    else if (tool === 'mute-video') args = ['-i', input, '-map', '0:v:0', '-c:v', 'copy', '-an'];
    else if (tool === 'trim-video') args = ['-ss', String(start), '-i', input, '-t', String(end-start), '-map', '0:v:0', '-map', '0:a:0?', ...encode, '-c:a', 'aac'];
    else if (tool === 'gif-to-mp4') {
      const gifEncode = encode.slice();
      gifEncode[1] = 'format=rgba,split[fg][bg];[bg]lutrgb=r=0:g=0:b=0:a=255[black];[black][fg]overlay=shortest=1,' + encode[1];
      args = ['-ignore_loop', '1', '-i', input, '-map', '0:v:0', ...gifEncode, '-an'];
    }
    else throw Error('Unknown video tool.');
    try {
      const code = execute([...args, '-map_metadata', '-1', output]);
      if (code !== 0) throw Error('Export failed or exceeded three minutes. Try a shorter clip or another format.');
      const bytes = core.FS.readFile(output);
      if (!bytes.length) throw Error('No frame or video was produced at that time.');
      self.postMessage({type: 'result', bytes, extension, mime: frame ? 'image/png' : 'video/' + extension}, [bytes.buffer]);
    } finally { try { core.FS.unlink(output); } catch (_) {} }
  } catch (error) { self.postMessage({type: 'error', message: error.message || 'Could not process this file.'}); }
};
