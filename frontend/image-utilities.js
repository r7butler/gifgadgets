/* Bulk still-image tools: resize, compress, convert and contact sheet.
   Unlike the GIF utilities these need no worker — each file is one decode plus
   one encode, and both already run off the main thread inside the browser.
   Work yields between files so the page stays responsive and cancellable. */
(function () {
  'use strict';
  const $ = id => document.getElementById('utility-' + id);
  const tool = document.querySelector('[data-tool]').dataset.tool;
  const SHEET = tool === 'image-contact-sheet';
  const geometry = GWImageGeometry;

  const MAX_FILES = 60, MAX_TOTAL = 100 * 1024 * 1024, MAX_SOURCE_PIXELS = 50e6;
  const FORMATS = {
    jpg: {type: 'image/jpeg', ext: '.jpg', lossy: true, opaque: true, label: 'JPG'},
    png: {type: 'image/png', ext: '.png', lossy: false, opaque: false, label: 'PNG'},
    webp: {type: 'image/webp', ext: '.webp', lossy: true, opaque: false, label: 'WebP'}
  };
  const ACCEPTED = /^image\/(png|jpeg|webp|gif|bmp|avif)$/;
  const ACCEPTED_EXT = /\.(png|jpe?g|webp|gif|bmp|avif)$/i;

  let chosen = [], results = [], outputURL = null, outputBlob = null;
  let generation = 0, running = false, metric = null;
  let thumbURLs = [];

  const kb = bytes => bytes < 1024 * 1024
    ? (bytes / 1024).toFixed(1) + ' KB' : (bytes / 1024 / 1024).toFixed(2) + ' MB';

  function clearResult() {
    if (outputURL) URL.revokeObjectURL(outputURL);
    outputURL = null; outputBlob = null; results = [];
    thumbURLs.forEach(URL.revokeObjectURL); thumbURLs = [];
    $('download').hidden = true; $('download').removeAttribute('href');
    if ($('results')) { $('results').hidden = true; $('results').textContent = ''; }
    if ($('result-wrap')) { $('result-wrap').hidden = true; $('result').removeAttribute('src'); }
  }

  function stop() {
    running = false; metric = null;
    $('cancel').hidden = $('progress').hidden = true;
    $('file').disabled = $('new').disabled = false;
    $('options').disabled = !chosen.length;
  }

  /* createImageBitmap is the fast path and honours EXIF orientation; the <img>
     fallback keeps the tools working where a format or the API is unsupported. */
  async function decode(file) {
    if (typeof createImageBitmap === 'function') {
      try { return await createImageBitmap(file, {imageOrientation: 'from-image'}); }
      catch (_) { /* fall through to the element decoder */ }
    }
    const url = URL.createObjectURL(file);
    try {
      const image = new Image();
      await new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = () => reject(new Error('“' + file.name + '” could not be decoded by this browser.'));
        image.src = url;
      });
      if (image.decode) { try { await image.decode(); } catch (_) { /* already loaded */ } }
      return {width: image.naturalWidth, height: image.naturalHeight, source: image, close() {}};
    } finally { setTimeout(() => URL.revokeObjectURL(url), 0); }
  }

  const drawable = bitmap => bitmap.source || bitmap;

  async function encode(canvas, format, quality) {
    const spec = FORMATS[format];
    const blob = await new Promise(resolve =>
      canvas.toBlob(resolve, spec.type, spec.lossy ? quality / 100 : undefined));
    // Browsers that cannot encode a format silently hand back a PNG, so the
    // type is checked rather than trusted.
    if (!blob) throw new Error('This browser could not encode the image.');
    if (blob.type !== spec.type) throw new Error('This browser cannot save ' + spec.label + '. Choose another output format.');
    return blob;
  }

  /* What the file already is, as one of our own format keys, or null for a
     format we can read but never write back (GIF, BMP, AVIF). */
  function sourceFormat(file) {
    if (/jpeg/.test(file.type) || /\.jpe?g$/i.test(file.name)) return 'jpg';
    if (/webp/.test(file.type) || /\.webp$/i.test(file.name)) return 'webp';
    if (/png/.test(file.type) || /\.png$/i.test(file.name)) return 'png';
    return null;
  }

  function targetFormat(file) {
    const choice = $('format') ? $('format').value : 'png';
    return choice !== 'keep' ? choice : sourceFormat(file) || 'png';
  }

  function baseName(name) { return name.replace(/\.[^.]+$/, '') || 'image'; }

  async function load(list) {
    const ticket = ++generation;
    stop(); chosen = []; clearResult(); $('options').disabled = true;
    $('upload').hidden = false; $('new').hidden = true;
    $('files').hidden = true; $('files').textContent = ''; $('info').textContent = '';
    const picked = list ? Array.from(list) : [];
    if (!picked.length) return;
    GWFunnel.accepted(picked.reduce((n, f) => n + f.size, 0));
    try {
      if (SHEET && picked.length < 2) throw new Error('Choose at least two images for a contact sheet.');
      if (picked.length > MAX_FILES) throw new Error('Choose at most ' + MAX_FILES + ' images at once.');
      if (picked.reduce((n, f) => n + f.size, 0) > MAX_TOTAL) throw new Error('Choose images totaling less than 100 MB.');
      for (const file of picked) {
        if (!ACCEPTED.test(file.type) && !ACCEPTED_EXT.test(file.name))
          throw new Error('“' + file.name + '” is not a PNG, JPG, WebP, GIF, BMP or AVIF image.');
      }
      if (ticket !== generation) return;
      chosen = picked;
      const items = document.createDocumentFragment();
      for (const file of picked) {
        const item = document.createElement('li');
        item.textContent = file.name;
        const size = document.createElement('span');
        size.className = 'utility-file-size'; size.textContent = kb(file.size);
        item.appendChild(size); items.appendChild(item);
      }
      $('files').appendChild(items); $('files').hidden = false;
      $('upload').hidden = true; $('new').hidden = false;
      $('info').textContent = picked.length + (picked.length === 1 ? ' image · ' : ' images · ')
        + kb(picked.reduce((n, f) => n + f.size, 0)) + ' total';
      $('options').disabled = false;
      $('status').textContent = 'Ready. Choose settings, then apply.';
      GWFunnel.ready();
    } catch (error) {
      chosen = []; $('status').textContent = error.message; GWFunnel.failure('decode');
    }
  }

  /* One source image through crop, scale and encode. */
  async function processOne(file, canvas, ctx) {
    const bitmap = await decode(file);
    try {
      if (bitmap.width * bitmap.height > MAX_SOURCE_PIXELS)
        throw new Error('“' + file.name + '” is too large to process in the browser.');
      const plan = geometry.resizePlan(bitmap, readResizeOptions());
      if (!geometry.withinCanvasLimits(plan.width, plan.height))
        throw new Error('The requested size for “' + file.name + '” exceeds the browser canvas limit.');
      const format = targetFormat(file);
      canvas.width = plan.width; canvas.height = plan.height;
      ctx.clearRect(0, 0, plan.width, plan.height);
      if (FORMATS[format].opaque || opaqueBackground()) {
        ctx.fillStyle = backgroundColor(); ctx.fillRect(0, 0, plan.width, plan.height);
      }
      ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(drawable(bitmap), plan.crop.x, plan.crop.y, plan.crop.width, plan.crop.height,
                    0, 0, plan.width, plan.height);
      let blob = await encode(canvas, format, Number($('quality') ? $('quality').value : 90));
      let name = baseName(file.name) + FORMATS[format].ext, kept = false;
      // Re-encoding can grow a file. The compressor promises a smaller result,
      // so when it cannot deliver one it returns the original untouched.
      if (tool === 'bulk-compress-images' && blob.size >= file.size && format === sourceFormat(file)
          && plan.width === bitmap.width && plan.height === bitmap.height) {
        blob = file; name = file.name; kept = true;
      }
      return {name, blob, kept, originalSize: file.size, width: plan.width, height: plan.height,
              sourceWidth: bitmap.width, sourceHeight: bitmap.height};
    } finally { if (bitmap.close) bitmap.close(); }
  }

  function readResizeOptions() {
    if (tool === 'bulk-resize-images') {
      return {mode: $('mode').value, width: Number($('width').value), height: Number($('height').value),
              percent: Number($('percent').value), enlarge: $('enlarge').checked};
    }
    if (tool === 'bulk-compress-images') {
      const cap = Number($('maxwidth').value);
      return cap > 0 ? {mode: 'fit', width: cap, height: geometry.MAX_SIDE, enlarge: false} : {mode: 'percent', percent: 100};
    }
    return {mode: 'percent', percent: 100};
  }

  const opaqueBackground = () => !!$('background') && $('background').value === 'color';
  const backgroundColor = () => ($('color') && opaqueBackground() ? $('color').value : '#ffffff');

  async function runBulk(ticket) {
    const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d');
    const used = new Set(), done = [];
    for (let i = 0; i < chosen.length; i++) {
      if (ticket !== generation) return null;
      $('status').textContent = 'Processing ' + (i + 1) + ' of ' + chosen.length + ' on your device…';
      const result = await processOne(chosen[i], canvas, ctx);
      result.name = GWZip.uniqueName(result.name, used);
      done.push(result);
      $('progress').value = Math.round((i + 1) / chosen.length * 100);
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    return done;
  }

  async function runSheet(ticket) {
    const plan = geometry.contactSheetPlan(chosen.length, {
      columns: Number($('columns').value), cell: Number($('cell').value),
      gap: Number($('gap').value), padding: Number($('padding').value),
      labels: $('labels').checked, labelHeight: 22
    });
    if (!geometry.withinCanvasLimits(plan.width, plan.height))
      throw new Error('That sheet would be ' + plan.width + ' × ' + plan.height + ' px, beyond the browser canvas limit. Use fewer images, a smaller cell size or more columns.');
    const format = $('format').value;
    const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d');
    canvas.width = plan.width; canvas.height = plan.height;
    // A transparent sheet exported as JPG would come out black, so an opaque
    // format always gets the background painted in.
    if ($('background').value === 'transparent' && !FORMATS[format].opaque) {
      ctx.clearRect(0, 0, plan.width, plan.height);
    } else {
      ctx.fillStyle = $('color').value; ctx.fillRect(0, 0, plan.width, plan.height);
    }
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    for (let i = 0; i < chosen.length; i++) {
      if (ticket !== generation) return null;
      $('status').textContent = 'Placing image ' + (i + 1) + ' of ' + chosen.length + '…';
      const bitmap = await decode(chosen[i]);
      try {
        if (bitmap.width * bitmap.height > MAX_SOURCE_PIXELS)
          throw new Error('“' + chosen[i].name + '” is too large to process in the browser.');
        const cell = plan.cells[i], box = geometry.containRect(bitmap, cell);
        ctx.drawImage(drawable(bitmap), box.x, box.y, box.width, box.height);
        if (plan.label) {
          ctx.fillStyle = $('label-color').value;
          ctx.font = '500 13px system-ui, -apple-system, Segoe UI, sans-serif';
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.save(); ctx.beginPath();
          ctx.rect(cell.x, cell.labelY, cell.width, cell.labelHeight); ctx.clip();
          ctx.fillText(chosen[i].name, cell.x + cell.width / 2, cell.labelY + cell.labelHeight / 2, cell.width - 6);
          ctx.restore();
        }
      } finally { if (bitmap.close) bitmap.close(); }
      $('progress').value = Math.round((i + 1) / chosen.length * 100);
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    if (ticket !== generation) return null;
    const blob = await encode(canvas, format, Number($('quality').value));
    return [{name: 'contact-sheet' + FORMATS[format].ext, blob, kept: false,
             originalSize: 0, width: plan.width, height: plan.height}];
  }

  function showResults(done) {
    results = done;
    const total = done.reduce((n, r) => n + r.blob.size, 0);
    const original = done.reduce((n, r) => n + r.originalSize, 0);
    if (SHEET) {
      outputBlob = done[0].blob; outputURL = URL.createObjectURL(outputBlob);
      $('result').src = outputURL; $('result-wrap').hidden = false;
      $('download').href = outputURL; $('download').download = done[0].name;
      $('download').textContent = 'Download sheet';
      $('status').textContent = 'Sheet ready · ' + done[0].width + ' × ' + done[0].height + ' px · ' + kb(total) + '.';
    } else {
      if (done.length === 1) {
        outputBlob = done[0].blob;
        $('download').download = done[0].name; $('download').textContent = 'Download image';
      } else {
        const entries = [];
        for (const result of done) entries.push({name: result.name, bytes: result.bytes});
        outputBlob = GWZip.zip(entries);
        $('download').download = tool.replace('bulk-', '').replace('-images', '') + '-images.zip';
        $('download').textContent = 'Download ZIP';
      }
      outputURL = URL.createObjectURL(outputBlob);
      $('download').href = outputURL;
      const kept = done.filter(r => r.kept).length;
      const change = original ? Math.round((1 - total / original) * 100) : 0;
      $('status').textContent = done.length + (done.length === 1 ? ' image ready · ' : ' images ready · ')
        + kb(original) + ' → ' + kb(total)
        + (change > 0 ? ' (' + change + '% smaller).' : change < 0 ? ' (' + -change + '% larger).' : ' (no change).')
        + (kept ? ' ' + kept + (kept === 1 ? ' file was' : ' files were') + ' already smaller and kept unchanged.' : '');
      const gallery = $('results');
      for (const result of done) {
        const url = URL.createObjectURL(result.blob); thumbURLs.push(url);
        const figure = document.createElement('figure');
        const link = document.createElement('a');
        link.href = url; link.download = result.name;
        const img = document.createElement('img');
        img.src = url; img.alt = result.name; img.loading = 'lazy';
        link.appendChild(img);
        const caption = document.createElement('figcaption');
        caption.textContent = result.width + ' × ' + result.height + ' · ' + kb(result.blob.size)
          + (result.kept ? ' · original kept' : '');
        const name = document.createElement('span');
        name.className = 'utility-thumb-name'; name.textContent = result.name;
        figure.append(link, name, caption); gallery.appendChild(figure);
      }
      gallery.hidden = false;
    }
    $('download').hidden = false;
  }

  $('apply').addEventListener('click', async () => {
    if (!chosen.length || running) return;
    clearResult();
    const ticket = ++generation;
    running = true; metric = GWFunnel.exportStarted();
    $('options').disabled = true; $('file').disabled = $('new').disabled = true;
    $('progress').hidden = $('cancel').hidden = false; $('progress').value = 0;
    $('status').textContent = 'Processing on your device…';
    try {
      const done = SHEET ? await runSheet(ticket) : await runBulk(ticket);
      if (ticket !== generation || !done) return;
      if (!SHEET) {
        // ZIP entries need bytes; read them once results are final.
        for (const result of done) result.bytes = new Uint8Array(await result.blob.arrayBuffer());
        if (ticket !== generation) return;
      }
      showResults(done);
      if (metric) metric.complete();
      stop();
    } catch (error) {
      if (ticket !== generation) return;
      if (metric) metric.fail('processing');
      stop(); clearResult();
      $('status').textContent = error.message;
    }
  });

  $('cancel').addEventListener('click', () => {
    generation++; stop(); clearResult();
    $('status').textContent = 'Cancelled. You can change settings and try again.';
  });

  $('file').addEventListener('change', () => load($('file').files));
  $('upload').addEventListener('click', () => $('file').click());
  $('new').addEventListener('click', () => $('file').click());
  $('upload').addEventListener('dragover', event => { event.preventDefault(); $('upload').classList.add('dragover'); });
  $('upload').addEventListener('dragleave', () => $('upload').classList.remove('dragover'));
  $('upload').addEventListener('drop', event => {
    event.preventDefault(); $('upload').classList.remove('dragover');
    if (!running && event.dataTransfer.files.length) load(event.dataTransfer.files);
  });

  $('options').addEventListener('input', event => {
    clearResult();
    $('status').textContent = 'Settings changed. Apply to produce the new result.';
    syncControls(event.target);
  });

  /* Only show the settings that apply to the current choice, so nothing sits
     enabled while being silently ignored. */
  function syncControls(target) {
    if ($('mode')) {
      const mode = $('mode').value;
      $('width').disabled = !['fit', 'width', 'exact'].includes(mode);
      $('height').disabled = !['fit', 'height', 'exact'].includes(mode);
      $('percent').disabled = mode !== 'percent';
      $('enlarge').disabled = mode !== 'fit';
    }
    // PNG has no quality setting; every other target does.
    if ($('quality') && $('format')) $('quality').disabled = $('format').value === 'png';
    if ($('color')) $('color').disabled = $('background').value !== 'color';
    if ($('label-color')) $('label-color').disabled = !$('labels').checked;
    if (target === $('quality') && $('quality-value')) $('quality-value').textContent = $('quality').value;
  }
  syncControls(null);

  window.addEventListener('pagehide', () => { generation++; stop(); });
})();
