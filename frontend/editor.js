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
  };

  var nextCaptionId = 1;
  var playbackTimer = null;
  var canvas, ctx;
  var timelineState = null;
  var exportInProgress = false;

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
    var compCtx = compCanvas.getContext('2d');

    var tmpCanvas = document.createElement('canvas');
    tmpCanvas.width = w;
    tmpCanvas.height = h;
    var tmpCtx = tmpCanvas.getContext('2d');

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
    $('#btn-export').disabled = false;
    $('#btn-share').disabled = false;
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
  function renderCurrentFrame() {
    if (state.frames.length === 0) return;
    ctx.putImageData(state.frames[state.currentFrame].imageData, 0, 0);

    for (var i = 0; i < state.captions.length; i++) {
      var cap = state.captions[i];
      if (state.currentFrame >= cap.startFrame && state.currentFrame <= cap.endFrame) {
        drawCaption(ctx, cap);
      }
    }

    // Selection highlight (hide when sidebar is collapsed on mobile)
    var sidebarEl = $('#editor-sidebar');
    var sidebarCollapsed = sidebarEl && sidebarEl.classList.contains('mobile-collapsed');
    if (state.selectedCaptionId && !sidebarCollapsed) {
      var sel = findCaption(state.selectedCaptionId);
      if (sel && state.currentFrame >= sel.startFrame && state.currentFrame <= sel.endFrame) {
        drawSelectionBox(ctx, sel);
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
    var hs = 5;
    [[bbox.x - 5, bbox.y - 5], [bbox.x + bbox.w + 5 - hs, bbox.y - 5],
     [bbox.x - 5, bbox.y + bbox.h + 5 - hs], [bbox.x + bbox.w + 5 - hs, bbox.y + bbox.h + 5 - hs]
    ].forEach(function (p) { context.fillRect(p[0], p[1], hs, hs); });
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
    return {
      x: (e.clientX - rect.left) * (state.width / rect.width),
      y: (e.clientY - rect.top) * (state.height / rect.height),
    };
  }

  function handleCanvasMouseDown(e) {
    var m = canvasCoords(e);
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
    if (!state.dragState) {
      // Update cursor for hover feedback
      var hovering = false;
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
      var brush = d3.brushX()
        .extent([[0, 2], [innerW, trackH - 6]])
        .on('brush end', function (event) {
          if (!event.selection) return;
          var s0 = Math.round(xScale.invert(event.selection[0]));
          var s1 = Math.round(xScale.invert(event.selection[1]));
          cap.startFrame = Math.max(0, Math.min(totalFrames - 1, s0));
          cap.endFrame = Math.max(cap.startFrame, Math.min(totalFrames - 1, s1));
          renderCurrentFrame();
        })
        .on('start', function () { selectCaption(cap.id); });

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

    var expCanvas = document.createElement('canvas');
    expCanvas.width = state.width;
    expCanvas.height = state.height;
    var expCtx = expCanvas.getContext('2d');

    var workerUrl = state._workerBlobUrl;
    if (!workerUrl) {
      showError('GIF worker not ready. Please try again.');
      return;
    }

    var gif = new GIF({
      workers: Math.min(navigator.hardwareConcurrency || 2, 4),
      quality: 10,
      width: state.width,
      height: state.height,
      workerScript: workerUrl,
    });

    for (var i = 0; i < state.frames.length; i++) {
      expCtx.putImageData(state.frames[i].imageData, 0, 0);
      for (var j = 0; j < state.captions.length; j++) {
        var cap = state.captions[j];
        if (i >= cap.startFrame && i <= cap.endFrame) drawCaption(expCtx, cap);
      }
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
        downloadBlob(blob, 'captioned.gif');
      }
    });

    gif.render();
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
    var x = state.width - 6;
    var y = state.height - 4;
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
    setShareStatus('Uploading…', '');

    modal.classList.remove('hidden');

    // Build default title from first caption text
    var title = '';
    for (var i = 0; i < state.captions.length; i++) {
      if (state.captions[i].text.trim()) { title = state.captions[i].text.trim(); break; }
    }
    if (!title) title = 'Captioned GIF';

    // Upload via API
    shareGif(blob, title).then(function (result) {
      $('#share-url').value = result.share_url;
      setShareSocial(result.share_url, title);
      setShareStatus('Link ready — copy and share!', 'success');
    }).catch(function (err) {
      setShareStatus('Upload failed: ' + err.message, 'error');
    });
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
        $('#btn-export').disabled = true;
        $('#btn-share').disabled = true;
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

    // Playback
    $('#btn-play-pause').addEventListener('click', togglePlayPause);
    $('#btn-prev-frame').addEventListener('click', function () {
      seekFrame((state.currentFrame - 1 + state.frames.length) % state.frames.length);
    });
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


    // Export & Share
    $('#btn-export').addEventListener('click', function () { exportGif(); });
    $('#btn-share').addEventListener('click', shareFlow);

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
    $('#btn-share-download').addEventListener('click', function () {
      var modal = $('#share-modal');
      if (modal._blob) downloadBlob(modal._blob, 'captioned.gif');
    });

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

    // Resize → rebuild timeline
    var resizeTimer;
    window.addEventListener('resize', function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        if (state.frames.length > 0) buildTimeline();
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
