/* ==========================================================
   GifCaption – Image Caption Tool bootstrap

   Thin layer that adapts the shared GC editor modules for
   still-image captioning (no GIF playback, no timeline,
   no object tracking).  Load this BEFORE editor.js so that
   stubs and overrides are in place when it runs.

   Depends on:
     editor-state.js   (GC namespace, state)
     gif-playback.js   (GC.loadHeicAsImage)
   ========================================================== */

(function () {
  'use strict';

  var $ = GC.$;
  var state = GC.state;

  // ── Stubs for GIF/tracker features not used here ──────

  /** No keyframe context menu in still-image mode. */
  GC.initKfMenu = function () {};

  /** No AI object tracking in still-image mode. */
  GC.trackerAvailable = function () { return false; };

  /** Tell the drop handler what file types are expected. */
  GC.dropErrorMessage = 'Please drop a JPEG, PNG, WebP, or HEIC image.';

  // ── Image loading ──────────────────────────────────────

  function isHeicFile(file) {
    return file.type === 'image/heic' || file.type === 'image/heif' ||
           /\.heic$/i.test(file.name) || /\.heif$/i.test(file.name);
  }

  /**
   * Load any raster image (JPEG, PNG, WebP, GIF frame, …) as a single
   * still frame so the shared editor can caption it.
   */
  GC.loadImageFile = function (file) {
    GC.showLoading('Loading image…');
    var url = URL.createObjectURL(file);
    var img = new Image();
    img.onload = function () {
      var w = img.naturalWidth;
      var h = img.naturalHeight;
      state.width  = w;
      state.height = h;
      state.gifFilename = file.name || null;
      state.frames = [];
      state.isStillImage = true;

      var tmpCanvas = document.createElement('canvas');
      tmpCanvas.width  = w;
      tmpCanvas.height = h;
      tmpCanvas.getContext('2d').drawImage(img, 0, 0);

      state.frames.push({
        imageData: tmpCanvas.getContext('2d').getImageData(0, 0, w, h),
        delay: 100,
      });
      URL.revokeObjectURL(url);

      GC.canvas.width  = w;
      GC.canvas.height = h;
      state.currentFrame = 0;
      state.isPlaying    = false;

      GC.renderCurrentFrame();
      GC.buildTimeline();
      GC.updateUI();

      $('#editor-workspace').classList.remove('hidden');
      $('#upload-zone').classList.add('hidden');
      $('#btn-download').disabled = false;
      GC.hideLoading();
    };
    img.onerror = function () {
      URL.revokeObjectURL(url);
      GC.hideLoading();
      GC.showError('Could not load image.');
    };
    img.src = url;
  };

  // ── IndexedDB loading (from landing page) ─────────────

  GC.loadImageFromIndexedDB = function () {
    var req = indexedDB.open('gifwidgets_imgcap', 1);
    req.onupgradeneeded = function (e) { e.target.result.createObjectStore('files'); };
    req.onsuccess = function (e) {
      var db = e.target.result;
      if (!db.objectStoreNames.contains('files')) return;
      var tx  = db.transaction('files', 'readonly');
      var get = tx.objectStore('files').get('pending');
      get.onsuccess = function () {
        var file = get.result;
        if (!file) return;
        var del = db.transaction('files', 'readwrite');
        del.objectStore('files').delete('pending');
        // Ensure still-image mode regardless of which loader is called
        state.isStillImage = true;
        state.gifFilename = file.name || null;
        if (isHeicFile(file)) {
          GC.loadHeicAsImage(file);
        } else {
          GC.loadImageFile(file);
        }
      };
      get.onerror = function () {};
    };
    req.onerror = function () {};
  };

})();
