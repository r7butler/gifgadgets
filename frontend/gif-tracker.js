/* ==========================================================
   GifCaption – Client-side Object Tracker (EdgeSAM via Web Worker)

   Uses EdgeSAM running in a Web Worker via onnxruntime-web (WebGPU/WASM).
   Model files are served from /models/ on the same origin.
   Results stream in frame-by-frame as each inference completes.

   Public API (called from editor.js):
     GC.trackerAvailable()
     GC.warmUpTracker()        — pre-loads the model in background
     GC.startTrackingMode(cap)
     GC.stopTrackingMode()
     GC.handleTrackingClick(normX, normY, clickFrame)

   Depends on:
     editor-state.js     (GC namespace, state)
     canvas-rendering.js (GC.renderCurrentFrame)
     gif-timeline.js     (GC.buildTimeline)
     editor.js           (GC.updateCaptionList, GC.updateUI)
   ========================================================== */

(function () {
  'use strict';

  var state = GC.state;

  // ── Worker lifecycle ─────────────────────────

  var _worker = null;
  var _trackingCap = null;   // caption being tracked (set during a run)
  var _timelineBuilt = false;

  function _getWorker() {
    if (_worker) return _worker;
    _worker = new Worker('gif-tracker-worker.js');
    _worker.onmessage = _handleWorkerMessage;
    _worker.onerror = function (e) {
      _hideTrackingProgress();
      GC.showError('Tracker worker error: ' + e.message);
      _trackingCap = null;
    };
    return _worker;
  }

  function _handleWorkerMessage(e) {
    var msg = e.data;
    if (msg.type === 'progress') {
      _setProgressText(msg.text);

    } else if (msg.type === 'keyframe') {
      if (!_trackingCap) return;
      // Insert / update keyframe in cap.motion and refresh UI incrementally.
      _upsertKeyframe(_trackingCap, msg.frame, msg.x, msg.y);
      if (!_timelineBuilt) {
        GC.buildTimeline();   // first keyframe — build motion row
        _timelineBuilt = true;
      }
      GC.renderCurrentFrame();

    } else if (msg.type === 'done') {
      if (_trackingCap) {
        _trackingCap.motion.sort(function (a, b) { return a.frame - b.frame; });
        GC.buildTimeline();
        GC.renderCurrentFrame();
        GC.updateCaptionList();
        if (GC.updateUI) GC.updateUI();
      }
      _hideTrackingProgress();
      _trackingCap = null;

    } else if (msg.type === 'error') {
      _hideTrackingProgress();
      GC.showError('Tracking failed: ' + msg.message);
      _trackingCap = null;
    }
  }

  function _upsertKeyframe(cap, frame, x, y) {
    if (!cap.motion) cap.motion = [];
    for (var i = 0; i < cap.motion.length; i++) {
      if (cap.motion[i].frame === frame) {
        cap.motion[i].x = x;
        cap.motion[i].y = y;
        return;
      }
    }
    cap.motion.push({ frame: frame, x: x, y: y });
  }

  // ── Public API ───────────────────────────────

  GC.trackerAvailable = function () { return true; };

  /**
   * Pre-load the SAM model in the background so the first real tracking
   * request doesn't have to wait for the download.
   */
  GC.warmUpTracker = function () {
    if (GC._trackerWarmupSent) return;
    GC._trackerWarmupSent = true;
    // Just instantiate the worker — it will load the model on first 'track' message.
    _getWorker();
  };

  GC.startTrackingMode = function (cap) {
    if (!cap) return;
    if (state.isPlaying) GC.pause();
    state._trackingMode = { captionId: cap.id };
    GC.canvas.style.cursor = 'crosshair';
    var overlay = document.getElementById('tracking-overlay');
    if (overlay) overlay.classList.remove('hidden');
    var bar = document.getElementById('tracking-bar');
    if (bar) bar.classList.remove('hidden');
    _getWorker().postMessage({ type: 'warmup' });
  };

  GC.stopTrackingMode = function () {
    state._trackingMode = null;
    GC.canvas.style.cursor = '';
    var overlay = document.getElementById('tracking-overlay');
    if (overlay) overlay.classList.add('hidden');
    var bar = document.getElementById('tracking-bar');
    if (bar) bar.classList.add('hidden');
  };

  /**
   * Called from handleCanvasMouseDown when tracking mode is active.
   *
   * @param {number} normX       Normalised click x (0–1)
   * @param {number} normY       Normalised click y (0–1)
   * @param {number} clickFrame  GIF frame index at time of click
   */
  GC.handleTrackingClick = function (normX, normY, clickFrame) {
    var trackingMode = state._trackingMode;
    GC.stopTrackingMode();
    if (!trackingMode) return;

    var cap = GC.findCaption(trackingMode.captionId);
    if (!cap) return;

    var sampled = _buildSampledFrames(clickFrame);
    if (sampled.frames.length === 0) return;

    // Clear existing motion and start fresh.
    cap.motion = [];
    _trackingCap = cap;
    _timelineBuilt = false;

    _showTrackingProgress('Initializing…');

    _getWorker().postMessage({
      type: 'track',
      frames: sampled.frames,
      clickX: normX * state.width,
      clickY: normY * state.height,
      clickFrameIdx: sampled.clickFrameIdx,
      origin: window.location.origin,
    });
  };

  // ── Frame sampling ───────────────────────────

  /**
   * Build strided frame list and locate the click frame within it.
   * Targets ~25 sampled frames: stride = ceil(total/25).
   *
   * Returns { frames: [{data, width, height, frameIndex}], clickFrameIdx }
   * where clickFrameIdx is the index within the returned frames array.
   */
  function _buildSampledFrames(clickFrame) {
    var total = state.frames.length;
    if (total === 0) return { frames: [], clickFrameIdx: 0 };

    var stride = 1;
    // var stride = Math.ceil(total / 25);

    // Collect strided indices, always including clickFrame.
    var indices = [];
    for (var i = 0; i < total; i += stride) indices.push(i);
    // Ensure clickFrame is included (snap to nearest strided index).
    if (indices.indexOf(clickFrame) === -1) {
      // Replace the strided index closest to clickFrame with clickFrame.
      var closest = indices.reduce(function (best, idx) {
        return Math.abs(idx - clickFrame) < Math.abs(best - clickFrame) ? idx : best;
      }, indices[0]);
      indices[indices.indexOf(closest)] = clickFrame;
      indices.sort(function (a, b) { return a - b; });
    }

    var clickFrameIdx = indices.indexOf(clickFrame);

    var tmpCanvas = document.createElement('canvas');
    tmpCanvas.width = state.width;
    tmpCanvas.height = state.height;
    var ctx = tmpCanvas.getContext('2d');

    var frames = indices.map(function (idx) {
      ctx.putImageData(state.frames[idx].imageData, 0, 0);
      var imgData = ctx.getImageData(0, 0, state.width, state.height);
      return {
        data: imgData.data.buffer,   // ArrayBuffer (cloned on postMessage)
        width: state.width,
        height: state.height,
        frameIndex: idx,
      };
    });

    return { frames: frames, clickFrameIdx: clickFrameIdx };
  }

  // ── Progress bar helpers ─────────────────────

  function _showTrackingProgress() {
    // Loading overlay is intentionally not shown yet — the ripple animation
    // plays during frame prep. The overlay appears once the fetch starts.
  }

  function _setProgressText(text) {
    // Only show the loading overlay once the Modal fetch has started
    // (i.e. after the fast local frame-prep phase is done).
    if (text === 'Preparing…') return;
    var el = document.getElementById('tracking-loading');
    if (!el) return;
    var label = el.querySelector('.tracking-loading-label');
    if (label) label.textContent = text || 'Creating motion keyframes…';
    el.classList.remove('hidden');
  }

  function _hideTrackingProgress() {
    var el = document.getElementById('tracking-loading');
    if (el) el.classList.add('hidden');
  }

})();
