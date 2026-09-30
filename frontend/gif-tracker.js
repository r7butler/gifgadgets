/* ==========================================================
   GifCaption – Object Tracker (SAM2 on Modal, via a Web Worker)

   The worker uploads sampled frames and asks the API to track the
   clicked object; the reply lists the object's position per frame.
   The tracked caption or overlay moves by the object's displacement
   from the clicked frame, so it keeps the place the visitor gave it.

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

  var _trackingMetric = null;
  var _worker = null;
  var _trackingCap = null;   // caption or overlay being tracked (set during a run)
  var _anchor = null;        // { frame, x, y }: the target's position on the clicked frame
  var _pathKeyframes = [];   // object positions collected during a run
  var _previousMotion = null; // restored if a run fails

  function _getWorker() {
    if (_worker) return _worker;
    _worker = new Worker('/gif-tracker-worker.js');
    _worker.onmessage = _handleWorkerMessage;
    _worker.onerror = function (e) {
      if (_trackingMetric) _trackingMetric.fail();
      _hideTrackingProgress();
      _restoreMotion();
      GC.showError('Tracker worker error: ' + e.message);
    };
    return _worker;
  }

  function _handleWorkerMessage(e) {
    var msg = e.data;
    if (msg.type === 'warmup-pending') {
      _setProgressText('Loading tracker…');

    } else if (msg.type === 'warmup-done') {
      GC._trackerWarm = true;
      _hideTrackingProgress();

    } else if (msg.type === 'progress') {
      _setProgressText(msg.text);

    } else if (msg.type === 'keyframe') {
      // The whole reply arrives at once, so keyframes are applied together on 'done'.
      if (_trackingCap) _pathKeyframes.push({ frame: msg.frame, x: msg.x, y: msg.y });

    } else if (msg.type === 'done') {
      if (_trackingMetric) _trackingMetric.complete();
      if (_trackingCap) {
        _trackingCap.motion = _followPath(_pathKeyframes, _anchor);
        GC.buildTimeline();
        GC.renderCurrentFrame();
        GC.updateCaptionList();
        if (GC.updateUI) GC.updateUI();
      }
      _hideTrackingProgress();
      _trackingCap = null;
      _previousMotion = null;

    } else if (msg.type === 'error') {
      if (_trackingMetric) _trackingMetric.fail();
      _hideTrackingProgress();
      _restoreMotion();
      // A service-level outage is not a failure of the user's GIF, and the
      // message already explains the manual alternative.
      GC.showError(msg.unavailable ? msg.message : 'Tracking failed: ' + msg.message);
    }
  }

  /**
   * The tracker reports where the object is on each frame. Moving the target
   * by the object's displacement from the clicked frame keeps a caption placed
   * beside the object beside it, instead of dropping it on top.
   */
  function _followPath(path, anchor) {
    if (!path.length) return [];
    var ref = path.reduce(function (best, k) {
      return Math.abs(k.frame - anchor.frame) < Math.abs(best.frame - anchor.frame) ? k : best;
    });
    function round(v) { return Math.round(v * 10000) / 10000; }
    return path.map(function (k) {
      return { frame: k.frame, x: round(anchor.x + k.x - ref.x), y: round(anchor.y + k.y - ref.y) };
    }).sort(function (a, b) { return a.frame - b.frame; });
  }

  function _restoreMotion() {
    if (_trackingCap && _previousMotion) {
      _trackingCap.motion = _previousMotion;
      GC.buildTimeline();
      GC.renderCurrentFrame();
      if (GC.updateUI) GC.updateUI();
    }
    _trackingCap = null;
    _previousMotion = null;
  }

  // ── Public API ───────────────────────────────

  GC.trackerAvailable = function () { return true; };

  /**
   * Pre-load the SAM model in the background so the first real tracking
   * request doesn't have to wait for the download.
   */
  GC.warmUpTracker = function () {
    if (GC._trackerWarm || GC._trackerWarmupSent) return;
    GC._trackerWarmupSent = true;
    _getWorker().postMessage({ type: 'warmup' });
  };

  /**
   * Enter tracking mode for a caption or overlay.
   * @param {Object} target  A caption or overlay object (must have .id and .motion)
   * @param {string} [kind]  'caption' (default) or 'overlay'
   */
  GC.startTrackingMode = function (target, kind) {
    if (!target) return;
    if (state.isPlaying) GC.pause();
    kind = kind || 'caption';
    state._trackingMode = kind === 'overlay'
      ? { overlayId: target.id }
      : { captionId: target.id };
    GC.canvas.style.cursor = 'crosshair';
    var overlay = document.getElementById('tracking-overlay');
    if (overlay) overlay.classList.remove('hidden');
    var bar = document.getElementById('tracking-bar');
    if (bar) bar.classList.remove('hidden');
    var hint = bar && bar.querySelector('.tracking-bar-text');
    if (hint) hint.textContent = 'Tap the object to follow. The ' + (kind === 'overlay' ? 'image' : 'caption') +
      ' keeps its place relative to it.';
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

    var target = trackingMode.overlayId
      ? GC.findOverlay(trackingMode.overlayId)
      : GC.findCaption(trackingMode.captionId);
    if (!target) return;

    if (state.frames.length === 0) return;
    // Where the visitor put the target on this frame; the tracked path is
    // measured from here (see _followPath).
    var at = GC.getInterpolatedPosition(target.motion, clickFrame) || { x: target.x, y: target.y };
    _anchor = { frame: clickFrame, x: at.x, y: at.y };
    _previousMotion = target.motion || [];
    target.motion = [];
    _trackingCap = target;
    _pathKeyframes = [];

    if (_trackingMetric) _trackingMetric.fail();
    _trackingMetric = GWFunnel.trackingStarted();

    var sampled = _buildSampledFrames(clickFrame);
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
   * Skips redundant frames based on FPS — targets ~10 inferred fps.
   *
   * Returns { frames: [{data, width, height, frameIndex}], clickFrameIdx }
   * where clickFrameIdx is the index within the returned frames array.
   */
  function _buildSampledFrames(clickFrame) {
    var total = state.frames.length;
    if (total === 0) return { frames: [], clickFrameIdx: 0 };

    // Calculate stride based on FPS — target ~10 inferred fps.
    // High-FPS GIFs have redundant frames safe to skip; low-FPS GIFs need every frame.
    var avgDelay = state.frames.reduce(function (sum, f) { return sum + f.delay; }, 0) / total;
    var fps = 1000 / avgDelay;
    var stride = Math.max(1, Math.floor(fps / 10));

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
    var ctx = tmpCanvas.getContext('2d', { willReadFrequently: true });

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

  window.addEventListener('beforeunload', function () {
    if (_worker) { _worker.terminate(); _worker = null; }
  });

})();
