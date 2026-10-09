/* GIF encoding for the pages that build animations: the editor's export
   (gif-export.js) and the Crop, Resize, GIF Maker and Video to GIF tools.
   Frames are encoded in gif-encode-worker.js, which stores only what changes
   between them (createGifEncoder in gif-codec.js). */
(function () {
  'use strict';

  function failure(category, message) {
    var error = new Error(message);
    error.category = category;
    return error;
  }

  /**
   * Encode `count` frames as a GIF. Resolves to a Blob; rejects with an Error
   * whose `category` is 'encode' or 'timeout'.
   *
   * job.frame(i)   frame i as ImageData. Its pixels are handed to the encoder,
   *                so return a fresh ImageData each time.
   * job.delay(i)   how long frame i shows, in hundredths of a second.
   * job.loop       repeat count: 0 forever (the default), null to play once.
   * job.colors     most colours a frame keeps, up to 256.
   * job.tolerance  how far a colour may drift between frames before it is
   *                redrawn (lossy); 0 keeps every change.
   * job.onProgress called with the fraction of frames encoded.
   *
   * Frames are made a few ahead of the encoder rather than all at once, so an
   * export holds a handful of frames, not a copy of the whole animation.
   */
  function encode(job) {
    return new Promise(function (resolve, reject) {
      var worker;
      try { worker = new Worker('/gif-encode-worker.js'); }
      catch (_) { reject(failure('encode', 'Your browser could not start the GIF encoder.')); return; }
      var sent = 0, added = 0, watchdog;
      function end(error, blob) {
        clearTimeout(watchdog);
        worker.terminate();
        if (error) reject(error); else resolve(blob);
      }
      // A minute without a frame finishing means the encoder is stuck.
      function wait() {
        clearTimeout(watchdog);
        watchdog = setTimeout(function () {
          end(failure('timeout', 'Export timed out. Try reducing the number of frames or file size.'));
        }, 60000);
      }
      function feed() {
        try {
          while (sent < job.count && sent - added < 3) {
            var image = job.frame(sent);
            worker.postMessage({type: 'frame', pixels: image.data.buffer, delay: job.delay(sent)}, [image.data.buffer]);
            if (++sent === job.count) worker.postMessage({type: 'finish'});
          }
        } catch (error) { end(failure('encode', error.message)); }
      }
      worker.onmessage = function (event) {
        var data = event.data;
        if (data.type === 'error') {
          end(failure('encode', 'The GIF could not be encoded. ' + data.message));
        } else if (data.type === 'added') {
          added++;
          if (job.onProgress) job.onProgress(added / job.count);
          wait();
          feed();
        } else if (data.type === 'done') {
          end(null, new Blob([data.bytes], {type: 'image/gif'}));
        }
      };
      worker.onerror = function () { end(failure('encode', 'GIF encoding failed. Try a shorter animation.')); };
      worker.postMessage({type: 'start', width: job.width, height: job.height,
        loop: job.loop === undefined ? 0 : job.loop, colors: job.colors || 256, tolerance: job.tolerance || 0});
      wait();
      feed();
    });
  }

  window.GWGif = {encode: encode};
})();
