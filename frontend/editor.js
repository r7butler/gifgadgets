/* ==========================================================
   GifCaption Editor
   Frame-based GIF captioning with D3 brush timeline
   ========================================================== */

(function () {
  'use strict';

  // ── Helpers ──────────────────────────────────
  var $ = function (sel) { return document.querySelector(sel); };
  var $$ = function (sel) { return document.querySelectorAll(sel); };

  // ── State ────────────────────────────────────
  var state = {
    frames: [],           // { imageData, delay }
    width: 0,
    height: 0,
    captions: [],
    currentFrame: 0,
    isPlaying: false,
    speed: 1,
    selectedCaptionId: null,
    dragState: null,      // { captionId, offsetX, offsetY }
    gifId: null,
    gifFilename: null,
    // Box captions (solid bars above/below the GIF)
    // Each is null when not added, or an object when active
    boxCaptionTop: null,
    boxCaptionBottom: null,
  };

  var nextCaptionId = 1;
  var playbackTimer = null;
  var canvas, ctx;
  var timelineState = null;
  var exportInProgress = false;

  function makeBoxCaption() {
    return {
      text: '',
      height: 80,
      fontSize: 36,
      fontFamily: 'Impact',
      align: 'center',
      textColor: '#000000',
      bgColor: '#ffffff',
      borderWidth: 0,
    };
  }

  var TRACK_COLORS = [
    '#6366f1', '#22d3ee', '#f59e0b', '#10b981',
    '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6'
  ];

  // ── Initialise ───────────────────────────────
  function init() {
    canvas = $('#preview-canvas');
    ctx = canvas.getContext('2d');
    bindEvents();
    preloadGifWorker();

    var params = new URLSearchParams(window.location.search);
    var gifId = params.get('id');
    var source = params.get('source');
    if (gifId) {
      loadGifById(gifId);
    } else if (source === 'local') {
      loadGifFromIndexedDB();
    }
  }

  // ── GIF Worker Preload ────────────────────────
  function preloadGifWorker() {
    fetch('https://cdnjs.cloudflare.com/ajax/libs/gif.js/0.2.0/gif.worker.js')
      .then(function (r) { return r.blob(); })
      .then(function (blob) {
        state._workerBlobUrl = URL.createObjectURL(blob);
      })
      .catch(function () {
        // Silently fail — checked at export time
      });
  }

  // ── GIF Loading ──────────────────────────────
  function loadGifFromFile(file) {
    state.gifFilename = file.name || null;
    showLoading('Parsing GIF frames…');
    var reader = new FileReader();
    reader.onload = function () {
      try {
        processGifBuffer(reader.result);
        hideLoading();
      } catch (err) {
        hideLoading();
        showError('Failed to parse GIF: ' + err.message);
      }
    };
    reader.onerror = function () {
      hideLoading();
      showError('Could not read file.');
    };
    reader.readAsArrayBuffer(file);
  }

  function loadGifById(id) {
    showLoading('Loading GIF…');
    state.gifId = id;
    fetchGif(id).then(function (data) {
      return fetch(data.gif_url);
    }).then(function (resp) {
      if (!resp.ok) throw new Error('Network error');
      return resp.arrayBuffer();
    }).then(function (buf) {
      processGifBuffer(buf);
      hideLoading();
    }).catch(function (err) {
      hideLoading();
      showError('Failed to load GIF: ' + err.message);
    });
  }

  function loadGifFromIndexedDB() {
    showLoading('Loading GIF…');
    var req = indexedDB.open('gifcaption', 1);
    req.onupgradeneeded = function (e) { e.target.result.createObjectStore('files'); };
    req.onsuccess = function (e) {
      var db = e.target.result;
      if (!db.objectStoreNames.contains('files')) { hideLoading(); return; }
      var tx = db.transaction('files', 'readonly');
      var get = tx.objectStore('files').get('pending');
      get.onsuccess = function () {
        var file = get.result;
        if (!file) { hideLoading(); return; }
        // Clean up
        var del = db.transaction('files', 'readwrite');
        del.objectStore('files').delete('pending');
        loadGifFromFile(file);
      };
      get.onerror = function () { hideLoading(); };
    };
    req.onerror = function () { hideLoading(); };
  }

  // ── Frame Extraction (omggif) ────────────────
  function processGifBuffer(buffer) {
    var gifReader = new GifReader(new Uint8Array(buffer));
    var w = gifReader.width;
    var h = gifReader.height;
    state.width = w;
    state.height = h;

    var compCanvas = document.createElement('canvas');
    compCanvas.width = w;
    compCanvas.height = h;
    var compCtx = compCanvas.getContext('2d', { willReadFrequently: true });

    var tmpCanvas = document.createElement('canvas');
    tmpCanvas.width = w;
    tmpCanvas.height = h;
    var tmpCtx = tmpCanvas.getContext('2d', { willReadFrequently: true });

    state.frames = [];
    var prevState = null;

    for (var i = 0; i < gifReader.numFrames(); i++) {
      var info = gifReader.frameInfo(i);

      // Save state before drawing (for disposal type 3)
      if (info.disposal === 3) {
        prevState = compCtx.getImageData(0, 0, w, h);
      }

      // Decode frame into full-size RGBA buffer
      var pixels = new Uint8ClampedArray(w * h * 4);
      gifReader.decodeAndBlitFrameRGBA(i, pixels);

      // Draw decoded pixels onto temp canvas, then composite
      tmpCtx.clearRect(0, 0, w, h);
      tmpCtx.putImageData(new ImageData(pixels, w, h), 0, 0);
      compCtx.drawImage(tmpCanvas, 0, 0);

      // Capture composited result
      var comp = compCtx.getImageData(0, 0, w, h);
      state.frames.push({
        imageData: new ImageData(new Uint8ClampedArray(comp.data), w, h),
        delay: Math.max((info.delay || 10) * 10, 20),
      });

      // Disposal
      if (info.disposal === 2) {
        compCtx.clearRect(info.x, info.y, info.width, info.height);
      } else if (info.disposal === 3 && prevState) {
        compCtx.putImageData(prevState, 0, 0);
      }
    }

    if (state.frames.length === 0) throw new Error('No frames found');

    // Set up canvas
    canvas.width = state.width;
    canvas.height = state.height;
    state.currentFrame = 0;
    state.isPlaying = false;

    renderCurrentFrame();
    buildTimeline();
    updateUI();

    $('#editor-workspace').classList.remove('hidden');
    $('#upload-zone').classList.add('hidden');
    $('#btn-share').disabled = false;
    $('#btn-download').disabled = false;
  }

  // ── Playback ─────────────────────────────────
  function play() {
    if (state.frames.length === 0) return;
    state.isPlaying = true;
    updatePlaybackUI();
    scheduleNextFrame();
  }

  function pause() {
    state.isPlaying = false;
    clearTimeout(playbackTimer);
    playbackTimer = null;
    updatePlaybackUI();
  }

  function togglePlayPause() {
    state.isPlaying ? pause() : play();
  }

  function scheduleNextFrame() {
    if (!state.isPlaying) return;
    var delay = state.frames[state.currentFrame].delay / state.speed;
    playbackTimer = setTimeout(function () {
      state.currentFrame = (state.currentFrame + 1) % state.frames.length;
      renderCurrentFrame();
      updatePlaybackUI();
      movePlayhead();
      scheduleNextFrame();
    }, delay);
  }

  function seekFrame(n) {
    n = Math.max(0, Math.min(state.frames.length - 1, n));
    state.currentFrame = n;
    renderCurrentFrame();
    updatePlaybackUI();
    movePlayhead();
  }

  // ── Rendering ────────────────────────────────

  /** Return the total height contributed by a single box caption (or 0). */
  function boxTotalH(bc) {
    if (!bc) return 0;
    return bc.height + bc.borderWidth * 2;
  }

  /** Return the total canvas dimensions accounting for box captions. */
  function getCompositeSize() {
    var w = state.width;
    var h = state.height + boxTotalH(state.boxCaptionTop) + boxTotalH(state.boxCaptionBottom);
    return { w: w, h: h };
  }

  /** Return the Y offset where the GIF frame should be drawn. */
  function getFrameOffsetY() {
    return boxTotalH(state.boxCaptionTop);
  }

  /** Draw a single box caption bar at a given Y position. */
  function _drawOneBox(context, bc, boxY, compW) {
    var boxH = bc.height + bc.borderWidth * 2;

    // Background
    context.save();
    context.fillStyle = bc.bgColor;
    context.fillRect(0, boxY, compW, boxH);

    // Black border
    if (bc.borderWidth > 0) {
      context.strokeStyle = '#000000';
      context.lineWidth = bc.borderWidth;
      var half = bc.borderWidth / 2;
      context.strokeRect(half, boxY + half, compW - bc.borderWidth, boxH - bc.borderWidth);
    }

    // Text
    var textAreaW = compW * 0.92;
    var padX = (compW - textAreaW) / 2;
    context.font = 'bold ' + bc.fontSize + 'px ' + bc.fontFamily;
    context.textAlign = bc.align;
    context.textBaseline = 'middle';
    context.fillStyle = bc.textColor;

    var lines = wrapText(context, bc.text || '', textAreaW);
    var lh = bc.fontSize * 1.25;
    var totalTextH = lines.length * lh;
    var startY = boxY + bc.borderWidth + (bc.height - totalTextH) / 2 + lh / 2;
    var textX = bc.align === 'left' ? padX : bc.align === 'right' ? compW - padX : compW / 2;

    for (var i = 0; i < lines.length; i++) {
      context.fillText(lines[i], textX, startY + i * lh);
    }
    context.restore();
  }

  /** Draw all active box caption bars onto a context. */
  function drawBoxCaption(context, compW, compH) {
    if (state.boxCaptionTop) {
      _drawOneBox(context, state.boxCaptionTop, 0, compW);
    }
    if (state.boxCaptionBottom) {
      var bottomY = compH - boxTotalH(state.boxCaptionBottom);
      _drawOneBox(context, state.boxCaptionBottom, bottomY, compW);
    }
  }

  /** Sync preview canvas size with composite dimensions. */
  function syncCanvasSize() {
    var size = getCompositeSize();
    if (canvas.width !== size.w || canvas.height !== size.h) {
      canvas.width = size.w;
      canvas.height = size.h;
    }
  }

  function renderCurrentFrame() {
    if (state.frames.length === 0) return;

    syncCanvasSize();
    var size = getCompositeSize();
    var offsetY = getFrameOffsetY();

    // Clear entire composite canvas
    ctx.clearRect(0, 0, size.w, size.h);

    // Draw the GIF frame at the correct offset
    ctx.putImageData(state.frames[state.currentFrame].imageData, 0, offsetY);

    // Draw overlay captions (coordinates are relative to GIF frame area)
    ctx.save();
    ctx.translate(0, offsetY);
    for (var i = 0; i < state.captions.length; i++) {
      var cap = state.captions[i];
      if (state.currentFrame >= cap.startFrame && state.currentFrame <= cap.endFrame) {
        drawCaption(ctx, cap);
      }
    }
    ctx.restore();

    // Draw box caption bar
    drawBoxCaption(ctx, size.w, size.h);

    // Selection highlight (hide when sidebar is collapsed on mobile)
    var sidebarEl = $('#editor-sidebar');
    var sidebarCollapsed = sidebarEl && sidebarEl.classList.contains('mobile-collapsed');
    if (state.selectedCaptionId && !sidebarCollapsed) {
      var sel = findCaption(state.selectedCaptionId);
      if (sel && state.currentFrame >= sel.startFrame && state.currentFrame <= sel.endFrame) {
        ctx.save();
        ctx.translate(0, offsetY);
        drawSelectionBox(ctx, sel);
        ctx.restore();
      }
    }
  }

  function drawCaption(context, cap) {
    var x = cap.x * state.width;
    var y = cap.y * state.height;
    context.save();
    context.font = 'bold ' + cap.fontSize + 'px ' + cap.fontFamily;
    context.textAlign = cap.align;
    context.textBaseline = 'top';

    var lines = wrapText(context, cap.text, state.width * 0.92);
    var lh = cap.fontSize * 1.2;

    for (var i = 0; i < lines.length; i++) {
      var ly = y + i * lh;
      if (cap.strokeWidth > 0) {
        context.strokeStyle = cap.strokeColor;
        context.lineWidth = cap.strokeWidth * 2;
        context.lineJoin = 'round';
        context.miterLimit = 2;
        context.strokeText(lines[i], x, ly);
      }
      context.fillStyle = cap.color;
      context.fillText(lines[i], x, ly);
    }
    context.restore();
  }

  var HANDLE_SIZE = ('ontouchstart' in window || navigator.maxTouchPoints > 0) ? 14 : 8;

  function getSelectionCorners(bbox) {
    var pad = 5;
    var hs = HANDLE_SIZE;
    return [
      { x: bbox.x - pad - hs / 2, y: bbox.y - pad - hs / 2 },                          // top-left
      { x: bbox.x + bbox.w + pad - hs / 2, y: bbox.y - pad - hs / 2 },                 // top-right
      { x: bbox.x - pad - hs / 2, y: bbox.y + bbox.h + pad - hs / 2 },                 // bottom-left
      { x: bbox.x + bbox.w + pad - hs / 2, y: bbox.y + bbox.h + pad - hs / 2 },        // bottom-right
    ];
  }

  function drawSelectionBox(context, cap) {
    var bbox = getCaptionBBox(context, cap);
    if (!bbox) return;
    context.save();
    context.strokeStyle = '#22d3ee';
    context.lineWidth = 2;
    context.setLineDash([6, 3]);
    context.strokeRect(bbox.x - 5, bbox.y - 5, bbox.w + 10, bbox.h + 10);

    // Corner handles
    context.fillStyle = '#22d3ee';
    context.setLineDash([]);
    var hs = HANDLE_SIZE;
    var corners = getSelectionCorners(bbox);
    corners.forEach(function (p) {
      context.beginPath();
      context.arc(p.x + hs / 2, p.y + hs / 2, hs / 2, 0, Math.PI * 2);
      context.fill();
    });
    context.restore();
  }

  function getCaptionBBox(context, cap) {
    var x = cap.x * state.width;
    var y = cap.y * state.height;
    context.save();
    context.font = 'bold ' + cap.fontSize + 'px ' + cap.fontFamily;
    context.textAlign = cap.align;
    var lines = wrapText(context, cap.text, state.width * 0.92);
    var lh = cap.fontSize * 1.2;
    var maxW = 0;
    for (var j = 0; j < lines.length; j++) {
      maxW = Math.max(maxW, context.measureText(lines[j]).width);
    }
    context.restore();
    var totalH = lines.length * lh;
    var bx = cap.align === 'left' ? x : cap.align === 'right' ? x - maxW : x - maxW / 2;
    return { x: bx, y: y, w: maxW, h: totalH };
  }

  function wrapText(context, text, maxWidth) {
    if (!text) return [''];
    var words = text.split(' ');
    var lines = [];
    var line = '';
    for (var i = 0; i < words.length; i++) {
      var test = line ? line + ' ' + words[i] : words[i];
      if (context.measureText(test).width > maxWidth && line) {
        lines.push(line);
        line = words[i];
      } else {
        line = test;
      }
    }
    if (line) lines.push(line);
    return lines.length ? lines : [''];
  }

  // ── Caption CRUD ─────────────────────────────
  function addCaption(opts) {
    opts = opts || {};
    var cap = {
      id: 'cap-' + (nextCaptionId++),
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
    updateCaptionList();
    updateCaptionEditor();
    buildTimeline();
    renderCurrentFrame();
    return cap;
  }

  function removeCaption(id) {
    state.captions = state.captions.filter(function (c) { return c.id !== id; });
    if (state.selectedCaptionId === id) {
      state.selectedCaptionId = state.captions.length ? state.captions[0].id : null;
    }
    updateCaptionList();
    updateCaptionEditor();
    buildTimeline();
    renderCurrentFrame();
  }

  function selectCaption(id) {
    state.selectedCaptionId = id;
    updateCaptionList();
    updateCaptionEditor();
    renderCurrentFrame();
  }

  function updateSelectedCaption(props) {
    var cap = findCaption(state.selectedCaptionId);
    if (!cap) return;
    for (var k in props) cap[k] = props[k];
    renderCurrentFrame();
    if ('startFrame' in props || 'endFrame' in props) buildTimeline();
  }

  function findCaption(id) {
    for (var i = 0; i < state.captions.length; i++) {
      if (state.captions[i].id === id) return state.captions[i];
    }
    return null;
  }

  // ── Canvas Drag ──────────────────────────────
  function canvasCoords(e) {
    var rect = canvas.getBoundingClientRect();
    var compSize = getCompositeSize();
    var offsetY = getFrameOffsetY();
    // Map mouse position to GIF-frame-relative coordinates
    var rawX = (e.clientX - rect.left) * (compSize.w / rect.width);
    var rawY = (e.clientY - rect.top) * (compSize.h / rect.height);
    return {
      x: rawX,
      y: rawY - offsetY,
    };
  }

  function handleCanvasMouseDown(e) {
    var m = canvasCoords(e);
    // Hit-test corner resize handles first (only for selected caption)
    if (state.selectedCaptionId) {
      var selCap = findCaption(state.selectedCaptionId);
      if (selCap && state.currentFrame >= selCap.startFrame && state.currentFrame <= selCap.endFrame) {
        var bbox = getCaptionBBox(ctx, selCap);
        if (bbox) {
          var corners = getSelectionCorners(bbox);
          var hs = HANDLE_SIZE;
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
              canvas.style.cursor = 'nwse-resize';
              return;
            }
          }
        }
      }
    }
    // Hit-test captions in reverse order (top-most first)
    for (var i = state.captions.length - 1; i >= 0; i--) {
      var cap = state.captions[i];
      if (state.currentFrame < cap.startFrame || state.currentFrame > cap.endFrame) continue;
      var bbox = getCaptionBBox(ctx, cap);
      if (!bbox) continue;
      if (m.x >= bbox.x - 6 && m.x <= bbox.x + bbox.w + 6 &&
          m.y >= bbox.y - 6 && m.y <= bbox.y + bbox.h + 6) {
        state.selectedCaptionId = cap.id;
        state.dragState = {
          captionId: cap.id,
          offsetX: m.x - cap.x * state.width,
          offsetY: m.y - cap.y * state.height,
        };
        canvas.style.cursor = 'grabbing';
        updateCaptionList();
        updateCaptionEditor();
        renderCurrentFrame();
        return;
      }
    }
  }

  function handleCanvasMouseMove(e) {
    var m = canvasCoords(e);
    // Resize drag
    if (state.resizeState) {
      var cap = findCaption(state.resizeState.captionId);
      if (!cap) return;
      var dist = Math.sqrt(Math.pow(m.x - cap.x * state.width, 2) + Math.pow(m.y - cap.y * state.height, 2));
      var scale = dist / state.resizeState.startDist;
      cap.fontSize = Math.max(10, Math.min(200, Math.round(state.resizeState.startFontSize * scale)));
      renderCurrentFrame();
      updateCaptionEditor();
      return;
    }
    if (!state.dragState) {
      // Update cursor for hover feedback
      var hovering = false;
      var onHandle = false;
      // Check resize handles first
      if (state.selectedCaptionId) {
        var selCap = findCaption(state.selectedCaptionId);
        if (selCap && state.currentFrame >= selCap.startFrame && state.currentFrame <= selCap.endFrame) {
          var bbox = getCaptionBBox(ctx, selCap);
          if (bbox) {
            var corners = getSelectionCorners(bbox);
            var hs = HANDLE_SIZE;
            var hitRadius = hs * 0.8;
            for (var c = 0; c < corners.length; c++) {
              var cx = corners[c].x + hs / 2;
              var cy = corners[c].y + hs / 2;
              var dx = m.x - cx, dy = m.y - cy;
              if (dx * dx + dy * dy <= hitRadius * hitRadius) {
                onHandle = true;
                break;
              }
            }
          }
        }
      }
      if (onHandle) {
        canvas.style.cursor = 'nwse-resize';
        return;
      }
      for (var i = state.captions.length - 1; i >= 0; i--) {
        var cap = state.captions[i];
        if (state.currentFrame < cap.startFrame || state.currentFrame > cap.endFrame) continue;
        var bbox = getCaptionBBox(ctx, cap);
        if (bbox && m.x >= bbox.x - 6 && m.x <= bbox.x + bbox.w + 6 &&
            m.y >= bbox.y - 6 && m.y <= bbox.y + bbox.h + 6) {
          hovering = true;
          break;
        }
      }
      canvas.style.cursor = hovering ? 'grab' : 'default';
      return;
    }
    var cap = findCaption(state.dragState.captionId);
    if (!cap) return;
    cap.x = Math.max(0, Math.min(1, (m.x - state.dragState.offsetX) / state.width));
    cap.y = Math.max(0, Math.min(1, (m.y - state.dragState.offsetY) / state.height));
    renderCurrentFrame();
  }

  function handleCanvasMouseUp() {
    if (state.resizeState) {
      state.resizeState = null;
      canvas.style.cursor = 'default';
      return;
    }
    if (state.dragState) {
      state.dragState = null;
      canvas.style.cursor = 'grab';
    }
  }

  // Touch support
  function touchToMouse(handler) {
    return function (e) {
      e.preventDefault();
      var t = e.touches[0] || e.changedTouches[0];
      handler({ clientX: t.clientX, clientY: t.clientY });
    };
  }

  // ── D3 Timeline ──────────────────────────────
  function buildTimeline() {
    var container = document.getElementById('timeline');
    container.innerHTML = '';

    if (state.frames.length === 0) return;

    var totalFrames = state.frames.length;
    var trackH = 34;
    var rulerH = 28;
    var margin = { top: 8, right: 24, bottom: 4, left: 110 };
    var cw = container.clientWidth || 800;
    var innerW = cw - margin.left - margin.right;
    var numTracks = Math.max(state.captions.length, 0);
    var totalH = margin.top + numTracks * trackH + rulerH + margin.bottom;

    var xScale = d3.scaleLinear().domain([0, totalFrames - 1]).range([0, innerW]);

    var svg = d3.select(container).append('svg')
      .attr('width', cw).attr('height', Math.max(totalH, 60));

    var g = svg.append('g')
      .attr('transform', 'translate(' + margin.left + ',' + margin.top + ')');

    // Frame ruler
    var rulerG = g.append('g')
      .attr('transform', 'translate(0,' + (numTracks * trackH) + ')');

    var tickCount = Math.min(totalFrames, Math.floor(innerW / 40));
    rulerG.call(d3.axisBottom(xScale).ticks(tickCount).tickFormat(function (d) { return Math.round(d); }))
      .selectAll('text').attr('fill', '#777').attr('font-size', 10);
    rulerG.selectAll('line').attr('stroke', '#444');
    rulerG.selectAll('path').attr('stroke', '#444');

    // Click ruler to seek
    rulerG.append('rect')
      .attr('width', innerW).attr('height', rulerH)
      .attr('fill', 'transparent').attr('cursor', 'pointer')
      .on('click', function (event) {
        var mx = d3.pointer(event)[0];
        seekFrame(Math.round(xScale.invert(mx)));
      });

    // Caption brush tracks
    state.captions.forEach(function (cap, idx) {
      var ty = idx * trackH;
      var tg = g.append('g').attr('transform', 'translate(0,' + ty + ')');

      // Track background
      tg.append('rect')
        .attr('width', innerW).attr('height', trackH - 4)
        .attr('fill', '#14142a').attr('rx', 4)
        .attr('stroke', '#2a2a44').attr('stroke-width', 1);

      // Label
      var labelText = cap.text.length > 14 ? cap.text.substring(0, 14) + '…' : cap.text;
      svg.append('text')
        .attr('x', margin.left - 10)
        .attr('y', margin.top + ty + (trackH - 4) / 2)
        .attr('text-anchor', 'end')
        .attr('dominant-baseline', 'central')
        .attr('fill', cap.id === state.selectedCaptionId ? TRACK_COLORS[idx % TRACK_COLORS.length] : '#888')
        .attr('font-size', 12)
        .attr('font-weight', cap.id === state.selectedCaptionId ? '700' : '400')
        .attr('cursor', 'pointer')
        .text(labelText)
        .on('click', function () { selectCaption(cap.id); });

      // D3 Brush
      var prevSel = null;
      var dragEdge = null; // 'start', 'end', or 'both'
      var userDragging = false;
      var brush = d3.brushX()
        .extent([[0, 2], [innerW, trackH - 6]])
        .on('start', function (event) {
          if (!event.sourceEvent) return; // ignore programmatic brush.move
          userDragging = true;
          state._brushActive = true;
          prevSel = event.selection ? event.selection.slice() : null;
          dragEdge = null;
          selectCaption(cap.id);
          // Pause playback while dragging timeline
          if (state.isPlaying) {
            state._wasPlayingBeforeBrush = true;
            pause();
          }
        })
        .on('brush', function (event) {
          if (!event.selection || !userDragging) return;
          var s0 = Math.round(xScale.invert(event.selection[0]));
          var s1 = Math.round(xScale.invert(event.selection[1]));
          cap.startFrame = Math.max(0, Math.min(totalFrames - 1, s0));
          cap.endFrame = Math.max(cap.startFrame, Math.min(totalFrames - 1, s1));
          // Show the frame at the edge being dragged
          var targetFrame;
          try {
            var pointerX = d3.pointer(event.sourceEvent, this)[0];
            var distToStart = Math.abs(pointerX - event.selection[0]);
            var distToEnd = Math.abs(pointerX - event.selection[1]);
            targetFrame = distToStart < distToEnd ? cap.startFrame : cap.endFrame;
          } catch (e) {
            // Determine which edge is being dragged (only on first movement)
            if (!dragEdge && prevSel) {
              var startMoved = Math.abs(event.selection[0] - prevSel[0]) > 0.5;
              var endMoved = Math.abs(event.selection[1] - prevSel[1]) > 0.5;
              if (startMoved && !endMoved) dragEdge = 'start';
              else if (endMoved && !startMoved) dragEdge = 'end';
              else dragEdge = 'both';
            }
            if (dragEdge === 'start') {
              targetFrame = cap.startFrame;
            } else if (dragEdge === 'end') {
              targetFrame = cap.endFrame;
            } else {
              var midX = (event.selection[0] + event.selection[1]) / 2;
              targetFrame = Math.round(xScale.invert(midX));
              targetFrame = Math.max(0, Math.min(totalFrames - 1, targetFrame));
            }
          }
          prevSel = event.selection.slice();
          state.currentFrame = targetFrame;
          renderCurrentFrame();
          movePlayhead();
          updatePlaybackUI();
        })
        .on('end', function (event) {
          if (!userDragging) return;
          userDragging = false;
          state._brushActive = false;
          if (event.selection) {
            var s0 = Math.round(xScale.invert(event.selection[0]));
            var s1 = Math.round(xScale.invert(event.selection[1]));
            cap.startFrame = Math.max(0, Math.min(totalFrames - 1, s0));
            cap.endFrame = Math.max(cap.startFrame, Math.min(totalFrames - 1, s1));
          }
          updateCaptionList();
          renderCurrentFrame();
          updatePlaybackUI();
          if (state._wasPlayingBeforeBrush) {
            state._wasPlayingBeforeBrush = false;
            play();
          }
        });

      var brushG = tg.append('g').attr('class', 'caption-brush')
        .call(brush)
        .call(brush.move, [xScale(cap.startFrame), xScale(cap.endFrame)]);

      brushG.selectAll('.selection')
        .attr('fill', TRACK_COLORS[idx % TRACK_COLORS.length])
        .attr('fill-opacity', 0.45)
        .attr('stroke', TRACK_COLORS[idx % TRACK_COLORS.length])
        .attr('rx', 4);

      brushG.selectAll('.handle')
        .attr('fill', TRACK_COLORS[idx % TRACK_COLORS.length])
        .attr('width', 6)
        .attr('rx', 2);
    });

    // Playhead
    var playhead = g.append('line')
      .attr('class', 'timeline-playhead')
      .attr('y1', 0)
      .attr('y2', numTracks * trackH + rulerH)
      .attr('stroke', '#ef4444')
      .attr('stroke-width', 2)
      .attr('pointer-events', 'none');

    timelineState = { xScale: xScale, playhead: playhead };
    movePlayhead();
  }

  function movePlayhead() {
    if (!timelineState) return;
    var x = timelineState.xScale(state.currentFrame);
    timelineState.playhead.attr('x1', x).attr('x2', x);
  }

  // ── GIF Export ───────────────────────────────
  function exportGif(opts) {
    if (state.frames.length === 0 || exportInProgress) return;
    opts = opts || {};
    exportInProgress = true;
    showExportProgress(0);

    var compSize = getCompositeSize();
    var offsetY = getFrameOffsetY();

    var expCanvas = document.createElement('canvas');
    expCanvas.width = compSize.w;
    expCanvas.height = compSize.h;
    var expCtx = expCanvas.getContext('2d');

    var workerUrl = state._workerBlobUrl;
    if (!workerUrl) {
      showError('GIF worker not ready. Please try again.');
      return;
    }

    var gif = new GIF({
      workers: Math.min(navigator.hardwareConcurrency || 2, 4),
      quality: 10,
      width: compSize.w,
      height: compSize.h,
      workerScript: workerUrl,
    });

    for (var i = 0; i < state.frames.length; i++) {
      expCtx.clearRect(0, 0, compSize.w, compSize.h);
      expCtx.putImageData(state.frames[i].imageData, 0, offsetY);

      // Overlay captions (relative to GIF frame area)
      expCtx.save();
      expCtx.translate(0, offsetY);
      for (var j = 0; j < state.captions.length; j++) {
        var cap = state.captions[j];
        if (i >= cap.startFrame && i <= cap.endFrame) drawCaption(expCtx, cap);
      }
      expCtx.restore();

      // Box caption bar
      drawBoxCaption(expCtx, compSize.w, compSize.h);

      drawWatermark(expCtx);
      gif.addFrame(expCtx, { copy: true, delay: state.frames[i].delay });
    }

    gif.on('progress', function (p) { showExportProgress(p); });

    gif.on('finished', function (blob) {
      hideExportProgress();
      exportInProgress = false;
      if (opts.onBlob) {
        opts.onBlob(blob);
      } else {
        downloadBlob(blob, makeCaptionedFilename());
      }
    });

    gif.render();
  }

  function makeCaptionedFilename() {
    var base = (state.gifFilename || 'animation').replace(/\.gif$/i, '');
    var id = Math.random().toString(36).slice(2, 7);
    return base + '-captioned-' + id + '.gif';
  }

  function downloadBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function drawWatermark(ctx2d) {
    var compSize = getCompositeSize();
    var fontSize = Math.max(10, Math.round(state.width * 0.028));
    ctx2d.save();
    ctx2d.font = fontSize + 'px sans-serif';
    ctx2d.textAlign = 'right';
    ctx2d.textBaseline = 'bottom';
    ctx2d.globalAlpha = 0.35;
    ctx2d.fillStyle = '#ffffff';
    ctx2d.strokeStyle = '#000000';
    ctx2d.lineWidth = Math.max(1, fontSize * 0.15);
    var text = 'GifCaption';
    var x = compSize.w - 6;
    var y = compSize.h - 4;
    ctx2d.strokeText(text, x, y);
    ctx2d.fillText(text, x, y);
    ctx2d.restore();
  }

  // ── Share Flow ───────────────────────────────
  function shareFlow() {
    if (state.frames.length === 0 || exportInProgress) return;
    exportGif({
      onBlob: function (blob) {
        showShareModal(blob);
      }
    });
  }

  function showShareModal(blob) {
    var modal = $('#share-modal');
    if (!modal) return;

    // Show GIF preview
    var preview = $('#share-preview');
    preview.innerHTML = '';
    var blobUrl = URL.createObjectURL(blob);
    var img = document.createElement('img');
    img.src = blobUrl;
    img.alt = 'Your captioned GIF';
    preview.appendChild(img);

    // Store blob for download
    modal._blob = blob;
    modal._blobUrl = blobUrl;

    // Clear previous state
    $('#share-url').value = '';
    $('#share-image-url').value = '';
    $('#share-image-url-row').style.display = 'none';
    $('#share-skeletons').classList.remove('hidden');
    $('#share-ready').classList.add('hidden');
    $('#share-social-skeletons').classList.remove('hidden');
    $('#share-social-ready').classList.add('hidden');
    setShareStatus('Uploading…', '');

    modal.classList.remove('hidden');

    // Build title from first caption text or fallback
    var title = '';
    for (var i = 0; i < state.captions.length; i++) {
      if (state.captions[i].text.trim()) { title = state.captions[i].text.trim(); break; }
    }
    if (!title) title = 'Captioned GIF';

    shareGif(blob, title, state.gifFilename).then(function (shareResult) {
      $('#share-url').value = shareResult.share_url;
      if (shareResult.gif_url) {
        $('#share-image-url').value = shareResult.gif_url;
        $('#share-image-url-row').style.display = '';
      }
      setShareSocial(shareResult.share_url, title);
      $('#share-skeletons').classList.add('hidden');
      $('#share-ready').classList.remove('hidden');
      $('#share-social-skeletons').classList.add('hidden');
      $('#share-social-ready').classList.remove('hidden');
      setShareStatus('Link ready — copy and share!', 'success');
    }).catch(function (err) {
      $('#share-skeletons').classList.add('hidden');
      $('#share-social-skeletons').classList.add('hidden');
      setShareStatus('Upload failed: ' + err.message, 'error');
    });
  }

  function extractFrameAsBase64(frameIndex) {
    var tmpCanvas = document.createElement('canvas');
    tmpCanvas.width = state.width;
    tmpCanvas.height = state.height;
    var tmpCtx = tmpCanvas.getContext('2d');
    tmpCtx.putImageData(state.frames[frameIndex].imageData, 0, 0);
    // toDataURL returns "data:image/png;base64,<data>" — strip the prefix
    return tmpCanvas.toDataURL('image/png').split(',')[1];
  }

  function closeShareModal() {
    var modal = $('#share-modal');
    if (!modal) return;
    modal.classList.add('hidden');
    if (modal._blobUrl) {
      URL.revokeObjectURL(modal._blobUrl);
      modal._blobUrl = null;
    }
    modal._blob = null;
  }

  function setShareStatus(msg, cls) {
    var el = $('#share-status');
    if (!el) return;
    el.textContent = msg;
    el.className = 'share-status' + (cls ? ' ' + cls : '');
  }

  function setShareSocial(shareUrl, title) {
    var enc = encodeURIComponent;
    var reddit = $('#btn-share-reddit');
    if (reddit) reddit.href = 'https://www.reddit.com/submit?url=' + enc(shareUrl) + '&title=' + enc(title);
    var twitter = $('#btn-share-twitter');
    if (twitter) twitter.href = 'https://twitter.com/intent/tweet?url=' + enc(shareUrl) + '&text=' + enc(title + ' — made with GifCaption');
  }

  // ── UI Updates ───────────────────────────────
  function updateUI() {
    updateCaptionList();
    updateCaptionEditor();
    updatePlaybackUI();
  }

  function updateCaptionList() {
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
        '<div class="caption-color-dot" style="background:' + TRACK_COLORS[idx % TRACK_COLORS.length] + '"></div>' +
        '<div class="caption-item-text">' + escapeHtml(cap.text) + '</div>' +
        '<div class="caption-item-range">f' + cap.startFrame + '–' + cap.endFrame + '</div>';
      item.addEventListener('click', function () { selectCaption(cap.id); });
      list.appendChild(item);
    });
  }

  function updateCaptionEditor() {
    var editor = $('#caption-editor');
    if (!editor) return;
    var cap = findCaption(state.selectedCaptionId);
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

  function updatePlaybackUI() {
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
  }

  // ── Event Binding ────────────────────────────
  function bindEvents() {
    // Drop zone
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
          loadGifFromFile(file);
        } else {
          showError('Please drop a GIF file.');
        }
      });
      dropZone.addEventListener('click', function () { $('#file-input').click(); });
    }

    var fileInput = $('#file-input');
    if (fileInput) {
      fileInput.addEventListener('change', function () {
        if (fileInput.files[0]) loadGifFromFile(fileInput.files[0]);
      });
    }

    // New button → show upload zone again
    var btnNew = $('#btn-new');
    if (btnNew) {
      btnNew.addEventListener('click', function () {
        pause();
        state.frames = [];
        state.captions = [];
        state.selectedCaptionId = null;
        state.currentFrame = 0;
        nextCaptionId = 1;
        $('#editor-workspace').classList.add('hidden');
        $('#upload-zone').classList.remove('hidden');
        $('#btn-share').disabled = true;
        $('#btn-download').disabled = true;
        if ($('#file-input')) $('#file-input').value = '';
      });
    }

    // Canvas interaction
    canvas.addEventListener('mousedown', handleCanvasMouseDown);
    canvas.addEventListener('mousemove', handleCanvasMouseMove);
    canvas.addEventListener('mouseup', handleCanvasMouseUp);
    canvas.addEventListener('mouseleave', handleCanvasMouseUp);
    canvas.addEventListener('touchstart', touchToMouse(handleCanvasMouseDown), { passive: false });
    canvas.addEventListener('touchmove', touchToMouse(handleCanvasMouseMove), { passive: false });
    canvas.addEventListener('touchend', function () { handleCanvasMouseUp(); });

    // Mobile sidebar toggle
    var sidebarToggle = $('#sidebar-toggle');
    if (sidebarToggle) {
      sidebarToggle.addEventListener('click', function () {
        var sidebar = $('#editor-sidebar');
        var collapsed = sidebar.classList.toggle('mobile-collapsed');
        sidebarToggle.classList.toggle('collapsed', collapsed);
        sidebarToggle.setAttribute('aria-expanded', String(!collapsed));
      });
    }

    // Mobile timeline toggle
    var timelineToggle = $('#timeline-toggle');
    if (timelineToggle) {
      timelineToggle.addEventListener('click', function () {
        var timeline = $('#editor-timeline');
        var collapsed = timeline.classList.toggle('mobile-collapsed');
        timelineToggle.classList.toggle('collapsed', collapsed);
        timelineToggle.setAttribute('aria-expanded', String(!collapsed));
      });
    }

    // Box caption section toggle
    var boxCapToggle = $('#box-caption-toggle');
    if (boxCapToggle) {
      boxCapToggle.addEventListener('click', function () {
        var section = $('#box-caption-section');
        var collapsed = section.classList.toggle('collapsed');
        boxCapToggle.classList.toggle('collapsed', collapsed);
        boxCapToggle.setAttribute('aria-expanded', String(!collapsed));
      });
    }

    // On-image caption section toggle
    var onImageCapToggle = $('#on-image-caption-toggle');
    if (onImageCapToggle) {
      onImageCapToggle.addEventListener('click', function () {
        var section = $('#on-image-caption-section');
        var collapsed = section.classList.toggle('collapsed');
        onImageCapToggle.classList.toggle('collapsed', collapsed);
        onImageCapToggle.setAttribute('aria-expanded', String(!collapsed));
      });
    }

    // Playback
    $('#btn-prev-frame').addEventListener('click', function () {
      seekFrame((state.currentFrame - 1 + state.frames.length) % state.frames.length);
    });
    $('#btn-play-pause').addEventListener('click', togglePlayPause);
    $('#btn-next-frame').addEventListener('click', function () {
      seekFrame((state.currentFrame + 1) % state.frames.length);
    });
    $('#frame-scrubber').addEventListener('input', function (e) {
      seekFrame(parseInt(e.target.value, 10));
    });
    $('#speed-slider').addEventListener('input', function (e) {
      state.speed = parseFloat(e.target.value);
      $('#speed-label').textContent = state.speed + '×';
    });

    // Caption controls
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

    // Caption editor inputs
    $('#cap-text').addEventListener('input', function (e) {
      updateSelectedCaption({ text: e.target.value });
      updateCaptionList();
      // Defer timeline rebuild to avoid lag while typing
      clearTimeout(state._tlTimer);
      state._tlTimer = setTimeout(buildTimeline, 400);
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
      var bc = makeBoxCaption();
      if (position === 'top') {
        state.boxCaptionTop = bc;
        $('#box-top-editor').classList.remove('hidden');
        $('#btn-add-box-top').classList.add('hidden');
        // Show bottom add button below top editor if bottom isn't active
        if (!state.boxCaptionBottom) $('#btn-add-box-bottom').classList.remove('hidden');
      } else {
        state.boxCaptionBottom = bc;
        $('#box-bottom-editor').classList.remove('hidden');
        $('#btn-add-box-bottom').classList.add('hidden');
      }
      renderCurrentFrame();
    }

    function removeBoxCaption(position) {
      if (position === 'top') {
        state.boxCaptionTop = null;
        $('#box-top-editor').classList.add('hidden');
        $('#btn-add-box-top').classList.remove('hidden');
        // Reset form values
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
      renderCurrentFrame();
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

    // Wire up each position's controls
    ['top', 'bottom'].forEach(function (pos) {
      var stateKey = pos === 'top' ? 'boxCaptionTop' : 'boxCaptionBottom';

      $('#box-' + pos + '-text').addEventListener('input', function (e) {
        if (state[stateKey]) { state[stateKey].text = e.target.value; renderCurrentFrame(); }
      });
      $('#box-' + pos + '-height').addEventListener('input', function (e) {
        var v = parseInt(e.target.value, 10);
        $('#box-' + pos + '-height-val').textContent = v;
        if (state[stateKey]) { state[stateKey].height = v; renderCurrentFrame(); }
      });
      $('#box-' + pos + '-border').addEventListener('input', function (e) {
        var v = parseInt(e.target.value, 10);
        $('#box-' + pos + '-border-val').textContent = v;
        if (state[stateKey]) { state[stateKey].borderWidth = v; renderCurrentFrame(); }
      });
      $('#box-' + pos + '-fontsize').addEventListener('input', function (e) {
        var v = parseInt(e.target.value, 10);
        $('#box-' + pos + '-fontsize-val').textContent = v;
        if (state[stateKey]) { state[stateKey].fontSize = v; renderCurrentFrame(); }
      });
      $('#box-' + pos + '-align').addEventListener('change', function (e) {
        if (state[stateKey]) { state[stateKey].align = e.target.value; renderCurrentFrame(); }
      });
      $('#box-' + pos + '-font').addEventListener('change', function (e) {
        if (state[stateKey]) { state[stateKey].fontFamily = e.target.value; renderCurrentFrame(); }
      });
      $('#box-' + pos + '-text-color').addEventListener('input', function (e) {
        if (state[stateKey]) { state[stateKey].textColor = e.target.value; renderCurrentFrame(); }
      });
      $('#box-' + pos + '-bg-color').addEventListener('input', function (e) {
        if (state[stateKey]) { state[stateKey].bgColor = e.target.value; renderCurrentFrame(); }
      });
    });


    // Export & Share
    var isMobile = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    $('#btn-download').addEventListener('click', function () {
      if (isMobile) {
        exportGif({ onBlob: showDownloadModal });
      } else {
        exportGif();
      }
    });
    $('#btn-share').addEventListener('click', shareFlow);

    // Download modal events
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
      if (blob) downloadBlob(blob, makeCaptionedFilename());
    });
    $('#btn-dl-save-photos').addEventListener('click', function () {
      var blob = $('#download-modal')._blob;
      if (!blob) return;
      var fname = makeCaptionedFilename();
      var file = new File([blob], fname, { type: 'image/gif' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        navigator.share({ files: [file], title: 'Captioned GIF' }).catch(function () {});
      } else {
        downloadBlob(blob, fname);
      }
    });

    // Share modal events
    $('#share-modal-close').addEventListener('click', closeShareModal);
    $('#share-modal').addEventListener('click', function (e) {
      if (e.target === this) closeShareModal();
    });
    $('#btn-copy-link').addEventListener('click', function () {
      var input = $('#share-url');
      if (!input.value) return;
      navigator.clipboard.writeText(input.value).then(function () {
        setShareStatus('Copied!', 'success');
      }).catch(function () {
        input.select();
        document.execCommand('copy');
        setShareStatus('Copied!', 'success');
      });
    });
    $('#btn-copy-image-url').addEventListener('click', function () {
      var input = $('#share-image-url');
      if (!input.value) return;
      navigator.clipboard.writeText(input.value).then(function () {
        setShareStatus('Image URL copied!', 'success');
      }).catch(function () {
        input.select();
        document.execCommand('copy');
        setShareStatus('Image URL copied!', 'success');
      });
    });
    $('#btn-share-download').addEventListener('click', function () {
      var modal = $('#share-modal');
      if (modal._blob) downloadBlob(modal._blob, makeCaptionedFilename());
    });

    // Save to Photos (mobile: uses Web Share API or falls back to download)
    var savePhotosBtn = $('#btn-share-save-photos');
    if (savePhotosBtn) {
      // Show on mobile/touch devices
      if ('ontouchstart' in window || navigator.maxTouchPoints > 0) {
        savePhotosBtn.style.display = '';
      }
      savePhotosBtn.addEventListener('click', function () {
        var modal = $('#share-modal');
        if (!modal._blob) return;
        var fname = makeCaptionedFilename();
        var file = new File([modal._blob], fname, { type: 'image/gif' });
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
          navigator.share({ files: [file], title: 'Captioned GIF' }).catch(function () {});
        } else {
          // Fallback: trigger download
          downloadBlob(modal._blob, fname);
        }
      });
    }

    // Keyboard shortcuts
    document.addEventListener('keydown', function (e) {
      var tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      if (state.frames.length === 0) return;
      switch (e.key) {
        case ' ':
          e.preventDefault(); togglePlayPause(); break;
        case 'ArrowLeft':
          e.preventDefault();
          seekFrame((state.currentFrame - 1 + state.frames.length) % state.frames.length);
          break;
        case 'ArrowRight':
          e.preventDefault();
          seekFrame((state.currentFrame + 1) % state.frames.length);
          break;
        case 'Delete':
          if (state.selectedCaptionId) { e.preventDefault(); removeCaption(state.selectedCaptionId); }
          break;
      }
    });

    // Resize → rebuild timeline (skip if brush drag is active)
    var resizeTimer;
    window.addEventListener('resize', function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        if (state.frames.length > 0 && !state._brushActive) buildTimeline();
      }, 200);
    });
  }

  // ── Utilities ────────────────────────────────
  function escapeHtml(s) {
    var d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  function showLoading(msg) {
    var el = $('#loading-overlay');
    if (el) {
      el.querySelector('.loading-text').textContent = msg || 'Loading…';
      el.classList.remove('hidden');
    }
  }
  function hideLoading() {
    var el = $('#loading-overlay');
    if (el) el.classList.add('hidden');
  }
  function showError(msg) {
    alert(msg);
  }
  function showExportProgress(p) {
    var el = $('#export-overlay');
    if (!el) return;
    el.classList.remove('hidden');
    var bar = el.querySelector('.progress-bar-fill');
    if (bar) bar.style.width = (p * 100) + '%';
    var txt = el.querySelector('.progress-text');
    if (txt) txt.textContent = 'Exporting… ' + Math.round(p * 100) + '%';
  }
  function hideExportProgress() {
    var el = $('#export-overlay');
    if (el) el.classList.add('hidden');
  }

  // ── Boot ─────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
