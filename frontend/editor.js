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

  function isHeic(file) {
    return file.type === 'image/heic' || file.type === 'image/heif' ||
           /\.heic$/i.test(file.name) || /\.heif$/i.test(file.name);
  }

  // ── Initialise ───────────────────────────────
  function init() {
    GC.canvas = $('#preview-canvas');
    GC.ctx = GC.canvas.getContext('2d');
    bindEvents();
    GC.initKfMenu();
    GC.preloadGifWorker();

    // Check URL params for a GIF to auto-load
    var params = new URLSearchParams(window.location.search);
    var gifId = params.get('id');
    var source = params.get('source');
    if (gifId) {
      GC.loadGifById(gifId);
    } else if (source === 'local') {
      GC.loadGifFromIndexedDB();
    } else if (source === 'imgcap' && GC.loadImageFromIndexedDB) {
      GC.loadImageFromIndexedDB();
    }
  }

  // ── Caption CRUD ─────────────────────────────

  /**
   * Create a new on-image caption and add it to the state.
   * All position/style values have sensible defaults.
   */
  function _pickCaptionPosition() {
    var caps = state.captions;
    var hasUpper = caps.some(function (c) { return c.y < 0.40; });
    var hasLower = caps.some(function (c) { return c.y > 0.60; });
    var hasMid   = caps.some(function (c) { return c.y >= 0.40 && c.y <= 0.60; });
    if (!hasUpper) return { x: 0.5, y: 0.07 };
    if (!hasLower) return { x: 0.5, y: 0.82 };
    if (!hasMid)   return { x: 0.5, y: 0.50 };
    // Middle occupied — try a small offset
    var ox = 0.53, oy = 0.53;
    var offsetTaken = caps.some(function (c) { return Math.abs(c.x - ox) < 0.03 && Math.abs(c.y - oy) < 0.03; });
    if (!offsetTaken) return { x: ox, y: oy };
    // Random fallback — try to find a clear spot
    for (var i = 0; i < 50; i++) {
      var rx = 0.1 + Math.random() * 0.8;
      var ry = 0.1 + Math.random() * 0.8;
      var tooClose = caps.some(function (c) { return Math.abs(c.x - rx) < 0.1 && Math.abs(c.y - ry) < 0.1; });
      if (!tooClose) return { x: rx, y: ry };
    }
    return { x: 0.5 + Math.random() * 0.1, y: 0.5 + Math.random() * 0.1 };
  }

  function addCaption(opts) {
    opts = opts || {};
    var pos = (opts.x == null && opts.y == null) ? _pickCaptionPosition() : null;
    var cap = {
      id: 'cap-' + (GC.nextCaptionId++),
      text: opts.text || 'YOUR TEXT HERE',
      x: opts.x != null ? opts.x : (pos ? pos.x : 0.5),
      y: opts.y != null ? opts.y : (pos ? pos.y : 0.15),
      fontSize: opts.fontSize || 40,
      fontFamily: opts.fontFamily || 'Impact',
      fontWeight: opts.fontWeight != null ? opts.fontWeight : 700,
      color: opts.color || '#ffffff',
      strokeColor: opts.strokeColor || '#000000',
      strokeWidth: opts.strokeWidth != null ? opts.strokeWidth : 3,
      align: opts.align || 'center',
      startFrame: opts.startFrame || 0,
      endFrame: opts.endFrame != null ? opts.endFrame : state.frames.length - 1,
      motion: [],        // Motion keyframes: [{ frame, x, y }] — empty = static position
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

  var CROP_EDGE_THRESHOLD = 10; // px tolerance for hitting a crop edge

  /** Convert a mouse/touch event to GIF-frame-relative canvas coordinates. */
  function canvasCoords(e) {
    var rect = GC.canvas.getBoundingClientRect();
    var compSize = GC.getCompositeSize();
    var offsetY = GC.getFrameOffsetY();
    var rawX = (e.clientX - rect.left) * (compSize.w / rect.width);
    var rawY = (e.clientY - rect.top) * (compSize.h / rect.height);
    return { x: rawX, y: rawY - offsetY };
  }

  // ── Zoom & Pan ────────────────────────────────

  function _applyZoom() {
    var s = state.zoom, px = state.panX, py = state.panY;
    GC.canvas.style.transform = (s === 1 && px === 0 && py === 0)
      ? '' : 'translate(' + px + 'px,' + py + 'px) scale(' + s + ')';
    var label = $('#zoom-label');
    if (label) label.textContent = s === 1 ? '1×' : (Math.round(s * 10) / 10) + '×';
  }

  function _clampPan() {
    if (state.zoom <= 1) { state.panX = 0; state.panY = 0; return; }
    var maxX = GC.canvas.offsetWidth  * (state.zoom - 1) / 2;
    var maxY = GC.canvas.offsetHeight * (state.zoom - 1) / 2;
    state.panX = Math.max(-maxX, Math.min(maxX, state.panX));
    state.panY = Math.max(-maxY, Math.min(maxY, state.panY));
  }

  function _setZoom(newZoom, pivotViewportX, pivotViewportY) {
    newZoom = Math.max(1, Math.min(8, newZoom));
    if (pivotViewportX !== undefined) {
      var rect = GC.canvas.getBoundingClientRect();
      var origCX = rect.left + rect.width  / 2;
      var origCY = rect.top  + rect.height / 2;
      var factor = newZoom / state.zoom;
      state.panX += (pivotViewportX - origCX) * (1 - factor);
      state.panY += (pivotViewportY - origCY) * (1 - factor);
    }
    state.zoom = newZoom;
    if (newZoom === 1) { state.panX = 0; state.panY = 0; }
    else _clampPan();
    _applyZoom();
  }

  /**
   * Hit-test the crop rectangle edges/interior.
   * Returns null or { edge: 'n'|'s'|'e'|'w'|'ne'|'nw'|'se'|'sw'|'move' }
   */
  function hitTestCrop(m) {
    if (!state.cropActive || !state.cropRect) return null;
    var r = state.cropRect;
    var t = CROP_EDGE_THRESHOLD;
    var inX = m.x >= r.x - t && m.x <= r.x + r.w + t;
    var inY = m.y >= r.y - t && m.y <= r.y + r.h + t;
    if (!inX || !inY) return null;

    var onLeft   = Math.abs(m.x - r.x) <= t;
    var onRight  = Math.abs(m.x - (r.x + r.w)) <= t;
    var onTop    = Math.abs(m.y - r.y) <= t;
    var onBottom = Math.abs(m.y - (r.y + r.h)) <= t;

    if (onTop && onLeft)     return { edge: 'nw' };
    if (onTop && onRight)    return { edge: 'ne' };
    if (onBottom && onLeft)  return { edge: 'sw' };
    if (onBottom && onRight) return { edge: 'se' };
    if (onTop)    return { edge: 'n' };
    if (onBottom) return { edge: 's' };
    if (onLeft)   return { edge: 'w' };
    if (onRight)  return { edge: 'e' };

    // Inside the crop rect — move
    if (m.x >= r.x && m.x <= r.x + r.w && m.y >= r.y && m.y <= r.y + r.h) {
      return { edge: 'move' };
    }
    return null;
  }

  var CROP_CURSOR_MAP = {
    n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize',
    nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize',
    move: 'move'
  };

  function syncCropInputs() {
    var r = state.cropRect;
    if (!r) return;
    $('#crop-x').value = r.x;
    $('#crop-y').value = r.y;
    $('#crop-w').value = r.w;
    $('#crop-h').value = r.h;
  }

  function handleCanvasMouseDown(e) {
    var m = canvasCoords(e);

    // 0. AI tracking mode — next canvas click picks the object
    if (state._trackingMode) {
      // Show ripple at click position relative to canvas-container
      var container = GC.canvas.parentElement;
      if (container) {
        var cRect = container.getBoundingClientRect();
        var dot = document.createElement('div');
        dot.className = 'tracking-ripple';
        dot.style.left = (e.clientX - cRect.left) + 'px';
        dot.style.top  = (e.clientY - cRect.top)  + 'px';
        container.appendChild(dot);
        setTimeout(function () { dot.parentNode && dot.parentNode.removeChild(dot); }, 1400);
      }
      GC.handleTrackingClick(
        m.x / state.width,
        m.y / state.height,
        state.currentFrame
      );
      return;
    }

    // 0b. Hit-test crop rectangle first when crop is active
    if (state.cropActive && state.cropRect) {
      var cropHit = hitTestCrop(m);
      if (cropHit) {
        state.cropDrag = {
          edge: cropHit.edge,
          startX: m.x, startY: m.y,
          origRect: { x: state.cropRect.x, y: state.cropRect.y, w: state.cropRect.w, h: state.cropRect.h }
        };
        GC.canvas.style.cursor = CROP_CURSOR_MAP[cropHit.edge] || 'default';
        return;
      }
    }

    // 1. Hit-test corner resize handles (selected caption only)
    if (state.selectedCaptionId) {
      var selCap = GC.findCaption(state.selectedCaptionId);
      if (selCap && state.currentFrame >= selCap.startFrame && state.currentFrame <= selCap.endFrame) {
        var bbox = GC.getCaptionBBox(GC.ctx, selCap, state.currentFrame);
        if (bbox) {
          var corners = GC.getSelectionCorners(bbox);
          var hs = GC.HANDLE_SIZE;
          var hitRadius = hs * 0.8;
          for (var c = 0; c < corners.length; c++) {
            var cx = corners[c].x + hs / 2;
            var cy = corners[c].y + hs / 2;
            var dx = m.x - cx, dy = m.y - cy;
            if (dx * dx + dy * dy <= hitRadius * hitRadius) {
              // Use interpolated position for resize distance calculation
              var rip = (selCap.motion && selCap.motion.length > 0)
                ? GC.getInterpolatedPosition(selCap.motion, state.currentFrame)
                : null;
              var rpx = rip ? rip.x : selCap.x;
              var rpy = rip ? rip.y : selCap.y;
              state.resizeState = {
                captionId: selCap.id,
                startFontSize: selCap.fontSize,
                startY: m.y,
                startX: m.x,
                refX: rpx,
                refY: rpy,
                startDist: Math.sqrt(Math.pow(m.x - rpx * state.width, 2) + Math.pow(m.y - rpy * state.height, 2)),
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
      var bbox = GC.getCaptionBBox(GC.ctx, cap, state.currentFrame);
      if (!bbox) continue;
      if (m.x >= bbox.x - 6 && m.x <= bbox.x + bbox.w + 6 &&
          m.y >= bbox.y - 6 && m.y <= bbox.y + bbox.h + 6) {
        state.selectedCaptionId = cap.id;
        // For motion captions, offset from interpolated position; otherwise from static
        var dip = (cap.motion && cap.motion.length > 0)
          ? GC.getInterpolatedPosition(cap.motion, state.currentFrame)
          : null;
        var dpx = dip ? dip.x : cap.x;
        var dpy = dip ? dip.y : cap.y;
        state.dragState = {
          captionId: cap.id,
          offsetX: m.x - dpx * state.width,
          offsetY: m.y - dpy * state.height,
          motionEnabled: cap.motion && cap.motion.length > 0,
          motionFrame: state.currentFrame,
        };
        GC.canvas.style.cursor = 'grabbing';
        GC.updateCaptionList();
        updateCaptionEditor();
        GC.renderCurrentFrame();
        return;
      }
    }

    // Nothing else hit — start pan drag when zoomed in
    if (state.zoom > 1) {
      state.panDrag = { startClientX: e.clientX, startClientY: e.clientY,
                        startPanX: state.panX, startPanY: state.panY };
      GC.canvas.style.cursor = 'grabbing';
    }
  }

  function handleCanvasMouseMove(e) {
    var m = canvasCoords(e);

    // Active pan drag
    if (state.panDrag) {
      state.panX = state.panDrag.startPanX + (e.clientX - state.panDrag.startClientX);
      state.panY = state.panDrag.startPanY + (e.clientY - state.panDrag.startClientY);
      _clampPan();
      _applyZoom();
      return;
    }

    // Active crop drag/resize
    if (state.cropDrag) {
      var cd = state.cropDrag;
      var o = cd.origRect;
      var dx = m.x - cd.startX;
      var dy = m.y - cd.startY;
      var r = state.cropRect;
      var maxW = state.width;
      var maxH = state.height;

      if (cd.edge === 'move') {
        r.x = Math.max(0, Math.min(maxW - o.w, o.x + dx));
        r.y = Math.max(0, Math.min(maxH - o.h, o.y + dy));
      } else {
        // Resize edges
        var nx = o.x, ny = o.y, nw = o.w, nh = o.h;
        if (cd.edge.indexOf('w') !== -1) { nx = o.x + dx; nw = o.w - dx; }
        if (cd.edge.indexOf('e') !== -1) { nw = o.w + dx; }
        if (cd.edge.indexOf('n') !== -1) { ny = o.y + dy; nh = o.h - dy; }
        if (cd.edge.indexOf('s') !== -1) { nh = o.h + dy; }
        // Enforce minimum size
        if (nw < 10) { if (cd.edge.indexOf('w') !== -1) nx = o.x + o.w - 10; nw = 10; }
        if (nh < 10) { if (cd.edge.indexOf('n') !== -1) ny = o.y + o.h - 10; nh = 10; }
        // Clamp to canvas bounds
        if (nx < 0) { nw += nx; nx = 0; }
        if (ny < 0) { nh += ny; ny = 0; }
        if (nx + nw > maxW) nw = maxW - nx;
        if (ny + nh > maxH) nh = maxH - ny;
        r.x = Math.round(nx); r.y = Math.round(ny);
        r.w = Math.round(nw); r.h = Math.round(nh);
      }
      syncCropInputs();
      GC.renderCurrentFrame();
      return;
    }

    // Active resize drag
    if (state.resizeState) {
      var cap = GC.findCaption(state.resizeState.captionId);
      if (!cap) return;
      var dist = Math.sqrt(Math.pow(m.x - state.resizeState.refX * state.width, 2) + Math.pow(m.y - state.resizeState.refY * state.height, 2));
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
          var bbox = GC.getCaptionBBox(GC.ctx, selCap, state.currentFrame);
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
        var bbox = GC.getCaptionBBox(GC.ctx, cap, state.currentFrame);
        if (bbox && m.x >= bbox.x - 6 && m.x <= bbox.x + bbox.w + 6 &&
            m.y >= bbox.y - 6 && m.y <= bbox.y + bbox.h + 6) {
          hovering = true; break;
        }
      }
      if (hovering) { GC.canvas.style.cursor = 'grab'; return; }

      // Crop hover cursor
      var cropHit = hitTestCrop(m);
      if (state._trackingMode) { /* keep crosshair set by startTrackingMode */ }
      else if (cropHit) { GC.canvas.style.cursor = CROP_CURSOR_MAP[cropHit.edge] || 'default'; }
      else if (state.zoom > 1) { GC.canvas.style.cursor = 'grab'; }
      else { GC.canvas.style.cursor = 'default'; }
      return;
    }

    // Active position drag
    var cap = GC.findCaption(state.dragState.captionId);
    if (!cap) return;
    var newX = Math.max(0, Math.min(1, (m.x - state.dragState.offsetX) / state.width));
    var newY = Math.max(0, Math.min(1, (m.y - state.dragState.offsetY) / state.height));
    if (state.dragState.motionEnabled) {
      // Update or create a keyframe at the frame where the drag started
      var mf = state.dragState.motionFrame;
      var existingKf = null;
      for (var ki = 0; ki < cap.motion.length; ki++) {
        if (cap.motion[ki].frame === mf) { existingKf = cap.motion[ki]; break; }
      }
      if (existingKf) {
        existingKf.x = newX;
        existingKf.y = newY;
      } else {
        cap.motion.push({ frame: mf, x: newX, y: newY });
      }
    } else {
      cap.x = newX;
      cap.y = newY;
    }
    GC.renderCurrentFrame();
  }

  function handleCanvasMouseUp() {
    if (state.panDrag) {
      state.panDrag = null;
      GC.canvas.style.cursor = state.zoom > 1 ? 'grab' : 'default';
      return;
    }
    if (state.cropDrag) {
      state.cropDrag = null;
      GC.canvas.style.cursor = 'default';
      return;
    }
    if (state.resizeState) {
      state.resizeState = null;
      GC.canvas.style.cursor = 'default';
      return;
    }
    if (state.dragState) {
      var wasMotion = state.dragState.motionEnabled;
      state.dragState = null;
      GC.canvas.style.cursor = 'grab';
      // Rebuild timeline to show any newly-created keyframe
      if (wasMotion) GC.buildTimeline();
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

  // ── Pinch-to-zoom (multi-touch) ───────────────
  var _pinchState = null;

  function _touchDist(t1, t2) {
    var dx = t1.clientX - t2.clientX, dy = t1.clientY - t2.clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function handleCanvasTouchStart(e) {
    e.preventDefault();
    if (e.touches.length === 2) {
      var t1 = e.touches[0], t2 = e.touches[1];
      _pinchState = {
        dist:   _touchDist(t1, t2),
        pivotX: (t1.clientX + t2.clientX) / 2,
        pivotY: (t1.clientY + t2.clientY) / 2,
      };
      return;
    }
    _pinchState = null;
    var t = e.touches[0];
    handleCanvasMouseDown({ clientX: t.clientX, clientY: t.clientY });
  }

  function handleCanvasTouchMove(e) {
    e.preventDefault();
    if (e.touches.length === 2 && _pinchState) {
      var t1 = e.touches[0], t2 = e.touches[1];
      var newDist = _touchDist(t1, t2);
      _setZoom(state.zoom * (newDist / _pinchState.dist), _pinchState.pivotX, _pinchState.pivotY);
      _pinchState.dist = newDist;
      return;
    }
    if (!_pinchState) {
      var t = e.touches[0];
      handleCanvasMouseMove({ clientX: t.clientX, clientY: t.clientY });
    }
  }

  function handleCanvasTouchEnd(e) {
    _pinchState = null;
    handleCanvasMouseUp();
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
        '<button class="caption-item-remove" title="Remove caption" aria-label="Remove caption">&times;</button>';
      item.addEventListener('click', function () { GC.selectCaption(cap.id); });
      item.querySelector('.caption-item-remove').addEventListener('click', function (e) {
        e.stopPropagation();
        state.selectedCaptionId = cap.id;
        GC.showDeleteModal();
      });
      list.appendChild(item);
    });
  };

  var SINGLE_WEIGHT_FONTS_CAP = ['Impact', 'Arial Black'];
  function toggleCapBoldOption(fontFamily) {
    var group = $('#cap-bold-group');
    if (!group) return;
    group.style.display = SINGLE_WEIGHT_FONTS_CAP.indexOf(fontFamily) !== -1 ? 'none' : '';
  }

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
    $('#cap-bold').checked = (cap.fontWeight || 700) >= 700;
    toggleCapBoldOption(cap.fontFamily);
    // Motion keyframe status
    var motionCount = cap.motion ? cap.motion.length : 0;
    var motionInfo = $('#cap-motion-info');
    if (motionInfo) {
      motionInfo.textContent = motionCount > 0
        ? motionCount + ' keyframe' + (motionCount !== 1 ? 's' : '') + ' — drag caption to set position per frame'
        : 'No motion — drag caption to move (static)';
    }
    var btnClear = $('#btn-clear-motion');
    if (btnClear) btnClear.style.display = motionCount > 0 ? '' : 'none';
    var btnTrack = $('#btn-track-with-ai');
    if (btnTrack) btnTrack.style.display = GC.trackerAvailable && GC.trackerAvailable() ? '' : 'none';
  }

  /** Update the play/pause button icon, frame counter, scrubber, and Save Frame state. */
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
    var btnSF = $('#btn-save-frame');
    if (btnSF) btnSF.disabled = state.isPlaying || state.frames.length === 0;
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
        if (!file) return;
        if (file.type === 'image/gif' || file.name.toLowerCase().endsWith('.gif')) {
          GC.loadGifFromFile(file);
        } else if (isHeic(file)) {
          GC.loadHeicAsImage(file);
        } else if (file.type.startsWith('video/')) {
          GC.loadVideoAsGif(file);
        } else if (file.type.startsWith('image/') && GC.loadImageFile) {
          GC.loadImageFile(file);
        } else {
          GC.showError(GC.dropErrorMessage || 'Please drop a GIF, video, or HEIC file.');
        }
      });
      dropZone.addEventListener('click', function () { $('#file-input').click(); });
    }

    var fileInput = $('#file-input');
    if (fileInput) {
      fileInput.addEventListener('change', function () {
        var file = fileInput.files[0];
        if (!file) return;
        if (file.type === 'image/gif' || file.name.toLowerCase().endsWith('.gif')) {
          GC.loadGifFromFile(file);
        } else if (isHeic(file)) {
          GC.loadHeicAsImage(file);
        } else if (file.type.startsWith('video/')) {
          GC.loadVideoAsGif(file);
        } else if (file.type.startsWith('image/') && GC.loadImageFile) {
          GC.loadImageFile(file);
        }
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
        state.cropActive = false;
        state.cropRect = null;
        state.zoom = 1; state.panX = 0; state.panY = 0;
        _applyZoom();
        state.compressGif = false;
        state.gifQuality = 10;
        state.lossyCompress = false;
        state.originalFileSize = 0;
        GC.nextCaptionId = 1;
        $('#editor-workspace').classList.add('hidden');
        $('#upload-zone').classList.remove('hidden');
        var adUpload = $('#ad-upload'); if (adUpload) adUpload.classList.remove('hidden');
        var adBottom = $('#ad-editor-bottom'); if (adBottom) adBottom.classList.add('hidden');
        var _btnShare = $('#btn-share'); if (_btnShare) _btnShare.disabled = true;
        $('#btn-download').disabled = true;
        if ($('#file-input')) $('#file-input').value = '';
        // Reset Other Options UI
        if ($('#chk-crop')) { $('#chk-crop').checked = false; }
        if ($('#crop-settings')) { $('#crop-settings').classList.add('hidden'); }
        if ($('#chk-compress')) { $('#chk-compress').checked = false; }
        if ($('#compress-settings')) { $('#compress-settings').classList.add('hidden'); }
        if ($('#chk-lossy')) { $('#chk-lossy').checked = false; }
        if ($('#compress-quality')) { $('#compress-quality').value = 10; $('#compress-quality-val').textContent = '10'; }
        // Reset photo adjustments
        state.adjustments.brightness = 0; state.adjustments.contrast   = 0;
        state.adjustments.saturation = 0; state.adjustments.hue        = 0;
        state.adjustments.filter     = 'none';
        _resetAdjUI();
      });
    }

    // ── Canvas interaction (drag, resize, touch)
    GC.canvas.addEventListener('mousedown', handleCanvasMouseDown);
    GC.canvas.addEventListener('mousemove', handleCanvasMouseMove);
    GC.canvas.addEventListener('mouseup', handleCanvasMouseUp);
    GC.canvas.addEventListener('mouseleave', handleCanvasMouseUp);
    GC.canvas.addEventListener('touchstart', handleCanvasTouchStart, { passive: false });
    GC.canvas.addEventListener('touchmove',  handleCanvasTouchMove,  { passive: false });
    GC.canvas.addEventListener('touchend',   handleCanvasTouchEnd,   { passive: false });

    // ── Zoom (mouse wheel + buttons) ──────────
    GC.canvas.parentElement.addEventListener('wheel', function (e) {
      if (state.frames.length === 0) return;
      e.preventDefault();
      var factor = e.deltaY < 0 ? 1.18 : (1 / 1.18);
      _setZoom(state.zoom * factor, e.clientX, e.clientY);
    }, { passive: false });
    $('#btn-zoom-in').addEventListener('click', function () { _setZoom(state.zoom * 1.5); });
    $('#btn-zoom-out').addEventListener('click', function () { _setZoom(state.zoom / 1.5); });

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
      // Start collapsed on mobile
      if (window.innerWidth <= 768) {
        $('#editor-timeline').classList.add('mobile-collapsed');
        timelineToggle.classList.add('collapsed');
        timelineToggle.setAttribute('aria-expanded', 'false');
      }
      timelineToggle.addEventListener('click', function () {
        var timeline = $('#editor-timeline');
        var collapsed = timeline.classList.toggle('mobile-collapsed');
        timelineToggle.classList.toggle('collapsed', collapsed);
        timelineToggle.setAttribute('aria-expanded', String(!collapsed));
        if (!collapsed && state.frames.length > 0) GC.buildTimeline();
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
    GC.skipDeleteConfirm = false;
    GC.showDeleteModal = function () {
      if (GC.skipDeleteConfirm) { removeCaption(state.selectedCaptionId); return; }
      $('#delete-modal-skip').checked = false;
      $('#delete-modal').classList.remove('hidden');
    };
    $('#btn-add-caption').addEventListener('click', function () { addCaption(); });
    $('#btn-delete-caption').addEventListener('click', function () {
      if (state.selectedCaptionId) GC.showDeleteModal();
    });

    // ── Motion keyframe controls ──────────────
    $('#btn-add-keyframe').addEventListener('click', function () {
      var cap = GC.findCaption(state.selectedCaptionId);
      if (!cap) return;
      var frame = state.currentFrame;
      // Check if keyframe already exists at this frame
      for (var ki = 0; ki < cap.motion.length; ki++) {
        if (cap.motion[ki].frame === frame) return; // already have one here
      }
      // Use interpolated position if motion is already active, else static position
      var px = cap.x, py = cap.y;
      if (cap.motion.length > 0) {
        var ip = GC.getInterpolatedPosition(cap.motion, frame);
        if (ip) { px = ip.x; py = ip.y; }
      }
      cap.motion.push({ frame: frame, x: px, y: py });
      updateCaptionEditor();
      GC.buildTimeline();
    });

    $('#btn-track-with-ai').addEventListener('click', function () {
      var cap = GC.findCaption(state.selectedCaptionId);
      if (!cap || state.frames.length === 0) return;
      GC.warmUpTracker();       // fire warm-up request immediately
      GC.startTrackingMode(cap); // show instruction bar, wait for canvas click
    });
    var btnCancelTracking = $('#btn-cancel-tracking');
    if (btnCancelTracking) {
      btnCancelTracking.addEventListener('click', function () {
        GC.stopTrackingMode();
      });
    }
    $('#btn-clear-motion').addEventListener('click', function () {
      var cap = GC.findCaption(state.selectedCaptionId);
      if (!cap || !cap.motion.length) return;
      // Snap static position to wherever the caption is at the current frame
      var ip = GC.getInterpolatedPosition(cap.motion, state.currentFrame);
      if (ip) { cap.x = ip.x; cap.y = ip.y; }
      cap.motion = [];
      updateCaptionEditor();
      GC.buildTimeline();
      GC.renderCurrentFrame();
    });
    $('#delete-modal-confirm').addEventListener('click', function () {
      if ($('#delete-modal-skip').checked) GC.skipDeleteConfirm = true;
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
      toggleCapBoldOption(e.target.value);
    });
    $('#cap-bold').addEventListener('change', function (e) {
      updateSelectedCaption({ fontWeight: e.target.checked ? 700 : 400 });
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
        $('#box-top-bold').checked = true;
      } else {
        state.boxCaptionBottom = null;
        $('#box-bottom-editor').classList.add('hidden');
        $('#btn-add-box-bottom').classList.remove('hidden');
        $('#box-bottom-text').value = '';
        $('#box-bottom-height').value = 80; $('#box-bottom-height-val').textContent = '80';
        $('#box-bottom-border').value = 0; $('#box-bottom-border-val').textContent = '0';
        $('#box-bottom-fontsize').value = 36; $('#box-bottom-fontsize-val').textContent = '36';
        $('#box-bottom-bold').checked = true;
      }
      GC.renderCurrentFrame();
    }

    $('#btn-add-box-top').addEventListener('click', function () { addBoxCaption('top'); });
    $('#btn-add-box-bottom').addEventListener('click', function () { addBoxCaption('bottom'); });

    var pendingBoxRemove = null;
    var skipRemoveBoxConfirm = false;
    function showRemoveBoxModal(pos) {
      if (skipRemoveBoxConfirm) { removeBoxCaption(pos); return; }
      pendingBoxRemove = pos;
      $('#remove-box-modal-skip').checked = false;
      $('#remove-box-modal').classList.remove('hidden');
    }
    $('#btn-remove-box-top').addEventListener('click', function () { showRemoveBoxModal('top'); });
    $('#btn-remove-box-bottom').addEventListener('click', function () { showRemoveBoxModal('bottom'); });
    $('#remove-box-modal-confirm').addEventListener('click', function () {
      if ($('#remove-box-modal-skip').checked) skipRemoveBoxConfirm = true;
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

    // Fonts that only ship a single weight — hide the bold toggle for these
    var SINGLE_WEIGHT_FONTS = ['Impact', 'Arial Black'];

    function toggleBoldOption(pos, fontFamily) {
      var group = $('#box-' + pos + '-bold-group');
      if (!group) return;
      var hide = SINGLE_WEIGHT_FONTS.indexOf(fontFamily) !== -1;
      group.style.display = hide ? 'none' : '';
    }

    // Wire up each position's sliders/pickers
    ['top', 'bottom'].forEach(function (pos) {
      var stateKey = pos === 'top' ? 'boxCaptionTop' : 'boxCaptionBottom';

      // Hide bold toggle for the default font if single-weight
      toggleBoldOption(pos, 'Impact');

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
      $('#box-' + pos + '-bold').addEventListener('change', function (e) {
        if (state[stateKey]) { state[stateKey].fontWeight = e.target.checked ? 700 : 400; GC.renderCurrentFrame(); }
      });
      $('#box-' + pos + '-align').addEventListener('change', function (e) {
        if (state[stateKey]) { state[stateKey].align = e.target.value; GC.renderCurrentFrame(); }
      });
      $('#box-' + pos + '-font').addEventListener('change', function (e) {
        if (state[stateKey]) { state[stateKey].fontFamily = e.target.value; GC.renderCurrentFrame(); }
        toggleBoldOption(pos, e.target.value);
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
      if (state.isStillImage && GC.exportImage) {
        GC.exportImage({ onBlob: showDownloadModal });
      } else {
        GC.exportGif({ onBlob: showDownloadModal });
      }
    });
    var btnShare = $('#btn-share');
    if (btnShare) {
      btnShare.addEventListener('click', function () {
        if (state.frames.length === 0 || GC.exportInProgress) return;
        var consentModal = $('#share-consent-modal');
        if (consentModal) consentModal.classList.remove('hidden');
      });
    }
    var btnConsentYes = $('#share-consent-yes');
    if (btnConsentYes) {
      btnConsentYes.addEventListener('click', function () {
        $('#share-consent-modal').classList.add('hidden');
        GC.shareFlow();
      });
    }
    var btnConsentNo = $('#share-consent-no');
    if (btnConsentNo) {
      btnConsentNo.addEventListener('click', function () {
        $('#share-consent-modal').classList.add('hidden');
        GC.exportGif({ onBlob: showDownloadModal });
      });
    }
    var shareConsentModal = $('#share-consent-modal');
    if (shareConsentModal) {
      shareConsentModal.addEventListener('click', function (e) {
        if (e.target === this) this.classList.add('hidden');
      });
    }

    // ── Export Frame (GIF editor — exports current frame as JPEG) ──
    var btnSaveFrame = $('#btn-save-frame');
    if (btnSaveFrame) {
      btnSaveFrame.addEventListener('click', function () {
        if (state.frames.length === 0) return;
        GC.saveCurrentFrame({ onBlob: showDownloadModal });
      });
    }

    // Download modal (mobile long-press save flow)
    function showDownloadModal(blob, filename) {
      var modal = $('#download-modal');
      modal._blob = blob;
      modal._filename = filename || null;
      // Update modal title based on file type
      var titleEl = modal.querySelector('.modal-title');
      if (titleEl) {
        var fn = filename || '';
        titleEl.textContent = fn.endsWith('.gif') ? 'Your GIF is ready!' :
                              fn.match(/\.(jpg|jpeg|webp|png)$/i) && fn.includes('-frame-') ? 'Frame exported!' :
                              'Your image is ready!';
      }
      var preview = $('#download-preview');
      preview.innerHTML = '';
      var blobUrl = URL.createObjectURL(blob);
      var img = document.createElement('img');
      img.src = blobUrl;
      img.alt = 'Your exported image';
      preview.appendChild(img);
      modal._blobUrl = blobUrl;
      // Update download button label
      var dlBtn = $('#btn-dl-download');
      if (dlBtn) dlBtn.textContent = filename && filename.endsWith('.gif') ? 'Download GIF' : 'Download Image';
      // Show original → exported file size when compression was used
      var sizeInfo = modal.querySelector('.dl-size-info');
      if (!sizeInfo) {
        sizeInfo = document.createElement('p');
        sizeInfo.className = 'dl-size-info';
        var previewEl = modal.querySelector('#download-preview');
        if (previewEl) previewEl.parentNode.insertBefore(sizeInfo, previewEl.nextSibling);
      }
      if (state.compressGif && state.originalFileSize > 0 && blob) {
        var origSize = state.originalFileSize;
        var newSize  = blob.size;
        var pct      = Math.round((1 - newSize / origSize) * 100);
        var pctStr   = pct > 0 ? '−' + pct + '%' : (pct < 0 ? '+' + Math.abs(pct) + '%' : 'no change');
        sizeInfo.innerHTML = '<span class="dl-size-orig">' + GC.formatBytes(origSize) + '</span>' +
          ' <span class="dl-size-arrow">→</span> ' +
          '<span class="dl-size-new">' + GC.formatBytes(newSize) + '</span>' +
          ' <span class="dl-size-pct ' + (pct > 0 ? 'dl-size-savings' : '') + '">(' + pctStr + ')</span>';
        sizeInfo.style.display = '';
      } else {
        sizeInfo.style.display = 'none';
      }
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
      var modal = $('#download-modal');
      var blob = modal._blob;
      if (blob) GC.downloadBlob(blob, modal._filename || GC.makeCaptionedFilename());
    });
    $('#btn-dl-save-photos').addEventListener('click', function () {
      var modal = $('#download-modal');
      var blob = modal._blob;
      if (!blob) return;
      var fname = modal._filename || GC.makeCaptionedFilename();
      var mimeType = (blob && blob.type) || (state.isStillImage ? (state.exportFormat || 'image/jpeg') : 'image/gif');
      var file = new File([blob], fname, { type: mimeType });
      var title = state.isStillImage ? 'Captioned image' : 'Captioned GIF';
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        navigator.share({ files: [file], title: title }).catch(function () {});
      } else {
        GC.downloadBlob(blob, fname);
      }
    });

    // Share modal events (only present in GIF editors, not image-caption)
    var shareModalClose = $('#share-modal-close');
    if (shareModalClose) shareModalClose.addEventListener('click', GC.closeShareModal);
    var shareModal = $('#share-modal');
    if (shareModal) shareModal.addEventListener('click', function (e) {
      if (e.target === this) GC.closeShareModal();
    });
    var btnCopyLink = $('#btn-copy-link');
    if (btnCopyLink) btnCopyLink.addEventListener('click', function () {
      var input = $('#share-url');
      if (!input || !input.value) return;
      navigator.clipboard.writeText(input.value).then(function () {
        GC.setShareStatus('Copied!', 'success');
      }).catch(function () {
        input.select();
        document.execCommand('copy');
        GC.setShareStatus('Copied!', 'success');
      });
    });
    var btnCopyImageUrl = $('#btn-copy-image-url');
    if (btnCopyImageUrl) btnCopyImageUrl.addEventListener('click', function () {
      var input = $('#share-image-url');
      if (!input || !input.value) return;
      navigator.clipboard.writeText(input.value).then(function () {
        GC.setShareStatus('Image URL copied!', 'success');
      }).catch(function () {
        input.select();
        document.execCommand('copy');
        GC.setShareStatus('Image URL copied!', 'success');
      });
    });
    var btnShareDownload = $('#btn-share-download');
    if (btnShareDownload) btnShareDownload.addEventListener('click', function () {
      var modal = $('#share-modal');
      if (modal && modal._blob) GC.downloadBlob(modal._blob, modal._filename || GC.makeCaptionedFilename());
    });

    // Save to Photos (mobile: Web Share API or download fallback)
    var savePhotosBtn = $('#btn-share-save-photos');
    if (savePhotosBtn) {
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

    // ── Other Options toggle ───────────────────
    var otherOptsToggle = $('#other-options-toggle');
    if (otherOptsToggle) {
      otherOptsToggle.addEventListener('click', function () {
        var section = $('#other-options-section');
        var collapsed = section.classList.toggle('collapsed');
        otherOptsToggle.classList.toggle('collapsed', collapsed);
        otherOptsToggle.setAttribute('aria-expanded', String(!collapsed));
      });
    }

    // ── Watermark toggle ─────────────────────
    var chkWatermark = $('#chk-watermark');
    if (chkWatermark) {
      chkWatermark.addEventListener('change', function () {
        state.hideWatermark = !chkWatermark.checked;
      });
    }

    // ── Compression toggle ───────────────────
    var chkCompress = $('#chk-compress');
    if (chkCompress) {
      chkCompress.addEventListener('change', function () {
        state.compressGif = chkCompress.checked;
        var settings = $('#compress-settings');
        if (settings) settings.classList.toggle('hidden', !chkCompress.checked);
        if (chkCompress.checked) {
          state.gifQuality = parseInt($('#compress-quality').value, 10);
        } else {
          state.gifQuality = 10;
        }
      });
    }
    var compressQuality = $('#compress-quality');
    if (compressQuality) {
      compressQuality.addEventListener('input', function () {
        var v = parseInt(compressQuality.value, 10);
        $('#compress-quality-val').textContent = v;
        state.gifQuality = v;
      });
    }
    var chkLossy = $('#chk-lossy');
    if (chkLossy) {
      chkLossy.addEventListener('change', function () {
        state.lossyCompress = chkLossy.checked;
      });
    }

    // ── Crop toggle ──────────────────────────
    var chkCrop = $('#chk-crop');
    if (chkCrop) {
      chkCrop.addEventListener('change', function () {
        state.cropActive = chkCrop.checked;
        var settings = $('#crop-settings');
        if (settings) settings.classList.toggle('hidden', !chkCrop.checked);
        if (chkCrop.checked) {
          // Default crop to full image if not set
          if (!state.cropRect) {
            state.cropRect = { x: 0, y: 0, w: state.width, h: state.height };
            syncCropInputs();
          }
        } else {
          state.cropRect = null;
        }
        GC.renderCurrentFrame();
      });
    }

    ['crop-x', 'crop-y', 'crop-w', 'crop-h'].forEach(function (id) {
      var el = $('#' + id);
      if (el) {
        el.addEventListener('input', function () {
          if (!state.cropRect) return;
          var key = id.split('-')[1] === 'x' ? 'x' : id.split('-')[1] === 'y' ? 'y' : id.split('-')[1] === 'w' ? 'w' : 'h';
          var v = parseInt(el.value, 10);
          if (isNaN(v) || v < 0) return;
          state.cropRect[key] = v;
          GC.renderCurrentFrame();
        });
      }
    });

    var btnCropReset = $('#btn-crop-reset');
    if (btnCropReset) {
      btnCropReset.addEventListener('click', function () {
        state.cropRect = { x: 0, y: 0, w: state.width, h: state.height };
        syncCropInputs();
        GC.renderCurrentFrame();
      });
    }

    var btnApplyCrop = $('#btn-apply-crop');
    if (btnApplyCrop) {
      btnApplyCrop.addEventListener('click', function () {
        if (!state.cropActive || !state.cropRect) return;
        var r = state.cropRect;
        if (r.w < 1 || r.h < 1) return;

        // Clamp crop to image bounds
        var cx = Math.max(0, Math.round(r.x));
        var cy = Math.max(0, Math.round(r.y));
        var cw = Math.min(state.width - cx, Math.round(r.w));
        var ch = Math.min(state.height - cy, Math.round(r.h));
        if (cw < 1 || ch < 1) return;

        // Crop each frame's ImageData
        var tmpCanvas = document.createElement('canvas');
        tmpCanvas.width = cw;
        tmpCanvas.height = ch;
        var tmpCtx = tmpCanvas.getContext('2d');
        for (var i = 0; i < state.frames.length; i++) {
          var frame = state.frames[i];
          tmpCtx.clearRect(0, 0, cw, ch);
          tmpCtx.putImageData(frame.imageData, -cx, -cy);
          frame.imageData = tmpCtx.getImageData(0, 0, cw, ch);
        }

        // Remap on-image caption positions
        var oldW = state.width;
        var oldH = state.height;
        for (var j = 0; j < state.captions.length; j++) {
          var cap = state.captions[j];
          cap.x = Math.max(0, Math.min(1, (cap.x * oldW - cx) / cw));
          cap.y = Math.max(0, Math.min(1, (cap.y * oldH - cy) / ch));
        }

        // Update dimensions
        state.width = cw;
        state.height = ch;

        // Turn off crop mode
        state.cropActive = false;
        state.cropRect = null;
        var chkCrop = $('#chk-crop');
        if (chkCrop) chkCrop.checked = false;
        var settings = $('#crop-settings');
        if (settings) settings.classList.add('hidden');

        // Re-render everything
        GC.renderCurrentFrame();
        GC.buildTimeline();
        GC.updateCaptionList();
        updateCaptionEditor();
      });
    }

    // ── Window resize → rebuild timeline ──────
    var resizeTimer;
    window.addEventListener('resize', function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        if (state.frames.length > 0 && !state._brushActive) GC.buildTimeline();
      }, 200);
    });

    // ── Adjustments section toggle ────────────
    var adjToggle = $('#adj-toggle');
    if (adjToggle) {
      adjToggle.addEventListener('click', function () {
        var section = $('#adj-section');
        var collapsed = section.classList.toggle('collapsed');
        adjToggle.classList.toggle('collapsed', collapsed);
        adjToggle.setAttribute('aria-expanded', String(!collapsed));
      });
    }

    // ── Adjustment sliders ────────────────────
    [
      { id: 'adj-brightness', key: 'brightness' },
      { id: 'adj-contrast',   key: 'contrast'   },
      { id: 'adj-saturation', key: 'saturation' },
      { id: 'adj-hue',        key: 'hue'        },
    ].forEach(function (sl) {
      var el = $('#' + sl.id);
      if (!el) return;
      el.addEventListener('input', function () {
        state.adjustments[sl.key] = +el.value;
        var valEl = $('#' + sl.id + '-val');
        if (valEl) valEl.textContent = el.value;
        GC.renderCurrentFrame();
      });
    });

    // ── Filter preset buttons ─────────────────
    GC.$$('.adj-filter-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        GC.$$('.adj-filter-btn').forEach(function (b) { b.classList.remove('active'); });
        btn.classList.add('active');
        state.adjustments.filter = btn.dataset.filter;
        GC.renderCurrentFrame();
      });
    });

    // ── Transform: rotate & flip (destructive) ─
    function applyRotateToFrames(degrees) {
      if (state.frames.length === 0) return;
      GC.pause();
      var w = state.width, h = state.height;
      var isSwap = degrees === 90 || degrees === 270;
      var newW = isSwap ? h : w, newH = isSwap ? w : h;
      var srcC = document.createElement('canvas'); srcC.width = w; srcC.height = h;
      var srcX = srcC.getContext('2d');
      var dstC = document.createElement('canvas'); dstC.width = newW; dstC.height = newH;
      var dstX = dstC.getContext('2d');
      for (var i = 0; i < state.frames.length; i++) {
        srcX.putImageData(state.frames[i].imageData, 0, 0);
        dstX.clearRect(0, 0, newW, newH);
        dstX.save();
        dstX.translate(newW / 2, newH / 2);
        dstX.rotate(degrees * Math.PI / 180);
        dstX.drawImage(srcC, -w / 2, -h / 2);
        dstX.restore();
        state.frames[i].imageData = dstX.getImageData(0, 0, newW, newH);
      }
      state.width = newW; state.height = newH;
      GC.canvas.width = newW; GC.canvas.height = newH;
      _updateAdjResizeInputs();
      GC.renderCurrentFrame();
      GC.buildTimeline();
    }

    function applyFlipToFrames(axis) {
      if (state.frames.length === 0) return;
      GC.pause();
      var w = state.width, h = state.height;
      var srcC = document.createElement('canvas'); srcC.width = w; srcC.height = h;
      var srcX = srcC.getContext('2d');
      var dstC = document.createElement('canvas'); dstC.width = w; dstC.height = h;
      var dstX = dstC.getContext('2d');
      for (var i = 0; i < state.frames.length; i++) {
        srcX.putImageData(state.frames[i].imageData, 0, 0);
        dstX.clearRect(0, 0, w, h);
        dstX.save();
        if (axis === 'h') { dstX.translate(w, 0); dstX.scale(-1, 1); }
        else               { dstX.translate(0, h); dstX.scale(1, -1); }
        dstX.drawImage(srcC, 0, 0);
        dstX.restore();
        state.frames[i].imageData = dstX.getImageData(0, 0, w, h);
      }
      GC.renderCurrentFrame();
    }

    var btnRotCW  = $('#adj-rotate-cw');  if (btnRotCW)  btnRotCW.addEventListener('click',  function () { applyRotateToFrames(90); });
    var btnRotCCW = $('#adj-rotate-ccw'); if (btnRotCCW) btnRotCCW.addEventListener('click', function () { applyRotateToFrames(270); });
    var btnFlipH  = $('#adj-flip-h');     if (btnFlipH)  btnFlipH.addEventListener('click',  function () { applyFlipToFrames('h'); });
    var btnFlipV  = $('#adj-flip-v');     if (btnFlipV)  btnFlipV.addEventListener('click',  function () { applyFlipToFrames('v'); });

    // ── Resize GIF / image ────────────────────
    var adjLockState = { locked: true };
    var adjLockBtn = $('#adj-lock-ratio');
    if (adjLockBtn) {
      adjLockBtn.addEventListener('click', function () {
        adjLockState.locked = !adjLockState.locked;
        adjLockBtn.classList.toggle('locked', adjLockState.locked);
        adjLockBtn.textContent = adjLockState.locked ? '🔒' : '🔓';
      });
    }
    var adjWInput = $('#adj-resize-width');
    var adjHInput = $('#adj-resize-height');
    if (adjWInput) {
      adjWInput.addEventListener('input', function () {
        if (adjLockState.locked && state.width > 0) {
          adjHInput.value = Math.round(+adjWInput.value * state.height / state.width);
        }
      });
    }
    if (adjHInput) {
      adjHInput.addEventListener('input', function () {
        if (adjLockState.locked && state.height > 0) {
          adjWInput.value = Math.round(+adjHInput.value * state.width / state.height);
        }
      });
    }
    var btnApplyResize = $('#adj-apply-resize');
    if (btnApplyResize) {
      btnApplyResize.addEventListener('click', function () {
        var newW = parseInt(adjWInput.value, 10);
        var newH = parseInt(adjHInput.value, 10);
        if (!newW || !newH || newW < 1 || newH < 1) return;
        if (state.frames.length === 0) return;
        GC.pause();
        var srcC = document.createElement('canvas'); srcC.width = state.width; srcC.height = state.height;
        var srcX = srcC.getContext('2d');
        var dstC = document.createElement('canvas'); dstC.width = newW; dstC.height = newH;
        var dstX = dstC.getContext('2d');
        for (var i = 0; i < state.frames.length; i++) {
          srcX.putImageData(state.frames[i].imageData, 0, 0);
          dstX.clearRect(0, 0, newW, newH);
          dstX.drawImage(srcC, 0, 0, newW, newH);
          state.frames[i].imageData = dstX.getImageData(0, 0, newW, newH);
        }
        state.width = newW; state.height = newH;
        GC.canvas.width = newW; GC.canvas.height = newH;
        _updateAdjResizeInputs();
        GC.renderCurrentFrame();
        GC.buildTimeline();
      });
    }

    // ── Reset adjustments ─────────────────────
    var btnAdjReset = $('#adj-reset');
    if (btnAdjReset) {
      btnAdjReset.addEventListener('click', function () {
        state.adjustments.brightness = 0;
        state.adjustments.contrast   = 0;
        state.adjustments.saturation = 0;
        state.adjustments.hue        = 0;
        state.adjustments.filter     = 'none';
        _resetAdjUI();
        GC.renderCurrentFrame();
      });
    }

    // ── Export format / quality (image caption tool) ──
    var selExportFmt = $('#sel-export-format');
    if (selExportFmt) {
      selExportFmt.addEventListener('change', function () {
        state.exportFormat = selExportFmt.value;
        var qg = $('#export-quality-group');
        if (qg) qg.style.display = selExportFmt.value === 'image/png' ? 'none' : '';
      });
    }
    var slExportQuality = $('#sl-export-quality');
    if (slExportQuality) {
      slExportQuality.addEventListener('input', function () {
        state.exportQuality = +slExportQuality.value / 100;
        var valEl = $('#export-quality-val');
        if (valEl) valEl.textContent = slExportQuality.value;
      });
    }
  }

  // ── Adjustment UI helpers ─────────────────────
  function _resetAdjUI() {
    ['adj-brightness', 'adj-contrast', 'adj-saturation', 'adj-hue'].forEach(function (id) {
      var el = $('#' + id); if (el) el.value = 0;
      var v  = $('#' + id + '-val'); if (v) v.textContent = '0';
    });
    GC.$$('.adj-filter-btn').forEach(function (b) {
      b.classList.toggle('active', b.dataset.filter === 'none');
    });
  }

  function _updateAdjResizeInputs() {
    var rw = $('#adj-resize-width');  if (rw) rw.value = state.width;
    var rh = $('#adj-resize-height'); if (rh) rh.value = state.height;
    var os = $('#adj-original-size'); if (os) os.textContent = state.width + ' × ' + state.height;
  }

  // Expose so gif-playback.js + image-caption.js can call it after load
  GC._updateAdjResizeInputs = _updateAdjResizeInputs;

  // Patch updateUI to also refresh resize inputs and Save Frame button state
  var _origUpdateUI = GC.updateUI;
  GC.updateUI = function () {
    _origUpdateUI();
    _updateAdjResizeInputs();
    var btnSF = $('#btn-save-frame');
    if (btnSF) btnSF.disabled = state.isPlaying || state.frames.length === 0;
  };

  // ── Boot ─────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
