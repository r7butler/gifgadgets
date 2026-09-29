/* ==========================================================
   GifCaption – Sample GIF

   "Try a sample" loads a bundled GIF through the same pipeline
   as a visitor's own file, then adds a caption whose motion
   keyframes already follow the subject. Visitors can edit and
   export it like any GIF.

   The sample never starts AI tracking: its keyframes ship with
   it (scripts/make-sample-media.cjs regenerates both files).

   Public API:
     GC.loadSample()             — also reached via ?sample=1
     GC.syncSampleBar()          — called from GC.updateUI
     GC.explainSampleTracking()  — called instead of tracking

   Depends on:
     editor-state.js   (GC namespace, state)
     gif-playback.js   (GC.loadGifFromFile, GC.play)       at call time
     editor.js         (GC.addCaption, GC.startNewFile, …) at call time
     editor-drafts.js  (GC.draftLoaded)                    at call time
   ========================================================== */

(function () {
  'use strict';

  var $ = GC.$;
  var state = GC.state;
  var PRESET_URL = '/samples/bee.json';
  var INTRO = 'Sample GIF: its caption follows the bee with motion keyframes. Select the caption to edit it.';
  var TRACKING = 'AI tracking runs on your own GIFs. This sample\'s caption already follows the bee with motion keyframes.';
  var loading = false;

  function fetchOk(url, as) {
    return fetch(url).then(function (response) {
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return response[as]();
    });
  }

  function setStatus(message) {
    var el = $('#sample-status');
    if (el) el.textContent = message;
  }

  GC.loadSample = async function () {
    if (loading || state.frames.length) return;
    loading = true;
    var button = $('#btn-try-sample');
    if (button) button.disabled = true;
    setStatus('');
    GC.showLoading('Loading sample GIF…');
    try {
      var preset = await fetchOk(PRESET_URL, 'json');
      var blob = await fetchOk(preset.gif, 'blob');
      var file = new File([blob], preset.filename, { type: 'image/gif' });
      // A decode failure is reported by the loader itself.
      if (!await GC.loadGifFromFile(file, { funnelKind: 'sample' })) return;
      state.isSample = true;
      preset.captions.forEach(function (spec) {
        var cap = GC.addCaption(spec);
        cap.motion = spec.motion.map(function (k) { return { frame: k.frame, x: k.x, y: k.y }; });
      });
      // Start unselected so the first thing seen is the finished effect, not handles.
      state.selectedCaptionId = null;
      // The preset is the starting point, not an edit, so leaving asks nothing.
      GC.draftLoaded();
      GC.buildTimeline();
      GC.updateUI();
      GC.renderCurrentFrame();
      var section = $('#on-image-caption-section');
      if (section && section.classList.contains('collapsed')) $('#on-image-caption-toggle').click();
      if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) GC.play();
    } catch (err) {
      GC.hideLoading();
      setStatus('The sample GIF could not be loaded. Check your connection and try again, or upload your own GIF.');
    } finally {
      loading = false;
      if (button) button.disabled = false;
    }
  };

  GC.syncSampleBar = function () {
    var bar = $('#sample-bar');
    if (!bar) return;
    var showing = !bar.classList.contains('hidden');
    // Each appearance starts from the introduction.
    if (showing !== state.isSample) $('#sample-bar-text').textContent = INTRO;
    bar.classList.toggle('hidden', !state.isSample);
  };

  GC.explainSampleTracking = function () {
    var text = $('#sample-bar-text');
    if (text) text.textContent = TRACKING;
    GC.syncSampleBar();
  };

  function bind() {
    var tryButton = $('#btn-try-sample');
    if (tryButton) tryButton.addEventListener('click', function () { GC.loadSample(); });
    var ownButton = $('#btn-sample-own');
    if (ownButton) ownButton.addEventListener('click', function () {
      GC.startNewFile({ skipConfirmIfUnchanged: true, pickFile: true });
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
})();
