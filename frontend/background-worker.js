'use strict';
self.window = self;
importScripts('/vendor/omggif.js', '/gifenc.browser.js', '/gif-codec.js', '/background-core.js');
let source, background, masks;
const MAX_MEMORY = 256 * 1024 * 1024;
async function decode(buffer, type) {
  if (type === 'image/gif') {
    const bytes = new Uint8Array(buffer), reader = new GifReader(bytes), parsed = blocks(bytes);
    const memory = reader.width * reader.height * 4 * (reader.numFrames() + 3);
    if (memory > MAX_MEMORY) throw Error('This animation exceeds available working memory. Resize it first.');
    return {width:reader.width, height:reader.height, loop:reader.loopCount(), memory,
      frames:decodeFrames(bytes, reader, parsed)};
  }
  const bitmap = await createImageBitmap(new Blob([buffer], {type}));
  try {
    if (bitmap.width * bitmap.height * 12 > MAX_MEMORY) throw Error('This image is too large to edit here. Resize it first.');
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height), ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    return {width:bitmap.width, height:bitmap.height, memory:bitmap.width * bitmap.height * 4,
      frames:[{pixels:ctx.getImageData(0,0,bitmap.width,bitmap.height).data,delay:10}],loop:null};
  } finally { bitmap.close(); }
}
self.onmessage = async ({data}) => {
  try {
    if (data.type === 'load') {
      source = await decode(data.buffer, data.mime); masks = null; background = null;
      const pixels = source.frames[0].pixels.slice();
      self.postMessage({type:'loaded',width:source.width,height:source.height,count:source.frames.length,pixels},[pixels.buffer]);
    } else if (data.type === 'background') {
      background = null;
      const decoded = await decode(data.buffer, data.mime);
      if (decoded.memory + source.memory > MAX_MEMORY) throw Error('These files need too much working memory together. Resize them first.');
      background = decoded;
      self.postMessage({type:'background-ready'});
    } else if (data.type === 'masks') {
      masks = null;
      masks = BackgroundCore.readMasks(data.buffer, source.frames.length);
      self.postMessage({type:'masks-ready'});
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
            bctx.putImageData(new ImageData(new Uint8ClampedArray(background.frames[frame.background].pixels),background.width,background.height),0,0);
            const ratio = data.fit === 'contain' ? Math.min(width/bg.width,height/bg.height) : Math.max(width/bg.width,height/bg.height);
            ctx.drawImage(bg,(width-bg.width*ratio)/2,(height-bg.height*ratio)/2,bg.width*ratio,bg.height*ratio);
          }
        }
        if (lastForeground !== frame.foreground) {
          const pixels = BackgroundCore.cutout(source.frames[frame.foreground].pixels,width,height,masks,frame.foreground);
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
        if (encoder.bytesView().length > MAX_MEMORY) throw Error('The exported GIF exceeds available memory. Use a smaller background.');
        if (++processed % 8 === 0) { self.postMessage({progress:Math.round((frame.foreground+1)/source.frames.length*100)}); await new Promise(r=>setTimeout(r,0)); }
      }
      encoder.finish(); const bytes = encoder.bytes();
      self.postMessage({type:'result',bytes,mime:'image/gif'},[bytes.buffer]);
    }
  } catch (error) { self.postMessage({type:'error',message:error.message}); }
};
