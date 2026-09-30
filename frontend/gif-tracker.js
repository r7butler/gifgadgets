/* ==========================================================
   GifCaption – Object Tracker (SAM2 on Modal, via a Web Worker)

   The worker uploads sampled frames and asks the API to track the
   clicked object; the reply lists the object's position per frame.
   The bundled sample instead uses its known path (GC.sampleTrack).

   Before tracking starts, the visitor picks how the caption or
   overlay follows (#track-place-modal): from where it is now, moving
   by the object's displacement from the clicked frame, or centered
   on the object. "Save my preference" skips the question, and the
   tracking bar's Change button asks again.

   Public API (called from editor.js):
     GC.trackerAvailable()
     GC.warmUpTracker()        — pre-loads the model in background
     GC.startTrackingMode(cap)
     GC.stopTrackingMode()
     GC.handleTrackingClick(normX, normY, clickFrame)

   Depends on:
     editor-state.js     (GC namespace, state)
     canvas-rendering.js (GC.renderCurrentFrame, GC.fitFontSize)
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
  var _middle = null;        // offset to the target's visible middle, when centering it
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
        _trackingCap.motion = _followPath(_pathKeyframes, _anchor, _middle);
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
   * beside the object beside it. Given `middle`, the offset from the target's
   * position to its visible middle, the target is centered on the object.
   */
  function _followPath(path, anchor, middle) {
    if (!path.length) return [];
    var ref = path.reduce(function (best, k) {
      return Math.abs(k.frame - anchor.frame) < Math.abs(best.frame - anchor.frame) ? k : best;
    });
    var dx = middle ? -middle.x : anchor.x - ref.x;
    var dy = middle ? -middle.y : anchor.y - ref.y;
    function round(v) { return Math.round(v * 10000) / 10000; }
    return path.map(function (k) {
      return { frame: k.frame, x: round(k.x + dx), y: round(k.y + dy) };
    }).sort(function (a, b) { return a.frame - b.frame; });
  }

  /**
   * The offset from a target's position to its visible middle, as fractions
   * of the GIF. An overlay's position is its middle; a caption's is the top of
   * its text, which is aligned left, center or right of it.
   */
  function _middleOf(target, kind) {
    if (kind === 'overlay') return { x: 0, y: 0 };
    var ctx = GC.ctx;
    ctx.save();
    var fit = GC.fitFontSize(ctx, target.text, target.fontWeight, target.fontFamily,
      (target.boxWidth || 0.55) * state.width, (target.boxHeight || 0.25) * state.height, 8, target.fontSize || 200);
    var width = fit.lines.reduce(function (w, line) { return Math.max(w, ctx.measureText(line).width); }, 0);
    ctx.restore();
    // Lines are drawn from the top, 1.2 font sizes apart (GC.drawCaption).
    var height = fit.fontSize * (1.2 * (fit.lines.length - 1) + 1);
    var dx = target.align === 'left' ? width / 2 : target.align === 'right' ? -width / 2 : 0;
    return { x: dx / state.width, y: height / 2 / state.height };
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

  // ── Placement ────────────────────────────────
  // 'keep' follows from where the target is now; 'center' puts it on the object.

  var PLACEMENT_KEY = 'gc_track_placement';
  var _placementPref;           // saved choice, read once; kept here if storage fails
  var _placementDone = null;    // receives the choice when the dialog closes

  function _savedPlacement() {
    if (_placementPref === undefined) {
      try { _placementPref = localStorage.getItem(PLACEMENT_KEY); } catch (_) { _placementPref = null; }
    }
    return _placementPref === 'keep' || _placementPref === 'center' ? _placementPref : null;
  }

  function _savePlacement(choice) {
    _placementPref = choice;
    try {
      if (choice) localStorage.setItem(PLACEMENT_KEY, choice);
      else localStorage.removeItem(PLACEMENT_KEY);
    } catch (_) {}
  }

  /**
   * Ask how the target should follow. `done` receives 'keep', 'center', or
   * null when the visitor backs out. `current` marks the choice in effect.
   */
  function _askPlacement(kind, current, done) {
    var modal = document.getElementById('track-place-modal');
    if (!modal) { done(current || 'keep'); return; }
    modal.querySelector('.modal-title').textContent =
      'How should the ' + (kind === 'overlay' ? 'image' : 'caption') + ' follow the object?';
    modal.querySelectorAll('[data-placement]').forEach(function (option) {
      var isCurrent = option.getAttribute('data-placement') === current;
      option.classList.toggle('is-current', isCurrent);
      option.querySelector('.track-place-current').hidden = !isCurrent;
    });
    document.getElementById('track-place-remember').checked = !!_savedPlacement();
    _placementDone = done;
    modal.classList.remove('hidden');
  }

  function _closePlacement(choice) {
    document.getElementById('track-place-modal').classList.add('hidden');
    // Unticking the box on a saved choice goes back to asking.
    if (choice) _savePlacement(document.getElementById('track-place-remember').checked ? choice : null);
    var done = _placementDone;
    _placementDone = null;
    if (done) done(choice);
  }

  function _showTrackingHint() {
    var mode = state._trackingMode;
    var bar = document.getElementById('tracking-bar');
    if (!mode || !bar) return;
    var noun = mode.overlayId ? 'image' : 'caption';
    var hint = bar.querySelector('.tracking-bar-detail');
    if (hint) hint.textContent = ' The ' + noun +
      (mode.placement === 'center' ? ' goes on top of it.' : ' keeps its place relative to it.');
    var change = document.getElementById('btn-tracking-placement');
    if (change) change.setAttribute('aria-label', 'Change how the ' + noun + ' follows');
  }

  function _enterTrackingMode(target, kind, placement) {
    if (GC.stopCutoutPick) GC.stopCutoutPick();
    state._trackingMode = kind === 'overlay'
      ? { overlayId: target.id, placement: placement }
      : { captionId: target.id, placement: placement };
    GC.canvas.style.cursor = 'crosshair';
    var overlay = document.getElementById('tracking-overlay');
    if (overlay) overlay.classList.remove('hidden');
    var bar = document.getElementById('tracking-bar');
    if (bar) bar.classList.remove('hidden');
    _showTrackingHint();
    if (GC.revealPreview) GC.revealPreview();
    if (!state.isSample) _getWorker().postMessage({ type: 'warmup' });
  }

  function _bindPlacement() {
    var modal = document.getElementById('track-place-modal');
    if (!modal) return;
    // The second click of a double-click on Follow an Object lands on the
    // dialog it opened; it is not an answer (e.detail counts the clicks).
    modal.querySelectorAll('[data-placement]').forEach(function (option) {
      option.addEventListener('click', function (e) {
        if (e.detail < 2) _closePlacement(option.getAttribute('data-placement'));
      });
    });
    document.getElementById('track-place-modal-cancel').addEventListener('click', function () { _closePlacement(null); });
    modal.addEventListener('click', function (e) { if (e.target === modal && e.detail < 2) _closePlacement(null); });
    var change = document.getElementById('btn-tracking-placement');
    if (change) change.addEventListener('click', function () {
      var mode = state._trackingMode;
      if (!mode) return;
      _askPlacement(mode.overlayId ? 'overlay' : 'caption', mode.placement, function (choice) {
        if (!choice || state._trackingMode !== mode) return;
        mode.placement = choice;
        _showTrackingHint();
      });
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _bindPlacement);
  else _bindPlacement();

  // ── Public API ───────────────────────────────

  GC.trackerAvailable = function () { return true; };

  /**
   * Pre-load the SAM model in the background so the first real tracking
   * request doesn't have to wait for the download.
   */
  GC.warmUpTracker = function () {
    // The sample's path ships with it, so it never wakes the GPU.
    if (state.isSample || GC._trackerWarm || GC._trackerWarmupSent) return;
    GC._trackerWarmupSent = true;
    _getWorker().postMessage({ type: 'warmup' });
  };

  /**
   * Enter tracking mode for a caption or overlay, first asking how it should
   * follow unless the visitor saved a choice.
   * @param {Object} target  A caption or overlay object (must have .id and .motion)
   * @param {string} [kind]  'caption' (default) or 'overlay'
   */
  GC.startTrackingMode = function (target, kind) {
    if (!target) return;
    if (state.isPlaying) GC.pause();
    kind = kind || 'caption';
    var saved = _savedPlacement();
    if (saved) { _enterTrackingMode(target, kind, saved); return; }
    _askPlacement(kind, null, function (choice) {
      if (choice) _enterTrackingMode(target, kind, choice);
    });
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

    var kind = trackingMode.overlayId ? 'overlay' : 'caption';
    var target = kind === 'overlay'
      ? GC.findOverlay(trackingMode.overlayId)
      : GC.findCaption(trackingMode.captionId);
    if (!target) return;

    if (state.frames.length === 0) return;
    // Where the visitor put the target on this frame; the tracked path is
    // measured from here, or from its middle when centering (see _followPath).
    var at = GC.getInterpolatedPosition(target.motion, clickFrame) || { x: target.x, y: target.y };
    _anchor = { frame: clickFrame, x: at.x, y: at.y };
    _middle = trackingMode.placement === 'center' ? _middleOf(target, kind) : null;
    _previousMotion = target.motion || [];
    target.motion = [];
    _trackingCap = target;
    _pathKeyframes = [];

    if (_trackingMetric) _trackingMetric.fail();
    _trackingMetric = GWFunnel.trackingStarted();

    if (state.isSample && GC.sampleTrack) {
      // The sample's subject path ships with it: nothing is uploaded or run.
      _setProgressText('Creating motion keyframes…');
      var reply = GC.sampleTrack(normX, normY, clickFrame);
      var shown = new Promise(function (resolve) { setTimeout(resolve, 500); });
      Promise.all([reply, shown]).then(function (done) {
        done[0].forEach(function (k) { _handleWorkerMessage({ data: { type: 'keyframe', frame: k.frame, x: k.x, y: k.y } }); });
        _handleWorkerMessage({ data: { type: 'done' } });
      }, function (err) {
        _handleWorkerMessage({ data: { type: 'error', message: err.message } });
      });
      return;
    }

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
