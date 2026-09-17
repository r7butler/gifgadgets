/* Pure layout arithmetic for the bulk image tools. No DOM, no canvas — this is
   the part that is easy to get subtly wrong, so it is isolated and unit tested. */
(function (root) {
  'use strict';
  // Chrome allows larger canvases, but Safari fails well below its documented
  // maximum, so both tools refuse work that would silently produce a blank image.
  const MAX_SIDE = 8000, MAX_AREA = 40e6;

  const clampSide = n => Math.max(1, Math.min(MAX_SIDE, Math.round(n) || 1));

  /* Where to read from the source and how big the output should be.
     Returns {width, height, crop:{x,y,width,height}}. Only 'exact' crops. */
  function resizePlan(source, options) {
    const sw = Math.max(1, source.width), sh = Math.max(1, source.height);
    const mode = options.mode || 'fit';
    let width, height, crop = {x: 0, y: 0, width: sw, height: sh};
    if (mode === 'percent') {
      const scale = Math.max(1, Math.min(400, Number(options.percent) || 100)) / 100;
      width = clampSide(sw * scale); height = clampSide(sh * scale);
    } else if (mode === 'width') {
      width = clampSide(options.width); height = clampSide(sh * (width / sw));
    } else if (mode === 'height') {
      height = clampSide(options.height); width = clampSide(sw * (height / sh));
    } else if (mode === 'exact') {
      width = clampSide(options.width); height = clampSide(options.height);
      // Cover the frame, then take the centre. Scaling up is the only way to
      // fill an exact box from a smaller source, so 'enlarge' does not apply.
      const scale = Math.max(width / sw, height / sh);
      const cw = Math.min(sw, width / scale), ch = Math.min(sh, height / scale);
      crop = {x: Math.round((sw - cw) / 2), y: Math.round((sh - ch) / 2),
              width: Math.max(1, Math.round(cw)), height: Math.max(1, Math.round(ch))};
    } else {
      let scale = Math.min(clampSide(options.width) / sw, clampSide(options.height) / sh);
      if (!options.enlarge) scale = Math.min(scale, 1);
      width = clampSide(sw * scale); height = clampSide(sh * scale);
    }
    return {width, height, crop};
  }

  /* Letterbox a source inside a box without distorting or enlarging it. */
  function containRect(source, box) {
    const scale = Math.min(box.width / Math.max(1, source.width), box.height / Math.max(1, source.height), 1);
    const width = Math.max(1, Math.round(source.width * scale)), height = Math.max(1, Math.round(source.height * scale));
    return {x: box.x + Math.round((box.width - width) / 2), y: box.y + Math.round((box.height - height) / 2), width, height};
  }

  /* Grid for the contact sheet. Cells are square; a label strip, when enabled,
     sits under each cell and is part of the row height. */
  function contactSheetPlan(count, options) {
    const total = Math.max(1, count);
    const columns = Math.max(1, Math.min(total, Math.round(options.columns) || 1));
    const rows = Math.ceil(total / columns);
    const cell = Math.max(32, Math.min(1000, Math.round(options.cell) || 200));
    const gap = Math.max(0, Math.min(200, Math.round(options.gap) || 0));
    const padding = Math.max(0, Math.min(200, Math.round(options.padding) || 0));
    const label = options.labels ? Math.max(12, Math.round(options.labelHeight) || 20) : 0;
    const width = padding * 2 + columns * cell + (columns - 1) * gap;
    const height = padding * 2 + rows * (cell + label) + (rows - 1) * gap;
    const cells = [];
    for (let i = 0; i < total; i++) {
      const column = i % columns, row = Math.floor(i / columns);
      const x = padding + column * (cell + gap), y = padding + row * (cell + label + gap);
      cells.push({x, y, width: cell, height: cell, labelY: y + cell, labelHeight: label});
    }
    return {columns, rows, cell, gap, padding, label, width, height, cells};
  }

  /* A canvas that is too large fails silently on some browsers, so callers
     check first and report a real message instead of exporting a blank image. */
  function withinCanvasLimits(width, height) {
    return width >= 1 && height >= 1 && width <= MAX_SIDE && height <= MAX_SIDE && width * height <= MAX_AREA;
  }

  root.GWImageGeometry = {resizePlan, containRect, contactSheetPlan, withinCanvasLimits, MAX_SIDE, MAX_AREA};
})(typeof self !== 'undefined' ? self : this);
