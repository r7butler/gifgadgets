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
  GC.warmUpTracker = function () {};

  /** Tell the drop handler what file types are expected. */
  GC.dropErrorMessage = 'Please drop a JPEG, PNG, WebP, or HEIC image.';

  /**
   * Wrap loadHeicAsImage so that direct HEIC drops (not via IndexedDB)
   * also get state.isStillImage = true before loading.
   */
  var _origLoadHeicAsImage = GC.loadHeicAsImage;
  GC.loadHeicAsImage = function (file) {
    state.isStillImage = true;
    state.gifFilename = state.gifFilename || file.name || null;
    _origLoadHeicAsImage(file);
  };

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
    GWFunnel.accepted(file.size);
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
      var _bs = $('#btn-share'); if (_bs) _bs.disabled = false;
      GWFunnel.ready();
      if (GC.draftLoaded) GC.draftLoaded();
      GC.hideLoading();
    };
    img.onerror = function () {
      URL.revokeObjectURL(url);
      GC.hideLoading();
      GWFunnel.failure('decode');
      GC.showError('Could not load image.');
    };
    img.src = url;
  };

  // Blank canvases are ordinary still frames: all existing layer, export and
  // recovery code continues to work, without an uploaded background image.
  GC.createBlankCanvas = function (options) {
    options = options || {};
    var width = Number(options.width), height = Number(options.height);
    var color = options.color || '#ffffff';
    if (!Number.isInteger(width) || !Number.isInteger(height) ||
        width < 1 || height < 1 || width > 4096 || height > 4096) {
      throw new Error('Enter a whole number from 1 to 4096 for both dimensions.');
    }
    if (!/^#[0-9a-f]{6}$/i.test(color)) throw new Error('Choose a valid background color.');
    if (state.frames.length) throw new Error('Choose New before creating another canvas.');

    // Allocate before changing state, so failure leaves the start screen usable.
    var canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    var context = canvas.getContext('2d');
    if (!context) throw new Error('Could not create this canvas. Try a smaller size.');
    if (!options.transparent) {
      context.fillStyle = color;
      context.fillRect(0, 0, width, height);
    }
    var pixels = context.getImageData(0, 0, width, height);
    canvas.width = canvas.height = 0;

    state.width = width; state.height = height;
    state.frames = [{ imageData: pixels, delay: 100 }];
    state.isStillImage = true;
    state.gifFilename = 'blank-canvas.png';
    state.gifId = null; state.originalFileSize = 0; state.isSample = false;
    state.currentFrame = 0; state.isPlaying = false;
    state.captions = []; state.overlays = [];
    state.selectedCaptionId = state.selectedOverlayId = null;
    state.boxCaptionTop = state.boxCaptionBottom = null;
    state.cropActive = false; state.cropRect = null;
    state.adjustments = { brightness: 0, contrast: 0, saturation: 0, hue: 0, filter: 'none' };
    GC.nextCaptionId = GC.nextOverlayId = 1;
    // PNG preserves transparent backgrounds and crisp meme text by default.
    state.exportFormat = 'image/png';
    var format = $('#sel-export-format');
    if (format) format.value = 'image/png';
    var quality = $('#export-quality-group');
    if (quality) quality.style.display = 'none';
    ['top', 'bottom'].forEach(function (position) {
      $('#box-' + position + '-editor').classList.add('hidden');
      $('#btn-add-box-' + position).classList.remove('hidden');
    });
    GC.canvas.width = width; GC.canvas.height = height;
    $('#editor-workspace').classList.remove('hidden');
    $('#upload-zone').classList.add('hidden');
    $('#btn-download').disabled = false;
    var share = $('#btn-share'); if (share) share.disabled = false;
    GC.updateUI(); GC.buildTimeline(); GC.renderCurrentFrame();
    if (GC.draftLoaded) GC.draftLoaded();
    // Expose the controls needed to compose a panel meme immediately.
    ['on-image-caption', 'overlay'].forEach(function (name) {
      var section = $('#' + name + '-section'), toggle = $('#' + name + '-toggle');
      if (section && toggle && section.classList.contains('collapsed')) toggle.click();
    });
    $('#btn-add-caption').focus({ preventScroll: true });
  };

  function mountBlankCanvasForm() {
    var upload = $('#upload-zone');
    if (!upload || $('#blank-canvas')) return;
    var details = document.createElement('details');
    details.id = 'blank-canvas';
    details.style.cssText = 'width:100%;max-width:500px;padding:16px;border:1px solid var(--border);border-radius:var(--radius-lg);background:var(--bg-secondary)';
    details.innerHTML =
      '<summary style="cursor:pointer;font-weight:700">Start with a blank canvas</summary>' +
      '<p class="drop-hint" style="margin:12px 0">Make a panel meme or collage. Add photos and text anywhere, without uploading a background image.</p>' +
      '<form id="blank-canvas-form">' +
        '<div class="form-group"><label for="blank-canvas-preset">Canvas size</label>' +
          '<select id="blank-canvas-preset">' +
            '<option value="1080x1350">Portrait (1080 &times; 1350)</option>' +
            '<option value="1080x1920">Tall / stacked panels (1080 &times; 1920)</option>' +
            '<option value="1080x1080">Square (1080 &times; 1080)</option>' +
            '<option value="1920x1080">Landscape (1920 &times; 1080)</option>' +
            '<option value="custom">Custom size</option>' +
          '</select></div>' +
        '<div class="form-row">' +
          '<div class="form-group" style="flex:1;min-width:0"><label for="blank-canvas-width">Width (px)</label>' +
            '<input id="blank-canvas-width" type="number" min="1" max="4096" step="1" inputmode="numeric" value="1080" required /></div>' +
          '<div class="form-group" style="flex:1;min-width:0"><label for="blank-canvas-height">Height (px)</label>' +
            '<input id="blank-canvas-height" type="number" min="1" max="4096" step="1" inputmode="numeric" value="1350" required /></div>' +
        '</div>' +
        '<div class="form-row" style="align-items:center;flex-wrap:wrap">' +
          '<div class="form-group"><label for="blank-canvas-color">Background</label>' +
            '<input id="blank-canvas-color" type="color" value="#ffffff" /></div>' +
          '<label class="option-label" for="blank-canvas-transparent">' +
            '<input id="blank-canvas-transparent" type="checkbox" /><span>Transparent</span></label>' +
        '</div>' +
        '<p id="blank-canvas-error" role="alert" class="drop-hint" style="color:var(--danger)" hidden></p>' +
        '<button id="btn-create-blank-canvas" type="submit" class="btn btn-accent btn-full">Create blank canvas</button>' +
        '<p class="drop-hint">Up to 4096 px per side. Use Image Overlays to add photos and On-Image Captions to add text.</p>' +
      '</form>';
    details.querySelectorAll('input[type=number]').forEach(function (input) {
      input.style.cssText = 'width:100%;min-width:0;min-height:40px;padding:8px 10px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg-primary);color:var(--text-primary);font:inherit';
    });
    // Keep the expanded form reachable on short screens and mobile keyboards.
    upload.style.minHeight = '0';
    upload.style.overflowY = 'auto';
    upload.style.justifyContent = 'flex-start';
    var drop = $('#drop-zone');
    if (drop) { drop.style.marginTop = 'auto'; drop.style.flexShrink = '0'; }
    details.style.marginBottom = 'auto';
    details.style.flexShrink = '0';
    upload.appendChild(details);
    // Landing-page links open the form. Existing draft recovery still runs.
    details.open = location.hash === '#blank-canvas';
    var preset = $('#blank-canvas-preset');
    var width = $('#blank-canvas-width'), height = $('#blank-canvas-height');
    var transparent = $('#blank-canvas-transparent'), color = $('#blank-canvas-color');
    preset.addEventListener('change', function () {
      if (preset.value === 'custom') return;
      var size = preset.value.split('x'); width.value = size[0]; height.value = size[1];
    });
    [width, height].forEach(function (input) {
      input.addEventListener('input', function () { preset.value = 'custom'; });
    });
    transparent.addEventListener('change', function () { color.disabled = transparent.checked; });
    $('#blank-canvas-form').addEventListener('submit', function (event) {
      event.preventDefault();
      var error = $('#blank-canvas-error'); error.hidden = true;
      try {
        GC.createBlankCanvas({ width: width.value, height: height.value, color: color.value, transparent: transparent.checked });
      } catch (err) {
        error.textContent = err.message || 'Could not create the canvas. Try a smaller size.';
        error.hidden = false;
      }
    });
  }
  mountBlankCanvasForm();

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
        if (file && file.buffer instanceof ArrayBuffer) file = new File([file.buffer], file.name, { type: file.type });
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
      get.onerror = function () { console.warn('Failed to read pending image from IndexedDB'); };
    };
    req.onerror = function () { console.warn('Failed to open IndexedDB for image loading'); };
  };

})();
