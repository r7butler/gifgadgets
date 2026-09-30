/* ==========================================================
   GifCaption – Background (remove or swap)

   The sidebar's Background section. Say what to keep, or tap it on the
   first frame, and the segmentation service (segment-client.js) returns
   a mask for every frame. The masks are a layer over the frames, never
   written into them, so the cutout can be refined or taken away again,
   and what goes behind the subject can change without more AI work:
   nothing (a transparent GIF), a color, or an image or GIF.

   Rotating, flipping, cropping or resizing afterwards moves the frames'
   pixels. Each edit extends the cutout's frame map (background-core.js),
   which takes the current frames back to the ones the masks were made for.

   The sample's bee comes with its masks (GC.sampleCutout), so trying
   this on the sample never starts a GPU job.

   Public API:
     GC.cutoutFrame(index), GC.drawBackdrop(ctx, index, w, h)  — for GC.drawBaseFrame
     GC.cutoutLeavesTransparency()   — whether exports keep transparency
     GC.framesEdited(edit)           — editor.js, after rotate/flip/crop/resize
     GC.sourceMap()                  — current frames → frames as loaded
     GC.cutoutPicking(), GC.cutoutPickAt(x, y), GC.stopCutoutPick()
     GC.drawCutoutPoints(ctx)        — canvas-rendering.js, preview only
     GC.syncBackgroundSection()      — called from GC.updateUI
     GC.cutoutDraft(), GC.restoreCutoutDraft(saved)  — editor-drafts.js

   Depends on:
     editor-state.js, background-core.js, segment-client.js
     canvas-rendering.js, gif-playback.js, editor.js   at call time
     editor-sample.js (GC.sampleCutout)                 when present
   ========================================================== */

(function () {
  'use strict';

  var $ = GC.$;
  var state = GC.state;
  var Core = window.BackgroundCore;

  var ownFrames = null;   // the frames array everything below belongs to
  var picking = false;    // canvas taps place points
  var keeping = true;     // a tap marks something to keep, rather than to exclude
  var subject = 0;        // the subject new points belong to
  var history = [];       // the subject of each point, oldest first, for Undo
  var job = null;         // the removal in progress: { cancelled, worker, run, abort }
  var backdrop = null;    // the image or GIF behind the subject: { id, file, name, frames, duration }
  var cutoutIds = 0, backdropIds = 0;
  var scratch = null, scratchFor = null; // the last frame cut out, reused while it is current

  var BACKDROP_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
  var BACKDROP_PIXELS = 64 * 1024 * 1024; // decoded backdrop frames, about 256 MB
  var BACKDROP_SIDE = 4096;

  function blankPrompt() { return { text: '', objects: [{ points: [] }] }; }
  function round(v) { return Math.round(v * 10000) / 10000; }

  /**
   * Loading a file or restoring a draft replaces state.frames with a new
   * array, while edits change the frames' pixels in place. So the cutout
   * and selection belong to one frames array, and start over with the next.
   * This never renders the canvas: it runs in the middle of rendering.
   */
  function sync() {
    if (ownFrames === state.frames) return;
    ownFrames = state.frames;
    if (job) cancelJob(true);
    state.cutout = null;
    state.cutoutPrompt = blankPrompt();
    state.backdrop = { mode: 'none', color: '#ffffff', fit: 'cover' };
    state.sourceMap = Core.IDENTITY.slice();
    backdrop = null; scratch = scratchFor = null;
    subject = 0; history = []; keeping = true;
    if (picking) { picking = false; setCursor(); }
    setStatus('');
    render();
  }
  GC.syncBackgroundSection = function () { sync(); render(); };

  // ── Frame edits ──────────────────────────────

  GC.framesEdited = function (edit) {
    sync();
    var back = Core.undoMap(edit), forward = Core.invert(back);
    state.sourceMap = Core.compose(state.sourceMap, back);
    if (state.cutout) state.cutout.map = Core.compose(state.cutout.map, back);
    if (job) job.map = Core.compose(job.map, back);
    // Points were placed on the frames as they were; move them along, and
    // drop any a crop cut away.
    history = [];
    state.cutoutPrompt.objects.forEach(function (object, index) {
      object.points = object.points.map(function (p) {
        var q = Core.mapPoint(forward, p.x, p.y);
        return { x: round(q.x), y: round(q.y), label: p.label };
      }).filter(function (p) { return p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1; });
      object.points.forEach(function () { history.push(index); });
    });
    render();
  };

  GC.sourceMap = function () { sync(); return state.sourceMap; };

  // ── Rendering (GC.drawBaseFrame) ─────────────

  /** Frame `index` with its background cleared, or null when nothing is cut out. */
  GC.cutoutFrame = function (index) {
    sync();
    var cut = state.cutout;
    if (!cut) return null;
    var image = state.frames[index].imageData;
    if (scratchFor && scratchFor.image === image && scratchFor.cut === cut && scratchFor.map === cut.map) return scratch;
    if (!scratch || scratch.width !== image.width || scratch.height !== image.height) {
      scratch = new ImageData(image.width, image.height);
    }
    Core.cutoutMapped(image.data, scratch.data, image.width, image.height, cut, index, cut.map);
    scratchFor = { image: image, cut: cut, map: cut.map };
    return scratch;
  };

  function hasBackdrop() {
    var mode = state.backdrop.mode;
    return mode === 'color' || (mode === 'image' && !!backdrop);
  }

  /** Paint what goes behind the subject of frame `index`, if anything. */
  GC.drawBackdrop = function (ctx, index, width, height) {
    if (!hasBackdrop()) return;
    var look = state.backdrop;
    // A fitted image is padded with the color.
    ctx.fillStyle = look.color;
    ctx.fillRect(0, 0, width, height);
    if (look.mode !== 'image') return;
    var picture = backdropAt(index);
    var ratio = look.fit === 'contain'
      ? Math.min(width / picture.width, height / picture.height)
      : Math.max(width / picture.width, height / picture.height);
    ctx.drawImage(picture, (width - picture.width * ratio) / 2, (height - picture.height * ratio) / 2,
      picture.width * ratio, picture.height * ratio);
  };

  // An animated backdrop keeps its own timing, repeating under the GIF.
  function backdropAt(index) {
    var frames = backdrop.frames;
    if (frames.length === 1) return frames[0].image;
    var time = 0;
    for (var i = 0; i < index; i++) time += state.frames[i].delay;
    time %= backdrop.duration;
    var j = 0;
    for (; j < frames.length - 1 && time >= frames[j].delay; j++) time -= frames[j].delay;
    return frames[j].image;
  }

  GC.cutoutLeavesTransparency = function () {
    sync();
    return !!state.cutout && !hasBackdrop();
  };

  // ── Picking what to keep ─────────────────────

  GC.cutoutPicking = function () { return picking; };
  GC.stopCutoutPick = function () { setPicking(false); };

  function showPicking() {
    var bar = $('#cutout-bar');
    if (bar) bar.classList.toggle('hidden', !picking);
    var pick = $('#btn-bg-pick');
    if (pick) {
      pick.textContent = picking ? 'Done tapping' : 'Tap what to keep';
      pick.setAttribute('aria-pressed', String(picking));
    }
    var keep = $('#btn-cutout-keep'), exclude = $('#btn-cutout-exclude');
    if (keep) keep.setAttribute('aria-pressed', String(keeping));
    if (exclude) exclude.setAttribute('aria-pressed', String(!keeping));
  }

  // Only on a change, so another mode's cursor (tracking's crosshair) is left alone.
  function setCursor() {
    if (GC.canvas) GC.canvas.style.cursor = picking ? 'crosshair' : '';
  }

  function setBarText(text) {
    var hint = $('#cutout-bar .tracking-bar-text');
    if (hint) hint.firstChild.textContent = text;
  }

  function setPicking(on) {
    sync();
    if (on && (!state.frames.length || job || describing())) return;
    // Tracking mode also waits for a tap; only one mode takes them.
    if (on && state._trackingMode && GC.stopTrackingMode) GC.stopTrackingMode();
    var was = picking;
    picking = on;
    showPicking();
    if (on !== was) setCursor();
    if (on) {
      setBarText(keeping ? 'Tap what to keep.' : 'Tap what to leave out.');
      // What to keep is marked on the first frame, and followed from there.
      if (state.currentFrame !== 0) GC.seekFrame(0);
      else { GC.pause(); GC.renderCurrentFrame(); }
      GC.revealPreview();
    } else if (was && state.frames.length) {
      GC.renderCurrentFrame();
    }
    render();
  }

  function setKeeping(keep) {
    keeping = keep;
    showPicking();
    setBarText(keeping ? 'Tap what to keep.' : 'Tap what to leave out.');
  }

  GC.cutoutPickAt = function (x, y) {
    if (!picking || job) return;
    if (state.currentFrame !== 0) {
      GC.seekFrame(0);
      setBarText('Points go on the first frame. Tap again.');
      return;
    }
    if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1)) return;
    var points = state.cutoutPrompt.objects[subject].points;
    if (points.length >= 128) { setStatus('Use at most 128 points per subject.'); return; }
    points.push({ x: round(x), y: round(y), label: keeping ? 1 : 0 });
    history.push(subject);
    selectionChanged();
  };

  GC.drawCutoutPoints = function (ctx) {
    if (!picking || state.currentFrame !== 0) return;
    // Points keep one size on screen at any zoom.
    var scale = GC.canvas.width / Math.max(1, GC.canvas.getBoundingClientRect().width);
    state.cutoutPrompt.objects.forEach(function (object, index) {
      object.points.forEach(function (p) {
        var x = p.x * state.width, y = p.y * state.height;
        ctx.beginPath();
        ctx.arc(x, y, 7 * scale, 0, Math.PI * 2);
        ctx.fillStyle = p.label ? '#10b981' : '#ef4444';
        ctx.fill();
        ctx.lineWidth = 2 * scale;
        ctx.strokeStyle = '#fff';
        ctx.stroke();
        ctx.fillStyle = '#fff';
        ctx.font = 'bold ' + Math.round(10 * scale) + 'px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(index + 1), x, y + 0.5 * scale);
      });
    });
  };

  // ── Selection ────────────────────────────────

  function describing() { return state.cutoutPrompt.text.trim(); }

  /** What to ask the service for: a description or tapped subjects, or why not yet. */
  function request() {
    var text = describing().replace(/\s+/g, ' ');
    if (text) return { text: text };
    var objects = state.cutoutPrompt.objects;
    if (!objects.some(function (o) { return o.points.length; })) {
      return { error: 'Describe what to keep, or tap it on the GIF.' };
    }
    var missing = objects.findIndex(function (o) {
      return o.points.length && !o.points.some(function (p) { return p.label === 1; });
    });
    if (missing >= 0) {
      return { subject: missing, error: 'Subject ' + (missing + 1) + ' only has Exclude points. Choose Keep, then tap inside what you want to keep.' };
    }
    return { objects: objects.filter(function (o) { return o.points.length; })
      .map(function (o) { return { points: o.points.slice() }; }) };
  }
  function requestKey(req) { return JSON.stringify(req.text ? { text: req.text } : { objects: req.objects }); }

  function selectionChanged() {
    render();
    if (picking) GC.renderCurrentFrame();
  }

  function undoPoint() {
    if (!history.length) return;
    var from = history.pop();
    state.cutoutPrompt.objects[from].points.pop();
    selectionChanged();
  }

  function clearPoints() {
    state.cutoutPrompt.objects = [{ points: [] }];
    subject = 0; history = [];
    selectionChanged();
  }

  function addSubject() {
    var objects = state.cutoutPrompt.objects;
    if (!objects[objects.length - 1].points.length) { subject = objects.length - 1; }
    else if (objects.length >= 32) { setStatus('Use at most 32 subjects.'); return; }
    else { objects.push({ points: [] }); subject = objects.length - 1; }
    setKeeping(true);
    setStatus('Tap inside subject ' + (subject + 1) + '.');
    if (!picking) setPicking(true); else render();
  }

  // ── Removing the background ──────────────────

  function setStatus(message) {
    var el = $('#bg-status');
    if (el) el.textContent = message;
  }

  function setProgress(done, total) {
    var bar = $('#bg-progress');
    if (!bar) return;
    if (total) { bar.max = total; bar.value = done; } else bar.removeAttribute('value');
  }

  /**
   * The frames as they are now, as a file to upload, so the masks line up
   * with any rotation, crop or resize already made. The service works at
   * 1024 pixels at most, so bigger frames go up scaled down. Resolves null
   * if the job is cancelled first.
   */
  function sourceFile(current, frames) {
    // Edits replace frames' images rather than change them, so these stay as
    // they were when the job started even if the frames are edited meanwhile.
    var images = frames.map(function (frame) { return frame.imageData; });
    var fullWidth = images[0].width, fullHeight = images[0].height;
    var scale = Math.min(1, 1024 / Math.max(fullWidth, fullHeight));
    var width = Math.max(1, Math.round(fullWidth * scale)), height = Math.max(1, Math.round(fullHeight * scale));
    var from = document.createElement('canvas'), to = document.createElement('canvas');
    from.width = fullWidth; from.height = fullHeight;
    to.width = width; to.height = height;
    var fromCtx = from.getContext('2d'), toCtx = to.getContext('2d', { willReadFrequently: true });
    function draw(index) {
      fromCtx.putImageData(images[index], 0, 0);
      toCtx.clearRect(0, 0, width, height);
      toCtx.drawImage(from, 0, 0, width, height);
    }
    return new Promise(function (resolve, reject) {
      if (frames.length === 1) {
        draw(0);
        to.toBlob(function (blob) { resolve(current.cancelled ? null : { blob: blob, type: 'image/png' }); }, 'image/png');
        return;
      }
      var worker = current.worker = new Worker('/segment-source-worker.js'), next = 0;
      current.abort = function () { worker.terminate(); resolve(null); };
      function send() {
        if (next === frames.length) { worker.postMessage({ type: 'finish' }); return; }
        draw(next);
        var pixels = toCtx.getImageData(0, 0, width, height).data;
        worker.postMessage({ type: 'frame', index: next, pixels: pixels.buffer, delay: frames[next].delay }, [pixels.buffer]);
        next++;
      }
      worker.onmessage = function (event) {
        var data = event.data;
        if (current.cancelled) return;
        if (data.error) { worker.terminate(); reject(new Error('The frames could not be prepared for upload: ' + data.error)); }
        else if (data.bytes) { worker.terminate(); resolve({ blob: new Blob([data.bytes], { type: 'image/gif' }), type: 'image/gif' }); }
        else { setStatus('Preparing frames… ' + data.done + ' / ' + frames.length); setProgress(data.done, frames.length); send(); }
      };
      worker.onerror = function (event) {
        event.preventDefault(); worker.terminate();
        reject(new Error('The frames could not be prepared for upload. Try again.'));
      };
      worker.postMessage({ type: 'start', width: width, height: height });
      send();
    });
  }

  async function removeBackground() {
    sync();
    var req = request();
    if (req.error) {
      if (req.subject != null) { subject = req.subject; setKeeping(true); }
      setStatus(req.error);
      render();
      return;
    }
    setPicking(false);
    var frames = state.frames, sample = !!(state.isSample && GC.sampleCutout);
    // `map` follows any edits made while the job runs (GC.framesEdited).
    var current = job = { cancelled: false, worker: null, run: null, abort: null, map: Core.IDENTITY.slice() };
    setProgress(0, null);
    render();
    var span = window.GWFunnel && GWFunnel.trackingStarted();
    try {
      var buffer;
      if (sample) {
        setStatus('Cutting out the bee…');
        buffer = await GC.sampleCutout(req);
      } else {
        setStatus('Preparing frames…');
        var source = await sourceFile(current, frames);
        if (!source || job !== current) return;
        current.run = GWSegment.start({ source: source.blob, type: source.type, text: req.text, objects: req.objects,
          frames: frames.length,
          onStatus: function (message) { if (job === current) setStatus(message); },
          onProgress: function (done, total) { if (job === current) setProgress(done, total); } });
        buffer = await current.run.result;
      }
      if (!buffer || job !== current) return;
      // Masks from the service match the frames uploaded; the sample's match
      // the sample as it was loaded.
      state.cutout = Object.assign(Core.readMasks(buffer, frames.length), {
        map: sample ? state.sourceMap.slice() : current.map,
        buffer: buffer, id: ++cutoutIds, request: requestKey(req) });
      if (span) span.complete();
      setStatus(sample ? 'The bee is cut out. Choose what goes behind it.'
        : 'Background removed. Choose what goes behind your subject.');
      GC.renderCurrentFrame();
    } catch (error) {
      if (span) span.fail('processing');
      if (job === current && !current.cancelled) {
        setStatus(error.message);
        var run = current.run;
        if (run && run.submission) {
          try { await run.cancelRemote(); }
          catch (_) { setStatus(error.message + ' The server job may still be running; it stops after one hour.'); }
        }
      }
    } finally {
      if (job === current) { job = null; render(); }
    }
  }

  function cancelJob(quietly) {
    var current = job;
    if (!current) return;
    current.cancelled = true;
    job = null;
    if (current.abort) current.abort();
    var stopping = current.run ? current.run.cancel() : Promise.resolve();
    render();
    if (quietly) { stopping.catch(function () {}); return; }
    setStatus('Cancelling…');
    stopping.then(function () {
      if (!job) setStatus('Cancelled. Nothing was changed.');
    }, function () {
      if (!job) setStatus('Stopped here, but the server did not confirm it stopped too. It stops on its own within an hour.');
    });
  }

  function restoreOriginal() {
    state.cutout = null;
    scratch = scratchFor = null;
    setStatus('The original background is back. Your selection is kept, to remove it again.');
    render();
    GC.renderCurrentFrame();
  }

  // ── What goes behind ─────────────────────────

  async function loadBackdrop(file) {
    var frames;
    if (file.type === 'image/gif') {
      var buffer = await file.arrayBuffer();
      var reader = new GifReader(new Uint8Array(buffer));
      if (reader.numFrames() * reader.width * reader.height > BACKDROP_PIXELS) {
        throw new Error('That GIF is too big to go behind this one. Try a shorter or smaller GIF.');
      }
      var decoded = await GC.decodeGifBuffer(buffer);
      GC.hideLoading();
      if (!decoded.length) throw new Error('That GIF has no frames.');
      frames = await Promise.all(decoded.map(async function (frame) {
        return { image: await createImageBitmap(frame.imageData), delay: frame.delay };
      }));
    } else {
      var image = await createImageBitmap(file);
      var shrink = Math.min(1, BACKDROP_SIDE / Math.max(image.width, image.height));
      if (shrink < 1) {
        try {
          var smaller = await createImageBitmap(image, { resizeWidth: Math.round(image.width * shrink),
            resizeHeight: Math.round(image.height * shrink), resizeQuality: 'high' });
          image.close();
          image = smaller;
        } catch (_) { /* browsers without resize options keep it full size */ }
      }
      frames = [{ image: image, delay: 0 }];
    }
    var duration = frames.reduce(function (sum, frame) { return sum + frame.delay; }, 0);
    return { id: ++backdropIds, file: file, name: file.name, frames: frames, duration: duration || 1 };
  }

  async function chooseBackdrop(file) {
    if (!file) return;
    if (BACKDROP_TYPES.indexOf(file.type) < 0 || file.size > 100 * 1024 * 1024) {
      setStatus('Choose a PNG, JPG, WebP or GIF up to 100 MB.');
      return;
    }
    var frames = state.frames;
    setStatus('Loading ' + file.name + '…');
    try {
      var loaded = await loadBackdrop(file);
      if (frames !== state.frames) return;
      if (backdrop) backdrop.frames.forEach(function (frame) { frame.image.close(); });
      backdrop = loaded;
      state.backdrop.mode = 'image';
      setStatus(loaded.frames.length > 1
        ? loaded.name + ' plays behind your subject, repeating as needed.'
        : loaded.name + ' is behind your subject.');
    } catch (error) {
      GC.hideLoading();
      setStatus(error.message || 'That file could not be opened. Try another image or GIF.');
    }
    render();
    GC.renderCurrentFrame();
  }

  // ── Section UI ───────────────────────────────

  function render() {
    var section = $('#background-section');
    if (!section) return;
    var busy = !!job, text = describing(), cut = state.cutout, look = state.backdrop;
    var prompt = $('#bg-prompt');
    if (document.activeElement !== prompt) prompt.value = state.cutoutPrompt.text;
    prompt.disabled = busy;

    var objects = state.cutoutPrompt.objects;
    var count = objects.reduce(function (sum, o) { return sum + o.points.length; }, 0);
    var subjects = objects.filter(function (o) { return o.points.length; }).length;
    $('#btn-bg-pick').disabled = busy || !!text || !state.frames.length;
    $('#btn-bg-subject').hidden = !count;
    $('#btn-bg-subject').disabled = busy || !!text;
    $('#bg-points-row').hidden = !count;
    $('#bg-points').textContent = text ? 'Using your description, not the points.'
      : count + ' point' + (count === 1 ? '' : 's') + ' · ' + subjects + ' subject' + (subjects === 1 ? '' : 's');
    $('#btn-bg-undo').disabled = $('#btn-bg-clear').disabled = busy || !!text;

    var req = request(), current = cut && !req.error && cut.request === requestKey(req);
    var remove = $('#btn-bg-remove');
    remove.textContent = cut ? 'Update the cutout' : 'Remove background';
    remove.hidden = !!current;
    remove.disabled = busy || !state.frames.length;
    $('#bg-progress-row').hidden = !busy;
    $('#bg-privacy').textContent = state.isSample
      ? 'The sample\'s bee has its cutout built in, so this is instant and nothing is uploaded. On your own GIFs, AI selection takes a little longer.'
      : 'Removing the background uploads this GIF\'s frames to our AI processor.';

    $('#bg-behind').hidden = !cut;
    section.querySelectorAll('input[name="bg-mode"]').forEach(function (radio) {
      radio.checked = radio.value === look.mode;
    });
    $('#bg-image-options').hidden = look.mode !== 'image';
    $('#bg-image-name').textContent = backdrop ? backdrop.name : 'No file chosen yet.';
    $('#bg-fit').value = look.fit;
    $('#bg-color-options').hidden = !(look.mode === 'color' || (look.mode === 'image' && look.fit === 'contain'));
    $('#bg-color-label').textContent = look.mode === 'color' ? 'Color' : 'Padding color';
    $('#bg-color').value = look.color;
    showPicking();
  }

  function bind() {
    var section = $('#background-section');
    if (!section) return;
    var toggle = $('#background-toggle');
    toggle.addEventListener('click', function () {
      var collapsed = section.classList.toggle('collapsed');
      toggle.classList.toggle('collapsed', collapsed);
      toggle.setAttribute('aria-expanded', String(!collapsed));
      if (collapsed) setPicking(false);
    });
    $('#bg-prompt').addEventListener('input', function (e) {
      sync();
      state.cutoutPrompt.text = e.target.value;
      // A description and taps are alternatives; the description wins.
      if (describing() && picking) setPicking(false);
      render();
    });
    $('#bg-prompt').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); removeBackground(); }
    });
    $('#btn-bg-pick').addEventListener('click', function () { setPicking(!picking); });
    $('#btn-bg-subject').addEventListener('click', addSubject);
    $('#btn-bg-undo').addEventListener('click', undoPoint);
    $('#btn-bg-clear').addEventListener('click', clearPoints);
    $('#btn-bg-remove').addEventListener('click', removeBackground);
    $('#btn-bg-cancel').addEventListener('click', function () { cancelJob(false); });
    $('#btn-bg-restore').addEventListener('click', restoreOriginal);
    $('#btn-cutout-keep').addEventListener('click', function () { setKeeping(true); });
    $('#btn-cutout-exclude').addEventListener('click', function () { setKeeping(false); });
    $('#btn-cutout-done').addEventListener('click', function () { setPicking(false); });

    section.querySelectorAll('input[name="bg-mode"]').forEach(function (radio) {
      radio.addEventListener('change', function () {
        if (!radio.checked) return;
        state.backdrop.mode = radio.value;
        if (radio.value === 'image' && !backdrop) setStatus('Choose an image or GIF to put behind your subject.');
        render();
        GC.renderCurrentFrame();
      });
    });
    $('#bg-color').addEventListener('input', function (e) {
      state.backdrop.color = e.target.value;
      GC.renderCurrentFrame();
    });
    $('#bg-fit').addEventListener('change', function (e) {
      state.backdrop.fit = e.target.value;
      render();
      GC.renderCurrentFrame();
    });
    $('#btn-bg-image').addEventListener('click', function () { $('#bg-image-input').click(); });
    $('#bg-image-input').addEventListener('change', function (e) {
      var file = e.target.files[0];
      e.target.value = '';
      chooseBackdrop(file);
    });
    render();
  }

  // ── Drafts (editor-drafts.js) ────────────────

  /**
   * What a draft keeps of this section beyond its state fields: a key that
   * changes whenever these do, and the masks and backdrop file themselves.
   */
  GC.cutoutDraft = function () {
    sync();
    var cut = state.cutout;
    return {
      key: (cut ? cut.id + ':' + cut.map.join(',') : '-') + '|' + (backdrop ? backdrop.id : '-'),
      cutout: cut ? { id: cut.id, buffer: cut.buffer, map: cut.map, request: cut.request } : null,
      backdrop: backdrop ? { id: backdrop.id, file: backdrop.file } : null,
    };
  };

  /** Called with the saved parts once a draft's frames and state are back. */
  GC.restoreCutoutDraft = async function (saved) {
    // The restored selection and settings belong to the restored frames.
    ownFrames = state.frames;
    state.cutout = null; backdrop = null; scratch = scratchFor = null;
    subject = 0; history = []; picking = false;
    if (saved && saved.cutout) {
      try {
        state.cutout = Object.assign(Core.readMasks(saved.cutout.buffer, state.frames.length), {
          map: saved.cutout.map, buffer: saved.cutout.buffer, id: ++cutoutIds, request: saved.cutout.request });
      } catch (_) { /* a draft that no longer matches starts without its cutout */ }
    }
    if (saved && saved.backdrop && saved.backdrop.file) {
      try { backdrop = await loadBackdrop(saved.backdrop.file); } catch (_) { GC.hideLoading(); }
    }
    render();
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
})();
