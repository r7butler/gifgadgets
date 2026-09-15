/* Shared decoder: runs in a worker, or yields between batches on the main thread. */
(function (scope) {
  'use strict';
  scope.GWDecodeGif = async function (buffer, onFrame, onProgress) {
    var reader = new GifReader(new Uint8Array(buffer));
    var w = reader.width, h = reader.height, count = reader.numFrames();
    if (!w || !h || !count) throw new Error('No frames found');
    var composed = new Uint8ClampedArray(w * h * 4);
    var pixels = new Uint8ClampedArray(composed.length);
    for (var i = 0; i < count; i++) {
      var info = reader.frameInfo(i);
      var previous = info.disposal === 3 ? composed.slice() : null;
      pixels.fill(0);
      reader.decodeAndBlitFrameRGBA(i, pixels);
      // GIF pixels are either fully opaque or transparent.
      for (var p = 0; p < pixels.length; p += 4) {
        if (pixels[p + 3]) {
          composed[p] = pixels[p]; composed[p + 1] = pixels[p + 1];
          composed[p + 2] = pixels[p + 2]; composed[p + 3] = pixels[p + 3];
        }
      }
      onFrame({ pixels: composed.slice(), width: w, height: h,
        delay: Math.max((info.delay || 10) * 10, 20) });
      if (info.disposal === 2) {
        for (var y = info.y; y < Math.min(h, info.y + info.height); y++) {
          composed.fill(0, (y * w + info.x) * 4, (y * w + Math.min(w, info.x + info.width)) * 4);
        }
      } else if (previous) composed = previous;
      if (i % 8 === 0 || i === count - 1) {
        onProgress(i + 1, count);
        await new Promise(function (resolve) { setTimeout(resolve, 0); });
      }
    }
  };
  if (typeof document === 'undefined') {
    self.onmessage = async function (event) {
      try {
        importScripts('https://unpkg.com/omggif@1.0.10/omggif.js');
        await scope.GWDecodeGif(event.data, function (frame) {
          self.postMessage({ frame: frame }, [frame.pixels.buffer]);
        }, function (done, total) { self.postMessage({ done: done, total: total }); });
        self.postMessage({ complete: true });
      } catch (error) { self.postMessage({ error: error.message }); }
    };
  }
})(typeof self !== 'undefined' ? self : window);
