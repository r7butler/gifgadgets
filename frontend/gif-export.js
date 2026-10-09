/* ==========================================================
   GifCaption – GIF Export & Share

   Composes the captioned frames and encodes them with
   gif-encode.js, provides a file download helper, and
   drives the share-modal flow (upload to backend → display
   share URL + social links).

   This module is GIF-specific.  A future still-image tool
   would export a single PNG/JPEG frame instead.

   Depends on:
     editor-state.js      (GC namespace, state)
     canvas-rendering.js  (GC.drawLayers, GC.drawBoxCaption,
                           GC.drawWatermark, GC.getCompositeSize,
                           GC.getFrameOffsetY)
     caption-fonts.js     (GC.loadCaptionFonts)
     gif-encode.js        (GWGif.encode — encodes in gif-encode-worker.js)
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
    // A caption font still downloading would be baked in as its fallback.
    var fonts = GC.loadCaptionFonts();
    if (fonts) { fonts.then(function () { GC.exportGif(opts); }); return; }
    opts = opts || {};
    var exportMetric = GWFunnel.exportStarted();
    GC.exportInProgress = true;
    GC.showExportProgress(0);

    var compSize = GC.getCompositeSize();
    var offsetY = GC.getFrameOffsetY();

    // Determine crop region (if active)
    var crop = state.cropActive && state.cropRect ? state.cropRect : null;
    var outW = crop ? crop.w : compSize.w;
    var outH = crop ? crop.h : compSize.h;

    if (outW <= 0 || outH <= 0) {
      exportMetric.fail('validation');
      GC.showError('Crop region is too small.');
      GC.exportInProgress = false;
      return;
    }

    // Off-screen canvas used to composite each frame for the encoder
    var expCanvas = document.createElement('canvas');
    expCanvas.width = compSize.w;
    expCanvas.height = compSize.h;
    var expCtx = expCanvas.getContext('2d');

    // Separate canvas for cropped output (if cropping)
    var cropCanvas, cropCtx;
    if (crop) {
      cropCanvas = document.createElement('canvas');
      cropCanvas.width = outW;
      cropCanvas.height = outH;
      cropCtx = cropCanvas.getContext('2d');
    }

    // Compression Level runs from 1 (higher quality) to 30 (smaller file): the
    // most colours a frame keeps, 256 down to 32, and with Lossy, how far a
    // colour may drift between frames before it is redrawn, 4 to 16 of 255.
    var colors = 256, tolerance = 0;
    if (state.compressGif) {
      var level = Math.max(1, Math.min(30, state.gifQuality || 10));
      colors = Math.round(256 / Math.pow(2, (level - 1) * 3 / 29));
      if (state.lossyCompress) tolerance = Math.round(4 + (level - 1) * 12 / 29);
    }

    // Composite one frame: base layer → overlay captions → box bars → watermark
    function compose(i) {
      expCtx.clearRect(0, 0, compSize.w, compSize.h);
      GC.drawBaseFrame(expCtx, i, 0, offsetY);

      expCtx.save();
      expCtx.translate(0, offsetY);
      GC.drawLayers(expCtx, i);
      expCtx.restore();

      GC.drawBoxCaption(expCtx, compSize.w, compSize.h);
      GC.drawWatermark(expCtx);
      if (!crop) return expCtx.getImageData(0, 0, outW, outH);

      // Adjust crop Y to account for box caption offset
      cropCtx.clearRect(0, 0, outW, outH);
      cropCtx.drawImage(expCanvas, crop.x, crop.y + offsetY, crop.w, crop.h, 0, 0, outW, outH);
      return cropCtx.getImageData(0, 0, outW, outH);
    }

    function done() { GC.exportInProgress = false; GC.hideExportProgress(); }
    GWGif.encode({
      width: outW, height: outH, count: state.frames.length, frame: compose,
      delay: function (i) { return Math.round(state.frames[i].delay / 10); },
      colors: colors, tolerance: tolerance, onProgress: GC.showExportProgress,
    }).then(function (blob) {
      done();
      exportMetric.complete();
      var fname = GC.makeCaptionedFilename();
      if (opts.onBlob) {
        opts.onBlob(blob, fname);
      } else {
        GC.downloadBlob(blob, fname);
      }
    }, function (error) {
      done();
      exportMetric.fail(error.category || 'encode');
      GC.showError(error.message);
    });
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
    setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
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
    var saveName = modal._filename || GC.makeCaptionedFilename();
    GWSave.offer($('#btn-share-save-photos'), GWSave.file(blob, saveName, blob.type || 'image/gif'),
      function () { GC.downloadBlob(blob, saveName); });

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
    GC.drawBaseFrame(saveCtx, state.currentFrame, 0, offsetY);

    saveCtx.save();
    saveCtx.translate(0, offsetY);
    GC.drawLayers(saveCtx, state.currentFrame);
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
    // A caption font still downloading would be baked in as its fallback.
    var fonts = GC.loadCaptionFonts();
    if (fonts) { fonts.then(function () { GC.exportImage(opts); }); return; }
    var exportMetric = GWFunnel.exportStarted();
    var onBlob  = opts && opts.onBlob;
    var fmt     = state.exportFormat  || 'image/jpeg';
    // JPEG has no transparency to keep a removed background in.
    if (fmt === 'image/jpeg' && GC.cutoutLeavesTransparency && GC.cutoutLeavesTransparency()) fmt = 'image/png';
    var quality = state.exportQuality != null ? state.exportQuality : 0.92;
    var ext     = fmt === 'image/jpeg' ? '.jpg' : fmt === 'image/webp' ? '.webp' : '.png';
    var base    = (state.gifFilename || 'image').replace(/\.[^.]+$/, '');
    var id      = Math.random().toString(36).slice(2, 5);
    var canvas  = renderFrameToCanvas();
    canvas.toBlob(function (blob) {
      if (!blob || blob.type !== fmt) {
        exportMetric.fail('unsupported_output');
        GC.showError('Your browser could not produce the requested format.');
        return;
      }
      exportMetric.complete();
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
    // A caption font still downloading would be baked in as its fallback.
    var fonts = GC.loadCaptionFonts();
    if (fonts) { fonts.then(function () { GC.saveCurrentFrame(opts); }); return; }
    var onBlob = opts && opts.onBlob;
    var id     = Math.random().toString(36).slice(2, 5);
    var base   = (state.gifFilename || 'frame').replace(/\.gif$/i, '');
    // JPEG has no transparency to keep a removed background in.
    var png    = GC.cutoutLeavesTransparency && GC.cutoutLeavesTransparency();
    var fname  = base + '-frame-' + id + (png ? '.png' : '.jpg');
    var canvas = renderFrameToCanvas();
    canvas.toBlob(function (blob) {
      if (onBlob) { onBlob(blob, fname); } else { GC.downloadBlob(blob, fname); }
    }, png ? 'image/png' : 'image/jpeg', 0.92);
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
