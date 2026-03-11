/* ==========================================================
   GifCaption – AI Object Tracker (SAM2 Lambda)

   Sends sampled GIF frames to the gifcaption-tracker Lambda,
   receives motion keyframes, and writes them into the caption.

   Workflow:
     1. User clicks "Track with AI" → warm-up request fires,
        tracking instruction bar appears.
     2. User clicks on the object in the canvas.
     3. Sampled frames + click coordinates POSTed to Lambda.
     4. Lambda returns motion[]; caption.motion is replaced.

   Depends on:
     editor-state.js     (GC namespace, state)
     canvas-rendering.js (GC.renderCurrentFrame)
     gif-timeline.js     (GC.buildTimeline)
     editor.js           (GC.updateCaptionList, updateCaptionEditor
                          exposed via GC.updateUI)

   TRACKER_BASE_URL is injected by deploy-frontend.sh at deploy time.
   ========================================================== */

(function () {
  'use strict';

  // Injected by deploy-frontend.sh — replaced with the real Lambda URL.
  var TRACKER_BASE_URL = 'TRACKER_URL_PLACEHOLDER';

  var state = GC.state;

  // ── Public API ───────────────────────────────

  /** Returns true if a real tracker URL has been configured. */
  GC.trackerAvailable = function () {
    return TRACKER_BASE_URL && TRACKER_BASE_URL !== 'TRACKER_URL_PLACEHOLDER';
  };

  /**
   * Fire a warm-up POST to wake the Lambda and pre-load the SAM2 model.
   * Safe to call multiple times — subsequent calls are no-ops if already warming.
   */
  GC.warmUpTracker = function () {
    if (!GC.trackerAvailable()) return;
    if (GC._trackerWarmupSent) return;
    GC._trackerWarmupSent = true;
    fetch(TRACKER_BASE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ warmup: true }),
    }).catch(function () { /* warm-up failure is non-fatal */ });
  };

  /**
   * Show the tracking instruction bar and wait for the user to click
   * on the canvas.  Stores the active caption in state._trackingMode.
   */
  GC.startTrackingMode = function (cap) {
    if (!cap) return;
    if (state.isPlaying) GC.pause();
    state._trackingMode = { captionId: cap.id };
    GC.canvas.style.cursor = 'crosshair';
    var bar = document.getElementById('tracking-bar');
    if (bar) bar.classList.remove('hidden');
  };

  /** Cancel tracking mode — hides the bar and restores normal cursor. */
  GC.stopTrackingMode = function () {
    state._trackingMode = null;
    GC.canvas.style.cursor = '';
    var bar = document.getElementById('tracking-bar');
    if (bar) bar.classList.add('hidden');
  };

  /**
   * Called from handleCanvasMouseDown when tracking mode is active.
   * Extracts sampled frames, sends them to the Lambda, and writes
   * the returned motion keyframes into the caption.
   *
   * @param {number} normX  Normalised click x (0–1)
   * @param {number} normY  Normalised click y (0–1)
   * @param {number} clickFrame  Current GIF frame index at time of click
   */
  GC.handleTrackingClick = function (normX, normY, clickFrame) {
    var trackingMode = state._trackingMode;
    GC.stopTrackingMode();
    if (!trackingMode) return;

    var cap = GC.findCaption(trackingMode.captionId);
    if (!cap) return;

    var sampled = _extractSampledFrames();
    if (sampled.frames.length === 0) return;

    _showTrackingProgress();

    fetch(TRACKER_BASE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        frames: sampled.frames,
        frame_indices: sampled.frameIndices,
        click_x: normX,
        click_y: normY,
        click_frame: clickFrame,
      }),
    })
      .then(function (res) {
        if (!res.ok) throw new Error('Tracker returned HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        _hideTrackingProgress();
        if (!data.motion || data.motion.length === 0) {
          GC.showError('Tracker returned no motion data.');
          return;
        }
        cap.motion = data.motion;
        GC.buildTimeline();
        GC.renderCurrentFrame();
        GC.updateCaptionList();
        if (GC.updateUI) GC.updateUI();
      })
      .catch(function (err) {
        _hideTrackingProgress();
        GC.showError('Tracking failed: ' + err.message);
      });
  };

  // ── Frame extraction ─────────────────────────

  /**
   * Sample up to 30 frames evenly across the GIF and encode each as a
   * base64 JPEG.  Returns { frames: string[], frameIndices: number[] }.
   */
  function _extractSampledFrames() {
    var totalFrames = state.frames.length;
    if (totalFrames === 0) return { frames: [], frameIndices: [] };

    var N = Math.max(1, Math.floor(totalFrames / 30));
    var indices = [];
    for (var i = 0; i < totalFrames; i += N) indices.push(i);

    var tmpCanvas = document.createElement('canvas');
    tmpCanvas.width = state.width;
    tmpCanvas.height = state.height;
    var tmpCtx = tmpCanvas.getContext('2d');

    var frames = [];
    var frameIndices = [];
    for (var j = 0; j < indices.length; j++) {
      var idx = indices[j];
      tmpCtx.putImageData(state.frames[idx].imageData, 0, 0);
      var b64 = tmpCanvas.toDataURL('image/jpeg', 0.8).split(',')[1];
      frames.push(b64);
      frameIndices.push(idx);
    }
    return { frames: frames, frameIndices: frameIndices };
  }

  // ── Progress overlay helpers ─────────────────

  function _showTrackingProgress() {
    var bar = document.getElementById('tracking-bar');
    if (!bar) return;
    bar.classList.remove('hidden');
    bar.querySelector('.tracking-bar-text').textContent = 'Analyzing… this takes a few seconds';
    var cancelBtn = bar.querySelector('#btn-cancel-tracking');
    if (cancelBtn) cancelBtn.style.display = 'none';
  }

  function _hideTrackingProgress() {
    var bar = document.getElementById('tracking-bar');
    if (!bar) return;
    bar.classList.add('hidden');
    bar.querySelector('.tracking-bar-text').textContent =
      'Click on the object you want to track';
    var cancelBtn = bar.querySelector('#btn-cancel-tracking');
    if (cancelBtn) cancelBtn.style.display = '';
  }

})();
