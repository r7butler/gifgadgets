/* ==========================================================
   GifCaption – GIF Playback

   GIF loading (file, URL, IndexedDB), frame extraction via
   the omggif library, and play/pause/seek scheduling.

   This module is GIF-specific.  A future still-image tool
   would skip this entirely and push a single frame into
   GC.state.frames instead.

   Depends on:
     editor-state.js      (GC namespace, state)
     canvas-rendering.js  (GC.renderCurrentFrame)
     omggif               (GifReader global)
   ========================================================== */

(function () {
  'use strict';

  var $ = GC.$;
  var state = GC.state;

  // ── GIF Worker Preload ───────────────────────
  // gif.js uses a Web Worker for encoding.  We fetch the worker
  // script at page load and turn it into a blob URL so the
  // encoder can use it later without a cross-origin request.

  GC.preloadGifWorker = function () {
    fetch('https://cdnjs.cloudflare.com/ajax/libs/gif.js/0.2.0/gif.worker.js')
      .then(function (r) { return r.blob(); })
      .then(function (blob) {
        state._workerBlobUrl = URL.createObjectURL(blob);
      })
      .catch(function () {
        // Silently fail — checked at export time
      });
  };

  // ── GIF Loading ──────────────────────────────

  /** Load a GIF from a File object (drag-drop or file picker). */
  GC.loadGifFromFile = function (file) {
    state.gifFilename = file.name || null;
    GC.showLoading('Parsing GIF frames…');
    var reader = new FileReader();
    reader.onload = function () {
      try {
        processGifBuffer(reader.result);
        GC.hideLoading();
      } catch (err) {
        GC.hideLoading();
        GC.showError('Failed to parse GIF: ' + err.message);
      }
    };
    reader.onerror = function () {
      GC.hideLoading();
      GC.showError('Could not read file.');
    };
    reader.readAsArrayBuffer(file);
  };

  /** Load a GIF by backend ID (via ?id= query parameter). */
  GC.loadGifById = function (id) {
    GC.showLoading('Loading GIF…');
    state.gifId = id;
    fetchGif(id).then(function (data) {
      return fetch(data.gif_url);
    }).then(function (resp) {
      if (!resp.ok) throw new Error('Network error');
      return resp.arrayBuffer();
    }).then(function (buf) {
      processGifBuffer(buf);
      GC.hideLoading();
    }).catch(function (err) {
      GC.hideLoading();
      GC.showError('Failed to load GIF: ' + err.message);
    });
  };

  /** Load a pending GIF from IndexedDB (set by the landing page). */
  GC.loadGifFromIndexedDB = function () {
    GC.showLoading('Loading GIF…');
    var req = indexedDB.open('gifcaption', 1);
    req.onupgradeneeded = function (e) { e.target.result.createObjectStore('files'); };
    req.onsuccess = function (e) {
      var db = e.target.result;
      if (!db.objectStoreNames.contains('files')) { GC.hideLoading(); return; }
      var tx = db.transaction('files', 'readonly');
      var get = tx.objectStore('files').get('pending');
      get.onsuccess = function () {
        var file = get.result;
        if (!file) { GC.hideLoading(); return; }
        // Clean up the pending entry
        var del = db.transaction('files', 'readwrite');
        del.objectStore('files').delete('pending');
        if (file.type && file.type.startsWith('video/')) {
          GC.loadVideoAsGif(file);
        } else {
          GC.loadGifFromFile(file);
        }
      };
      get.onerror = function () { GC.hideLoading(); };
    };
    req.onerror = function () { GC.hideLoading(); };
  };

  // ── Frame Extraction (omggif) ────────────────

  /**
   * Parse a GIF ArrayBuffer into individual frames.
   * Handles all three GIF disposal methods so composited
   * frames render correctly (keep, clear, restore).
   */
  function processGifBuffer(buffer) {
    var gifReader = new GifReader(new Uint8Array(buffer));
    var w = gifReader.width;
    var h = gifReader.height;
    state.width = w;
    state.height = h;

    // Compositing canvas — accumulates frames that build on each other
    var compCanvas = document.createElement('canvas');
    compCanvas.width = w;
    compCanvas.height = h;
    var compCtx = compCanvas.getContext('2d', { willReadFrequently: true });

    // Temporary canvas for decoding each frame's raw pixels
    var tmpCanvas = document.createElement('canvas');
    tmpCanvas.width = w;
    tmpCanvas.height = h;
    var tmpCtx = tmpCanvas.getContext('2d', { willReadFrequently: true });

    state.frames = [];
    var prevState = null;

    for (var i = 0; i < gifReader.numFrames(); i++) {
      var info = gifReader.frameInfo(i);

      // Disposal method 3 = restore to previous — save state before drawing
      if (info.disposal === 3) {
        prevState = compCtx.getImageData(0, 0, w, h);
      }

      // Decode frame RGBA data and composite onto the running canvas
      var pixels = new Uint8ClampedArray(w * h * 4);
      gifReader.decodeAndBlitFrameRGBA(i, pixels);
      tmpCtx.clearRect(0, 0, w, h);
      tmpCtx.putImageData(new ImageData(pixels, w, h), 0, 0);
      compCtx.drawImage(tmpCanvas, 0, 0);

      // Snapshot the composited result for this frame
      var comp = compCtx.getImageData(0, 0, w, h);
      state.frames.push({
        imageData: new ImageData(new Uint8ClampedArray(comp.data), w, h),
        delay: Math.max((info.delay || 10) * 10, 20),
      });

      // Apply disposal method
      if (info.disposal === 2) {
        // Clear the frame's region
        compCtx.clearRect(info.x, info.y, info.width, info.height);
      } else if (info.disposal === 3 && prevState) {
        // Restore canvas to snapshot before this frame
        compCtx.putImageData(prevState, 0, 0);
      }
    }

    if (state.frames.length === 0) throw new Error('No frames found');

    // Initialise the preview canvas
    GC.canvas.width = state.width;
    GC.canvas.height = state.height;
    state.currentFrame = 0;
    state.isPlaying = false;

    GC.renderCurrentFrame();
    GC.buildTimeline();
    GC.updateUI();

    $('#editor-workspace').classList.remove('hidden');
    $('#upload-zone').classList.add('hidden');
    $('#btn-share').disabled = false;
    $('#btn-download').disabled = false;
  }

  // ── Playback Controls ────────────────────────

  GC.play = function () {
    if (state.frames.length === 0) return;
    state.isPlaying = true;
    GC.updatePlaybackUI();
    scheduleNextFrame();
  };

  GC.pause = function () {
    state.isPlaying = false;
    clearTimeout(GC.playbackTimer);
    GC.playbackTimer = null;
    GC.updatePlaybackUI();
  };

  GC.togglePlayPause = function () {
    state.isPlaying ? GC.pause() : GC.play();
  };

  /** Schedule the next frame after the current frame's delay. */
  function scheduleNextFrame() {
    if (!state.isPlaying) return;
    var delay = state.frames[state.currentFrame].delay / state.speed;
    GC.playbackTimer = setTimeout(function () {
      state.currentFrame = (state.currentFrame + 1) % state.frames.length;
      GC.renderCurrentFrame();
      GC.updatePlaybackUI();
      GC.movePlayhead();
      scheduleNextFrame();
    }, delay);
  }

  /** Jump to a specific frame number (clamped to valid range). */
  GC.seekFrame = function (n) {
    n = Math.max(0, Math.min(state.frames.length - 1, n));
    state.currentFrame = n;
    GC.renderCurrentFrame();
    GC.updatePlaybackUI();
    GC.movePlayhead();
  };

  // ── Video → GIF Conversion ───────────────────

  /**
   * Load a video file, extract frames at ~10 fps using canvas,
   * and populate GC.state.frames as if a GIF had been loaded.
   */
  GC.loadVideoAsGif = function (file) {
    state.gifFilename = (file.name || 'video').replace(/\.[^.]+$/, '') + '.gif';
    GC.showLoading('Converting video to GIF frames…');

    var url = URL.createObjectURL(file);
    var video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';

    video.onerror = function () {
      URL.revokeObjectURL(url);
      GC.hideLoading();
      GC.showError('Could not load video. The format may not be supported by your browser.');
    };

    video.onloadedmetadata = function () {
      var duration = video.duration;
      if (!isFinite(duration) || duration <= 0) {
        URL.revokeObjectURL(url);
        GC.hideLoading();
        GC.showError('Could not determine video duration.');
        return;
      }

      // Cap at 20 seconds to avoid excessive memory use
      var maxDuration = Math.min(duration, 20);
      var fps = 10;
      var frameInterval = 1 / fps;
      var delay = Math.round(1000 / fps); // ms per frame for GIF playback

      var w = video.videoWidth;
      var h = video.videoHeight;

      // Scale down large videos to keep memory reasonable
      var maxDim = 640;
      if (w > maxDim || h > maxDim) {
        var scale = maxDim / Math.max(w, h);
        w = Math.round(w * scale);
        h = Math.round(h * scale);
      }

      state.width = w;
      state.height = h;

      var captureCanvas = document.createElement('canvas');
      captureCanvas.width = w;
      captureCanvas.height = h;
      var captureCtx = captureCanvas.getContext('2d', { willReadFrequently: true });

      state.frames = [];
      var currentTime = 0;
      var totalFrames = Math.floor(maxDuration * fps);

      function captureFrame() {
        if (currentTime > maxDuration) {
          finishCapture();
          return;
        }
        video.currentTime = currentTime;
      }

      video.onseeked = function () {
        captureCtx.drawImage(video, 0, 0, w, h);
        var imgData = captureCtx.getImageData(0, 0, w, h);
        state.frames.push({
          imageData: new ImageData(new Uint8ClampedArray(imgData.data), w, h),
          delay: delay,
        });

        // Update loading progress
        var progress = Math.round((state.frames.length / totalFrames) * 100);
        GC.showLoading('Converting video… ' + progress + '%');

        currentTime += frameInterval;
        captureFrame();
      };

      function finishCapture() {
        URL.revokeObjectURL(url);
        if (state.frames.length === 0) {
          GC.hideLoading();
          GC.showError('No frames could be extracted from the video.');
          return;
        }

        GC.canvas.width = w;
        GC.canvas.height = h;
        state.currentFrame = 0;
        state.isPlaying = false;

        GC.renderCurrentFrame();
        GC.buildTimeline();
        GC.updateUI();

        GC.$('#editor-workspace').classList.remove('hidden');
        GC.$('#upload-zone').classList.add('hidden');
        GC.$('#btn-share').disabled = false;
        GC.$('#btn-download').disabled = false;

        GC.hideLoading();
      }

      captureFrame();
    };

    video.src = url;
  };

})();
