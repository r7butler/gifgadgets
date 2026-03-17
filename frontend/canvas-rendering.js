/* ==========================================================
   GifCaption – Canvas Rendering

   All canvas drawing helpers: text captions, box-caption bars,
   selection handles, watermark, and text wrapping.

   These functions are NOT GIF-specific — they work on any
   canvas context, so future tools (still-image macro editor,
   etc.) can reuse them directly.

   Depends on: editor-state.js (GC namespace, state, constants)
   ========================================================== */

(function () {
  'use strict';

  var state = GC.state;

  // ── Box Caption Geometry ─────────────────────

  /** Total pixel height of a box-caption bar (bar + both borders), or 0. */
  GC.boxTotalH = function (bc) {
    if (!bc) return 0;
    return bc.height + bc.borderWidth * 2;
  };

  /** Full canvas size once box-caption bars are factored in. */
  GC.getCompositeSize = function () {
    return {
      w: state.width,
      h: state.height + GC.boxTotalH(state.boxCaptionTop) + GC.boxTotalH(state.boxCaptionBottom),
    };
  };

  /** Y-offset where the source image/frame should be drawn (below the top bar). */
  GC.getFrameOffsetY = function () {
    return GC.boxTotalH(state.boxCaptionTop);
  };

  // ── Box Caption Drawing ──────────────────────

  /**
   * Draw a single box-caption bar at a given Y position.
   * Renders the background fill, optional border, and wrapped text.
   */
  function _drawOneBox(context, bc, boxY, compW) {
    var boxH = bc.height + bc.borderWidth * 2;

    context.save();

    // Background fill
    context.fillStyle = bc.bgColor;
    context.fillRect(0, boxY, compW, boxH);

    // Black border stroke
    if (bc.borderWidth > 0) {
      context.strokeStyle = '#000000';
      context.lineWidth = bc.borderWidth;
      var half = bc.borderWidth / 2;
      context.strokeRect(half, boxY + half, compW - bc.borderWidth, boxH - bc.borderWidth);
    }

    // Wrapped text centred vertically in the bar
    var textAreaW = compW * 0.92;
    var padX = (compW - textAreaW) / 2;
    var weight = bc.fontWeight || 700;
    context.font = weight + ' ' + bc.fontSize + 'px ' + bc.fontFamily;
    context.textAlign = bc.align;
    context.textBaseline = 'middle';
    context.fillStyle = bc.textColor;

    var lines = GC.wrapText(context, bc.text || '', textAreaW);
    var lh = bc.fontSize * 1.25;
    var totalTextH = lines.length * lh;
    var startY = boxY + bc.borderWidth + (bc.height - totalTextH) / 2 + lh / 2;
    var textX = bc.align === 'left' ? padX : bc.align === 'right' ? compW - padX : compW / 2;

    for (var i = 0; i < lines.length; i++) {
      context.fillText(lines[i], textX, startY + i * lh);
    }
    context.restore();
  }

  /** Draw both active box caption bars (top and/or bottom) onto a context. */
  GC.drawBoxCaption = function (context, compW, compH) {
    if (state.boxCaptionTop) {
      _drawOneBox(context, state.boxCaptionTop, 0, compW);
    }
    if (state.boxCaptionBottom) {
      var bottomY = compH - GC.boxTotalH(state.boxCaptionBottom);
      _drawOneBox(context, state.boxCaptionBottom, bottomY, compW);
    }
  };

  // ── Canvas Sync ──────────────────────────────

  /** Resize the preview <canvas> element when composite dimensions change. */
  GC.syncCanvasSize = function () {
    var size = GC.getCompositeSize();
    if (GC.canvas.width !== size.w || GC.canvas.height !== size.h) {
      GC.canvas.width = size.w;
      GC.canvas.height = size.h;
    }
  };

  // ── Frame + Caption Compositing ──────────────

  /**
   * Draw a frame's ImageData to ctx at (x, y), applying photo adjustments.
   * ctx.putImageData ignores the canvas filter, so we route through a temp
   * canvas + ctx.drawImage when any adjustment is active.
   */
  function drawFrameAdjusted(ctx, frame, x, y) {
    if (GC.hasAdjustments()) {
      var s = state;
      // Reuse a cached temp canvas when possible (invalidate on dimension change)
      if (!s._adjTmpCanvas || s._adjTmpCanvas.width !== s.width || s._adjTmpCanvas.height !== s.height) {
        s._adjTmpCanvas = document.createElement('canvas');
        s._adjTmpCanvas.width  = s.width;
        s._adjTmpCanvas.height = s.height;
      }
      s._adjTmpCanvas.getContext('2d').putImageData(frame.imageData, 0, 0);
      ctx.filter = GC.buildAdjFilter();
      ctx.drawImage(s._adjTmpCanvas, x, y);
      ctx.filter = 'none';
    } else {
      ctx.putImageData(frame.imageData, x, y);
    }
  }

  /**
   * Render the current frame onto the preview canvas.
   * Composites: GIF frame → overlay captions → box bars → selection box.
   */
  GC.renderCurrentFrame = function () {
    if (state.frames.length === 0) return;

    GC.syncCanvasSize();
    var size = GC.getCompositeSize();
    var offsetY = GC.getFrameOffsetY();
    var ctx = GC.ctx;

    // Clear and draw the raw frame at the correct vertical offset
    ctx.clearRect(0, 0, size.w, size.h);
    drawFrameAdjusted(ctx, state.frames[state.currentFrame], 0, offsetY);

    // Overlay on-image captions and image overlays (coordinates are relative to the GIF area)
    ctx.save();
    ctx.translate(0, offsetY);

    // Image overlays (drawn behind text captions)
    for (var oi = 0; oi < state.overlays.length; oi++) {
      var ov = state.overlays[oi];
      if (state.currentFrame >= ov.startFrame && state.currentFrame <= ov.endFrame) {
        GC.drawOverlay(ctx, ov, state.currentFrame);
      }
    }

    for (var i = 0; i < state.captions.length; i++) {
      var cap = state.captions[i];
      if (state.currentFrame >= cap.startFrame && state.currentFrame <= cap.endFrame) {
        GC.drawCaption(ctx, cap, state.currentFrame);
      }
    }
    ctx.restore();

    // Box-caption bars on top of everything
    GC.drawBoxCaption(ctx, size.w, size.h);

    // Selection highlight (hidden when sidebar is collapsed on mobile)
    var sidebarEl = GC.$('#editor-sidebar');
    var sidebarCollapsed = sidebarEl && sidebarEl.classList.contains('mobile-collapsed');
    if (state.selectedCaptionId && !sidebarCollapsed) {
      var sel = GC.findCaption(state.selectedCaptionId);
      if (sel && state.currentFrame >= sel.startFrame && state.currentFrame <= sel.endFrame) {
        ctx.save();
        ctx.translate(0, offsetY);
        GC.drawSelectionBox(ctx, sel, state.currentFrame);
        ctx.restore();
      }
    }
    if (state.selectedOverlayId && !sidebarCollapsed) {
      var selOv = GC.findOverlay(state.selectedOverlayId);
      if (selOv && state.currentFrame >= selOv.startFrame && state.currentFrame <= selOv.endFrame) {
        ctx.save();
        ctx.translate(0, offsetY);
        GC.drawOverlaySelectionBox(ctx, selOv, state.currentFrame);
        ctx.restore();
      }
    }

    // Crop overlay (preview only — not baked into export)
    GC.drawCropOverlay();
  };

  // ── Motion Keyframe Interpolation ────────────

  /**
   * Interpolate caption position across motion keyframes.
   * Returns { x, y } (normalised 0–1) for the given frame, or null
   * if the motion array is empty.
   */
  GC.getInterpolatedPosition = function (motion, frame) {
    if (!motion || motion.length === 0) return null;
    if (motion.length === 1) return { x: motion[0].x, y: motion[0].y };
    var sorted = motion.slice().sort(function (a, b) { return a.frame - b.frame; });
    if (frame <= sorted[0].frame) return { x: sorted[0].x, y: sorted[0].y };
    var last = sorted[sorted.length - 1];
    if (frame >= last.frame) return { x: last.x, y: last.y };
    for (var i = 0; i < sorted.length - 1; i++) {
      if (frame >= sorted[i].frame && frame < sorted[i + 1].frame) {
        var t = (frame - sorted[i].frame) / (sorted[i + 1].frame - sorted[i].frame);
        return {
          x: sorted[i].x + t * (sorted[i + 1].x - sorted[i].x),
          y: sorted[i].y + t * (sorted[i + 1].y - sorted[i].y),
        };
      }
    }
    return { x: last.x, y: last.y };
  };

  // ── On-Image Caption Drawing ─────────────────

  /**
   * Draw a single on-image text caption (stroke outline + fill).
   * Pass frameIndex to use interpolated motion position; omit for static.
   */
  GC.drawCaption = function (context, cap, frameIndex) {
    var motion = cap.motion || [];
    var px = cap.x, py = cap.y;
    if (motion.length > 0 && frameIndex != null) {
      var interp = GC.getInterpolatedPosition(motion, frameIndex);
      if (interp) { px = interp.x; py = interp.y; }
    }
    var x = px * state.width;
    var y = py * state.height;
    context.save();
    context.font = (cap.fontWeight || 700) + ' ' + cap.fontSize + 'px ' + cap.fontFamily;
    context.textAlign = cap.align;
    context.textBaseline = 'top';

    var lines = GC.wrapText(context, cap.text, state.width * 0.92);
    var lh = cap.fontSize * 1.2;

    for (var i = 0; i < lines.length; i++) {
      var ly = y + i * lh;
      if (cap.strokeWidth > 0) {
        context.strokeStyle = cap.strokeColor;
        context.lineWidth = cap.strokeWidth * 2;
        context.lineJoin = 'round';
        context.miterLimit = 2;
        context.strokeText(lines[i], x, ly);
      }
      context.fillStyle = cap.color;
      context.fillText(lines[i], x, ly);
    }
    context.restore();
  };

  // ── Selection Box & Hit-Testing ──────────────

  /** Return the four corner positions of a caption's selection box. */
  GC.getSelectionCorners = function (bbox) {
    var pad = 5;
    var hs = GC.HANDLE_SIZE;
    return [
      { x: bbox.x - pad - hs / 2, y: bbox.y - pad - hs / 2 },
      { x: bbox.x + bbox.w + pad - hs / 2, y: bbox.y - pad - hs / 2 },
      { x: bbox.x - pad - hs / 2, y: bbox.y + bbox.h + pad - hs / 2 },
      { x: bbox.x + bbox.w + pad - hs / 2, y: bbox.y + bbox.h + pad - hs / 2 },
    ];
  };

  /** Draw the dashed selection rectangle + circular corner handles. */
  GC.drawSelectionBox = function (context, cap, frameIndex) {
    var bbox = GC.getCaptionBBox(context, cap, frameIndex);
    if (!bbox) return;

    context.save();
    context.strokeStyle = '#22d3ee';
    context.lineWidth = 2;
    context.setLineDash([6, 3]);
    context.strokeRect(bbox.x - 5, bbox.y - 5, bbox.w + 10, bbox.h + 10);

    // Circular corner handles
    context.fillStyle = '#22d3ee';
    context.setLineDash([]);
    var hs = GC.HANDLE_SIZE;
    var corners = GC.getSelectionCorners(bbox);
    corners.forEach(function (p) {
      context.beginPath();
      context.arc(p.x + hs / 2, p.y + hs / 2, hs / 2, 0, Math.PI * 2);
      context.fill();
    });
    context.restore();
  };

  /**
   * Calculate the bounding box of a caption's rendered text.
   * Returns { x, y, w, h } in canvas-pixel coordinates (GIF-area-relative).
   * Pass frameIndex to account for motion position.
   */
  GC.getCaptionBBox = function (context, cap, frameIndex) {
    var motion = cap.motion || [];
    var px = cap.x, py = cap.y;
    if (motion.length > 0 && frameIndex != null) {
      var interp = GC.getInterpolatedPosition(motion, frameIndex);
      if (interp) { px = interp.x; py = interp.y; }
    }
    var x = px * state.width;
    var y = py * state.height;
    context.save();
    context.font = (cap.fontWeight || 700) + ' ' + cap.fontSize + 'px ' + cap.fontFamily;
    context.textAlign = cap.align;

    var lines = GC.wrapText(context, cap.text, state.width * 0.92);
    var lh = cap.fontSize * 1.2;
    var maxW = 0;
    for (var j = 0; j < lines.length; j++) {
      maxW = Math.max(maxW, context.measureText(lines[j]).width);
    }
    context.restore();

    var totalH = lines.length * lh;
    var bx = cap.align === 'left' ? x : cap.align === 'right' ? x - maxW : x - maxW / 2;
    return { x: bx, y: y, w: maxW, h: totalH };
  };

  // ── Text Wrapping ────────────────────────────

  /**
   * Word-wrap a string to fit within maxWidth pixels.
   * Returns an array of line strings.
   */
  GC.wrapText = function (context, text, maxWidth) {
    if (!text) return [''];
    var words = text.split(' ');
    var lines = [];
    var line = '';
    for (var i = 0; i < words.length; i++) {
      var test = line ? line + ' ' + words[i] : words[i];
      if (context.measureText(test).width > maxWidth && line) {
        lines.push(line);
        line = words[i];
      } else {
        line = test;
      }
    }
    if (line) lines.push(line);
    return lines.length ? lines : [''];
  };

  // ── Image Overlays ──────────────────────────

  /** Draw a single image overlay on the canvas. */
  GC.drawOverlay = function (context, ov, frameIndex) {
    var motion = ov.motion || [];
    var px = ov.x, py = ov.y;
    if (motion.length > 0 && frameIndex != null) {
      var interp = GC.getInterpolatedPosition(motion, frameIndex);
      if (interp) { px = interp.x; py = interp.y; }
    }
    var x = px * state.width;
    var y = py * state.height;
    var w = ov.img.naturalWidth * ov.scale;
    var h = ov.img.naturalHeight * ov.scale;
    context.save();
    context.globalAlpha = ov.opacity != null ? ov.opacity : 1;
    context.drawImage(ov.img, x, y, w, h);
    context.restore();
  };

  /** Get the bounding box of an overlay in GIF-area pixel coords. */
  GC.getOverlayBBox = function (ov, frameIndex) {
    var motion = ov.motion || [];
    var px = ov.x, py = ov.y;
    if (motion.length > 0 && frameIndex != null) {
      var interp = GC.getInterpolatedPosition(motion, frameIndex);
      if (interp) { px = interp.x; py = interp.y; }
    }
    return {
      x: px * state.width,
      y: py * state.height,
      w: ov.img.naturalWidth * ov.scale,
      h: ov.img.naturalHeight * ov.scale
    };
  };

  /** Draw selection box around an overlay. */
  GC.drawOverlaySelectionBox = function (context, ov, frameIndex) {
    var bbox = GC.getOverlayBBox(ov, frameIndex);
    if (!bbox) return;
    context.save();
    context.strokeStyle = '#f59e0b';
    context.lineWidth = 2;
    context.setLineDash([6, 3]);
    context.strokeRect(bbox.x - 3, bbox.y - 3, bbox.w + 6, bbox.h + 6);
    context.fillStyle = '#f59e0b';
    context.setLineDash([]);
    var hs = GC.HANDLE_SIZE;
    var corners = [
      { x: bbox.x - 3 - hs / 2, y: bbox.y - 3 - hs / 2 },
      { x: bbox.x + bbox.w + 3 - hs / 2, y: bbox.y - 3 - hs / 2 },
      { x: bbox.x - 3 - hs / 2, y: bbox.y + bbox.h + 3 - hs / 2 },
      { x: bbox.x + bbox.w + 3 - hs / 2, y: bbox.y + bbox.h + 3 - hs / 2 },
    ];
    corners.forEach(function (p) {
      context.beginPath();
      context.arc(p.x + hs / 2, p.y + hs / 2, hs / 2, 0, Math.PI * 2);
      context.fill();
    });
    context.restore();
  };

  /** Find overlay by ID. */
  GC.findOverlay = function (id) {
    for (var i = 0; i < state.overlays.length; i++) {
      if (state.overlays[i].id === id) return state.overlays[i];
    }
    return null;
  };

  // ── Watermark ────────────────────────────────

  /** Draw a small semi-transparent "GifCaption" label in the bottom-right. */
  GC.drawWatermark = function (ctx2d) {
    if (GC.state.hideWatermark) return;
    var compSize = GC.getCompositeSize();
    var fontSize = Math.max(10, Math.round(state.width * 0.028));
    ctx2d.save();
    ctx2d.font = fontSize + 'px sans-serif';
    ctx2d.textAlign = 'right';
    ctx2d.textBaseline = 'bottom';
    ctx2d.globalAlpha = 0.35;
    ctx2d.fillStyle = '#ffffff';
    ctx2d.strokeStyle = '#000000';
    ctx2d.lineWidth = Math.max(1, fontSize * 0.15);
    var text = 'GifWidgets.com';
    var x = compSize.w - 6;
    var y = compSize.h - 4;
    ctx2d.strokeText(text, x, y);
    ctx2d.fillText(text, x, y);
    ctx2d.restore();
  };

  // ── Crop Overlay ─────────────────────────────

  /** Draw a semi-transparent overlay with a clear crop window on the preview canvas. */
  GC.drawCropOverlay = function () {
    if (!state.cropActive || !state.cropRect) return;
    var ctx = GC.ctx;
    var compSize = GC.getCompositeSize();
    var offsetY = GC.getFrameOffsetY();
    var r = state.cropRect;

    ctx.save();
    // Darken entire canvas
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(0, 0, compSize.w, compSize.h);
    // Clear the crop region
    ctx.clearRect(r.x, r.y + offsetY, r.w, r.h);
    // Re-draw crop region content
    if (state.frames.length > 0) {
      var frame = state.frames[state.currentFrame];
      ctx.putImageData(frame.imageData, 0, offsetY,
        r.x, r.y, r.w, r.h);
      // Re-draw captions in crop area
      ctx.save();
      ctx.beginPath();
      ctx.rect(r.x, r.y + offsetY, r.w, r.h);
      ctx.clip();
      ctx.translate(0, offsetY);
      for (var i = 0; i < state.captions.length; i++) {
        var cap = state.captions[i];
        if (state.currentFrame >= cap.startFrame && state.currentFrame <= cap.endFrame) {
          GC.drawCaption(ctx, cap, state.currentFrame);
        }
      }
      ctx.restore();
      GC.drawBoxCaption(ctx, compSize.w, compSize.h);
    }
    // Draw crop border
    ctx.strokeStyle = '#6366f1';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(r.x, r.y + offsetY, r.w, r.h);
    ctx.restore();
  };

})();
