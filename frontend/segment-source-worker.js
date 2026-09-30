/* Encodes the GIF editor's frames, as they stand after any edits, into the GIF
   uploaded for AI object selection (editor-background.js), so the masks that
   come back line up with them rather than with the original file. Frames
   arrive one at a time and each is acknowledged, to hold one in memory. */
'use strict';
self.window = self;
importScripts('/gifenc.browser.js', '/gif-codec.js');

let encoder, width, height;
self.onmessage = ({data}) => {
  try {
    if (data.type === 'start') {
      encoder = gifenc.GIFEncoder(); width = data.width; height = data.height;
    } else if (data.type === 'frame') {
      const palette = paletteFrame(new Uint8Array(data.pixels));
      encoder.writeFrame(palette.indexed, width, height, {
        palette: palette.palette.map(c => [c >> 16 & 255, c >> 8 & 255, c & 255]),
        transparent: palette.transparent !== undefined, transparentIndex: palette.transparent || 0,
        delay: data.delay, repeat: 0, dispose: 2});
      self.postMessage({done: data.index + 1});
    } else if (data.type === 'finish') {
      encoder.finish();
      const bytes = encoder.bytes();
      self.postMessage({bytes}, [bytes.buffer]);
    }
  } catch (error) {
    self.postMessage({error: error.message});
  }
};
