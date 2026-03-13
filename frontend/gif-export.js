/* ==========================================================
   GifCaption – GIF Export & Share

   Encodes the captioned GIF using gif.js, provides a file
   download helper, and drives the share-modal flow (upload
   to backend → display share URL + social links).

   This module is GIF-specific.  A future still-image tool
   would export a single PNG/JPEG frame instead.

   Depends on:
     editor-state.js      (GC namespace, state)
     canvas-rendering.js  (GC.drawCaption, GC.drawBoxCaption,
                           GC.drawWatermark, GC.getCompositeSize,
                           GC.getFrameOffsetY)
     gif.js               (GIF global — the gif.js encoder)
     app.js               (shareGif function)
   ========================================================== */

(function () {
  'use strict';

  var $ = GC.$;
  var state = GC.state;

  // ── GIF Encoding ─────────────────────────────

  /**
   * Render all frames with captions and encode them into a GIF blob.
   * @param {Object} [opts]
   * @param {Function} [opts.onBlob]  If provided, called with the blob
   *   instead of triggering a download (used by the share flow).
   */
  GC.exportGif = function (opts) {
    if (state.frames.length === 0 || GC.exportInProgress) return;
    opts = opts || {};
    GC.exportInProgress = true;
    GC.showExportProgress(0);

    var compSize = GC.getCompositeSize();
    var offsetY = GC.getFrameOffsetY();

    // Determine crop region (if active)
    var crop = state.cropActive && state.cropRect ? state.cropRect : null;
    var outW = crop ? crop.w : compSize.w;
    var outH = crop ? crop.h : compSize.h;

    if (outW <= 0 || outH <= 0) {
      GC.showError('Crop region is too small.');
      GC.exportInProgress = false;
      return;
    }

    // Off-screen canvas used to composite each frame for the encoder
    var expCanvas = document.createElement('canvas');
    expCanvas.width = compSize.w;
    expCanvas.height = compSize.h;
    var expCtx = expCanvas.getContext('2d');

    // Reusable temp canvas for adjustment filter pass (drawImage respects ctx.filter; putImageData does not)
    var adjTmpCanvas = null, adjTmpCtx = null;
    if (GC.hasAdjustments()) {
      adjTmpCanvas = document.createElement('canvas');
      adjTmpCanvas.width  = state.width;
      adjTmpCanvas.height = state.height;
      adjTmpCtx = adjTmpCanvas.getContext('2d');
    }

    // Separate canvas for cropped output (if cropping)
    var cropCanvas, cropCtx;
    if (crop) {
      cropCanvas = document.createElement('canvas');
      cropCanvas.width = outW;
      cropCanvas.height = outH;
      cropCtx = cropCanvas.getContext('2d');
    }

    var workerUrl = state._workerBlobUrl;
    if (!workerUrl) {
      GC.showError('GIF worker not ready. Please try again.');
      GC.exportInProgress = false;
      return;
    }

    var quality = state.compressGif ? state.gifQuality : 10;

    var gif = new GIF({
      workers: Math.min(navigator.hardwareConcurrency || 2, 4),
      quality: quality,
      width: outW,
      height: outH,
      workerScript: workerUrl,
    });

    // Composite every frame: raw pixels → overlay captions → box bars → watermark
    for (var i = 0; i < state.frames.length; i++) {
      expCtx.clearRect(0, 0, compSize.w, compSize.h);
      if (adjTmpCanvas) {
        adjTmpCtx.putImageData(state.frames[i].imageData, 0, 0);
        expCtx.filter = GC.buildAdjFilter();
        expCtx.drawImage(adjTmpCanvas, 0, offsetY);
        expCtx.filter = 'none';
      } else {
        expCtx.putImageData(state.frames[i].imageData, 0, offsetY);
      }

      expCtx.save();
      expCtx.translate(0, offsetY);
      for (var j = 0; j < state.captions.length; j++) {
        var cap = state.captions[j];
        if (i >= cap.startFrame && i <= cap.endFrame) GC.drawCaption(expCtx, cap, i);
      }
      expCtx.restore();

      GC.drawBoxCaption(expCtx, compSize.w, compSize.h);
      GC.drawWatermark(expCtx);

      // If cropping, extract the crop region into the crop canvas
      var frameCtx = expCtx;
      if (crop) {
        // Adjust crop Y to account for box caption offset
        cropCtx.clearRect(0, 0, outW, outH);
        cropCtx.drawImage(expCanvas, crop.x, crop.y + offsetY, crop.w, crop.h, 0, 0, outW, outH);
        frameCtx = cropCtx;
      }

      gif.addFrame(frameCtx, { copy: true, delay: state.frames[i].delay });
    }

    gif.on('progress', function (p) { GC.showExportProgress(p); });

    gif.on('finished', function (blob) {
      GC.hideExportProgress();
      GC.exportInProgress = false;
      var fname = GC.makeCaptionedFilename();
      if (opts.onBlob) {
        opts.onBlob(blob, fname);
      } else {
        GC.downloadBlob(blob, fname);
      }
    });

    gif.render();
  };

  // ── Download Helpers ─────────────────────────

  /** Generate a unique output filename based on the original file. */
  GC.makeCaptionedFilename = function () {
    var base = (state.gifFilename || 'animation').replace(/\.gif$/i, '');
    var id = Math.random().toString(36).slice(2, 7);
    return base + '-captioned-' + id + '.gif';
  };

  /** Trigger a browser download of a Blob with the given filename. */
  GC.downloadBlob = function (blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  };

  // ── Size Info Helper ─────────────────────────

  /**
   * Insert or update a `.dl-size-info` element inside `modal` to show
   * original → exported file size when compression is active.
   * Inserts immediately after the `#download-preview` or `#share-preview` element.
   */
  GC.updateSizeInfo = function (modal, blob) {
    var sizeInfo = modal.querySelector('.dl-size-info');
    if (!sizeInfo) {
      sizeInfo = document.createElement('p');
      sizeInfo.className = 'dl-size-info';
      var previewEl = modal.querySelector('#download-preview, #share-preview');
      if (previewEl) previewEl.parentNode.insertBefore(sizeInfo, previewEl.nextSibling);
    }
    if (state.compressGif && state.originalFileSize > 0 && blob) {
      var origSize = state.originalFileSize;
      var newSize  = blob.size;
      var pct      = Math.round((1 - newSize / origSize) * 100);
      var pctStr   = pct > 0 ? '−' + pct + '%' : (pct < 0 ? '+' + Math.abs(pct) + '%' : 'no change');
      var hasCaptions = state.captions.length > 0 || state.boxCaptionTop || state.boxCaptionBottom;
      var note = hasCaptions ? ' <span class="dl-size-note">(captions add to file size)</span>' : '';
      sizeInfo.innerHTML =
        '<span class="dl-size-orig">'  + GC.formatBytes(origSize) + '</span>' +
        ' <span class="dl-size-arrow">→</span> ' +
        '<span class="dl-size-new">'   + GC.formatBytes(newSize)  + '</span>' +
        ' <span class="dl-size-pct '  + (pct > 0 ? 'dl-size-savings' : '') + '">(' + pctStr + ')</span>' +
        note;
      sizeInfo.style.display = '';
    } else {
      sizeInfo.style.display = 'none';
    }
  };

  // ── Share Flow ───────────────────────────────

  /**
   * Export the GIF, then open the share modal to upload it and
   * display the public URL + social sharing links.
   */
  GC.shareFlow = function () {
    if (state.frames.length === 0 || GC.exportInProgress) return;
    GC.exportGif({
      onBlob: function (blob) { showShareModal(blob); },
    });
  };

  /** Populate and show the share modal, uploading the blob in the background. */
  function showShareModal(blob, fname) {
    var modal = $('#share-modal');
    if (!modal) return;

    // Show a live preview of the exported GIF
    var preview = $('#share-preview');
    preview.innerHTML = '';
    var blobUrl = URL.createObjectURL(blob);
    var img = document.createElement('img');
    img.src = blobUrl;
    img.alt = 'Your captioned GIF';
    preview.appendChild(img);

    GC.updateSizeInfo(modal, blob);

    // Stash blob for the download button inside the modal
    modal._blob = blob;
    modal._filename = fname || null;
    modal._blobUrl = blobUrl;

    // Reset UI to "uploading" state (skeleton placeholders)
    $('#share-url').value = '';
    $('#share-image-url').value = '';
    $('#share-image-url-row').style.display = 'none';
    $('#share-skeletons').classList.remove('hidden');
    $('#share-ready').classList.add('hidden');
    $('#share-social-skeletons').classList.remove('hidden');
    $('#share-social-ready').classList.add('hidden');
    GC.setShareStatus('Uploading…', '');

    modal.classList.remove('hidden');

    // Use the first non-empty caption as the share title
    var title = '';
    for (var i = 0; i < state.captions.length; i++) {
      if (state.captions[i].text.trim()) { title = state.captions[i].text.trim(); break; }
    }
    if (!title) title = 'Captioned GIF';

    // Upload to the backend and populate the share URL on success
    shareGif(blob, title, state.gifFilename).then(function (shareResult) {
      $('#share-url').value = shareResult.share_url;
      if (shareResult.gif_url) {
        $('#share-image-url').value = shareResult.gif_url;
        $('#share-image-url-row').style.display = '';
      }
      GC.setShareSocial(shareResult.share_url, title);
      $('#share-skeletons').classList.add('hidden');
      $('#share-ready').classList.remove('hidden');
      $('#share-social-skeletons').classList.add('hidden');
      $('#share-social-ready').classList.remove('hidden');
      GC.setShareStatus('Link ready — copy and share!', 'success');
    }).catch(function (err) {
      $('#share-skeletons').classList.add('hidden');
      $('#share-social-skeletons').classList.add('hidden');
      GC.setShareStatus('Upload failed: ' + err.message, 'error');
    });
  }

  /** Close the share modal and clean up the blob URL. */
  GC.closeShareModal = function () {
    var modal = $('#share-modal');
    if (!modal) return;
    modal.classList.add('hidden');
    if (modal._blobUrl) {
      URL.revokeObjectURL(modal._blobUrl);
      modal._blobUrl = null;
    }
    modal._blob = null;
  };

  /** Update the small status label inside the share modal. */
  GC.setShareStatus = function (msg, cls) {
    var el = $('#share-status');
    if (!el) return;
    el.textContent = msg;
    el.className = 'share-status' + (cls ? ' ' + cls : '');
  };

  /** Set social-share button hrefs (Reddit, Twitter/X). */
  GC.setShareSocial = function (shareUrl, title) {
    var enc = encodeURIComponent;
    var reddit = $('#btn-share-reddit');
    if (reddit) reddit.href = 'https://www.reddit.com/submit?url=' + enc(shareUrl) + '&title=' + enc(title);
    var twitter = $('#btn-share-twitter');
    if (twitter) twitter.href = 'https://twitter.com/intent/tweet?url=' + enc(shareUrl) + '&text=' + enc(title + ' — made with GifCaption');
  };

  // ── Still-Image Export ───────────────────────

  /**
   * Render the current frame with all captions onto a temp canvas and
   * return it. Shared by exportImage() and saveCurrentFrame().
   */
  function renderFrameToCanvas() {
    var compSize = GC.getCompositeSize();
    var offsetY  = GC.getFrameOffsetY();
    var saveCanvas = document.createElement('canvas');
    saveCanvas.width  = compSize.w;
    saveCanvas.height = compSize.h;
    var saveCtx = saveCanvas.getContext('2d');
    var frame = state.frames[state.currentFrame];

    if (GC.hasAdjustments()) {
      var tmpC = document.createElement('canvas');
      tmpC.width  = state.width;
      tmpC.height = state.height;
      tmpC.getContext('2d').putImageData(frame.imageData, 0, 0);
      saveCtx.filter = GC.buildAdjFilter();
      saveCtx.drawImage(tmpC, 0, offsetY);
      saveCtx.filter = 'none';
    } else {
      saveCtx.putImageData(frame.imageData, 0, offsetY);
    }

    saveCtx.save();
    saveCtx.translate(0, offsetY);
    for (var i = 0; i < state.captions.length; i++) {
      var cap = state.captions[i];
      if (state.currentFrame >= cap.startFrame && state.currentFrame <= cap.endFrame) {
        GC.drawCaption(saveCtx, cap, state.currentFrame);
      }
    }
    saveCtx.restore();
    GC.drawBoxCaption(saveCtx, compSize.w, compSize.h);
    GC.drawWatermark(saveCtx);
    return saveCanvas;
  }

  /**
   * Export the current frame as a still image (used by the image-caption tool).
   * Format and quality come from state.exportFormat / state.exportQuality.
   */
  GC.exportImage = function (opts) {
    if (state.frames.length === 0) return;
    var onBlob  = opts && opts.onBlob;
    var fmt     = state.exportFormat  || 'image/jpeg';
    var quality = state.exportQuality != null ? state.exportQuality : 0.92;
    var ext     = fmt === 'image/jpeg' ? '.jpg' : fmt === 'image/webp' ? '.webp' : '.png';
    var base    = (state.gifFilename || 'image').replace(/\.[^.]+$/, '');
    var id      = Math.random().toString(36).slice(2, 5);
    var canvas  = renderFrameToCanvas();
    canvas.toBlob(function (blob) {
      if (onBlob) {
        onBlob(blob, base + '-captioned-' + id + ext);
      } else {
        GC.downloadBlob(blob, base + '-captioned-' + id + ext);
      }
    }, fmt, quality);
  };

  /**
   * Save the current GIF frame as a JPEG (the "Save Frame" button in the GIF editor).
   */
  GC.saveCurrentFrame = function (opts) {
    if (state.frames.length === 0) return;
    var onBlob = opts && opts.onBlob;
    var id     = Math.random().toString(36).slice(2, 5);
    var base   = (state.gifFilename || 'frame').replace(/\.gif$/i, '');
    var fname  = base + '-frame-' + id + '.jpg';
    var canvas = renderFrameToCanvas();
    canvas.toBlob(function (blob) {
      if (onBlob) { onBlob(blob, fname); } else { GC.downloadBlob(blob, fname); }
    }, 'image/jpeg', 0.92);
  };

  /**
   * Extract a single frame as a base64-encoded PNG string.
   * (Currently unused but useful for thumbnail generation.)
   */
  GC.extractFrameAsBase64 = function (frameIndex) {
    var tmpCanvas = document.createElement('canvas');
    tmpCanvas.width = state.width;
    tmpCanvas.height = state.height;
    var tmpCtx = tmpCanvas.getContext('2d');
    tmpCtx.putImageData(state.frames[frameIndex].imageData, 0, 0);
    return tmpCanvas.toDataURL('image/png').split(',')[1];
  };

})();
