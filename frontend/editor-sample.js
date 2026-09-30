/* ==========================================================
   GifCaption – Sample GIF

   "Try a sample" loads a bundled GIF through the same pipeline
   as a visitor's own file, then adds a caption whose motion
   keyframes already follow the subject. Visitors can edit,
   track and export it like any GIF.

   Follow an Object and Remove Background work on the sample
   without the GPU: the preset ships the bee's position on every
   frame, and bee.masks.gz its outline, in the segmentation
   service's format. The rest of the scene is still, so every
   answer is already known. scripts/make-sample-media.cjs
   regenerates the GIFs, preset and masks.

   Public API:
     GC.loadSample()                 — also reached via ?sample=1|day|night
     GC.sampleTrack(x, y, frame)     — object path for a tap, as the tracker returns it
     GC.sampleCutout(request)        — the bee's masks, as the segmentation service returns them
     GC.syncSampleBar()              — called from GC.updateUI

   Depends on:
     editor-state.js   (GC namespace, state)
     background-core.js (BackgroundCore frame maps)
     gif-playback.js   (GC.loadGifFromFile, GC.play)       at call time
     editor.js         (GC.addCaption, GC.startNewFile, …) at call time
     editor-drafts.js  (GC.draftLoaded)                    at call time
   ========================================================== */

(function () {
  'use strict';

  var $ = GC.$;
  var state = GC.state;
  var PRESET_URL = '/samples/bee.json';
  var MASKS_URL = '/samples/bee.masks.gz';
  var INTRO = 'Sample GIF. To try tracking, select a caption, click Follow an Object, then tap the bee.';
  var FOLLOWING = 'It follows the bee now. The sample\'s path is built in, so this is instant; ' +
    'on your own GIFs, AI tracking takes a little longer.';
  var STILL = 'That spot doesn\'t move in this GIF, so neither does the caption. Try tapping the bee.';
  var loading = false;
  var presetRequest = null;
  var masksRequest = null;

  function fetchOk(url, as) {
    return fetch(url).then(function (response) {
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return response[as]();
    });
  }

  // Cached, and re-fetched after a failure. A restored sample draft needs it too.
  function preset() {
    if (!presetRequest) {
      presetRequest = fetchOk(PRESET_URL, 'json').catch(function (err) { presetRequest = null; throw err; });
    }
    return presetRequest;
  }

  // The night scene suits the dark theme; ?sample=day|night picks one explicitly.
  function variantName() {
    var asked = new URLSearchParams(location.search).get('sample');
    if (asked === 'day' || asked === 'night') return asked;
    return document.documentElement.getAttribute('data-theme') === 'dark' ? 'night' : 'day';
  }

  function setStatus(message) {
    var el = $('#sample-status');
    if (el) el.textContent = message;
  }

  function setBar(message) {
    var text = $('#sample-bar-text');
    if (text) text.textContent = message;
  }

  GC.loadSample = async function () {
    if (loading || state.frames.length) return;
    loading = true;
    var button = $('#btn-try-sample');
    if (button) button.disabled = true;
    setStatus('');
    GC.showLoading('Loading sample GIF…');
    try {
      var spec = await preset();
      var variant = spec.variants[variantName()];
      var blob = await fetchOk(variant.gif, 'blob');
      var file = new File([blob], variant.filename, { type: 'image/gif' });
      // A decode failure is reported by the loader itself.
      if (!await GC.loadGifFromFile(file, { funnelKind: 'sample' })) return;
      state.isSample = true;
      spec.captions.forEach(function (caption) {
        var cap = GC.addCaption(caption);
        cap.motion = caption.motion.map(function (k) { return { frame: k.frame, x: k.x, y: k.y }; });
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

  // The preset was measured on the sample as loaded. Rotating, flipping or
  // cropping it since moves the bee, so taps are taken back to that geometry
  // (and answers brought forward) through the frame map.
  function sourceMap() { return GC.sourceMap ? GC.sourceMap() : BackgroundCore.IDENTITY; }

  function onBee(subject, x, y, frame) {
    var at = BackgroundCore.mapPoint(sourceMap(), x, y);
    var here = subject.path[Math.min(frame, subject.path.length - 1)];
    var dx = (at.x - here.x) / subject.radius.x, dy = (at.y - here.y) / subject.radius.y;
    return dx * dx + dy * dy <= 1;
  }

  /**
   * What the tracker would report for a tap on the sample: the bee's path when
   * the tap lands on it, otherwise the tapped point on every frame, because
   * nothing else in the scene moves.
   */
  GC.sampleTrack = function (x, y, frame) {
    return preset().then(function (spec) {
      var subject = spec.subject;
      var hit = onBee(subject, x, y, frame);
      setBar(hit ? FOLLOWING : STILL);
      if (!hit) return subject.path.map(function (k) { return { frame: k.frame, x: x, y: y }; });
      var forward = BackgroundCore.invert(sourceMap());
      return subject.path.map(function (k) {
        var p = BackgroundCore.mapPoint(forward, k.x, k.y);
        return { frame: k.frame, x: p.x, y: p.y };
      });
    });
  };

  /**
   * The bee's masks, as the segmentation service would return them, when the
   * selection picks out the bee. Nothing else in the sample has a cutout, so
   * any other selection is explained instead.
   */
  GC.sampleCutout = function (request) {
    return preset().then(function (spec) {
      var bee = request.text ? /\bbees?\b/i.test(request.text) : request.objects.some(function (object) {
        return object.points.some(function (p) { return p.label === 1 && onBee(spec.subject, p.x, p.y, 0); });
      });
      if (!bee) {
        throw new Error('Only the bee has a cutout built into this sample. ' + (request.text
          ? 'Try "bee", or tap it. On your own GIFs, describe anything.'
          : 'Tap the bee. On your own GIFs, tap anything.'));
      }
      if (!masksRequest) {
        masksRequest = fetchOk(MASKS_URL, 'arrayBuffer').catch(function () {
          masksRequest = null;
          throw new Error('The sample\'s cutout could not be loaded. Check your connection and try again.');
        });
      }
      return masksRequest;
    }).then(function (bytes) {
      // A gzip file, unless a server already unpacked it on the way.
      var head = new Uint8Array(bytes, 0, 2);
      if (head[0] !== 0x1f || head[1] !== 0x8b) return bytes.slice(0);
      return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
    });
  };

  GC.syncSampleBar = function () {
    var bar = $('#sample-bar');
    if (!bar) return;
    var showing = !bar.classList.contains('hidden');
    // Each appearance starts from the introduction.
    if (showing !== state.isSample) setBar(INTRO);
    bar.classList.toggle('hidden', !state.isSample);
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
