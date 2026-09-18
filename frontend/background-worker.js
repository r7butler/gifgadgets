'use strict';
self.window = self;
importScripts('/vendor/omggif.js', '/gifenc.browser.js', '/gif-codec.js', '/background-core.js');
let source, background, masks;
const MAX_MEMORY = 256 * 1024 * 1024;
function checkMemory(memory, budget, width, height) {
  if (memory > budget) throw Error(`These ${width} × ${height} pixels need about ${Math.ceil(memory / 1048576)} MiB of editing memory; ${Math.max(0, Math.floor(budget / 1048576))} MiB remain in this editor's 256 MiB budget. The 100 MB limit is for file size. Reduce the width or height and try again.`);
}
async function decode(buffer, type, budget = MAX_MEMORY) {
  if (type === 'image/gif') {
    const bytes = new Uint8Array(buffer), reader = new GifReader(bytes), parsed = blocks(bytes, false);
    // Budget encoded input plus decoder/compositing buffers, not one RGBA canvas
    // for every frame. Frame count now affects processing time, not pixel storage.
    const memory = bytes.byteLength + reader.width * reader.height * 4 * 10;
    checkMemory(memory, budget, reader.width, reader.height);
    const pixelsAt = createFrameCursor(bytes, reader, parsed);
    const frames = Array.from({length:reader.numFrames()}, (_,i) => ({delay:reader.frameInfo(i).delay}));
    // Validate every frame rectangle before a source can be submitted for AI.
    for (let i = 0; i < frames.length; i++) {
      const info = reader.frameInfo(i);
      check(info.x + info.width <= reader.width && info.y + info.height <= reader.height, 'Frame extends beyond the GIF canvas.');
    }
    pixelsAt(0);
    return {width:reader.width, height:reader.height, loop:reader.loopCount(), memory, frames, pixelsAt};
  }
  const bitmap = await createImageBitmap(new Blob([buffer], {type}));
  try {
    const memory = buffer.byteLength + bitmap.width * bitmap.height * 4 * 3;
    checkMemory(memory, budget, bitmap.width, bitmap.height);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height), ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    const pixels = ctx.getImageData(0,0,bitmap.width,bitmap.height).data;
    return {width:bitmap.width, height:bitmap.height, memory,
      frames:[{delay:10}], pixelsAt:() => pixels, loop:null};
  } finally { bitmap.close(); }
}
self.onmessage = async ({data}) => {
  try {
    if (data.type === 'load') {
      source = await decode(data.buffer, data.mime); masks = null; background = null;
      const pixels = source.pixelsAt(0).slice();
      self.postMessage({type:'loaded',width:source.width,height:source.height,count:source.frames.length,pixels},[pixels.buffer]);
    } else if (data.type === 'background') {
      background = null;
      const decoded = await decode(data.buffer, data.mime, MAX_MEMORY - source.memory);
      background = decoded;
      self.postMessage({type:'background-ready'});
    } else if (data.type === 'masks') {
      masks = null;
      masks = BackgroundCore.readMasks(data.buffer, source.frames.length);
      if (!masks.bytes.some(value => value)) {
        masks = null;
        throw Error('No subject was found. Add a keep point near the center of your subject and try again.');
      }
      const pixels = BackgroundCore.cutout(source.pixelsAt(0),source.width,source.height,masks,0);
      self.postMessage({type:'masks-ready',pixels},[pixels.buffer]);
    } else if (data.type === 'export') {
      if (!masks) throw Error('Select your objects and remove the background first.');
      const {width,height} = source;
      const canvas = new OffscreenCanvas(width,height), ctx = canvas.getContext('2d');
      const fg = new OffscreenCanvas(width,height), fctx = fg.getContext('2d');
      const useBackground = data.replace && data.mode === 'file';
      if (useBackground && !background) throw Error('Choose a replacement background.');
      const bg = useBackground ? new OffscreenCanvas(background.width,background.height) : null;
      const bctx = bg?.getContext('2d');
      const encoder = data.gif ? gifenc.GIFEncoder() : null;
      let lastForeground = -1, processed = 0;
      for (const frame of BackgroundCore.timeline(source.frames, useBackground ? background.frames : null)) {
        ctx.clearRect(0,0,width,height);
        if (data.replace) {
          ctx.fillStyle = data.color; ctx.fillRect(0,0,width,height);
          if (useBackground) {
            bctx.putImageData(new ImageData(new Uint8ClampedArray(background.pixelsAt(frame.background)),background.width,background.height),0,0);
            const ratio = data.fit === 'contain' ? Math.min(width/bg.width,height/bg.height) : Math.max(width/bg.width,height/bg.height);
            ctx.drawImage(bg,(width-bg.width*ratio)/2,(height-bg.height*ratio)/2,bg.width*ratio,bg.height*ratio);
          }
        }
        if (lastForeground !== frame.foreground) {
          const pixels = BackgroundCore.cutout(source.pixelsAt(frame.foreground),width,height,masks,frame.foreground);
          fctx.putImageData(new ImageData(pixels,width,height),0,0); lastForeground = frame.foreground;
        }
        ctx.drawImage(fg,0,0);
        if (!data.gif) {
          const blob = await canvas.convertToBlob({type:'image/png'});
          const bytes = new Uint8Array(await blob.arrayBuffer());
          self.postMessage({type:'result',bytes,mime:'image/png'},[bytes.buffer]); return;
        }
        const palette = paletteFrame(ctx.getImageData(0,0,width,height).data);
        encoder.writeFrame(palette.indexed,width,height,{
          palette:palette.palette.map(c => [c >> 16 & 255,c >> 8 & 255,c & 255]),
          transparent:palette.transparent !== undefined, transparentIndex:palette.transparent || 0,
          delay:frame.delay*10, repeat:source.loop === null ? -1 : source.loop, dispose:2});
        if (encoder.bytesView().length > MAX_MEMORY) throw Error('The result exceeds the 256 MiB export limit. This is separate from the 100 MB input-file limit. Reduce the dimensions or use a simpler background.');
        if (++processed % 8 === 0) { self.postMessage({progress:Math.round((frame.foreground+1)/source.frames.length*100)}); await new Promise(r=>setTimeout(r,0)); }
      }
      encoder.finish(); const bytes = encoder.bytes();
      self.postMessage({type:'result',bytes,mime:'image/gif'},[bytes.buffer]);
    }
  } catch (error) { self.postMessage({type:'error',message:error.message}); }
};
