/* Local recovery: metadata saves are small; media is written once, frame by frame. */
(function () {
  'use strict';
  var fields = ['width', 'height', 'gifFilename', 'originalFileSize', 'captions',
    'boxCaptionTop', 'boxCaptionBottom', 'cropRect', 'cropActive', 'speed', 'adjustments',
    'hideWatermark', 'compressGif', 'gifQuality', 'lossyCompress', 'isStillImage',
    'exportFormat', 'exportQuality'];
  var key = location.pathname, ready = false, pending = null, retryAfter = 0, epoch = 0;
  var baseline = '', saved = '', savedFrames = '', generation = null;
  var frameIds = new WeakMap(), nextId = 1, images = new WeakMap();
  var dbPromise = new Promise(function (resolve) {
    var request = indexedDB.open('gifwidgets_editor_drafts', 1);
    request.onupgradeneeded = function () {
      request.result.createObjectStore('drafts');
      request.result.createObjectStore('frames');
    };
    request.onsuccess = function () { resolve(request.result); };
    request.onerror = request.onblocked = function () { resolve(null); };
  }).catch(function () { return null; });
  function completed(tx) {
    return new Promise(function (resolve, reject) {
      tx.oncomplete = resolve;
      tx.onerror = tx.onabort = function () { reject(tx.error || new Error('Storage unavailable')); };
    });
  }
  function snapshot() {
    var data = {};
    fields.forEach(function (field) { data[field] = GC.state[field]; });
    data.overlays = GC.state.overlays.map(function (overlay) {
      var copy = Object.assign({}, overlay);
      if (!images.has(overlay.img)) {
        var source = overlay.img.src;
        if (source.indexOf('blob:') === 0) {
          var canvas = document.createElement('canvas');
          canvas.width = overlay.img.naturalWidth; canvas.height = overlay.img.naturalHeight;
          canvas.getContext('2d').drawImage(overlay.img, 0, 0);
          source = canvas.toDataURL('image/png');
        }
        images.set(overlay.img, source);
      }
      copy.src = images.get(overlay.img); delete copy.img;
      return copy;
    });
    return data;
  }
  function mediaSignature() {
    return GC.state.frames.map(function (frame) {
      if (!frameIds.has(frame.imageData)) frameIds.set(frame.imageData, nextId++);
      return frameIds.get(frame.imageData) + ':' + frame.delay;
    }).join(',');
  }
  function signature() { return JSON.stringify(snapshot()) + '|' + mediaSignature(); }
  GC.hasUnsavedDraft = function () {
    if (!GC.state.frames.length) return false;
    var current = signature();
    return current !== baseline && current !== saved;
  };
  GC.clearDraft = async function () {
    epoch++;
    ready = false;
    if (pending) await pending;
    try {
      var db = await dbPromise;
      if (db) {
        var tx = db.transaction(['drafts', 'frames'], 'readwrite');
        tx.objectStore('drafts').delete(key);
        tx.objectStore('frames').delete(IDBKeyRange.bound([key], [key, []]));
        await completed(tx);
      }
    } catch (_) {}
    saved = ''; savedFrames = ''; generation = null; retryAfter = 0;
    ready = true;
  };
  GC.draftLoaded = function () {
    baseline = signature();
    GC.clearDraft();
  };
  GC.saveDraft = function () {
    if (!ready || pending || Date.now() < retryAfter || !GC.state.frames.length || GC.exportInProgress) return pending || Promise.resolve();
    var metadata = JSON.stringify(snapshot()), media = mediaSignature();
    var current = metadata + '|' + media;
    if (current === baseline) return saved ? GC.clearDraft() : Promise.resolve();
    if (current === saved) return Promise.resolve();
    var savingEpoch = epoch;
    var frames = GC.state.frames.map(function (frame) { return { imageData: frame.imageData, delay: frame.delay }; });
    pending = (async function () {
      try {
        var db = await dbPromise;
        if (!db) return;
        var nextGeneration = generation;
        if (media !== savedFrames) {
          nextGeneration = Date.now() + '-' + Math.random().toString(36).slice(2);
          for (var i = 0; i < frames.length; i++) {
            if (savingEpoch !== epoch) throw new Error('Draft superseded');
            var frameTx = db.transaction('frames', 'readwrite');
            frameTx.objectStore('frames').put(frames[i], [key, nextGeneration, i]);
            await completed(frameTx);
          }
        }
        if (savingEpoch !== epoch) throw new Error('Draft superseded');
        var tx = db.transaction(['drafts', 'frames'], 'readwrite');
        tx.objectStore('drafts').put({ data: JSON.parse(metadata), generation: nextGeneration, count: frames.length }, key);
        if (generation && generation !== nextGeneration) {
          tx.objectStore('frames').delete(IDBKeyRange.bound([key, generation], [key, generation, []]));
        }
        await completed(tx);
        generation = nextGeneration; savedFrames = media; saved = current;
      } catch (_) {
        // Preserve editing and the unsaved-work guard if quota/storage fails.
        retryAfter = Date.now() + 30000;
        if (db && nextGeneration && nextGeneration !== generation) {
          try {
            var cleanup = db.transaction('frames', 'readwrite');
            cleanup.objectStore('frames').delete(IDBKeyRange.bound([key, nextGeneration], [key, nextGeneration, []]));
            await completed(cleanup);
          } catch (_) {}
        }
      } finally { pending = null; }
    })();
    return pending;
  };
  function askRestore() {
    return new Promise(function (resolve) {
      var overlay = document.createElement('div');
      overlay.className = 'modal-overlay'; overlay.id = 'draft-restore-modal';
      overlay.dataset.dialogDismissible = 'false';
      overlay.innerHTML = '<div class="modal modal-sm"><h2 class="modal-title">Restore your draft?</h2>' +
        '<p class="modal-body-text">Your previous edits are saved in this browser.</p><div class="modal-actions">' +
        '<button id="draft-discard" class="btn btn-ghost">Discard</button>' +
        '<button id="draft-restore" class="btn btn-accent">Restore draft</button></div></div>';
      overlay.querySelector('#draft-discard').onclick = async function () {
        overlay.querySelectorAll('button').forEach(function (button) { button.disabled = true; });
        await GC.clearDraft();
        overlay.remove(); resolve(false);
      };
      overlay.querySelector('#draft-restore').onclick = function () { overlay.remove(); resolve(true); };
      document.body.appendChild(overlay);
    });
  }
  GC.restoreDraft = async function () {
    try {
      var nav = performance.getEntriesByType('navigation')[0];
      // Explicit handoffs win; reloads may recover work after the handoff was consumed.
      if (location.search && (!nav || nav.type !== 'reload')) return false;
      var db = await dbPromise;
      if (!db) return false;
      var tx = db.transaction('drafts', 'readonly');
      var request = tx.objectStore('drafts').get(key);
      await completed(tx);
      var record = request.result;
      if (!record || GC.state.frames.length) return false;
      if (!await askRestore()) return false;
      var frames = [];
      for (var i = 0; i < record.count; i++) {
        GC.showLoading('Restoring draft… ' + (i + 1) + ' / ' + record.count + ' frames');
        var frameTx = db.transaction('frames', 'readonly');
        var frameRequest = frameTx.objectStore('frames').get([key, record.generation, i]);
        await completed(frameTx);
        if (!frameRequest.result) throw new Error('Incomplete draft');
        frames.push(frameRequest.result);
      }
      var data = record.data;
      var overlays = await Promise.all(data.overlays.map(function (overlay) {
        return new Promise(function (resolve, reject) {
          var img = new Image();
          img.onload = function () { overlay.img = img; delete overlay.src; resolve(overlay); };
          img.onerror = reject; img.src = overlay.src;
        });
      }));
      Object.assign(GC.state, data, { frames: frames, overlays: overlays, currentFrame: 0, isPlaying: false });
      GC.nextCaptionId = Math.max(0, ...data.captions.map(function (c) { return parseInt(c.id.replace('cap-', ''), 10) || 0; })) + 1;
      GC.nextOverlayId = Math.max(0, ...overlays.map(function (o) { return parseInt(o.id.replace('ov-', ''), 10) || 0; })) + 1;
      GC.canvas.width = data.width; GC.canvas.height = data.height;
      GC.renderCurrentFrame(); GC.buildTimeline(); GC.updateCaptionList(); GC.updateUI();
      restoreControls();
      document.querySelector('#editor-workspace').classList.remove('hidden');
      document.querySelector('#upload-zone').classList.add('hidden');
      ['#btn-share', '#btn-download'].forEach(function (id) { var el = document.querySelector(id); if (el) el.disabled = false; });
      generation = record.generation; savedFrames = mediaSignature(); saved = signature(); baseline = '';
      return true;
    } catch (_) {
      GC.showError('The saved draft could not be restored. You can open your file again.');
      return false;
    } finally { GC.hideLoading(); ready = true; }
  };
  function restoreControls() {
    function setValue(id, value) {
      var el = document.getElementById(id);
      if (!el) return;
      if (el.type === 'checkbox') el.checked = Boolean(value); else el.value = value;
      var label = document.getElementById(id + '-val');
      if (label) label.textContent = value;
    }
    ['top', 'bottom'].forEach(function (position) {
      var box = GC.state[position === 'top' ? 'boxCaptionTop' : 'boxCaptionBottom'];
      var editor = document.getElementById('box-' + position + '-editor');
      var add = document.getElementById('btn-add-box-' + position);
      if (editor) editor.classList.toggle('hidden', !box);
      if (add) add.classList.toggle('hidden', !!box);
      if (!box) return;
      var mapping = {text: 'text', height: 'height', border: 'borderWidth', fontsize: 'fontSize',
        align: 'align', font: 'fontFamily', 'text-color': 'textColor', 'bg-color': 'bgColor'};
      Object.keys(mapping).forEach(function (name) { setValue('box-' + position + '-' + name, box[mapping[name]]); });
      setValue('box-' + position + '-bold', box.fontWeight === 700);
    });
    ['brightness', 'contrast', 'saturation', 'hue'].forEach(function (name) {
      setValue('adj-' + name, GC.state.adjustments[name]);
    });
    document.querySelectorAll('.adj-filter-btn').forEach(function (button) {
      button.classList.toggle('active', button.dataset.filter === GC.state.adjustments.filter);
    });
    setValue('chk-crop', GC.state.cropActive);
    setValue('chk-compress', GC.state.compressGif);
    setValue('chk-lossy', GC.state.lossyCompress);
    setValue('compress-quality', GC.state.gifQuality);
    setValue('chk-hide-watermark', GC.state.hideWatermark);
    setValue('speed-slider', GC.state.speed);
    var speedLabel = document.getElementById('speed-label');
    if (speedLabel) speedLabel.textContent = GC.state.speed + '×';
    if (GC.state.cropRect) ['x', 'y', 'w', 'h'].forEach(function (name) {
      setValue('crop-' + name, GC.state.cropRect[name]);
    });
    setValue('sel-export-format', GC.state.exportFormat);
    setValue('sl-export-quality', Math.round(GC.state.exportQuality * 100));
    var qualityLabel = document.getElementById('export-quality-val');
    if (qualityLabel) qualityLabel.textContent = Math.round(GC.state.exportQuality * 100);
    var qualityGroup = document.getElementById('export-quality-group');
    if (qualityGroup) qualityGroup.style.display = GC.state.exportFormat === 'image/png' ? 'none' : '';
    ['crop', 'compress'].forEach(function (name) {
      var section = document.getElementById(name + '-settings');
      if (section) section.classList.toggle('hidden', !(name === 'crop' ? GC.state.cropActive : GC.state.compressGif));
    });
  }

  setInterval(GC.saveDraft, 1500);
  document.addEventListener('visibilitychange', function () { if (document.hidden) GC.saveDraft(); });
  window.addEventListener('beforeunload', function (event) {
    if (!GC.hasUnsavedDraft()) return;
    event.preventDefault(); event.returnValue = '';
  });
})();
