/* ==========================================================
   GifCaption – Editor (Entry Point / Orchestrator)

   Initialises the editor, wires up all DOM events, handles
   caption CRUD, canvas drag/resize interactions, and UI
   updates.  The heavy lifting (rendering, playback, timeline,
   export) lives in the other GC modules.

   Depends on:
     editor-state.js      (GC namespace, state, constants, helpers)
     canvas-rendering.js  (GC.renderCurrentFrame, GC.getCaptionBBox,
                           GC.getSelectionCorners, GC.getCompositeSize,
                           GC.getFrameOffsetY, GC.drawBoxCaption, …)
     gif-playback.js      (GC.loadGifFromFile, GC.loadGifById,
                           GC.loadGifFromIndexedDB, GC.play, GC.pause,
                           GC.togglePlayPause, GC.seekFrame, …)
     gif-timeline.js      (GC.buildTimeline, GC.movePlayhead)
     gif-export.js        (GC.exportGif, GC.downloadBlob,
                           GC.makeCaptionedFilename, GC.shareFlow,
                           GC.closeShareModal, GC.setShareStatus,
                           GC.setShareSocial)
     app.js               (shareGif — called by gif-export)
   ========================================================== */

(function () {
  'use strict';

  var $ = GC.$;
  var state = GC.state;

  // ── Initialise ───────────────────────────────
  function init() {
    GC.canvas = $('#preview-canvas');
    GC.ctx = GC.canvas.getContext('2d');
    bindEvents();
    GC.preloadGifWorker();

    // Check URL params for a GIF to auto-load
    var params = new URLSearchParams(window.location.search);
    var gifId = params.get('id');
    var source = params.get('source');
    if (gifId) {
      GC.loadGifById(gifId);
    } else if (source === 'local') {
      GC.loadGifFromIndexedDB();
    }
  }

  // ── Caption CRUD ─────────────────────────────

  /**
   * Create a new on-image caption and add it to the state.
   * All position/style values have sensible defaults.
   */
  function addCaption(opts) {
    opts = opts || {};
    var cap = {
      id: 'cap-' + (GC.nextCaptionId++),
      text: opts.text || 'YOUR TEXT HERE',
      x: opts.x != null ? opts.x : 0.5,
      y: opts.y != null ? opts.y : 0.1,
      fontSize: opts.fontSize || 40,
      fontFamily: opts.fontFamily || 'Impact',
      color: opts.color || '#ffffff',
      strokeColor: opts.strokeColor || '#000000',
      strokeWidth: opts.strokeWidth != null ? opts.strokeWidth : 3,
      align: opts.align || 'center',
      startFrame: opts.startFrame || 0,
      endFrame: opts.endFrame != null ? opts.endFrame : state.frames.length - 1,
    };
    state.captions.push(cap);
    state.selectedCaptionId = cap.id;
    GC.updateCaptionList();
    updateCaptionEditor();
    GC.buildTimeline();
    GC.renderCurrentFrame();
    return cap;
  }

  function removeCaption(id) {
    state.captions = state.captions.filter(function (c) { return c.id !== id; });
    if (state.selectedCaptionId === id) {
      state.selectedCaptionId = state.captions.length ? state.captions[0].id : null;
    }
    GC.updateCaptionList();
    updateCaptionEditor();
    GC.buildTimeline();
    GC.renderCurrentFrame();
  }

  /** Select a caption by ID — highlights it on the canvas and opens the editor. */
  GC.selectCaption = function (id) {
    state.selectedCaptionId = id;
    GC.updateCaptionList();
    updateCaptionEditor();
    GC.renderCurrentFrame();
  };

  /** Apply a set of property changes to the currently selected caption. */
  function updateSelectedCaption(props) {
    var cap = GC.findCaption(state.selectedCaptionId);
    if (!cap) return;
    for (var k in props) cap[k] = props[k];
    GC.renderCurrentFrame();
    if ('startFrame' in props || 'endFrame' in props) GC.buildTimeline();
  }

  /** Look up a caption object by its ID string. */
  GC.findCaption = function (id) {
    for (var i = 0; i < state.captions.length; i++) {
      if (state.captions[i].id === id) return state.captions[i];
    }
    return null;
  };

  // ── Canvas Drag & Resize ─────────────────────

  /** Convert a mouse/touch event to GIF-frame-relative canvas coordinates. */
  function canvasCoords(e) {
    var rect = GC.canvas.getBoundingClientRect();
    var compSize = GC.getCompositeSize();
    var offsetY = GC.getFrameOffsetY();
    var rawX = (e.clientX - rect.left) * (compSize.w / rect.width);
    var rawY = (e.clientY - rect.top) * (compSize.h / rect.height);
    return { x: rawX, y: rawY - offsetY };
  }

  function handleCanvasMouseDown(e) {
    var m = canvasCoords(e);

    // 1. Hit-test corner resize handles (selected caption only)
    if (state.selectedCaptionId) {
      var selCap = GC.findCaption(state.selectedCaptionId);
      if (selCap && state.currentFrame >= selCap.startFrame && state.currentFrame <= selCap.endFrame) {
        var bbox = GC.getCaptionBBox(GC.ctx, selCap);
        if (bbox) {
          var corners = GC.getSelectionCorners(bbox);
          var hs = GC.HANDLE_SIZE;
          var hitRadius = hs * 0.8;
          for (var c = 0; c < corners.length; c++) {
            var cx = corners[c].x + hs / 2;
            var cy = corners[c].y + hs / 2;
            var dx = m.x - cx, dy = m.y - cy;
            if (dx * dx + dy * dy <= hitRadius * hitRadius) {
              state.resizeState = {
                captionId: selCap.id,
                startFontSize: selCap.fontSize,
                startY: m.y,
                startX: m.x,
                startDist: Math.sqrt(Math.pow(m.x - selCap.x * state.width, 2) + Math.pow(m.y - selCap.y * state.height, 2)),
              };
              GC.canvas.style.cursor = 'nwse-resize';
              return;
            }
          }
        }
      }
    }

    // 2. Hit-test captions in reverse order (top-most first)
    for (var i = state.captions.length - 1; i >= 0; i--) {
      var cap = state.captions[i];
      if (state.currentFrame < cap.startFrame || state.currentFrame > cap.endFrame) continue;
      var bbox = GC.getCaptionBBox(GC.ctx, cap);
      if (!bbox) continue;
      if (m.x >= bbox.x - 6 && m.x <= bbox.x + bbox.w + 6 &&
          m.y >= bbox.y - 6 && m.y <= bbox.y + bbox.h + 6) {
        state.selectedCaptionId = cap.id;
        state.dragState = {
          captionId: cap.id,
          offsetX: m.x - cap.x * state.width,
          offsetY: m.y - cap.y * state.height,
        };
        GC.canvas.style.cursor = 'grabbing';
        GC.updateCaptionList();
        updateCaptionEditor();
        GC.renderCurrentFrame();
        return;
      }
    }
  }

  function handleCanvasMouseMove(e) {
    var m = canvasCoords(e);

    // Active resize drag
    if (state.resizeState) {
      var cap = GC.findCaption(state.resizeState.captionId);
      if (!cap) return;
      var dist = Math.sqrt(Math.pow(m.x - cap.x * state.width, 2) + Math.pow(m.y - cap.y * state.height, 2));
      var scale = dist / state.resizeState.startDist;
      cap.fontSize = Math.max(10, Math.min(200, Math.round(state.resizeState.startFontSize * scale)));
      GC.renderCurrentFrame();
      updateCaptionEditor();
      return;
    }

    // No active drag — update cursor based on hover
    if (!state.dragState) {
      var onHandle = false;
      if (state.selectedCaptionId) {
        var selCap = GC.findCaption(state.selectedCaptionId);
        if (selCap && state.currentFrame >= selCap.startFrame && state.currentFrame <= selCap.endFrame) {
          var bbox = GC.getCaptionBBox(GC.ctx, selCap);
          if (bbox) {
            var corners = GC.getSelectionCorners(bbox);
            var hs = GC.HANDLE_SIZE;
            var hitRadius = hs * 0.8;
            for (var c = 0; c < corners.length; c++) {
              var cx = corners[c].x + hs / 2;
              var cy = corners[c].y + hs / 2;
              var dx = m.x - cx, dy = m.y - cy;
              if (dx * dx + dy * dy <= hitRadius * hitRadius) { onHandle = true; break; }
            }
          }
        }
      }
      if (onHandle) { GC.canvas.style.cursor = 'nwse-resize'; return; }

      var hovering = false;
      for (var i = state.captions.length - 1; i >= 0; i--) {
        var cap = state.captions[i];
        if (state.currentFrame < cap.startFrame || state.currentFrame > cap.endFrame) continue;
        var bbox = GC.getCaptionBBox(GC.ctx, cap);
        if (bbox && m.x >= bbox.x - 6 && m.x <= bbox.x + bbox.w + 6 &&
            m.y >= bbox.y - 6 && m.y <= bbox.y + bbox.h + 6) {
          hovering = true; break;
        }
      }
      GC.canvas.style.cursor = hovering ? 'grab' : 'default';
      return;
    }

    // Active position drag
    var cap = GC.findCaption(state.dragState.captionId);
    if (!cap) return;
    cap.x = Math.max(0, Math.min(1, (m.x - state.dragState.offsetX) / state.width));
    cap.y = Math.max(0, Math.min(1, (m.y - state.dragState.offsetY) / state.height));
    GC.renderCurrentFrame();
  }

  function handleCanvasMouseUp() {
    if (state.resizeState) {
      state.resizeState = null;
      GC.canvas.style.cursor = 'default';
      return;
    }
    if (state.dragState) {
      state.dragState = null;
      GC.canvas.style.cursor = 'grab';
    }
  }

  /** Convert a touch event into a fake mouse event for the drag handlers. */
  function touchToMouse(handler) {
    return function (e) {
      e.preventDefault();
      var t = e.touches[0] || e.changedTouches[0];
      handler({ clientX: t.clientX, clientY: t.clientY });
    };
  }

  // ── UI Updates ───────────────────────────────

  /** Refresh all UI panels (caption list, editor, playback controls). */
  GC.updateUI = function () {
    GC.updateCaptionList();
    updateCaptionEditor();
    GC.updatePlaybackUI();
  };

  /** Rebuild the caption list sidebar from current state. */
  GC.updateCaptionList = function () {
    var list = $('#caption-list');
    if (!list) return;
    list.innerHTML = '';
    if (state.captions.length === 0) {
      list.innerHTML = '<div class="caption-list-empty">No captions yet.<br>Click <strong>+ Add</strong> to start.</div>';
      return;
    }
    state.captions.forEach(function (cap, idx) {
      var item = document.createElement('div');
      item.className = 'caption-list-item' + (cap.id === state.selectedCaptionId ? ' selected' : '');
      item.innerHTML =
        '<div class="caption-color-dot" style="background:' + GC.TRACK_COLORS[idx % GC.TRACK_COLORS.length] + '"></div>' +
        '<div class="caption-item-text">' + GC.escapeHtml(cap.text) + '</div>' +
        '<div class="caption-item-range">f' + cap.startFrame + '–' + cap.endFrame + '</div>';
      item.addEventListener('click', function () { GC.selectCaption(cap.id); });
      list.appendChild(item);
    });
  };

  /** Sync the caption editor panel with the currently selected caption. */
  function updateCaptionEditor() {
    var editor = $('#caption-editor');
    if (!editor) return;
    var cap = GC.findCaption(state.selectedCaptionId);
    if (!cap) { editor.classList.add('hidden'); return; }
    editor.classList.remove('hidden');
    $('#cap-text').value = cap.text;
    $('#cap-font-size').value = cap.fontSize;
    $('#cap-font-size-val').textContent = cap.fontSize;
    $('#cap-color').value = cap.color;
    $('#cap-stroke-color').value = cap.strokeColor;
    $('#cap-stroke-width').value = cap.strokeWidth;
    $('#cap-stroke-width-val').textContent = cap.strokeWidth;
    $('#cap-font').value = cap.fontFamily;
  }

  /** Update the play/pause button icon, frame counter, and scrubber. */
  GC.updatePlaybackUI = function () {
    var btn = $('#btn-play-pause');
    if (btn) {
      btn.innerHTML = state.isPlaying
        ? '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>'
        : '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>';
    }
    var counter = $('#frame-counter');
    if (counter) counter.textContent = (state.currentFrame + 1) + ' / ' + state.frames.length;
    var scrubber = $('#frame-scrubber');
    if (scrubber) {
      scrubber.max = state.frames.length - 1;
      scrubber.value = state.currentFrame;
    }
  };

  // ── Loading & Progress Overlays ──────────────

  GC.showLoading = function (msg) {
    var el = $('#loading-overlay');
    if (el) {
      el.querySelector('.loading-text').textContent = msg || 'Loading…';
      el.classList.remove('hidden');
    }
  };

  GC.hideLoading = function () {
    var el = $('#loading-overlay');
    if (el) el.classList.add('hidden');
  };

  GC.showError = function (msg) {
    alert(msg);
  };

  GC.showExportProgress = function (p) {
    var el = $('#export-overlay');
    if (!el) return;
    el.classList.remove('hidden');
    var bar = el.querySelector('.progress-bar-fill');
    if (bar) bar.style.width = (p * 100) + '%';
    var txt = el.querySelector('.progress-text');
    if (txt) txt.textContent = 'Exporting… ' + Math.round(p * 100) + '%';
  };

  GC.hideExportProgress = function () {
    var el = $('#export-overlay');
    if (el) el.classList.add('hidden');
  };

  // ── Event Binding ────────────────────────────

  function bindEvents() {
    // ── Drop zone / file picker ───────────────
    var dropZone = $('#drop-zone');
    if (dropZone) {
      dropZone.addEventListener('dragover', function (e) {
        e.preventDefault();
        dropZone.classList.add('dragover');
      });
      dropZone.addEventListener('dragleave', function () {
        dropZone.classList.remove('dragover');
      });
      dropZone.addEventListener('drop', function (e) {
        e.preventDefault();
        dropZone.classList.remove('dragover');
        var file = e.dataTransfer.files[0];
        if (file && (file.type === 'image/gif' || file.name.toLowerCase().endsWith('.gif'))) {
          GC.loadGifFromFile(file);
        } else {
          GC.showError('Please drop a GIF file.');
        }
      });
      dropZone.addEventListener('click', function () { $('#file-input').click(); });
    }

    var fileInput = $('#file-input');
    if (fileInput) {
      fileInput.addEventListener('change', function () {
        if (fileInput.files[0]) GC.loadGifFromFile(fileInput.files[0]);
      });
    }

    // ── "New" button → reset to upload screen ─
    var btnNew = $('#btn-new');
    if (btnNew) {
      btnNew.addEventListener('click', function () {
        GC.pause();
        state.frames = [];
        state.captions = [];
        state.selectedCaptionId = null;
        state.currentFrame = 0;
        GC.nextCaptionId = 1;
        $('#editor-workspace').classList.add('hidden');
        $('#upload-zone').classList.remove('hidden');
        $('#btn-share').disabled = true;
        $('#btn-download').disabled = true;
        if ($('#file-input')) $('#file-input').value = '';
      });
    }

    // ── Canvas interaction (drag, resize, touch)
    GC.canvas.addEventListener('mousedown', handleCanvasMouseDown);
    GC.canvas.addEventListener('mousemove', handleCanvasMouseMove);
    GC.canvas.addEventListener('mouseup', handleCanvasMouseUp);
    GC.canvas.addEventListener('mouseleave', handleCanvasMouseUp);
    GC.canvas.addEventListener('touchstart', touchToMouse(handleCanvasMouseDown), { passive: false });
    GC.canvas.addEventListener('touchmove', touchToMouse(handleCanvasMouseMove), { passive: false });
    GC.canvas.addEventListener('touchend', function () { handleCanvasMouseUp(); });

    // ── Mobile sidebar toggle ─────────────────
    var sidebarToggle = $('#sidebar-toggle');
    if (sidebarToggle) {
      sidebarToggle.addEventListener('click', function () {
        var sidebar = $('#editor-sidebar');
        var collapsed = sidebar.classList.toggle('mobile-collapsed');
        sidebarToggle.classList.toggle('collapsed', collapsed);
        sidebarToggle.setAttribute('aria-expanded', String(!collapsed));
      });
    }

    // ── Mobile timeline toggle ────────────────
    var timelineToggle = $('#timeline-toggle');
    if (timelineToggle) {
      timelineToggle.addEventListener('click', function () {
        var timeline = $('#editor-timeline');
        var collapsed = timeline.classList.toggle('mobile-collapsed');
        timelineToggle.classList.toggle('collapsed', collapsed);
        timelineToggle.setAttribute('aria-expanded', String(!collapsed));
      });
    }

    // ── Collapsible sidebar sections ──────────
    var boxCapToggle = $('#box-caption-toggle');
    if (boxCapToggle) {
      boxCapToggle.addEventListener('click', function () {
        var section = $('#box-caption-section');
        var collapsed = section.classList.toggle('collapsed');
        boxCapToggle.classList.toggle('collapsed', collapsed);
        boxCapToggle.setAttribute('aria-expanded', String(!collapsed));
      });
    }

    var onImageCapToggle = $('#on-image-caption-toggle');
    if (onImageCapToggle) {
      onImageCapToggle.addEventListener('click', function () {
        var section = $('#on-image-caption-section');
        var collapsed = section.classList.toggle('collapsed');
        onImageCapToggle.classList.toggle('collapsed', collapsed);
        onImageCapToggle.setAttribute('aria-expanded', String(!collapsed));
      });
    }

    // ── Playback controls ─────────────────────
    $('#btn-prev-frame').addEventListener('click', function () {
      GC.seekFrame((state.currentFrame - 1 + state.frames.length) % state.frames.length);
    });
    $('#btn-play-pause').addEventListener('click', GC.togglePlayPause);
    $('#btn-next-frame').addEventListener('click', function () {
      GC.seekFrame((state.currentFrame + 1) % state.frames.length);
    });
    $('#frame-scrubber').addEventListener('input', function (e) {
      GC.seekFrame(parseInt(e.target.value, 10));
    });
    $('#speed-slider').addEventListener('input', function (e) {
      state.speed = parseFloat(e.target.value);
      $('#speed-label').textContent = state.speed + '×';
    });

    // ── On-image caption controls ─────────────
    $('#btn-add-caption').addEventListener('click', function () { addCaption(); });
    $('#btn-add-top').addEventListener('click', function () {
      addCaption({ text: 'TOP TEXT', y: 0.05 });
    });
    $('#btn-add-bottom').addEventListener('click', function () {
      addCaption({ text: 'BOTTOM TEXT', y: 0.85 });
    });
    $('#btn-delete-caption').addEventListener('click', function () {
      if (state.selectedCaptionId) {
        $('#delete-modal').classList.remove('hidden');
      }
    });
    $('#delete-modal-confirm').addEventListener('click', function () {
      if (state.selectedCaptionId) removeCaption(state.selectedCaptionId);
      $('#delete-modal').classList.add('hidden');
    });
    $('#delete-modal-cancel').addEventListener('click', function () {
      $('#delete-modal').classList.add('hidden');
    });
    $('#delete-modal').addEventListener('click', function (e) {
      if (e.target === this) $('#delete-modal').classList.add('hidden');
    });

    // ── Caption editor inputs ─────────────────
    $('#cap-text').addEventListener('input', function (e) {
      updateSelectedCaption({ text: e.target.value });
      GC.updateCaptionList();
      // Defer timeline rebuild to avoid lag while typing
      clearTimeout(state._tlTimer);
      state._tlTimer = setTimeout(GC.buildTimeline, 400);
    });
    $('#cap-font-size').addEventListener('input', function (e) {
      var v = parseInt(e.target.value, 10);
      $('#cap-font-size-val').textContent = v;
      updateSelectedCaption({ fontSize: v });
    });
    $('#cap-color').addEventListener('input', function (e) {
      updateSelectedCaption({ color: e.target.value });
    });
    $('#cap-stroke-color').addEventListener('input', function (e) {
      updateSelectedCaption({ strokeColor: e.target.value });
    });
    $('#cap-stroke-width').addEventListener('input', function (e) {
      var v = parseFloat(e.target.value);
      $('#cap-stroke-width-val').textContent = v;
      updateSelectedCaption({ strokeWidth: v });
    });
    $('#cap-font').addEventListener('change', function (e) {
      updateSelectedCaption({ fontFamily: e.target.value });
    });

    // ── Box caption controls ──────────────────
    function addBoxCaption(position) {
      var bc = GC.makeBoxCaption();
      if (position === 'top') {
        state.boxCaptionTop = bc;
        $('#box-top-editor').classList.remove('hidden');
        $('#btn-add-box-top').classList.add('hidden');
        if (!state.boxCaptionBottom) $('#btn-add-box-bottom').classList.remove('hidden');
      } else {
        state.boxCaptionBottom = bc;
        $('#box-bottom-editor').classList.remove('hidden');
        $('#btn-add-box-bottom').classList.add('hidden');
      }
      GC.renderCurrentFrame();
    }

    function removeBoxCaption(position) {
      if (position === 'top') {
        state.boxCaptionTop = null;
        $('#box-top-editor').classList.add('hidden');
        $('#btn-add-box-top').classList.remove('hidden');
        $('#box-top-text').value = '';
        $('#box-top-height').value = 80; $('#box-top-height-val').textContent = '80';
        $('#box-top-border').value = 0; $('#box-top-border-val').textContent = '0';
        $('#box-top-fontsize').value = 36; $('#box-top-fontsize-val').textContent = '36';
      } else {
        state.boxCaptionBottom = null;
        $('#box-bottom-editor').classList.add('hidden');
        $('#btn-add-box-bottom').classList.remove('hidden');
        $('#box-bottom-text').value = '';
        $('#box-bottom-height').value = 80; $('#box-bottom-height-val').textContent = '80';
        $('#box-bottom-border').value = 0; $('#box-bottom-border-val').textContent = '0';
        $('#box-bottom-fontsize').value = 36; $('#box-bottom-fontsize-val').textContent = '36';
      }
      GC.renderCurrentFrame();
    }

    $('#btn-add-box-top').addEventListener('click', function () { addBoxCaption('top'); });
    $('#btn-add-box-bottom').addEventListener('click', function () { addBoxCaption('bottom'); });

    var pendingBoxRemove = null;
    $('#btn-remove-box-top').addEventListener('click', function () {
      pendingBoxRemove = 'top';
      $('#remove-box-modal').classList.remove('hidden');
    });
    $('#btn-remove-box-bottom').addEventListener('click', function () {
      pendingBoxRemove = 'bottom';
      $('#remove-box-modal').classList.remove('hidden');
    });
    $('#remove-box-modal-confirm').addEventListener('click', function () {
      if (pendingBoxRemove) removeBoxCaption(pendingBoxRemove);
      pendingBoxRemove = null;
      $('#remove-box-modal').classList.add('hidden');
    });
    $('#remove-box-modal-cancel').addEventListener('click', function () {
      pendingBoxRemove = null;
      $('#remove-box-modal').classList.add('hidden');
    });
    $('#remove-box-modal').addEventListener('click', function (e) {
      if (e.target === this) { pendingBoxRemove = null; this.classList.add('hidden'); }
    });

    // Wire up each position's sliders/pickers
    ['top', 'bottom'].forEach(function (pos) {
      var stateKey = pos === 'top' ? 'boxCaptionTop' : 'boxCaptionBottom';

      $('#box-' + pos + '-text').addEventListener('input', function (e) {
        if (state[stateKey]) { state[stateKey].text = e.target.value; GC.renderCurrentFrame(); }
      });
      $('#box-' + pos + '-height').addEventListener('input', function (e) {
        var v = parseInt(e.target.value, 10);
        $('#box-' + pos + '-height-val').textContent = v;
        if (state[stateKey]) { state[stateKey].height = v; GC.renderCurrentFrame(); }
      });
      $('#box-' + pos + '-border').addEventListener('input', function (e) {
        var v = parseInt(e.target.value, 10);
        $('#box-' + pos + '-border-val').textContent = v;
        if (state[stateKey]) { state[stateKey].borderWidth = v; GC.renderCurrentFrame(); }
      });
      $('#box-' + pos + '-fontsize').addEventListener('input', function (e) {
        var v = parseInt(e.target.value, 10);
        $('#box-' + pos + '-fontsize-val').textContent = v;
        if (state[stateKey]) { state[stateKey].fontSize = v; GC.renderCurrentFrame(); }
      });
      $('#box-' + pos + '-align').addEventListener('change', function (e) {
        if (state[stateKey]) { state[stateKey].align = e.target.value; GC.renderCurrentFrame(); }
      });
      $('#box-' + pos + '-font').addEventListener('change', function (e) {
        if (state[stateKey]) { state[stateKey].fontFamily = e.target.value; GC.renderCurrentFrame(); }
      });
      $('#box-' + pos + '-text-color').addEventListener('input', function (e) {
        if (state[stateKey]) { state[stateKey].textColor = e.target.value; GC.renderCurrentFrame(); }
      });
      $('#box-' + pos + '-bg-color').addEventListener('input', function (e) {
        if (state[stateKey]) { state[stateKey].bgColor = e.target.value; GC.renderCurrentFrame(); }
      });
    });

    // ── Export & Share ─────────────────────────
    var isMobile = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    $('#btn-download').addEventListener('click', function () {
      if (isMobile) {
        GC.exportGif({ onBlob: showDownloadModal });
      } else {
        GC.exportGif();
      }
    });
    $('#btn-share').addEventListener('click', GC.shareFlow);

    // Download modal (mobile long-press save flow)
    function showDownloadModal(blob) {
      var modal = $('#download-modal');
      modal._blob = blob;
      var preview = $('#download-preview');
      preview.innerHTML = '';
      var blobUrl = URL.createObjectURL(blob);
      var img = document.createElement('img');
      img.src = blobUrl;
      img.alt = 'Your captioned GIF';
      preview.appendChild(img);
      modal._blobUrl = blobUrl;
      modal.classList.remove('hidden');
    }
    function closeDownloadModal() {
      var modal = $('#download-modal');
      modal.classList.add('hidden');
      if (modal._blobUrl) { URL.revokeObjectURL(modal._blobUrl); modal._blobUrl = null; }
      modal._blob = null;
    }
    $('#download-modal-close').addEventListener('click', closeDownloadModal);
    $('#download-modal').addEventListener('click', function (e) {
      if (e.target === this) closeDownloadModal();
    });
    $('#btn-dl-download').addEventListener('click', function () {
      var blob = $('#download-modal')._blob;
      if (blob) GC.downloadBlob(blob, GC.makeCaptionedFilename());
    });
    $('#btn-dl-save-photos').addEventListener('click', function () {
      var blob = $('#download-modal')._blob;
      if (!blob) return;
      var fname = GC.makeCaptionedFilename();
      var file = new File([blob], fname, { type: 'image/gif' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        navigator.share({ files: [file], title: 'Captioned GIF' }).catch(function () {});
      } else {
        GC.downloadBlob(blob, fname);
      }
    });

    // Share modal events
    $('#share-modal-close').addEventListener('click', GC.closeShareModal);
    $('#share-modal').addEventListener('click', function (e) {
      if (e.target === this) GC.closeShareModal();
    });
    $('#btn-copy-link').addEventListener('click', function () {
      var input = $('#share-url');
      if (!input.value) return;
      navigator.clipboard.writeText(input.value).then(function () {
        GC.setShareStatus('Copied!', 'success');
      }).catch(function () {
        input.select();
        document.execCommand('copy');
        GC.setShareStatus('Copied!', 'success');
      });
    });
    $('#btn-copy-image-url').addEventListener('click', function () {
      var input = $('#share-image-url');
      if (!input.value) return;
      navigator.clipboard.writeText(input.value).then(function () {
        GC.setShareStatus('Image URL copied!', 'success');
      }).catch(function () {
        input.select();
        document.execCommand('copy');
        GC.setShareStatus('Image URL copied!', 'success');
      });
    });
    $('#btn-share-download').addEventListener('click', function () {
      var modal = $('#share-modal');
      if (modal._blob) GC.downloadBlob(modal._blob, GC.makeCaptionedFilename());
    });

    // Save to Photos (mobile: Web Share API or download fallback)
    var savePhotosBtn = $('#btn-share-save-photos');
    if (savePhotosBtn) {
      if ('ontouchstart' in window || navigator.maxTouchPoints > 0) {
        savePhotosBtn.style.display = '';
      }
      savePhotosBtn.addEventListener('click', function () {
        var modal = $('#share-modal');
        if (!modal._blob) return;
        var fname = GC.makeCaptionedFilename();
        var file = new File([modal._blob], fname, { type: 'image/gif' });
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
          navigator.share({ files: [file], title: 'Captioned GIF' }).catch(function () {});
        } else {
          GC.downloadBlob(modal._blob, fname);
        }
      });
    }

    // ── Keyboard shortcuts ────────────────────
    document.addEventListener('keydown', function (e) {
      var tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      if (state.frames.length === 0) return;
      switch (e.key) {
        case ' ':
          e.preventDefault(); GC.togglePlayPause(); break;
        case 'ArrowLeft':
          e.preventDefault();
          GC.seekFrame((state.currentFrame - 1 + state.frames.length) % state.frames.length);
          break;
        case 'ArrowRight':
          e.preventDefault();
          GC.seekFrame((state.currentFrame + 1) % state.frames.length);
          break;
        case 'Delete':
          if (state.selectedCaptionId) { e.preventDefault(); removeCaption(state.selectedCaptionId); }
          break;
      }
    });

    // ── Window resize → rebuild timeline ──────
    var resizeTimer;
    window.addEventListener('resize', function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        if (state.frames.length > 0 && !state._brushActive) GC.buildTimeline();
      }, 200);
    });
  }

  // ── Boot ─────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
