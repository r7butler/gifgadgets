/* Encodes the editor's composed frames as they arrive (GC.exportGif in gif-export.js).
   Messages in:  {type:'start', width, height, colors, tolerance}
                 {type:'frame', pixels: ArrayBuffer of RGBA, delay: hundredths}
                 {type:'finish'}
   Messages out: {type:'added'} once per frame, {type:'done', bytes}, {type:'error', message} */
'use strict';
self.window = self;
importScripts('/vendor/omggif.js', '/gifenc.browser.js', '/gif-codec.js');
let encoder = null;
self.onmessage = ({data}) => {
  try {
    if (data.type === 'start') {
      encoder = createGifEncoder(data.width, data.height, {loop: 0, colors: data.colors, tolerance: data.tolerance});
    } else if (data.type === 'frame') {
      const pixels = new Uint8Array(data.pixels);
      // GIF pixels are clear or not. Half-covered edges count as covered, as the
      // transparent key did with gif.js.
      for (let p = 3; p < pixels.length; p += 4) pixels[p] = pixels[p] < 128 ? 0 : 255;
      encoder.add(pixels, data.delay);
      postMessage({type: 'added'});
    } else if (data.type === 'finish') {
      const {bytes} = encoder.finish();
      postMessage({type: 'done', bytes}, [bytes.buffer]);
    }
  } catch (error) { postMessage({type: 'error', message: error.message}); }
};
