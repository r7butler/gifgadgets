/* ==========================================================
   GifCaption – Shared State & Constants

   Initialises the global GC (GifCaption) namespace that every
   editor module reads and writes.  Load this script FIRST.

   Architecture (script load order):
     editor-state.js       → State object, constants, DOM helpers
     canvas-rendering.js   → Canvas drawing (captions, box bars, text
                             wrap, selection handles).  Reusable — not
                             GIF-specific, so future tools (still-image
                             macro editor, etc.) can share this code.
     gif-playback.js       → GIF loading & frame extraction (omggif),
                             play / pause / seek scheduling.
     gif-timeline.js       → D3-brush caption timeline (frame-based).
     gif-export.js         → GIF encoding (gif.js), download helper,
                             share-modal flow.
     editor.js             → Entry point: init, event binding, canvas
                             drag/resize, caption CRUD, UI updates.
     app.js                → Backend API helpers (upload, share).
   ========================================================== */

(function () {
  'use strict';

  // ── Global Namespace ─────────────────────────
  // All editor modules attach their public functions to window.GC
  // so they can call each other without tight coupling.
  window.GC = {};

  // ── DOM Shorthand ────────────────────────────
  GC.$ = function (sel) { return document.querySelector(sel); };
  GC.$$ = function (sel) { return document.querySelectorAll(sel); };

  // ── Editor State ─────────────────────────────
  // Single source of truth for the whole editor.  Every module reads
  // and writes this object directly via GC.state.
  GC.state = {
    frames: [],             // Array of { imageData: ImageData, delay: number (ms) }
    width: 0,               // Original GIF pixel width
    height: 0,              // Original GIF pixel height
    captions: [],           // On-image text captions (shape: see GC.addCaption)
    currentFrame: 0,        // Index of the displayed frame
    isPlaying: false,       // Whether playback is running
    speed: 1,               // Playback speed multiplier (0.25 – 3)
    selectedCaptionId: null, // ID of the currently-selected caption (or null)
    dragState: null,        // Active position drag: { captionId, offsetX, offsetY }
    resizeState: null,      // Active resize drag: { captionId, startFontSize, startDist, … }
    cropDrag: null,         // Active crop drag: { edge, startX, startY, origRect }
    gifId: null,            // Backend GIF ID (when loaded via ?id= URL param)
    gifFilename: null,      // Original filename of the uploaded GIF file

    // Box captions — solid-colour bars above/below the GIF.
    // null = not yet added; object = active (see GC.makeBoxCaption).
    boxCaptionTop: null,
    boxCaptionBottom: null,

    // Export options
    hideWatermark: false,   // true = user opted out of the watermark
    compressGif: false,     // true = use higher compression settings
    gifQuality: 10,         // gif.js quality (1 = best, 30 = worst)
    lossyCompress: false,   // true = reduce colour palette for smaller files

    // Crop
    cropActive: false,      // true = crop mode enabled
    cropRect: null,         // { x, y, w, h } in GIF pixel coords (null = no crop)

    // Zoom & pan (canvas CSS transform only — does not affect export)
    zoom: 1,                // current zoom level (1 = fit, max 8)
    panX: 0,                // canvas translate X in screen pixels
    panY: 0,                // canvas translate Y in screen pixels
    panDrag: null,          // active pan drag: { startClientX, startClientY, startPanX, startPanY }

    // Photo adjustments (non-destructive — applied at render + export time)
    adjustments: {
      brightness: 0,        // -100 … +100
      contrast: 0,          // -100 … +100
      saturation: 0,        // -100 … +100
      hue: 0,               // 0 … 360
      filter: 'none',       // 'none' | 'grayscale' | 'sepia' | 'invert' | 'blur' | 'warm'
    },

    // Still-image mode (image caption tool) — single frame, exports to image not GIF
    isStillImage: false,
    exportFormat: 'image/jpeg',   // output format for image export
    exportQuality: 0.92,          // 0–1 quality for JPEG/WebP
  };

  // ── Mutable Shared References ────────────────
  // Set once during init(), then used across every module.
  GC.canvas = null;           // the <canvas> element
  GC.ctx = null;              // its CanvasRenderingContext2D
  GC.nextCaptionId = 1;       // auto-incrementing caption ID counter
  GC.playbackTimer = null;    // setTimeout handle for frame scheduling
  GC.timelineState = null;    // { xScale, playhead } – set by buildTimeline()
  GC.exportInProgress = false; // guard to prevent concurrent exports

  // ── Constants ────────────────────────────────

  /** Colours cycled through for timeline tracks and caption-list dots. */
  GC.TRACK_COLORS = [
    '#6366f1', '#22d3ee', '#f59e0b', '#10b981',
    '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6',
  ];

  /** Corner-handle hit radius — larger on touch devices for easier grabbing. */
  GC.HANDLE_SIZE = ('ontouchstart' in window || navigator.maxTouchPoints > 0) ? 14 : 8;

  // ── Factories ────────────────────────────────

  /** Create default config for a new top or bottom box-caption bar. */
  GC.makeBoxCaption = function () {
    return {
      text: '',
      height: 80,          // bar height in px (excluding border)
      fontSize: 36,
      fontFamily: 'Impact',
      align: 'center',     // 'left' | 'center' | 'right'
      textColor: '#000000',
      bgColor: '#ffffff',
      borderWidth: 0,       // black border thickness around the bar
      fontWeight: 700,      // CSS font-weight (100–900)
    };
  };

  // ── Adjustment Helpers ───────────────────────

  /** Build a CSS filter string from current adjustment state. */
  GC.buildAdjFilter = function () {
    var a = GC.state.adjustments;
    var b = a.brightness || 0;
    var c = a.contrast   || 0;
    var s = a.saturation || 0;
    var h = a.hue        || 0;
    var parts = [
      'brightness(' + (1 + b / 100) + ')',
      'contrast('   + (1 + c / 100) + ')',
      'saturate('   + (1 + s / 100) + ')',
      'hue-rotate(' + h + 'deg)',
    ];
    var f = a.filter || 'none';
    if (f === 'grayscale') parts.push('grayscale(1)');
    else if (f === 'sepia')     parts.push('sepia(0.8)');
    else if (f === 'invert')    parts.push('invert(1)');
    else if (f === 'blur')      parts.push('blur(2px)');
    else if (f === 'warm')      parts.push('sepia(0.3) saturate(1.4) hue-rotate(-10deg)');
    return parts.join(' ');
  };

  /** Return true when any adjustment is non-neutral. */
  GC.hasAdjustments = function () {
    var a = GC.state.adjustments;
    return a.brightness !== 0 || a.contrast !== 0 || a.saturation !== 0 ||
           a.hue !== 0 || (a.filter && a.filter !== 'none');
  };

  // ── Tiny Helpers ─────────────────────────────

  /** HTML-escape a string (safe for injecting into innerHTML). */
  GC.escapeHtml = function (s) {
    var d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  };

})();
