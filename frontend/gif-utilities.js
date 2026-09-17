(function () {
  'use strict';
  const $ = id => document.getElementById('utility-' + id);
  const tool = document.querySelector('[data-tool]').dataset.tool;
  // combine-gifs takes several inputs; extract-frames returns PNGs rather than a GIF.
  const MULTI = tool === 'combine-gifs', FRAMES = tool === 'extract-frames';
  let source, extras = [], worker, timer, metric, inputURL, outputURL, outputBlob, generation = 0;
  let outputName = tool + '.gif';
  let frameURLs = [];
  function clearResult() {
    if (outputURL) URL.revokeObjectURL(outputURL);
    outputURL = null; outputBlob = null;
    $('download').hidden = $('replay').hidden = $('result-wrap').hidden = $('continue-wrap').hidden = true;
    $('result').removeAttribute('src'); $('download').removeAttribute('href');
    frameURLs.forEach(URL.revokeObjectURL); frameURLs = [];
    if ($('frames')) { $('frames').hidden = true; $('frames').textContent = ''; }
  }
  function stop() {
    if (worker) worker.terminate();
    worker = null; clearTimeout(timer); metric = null;
    $('cancel').hidden = $('progress').hidden = true;
    $('file').disabled = $('new').disabled = false; $('options').disabled = !source;
  }
  async function load(input) {
    const list = input ? (input.length !== undefined ? Array.from(input) : [input]) : [];
    const file = list[0];
    const ticket = ++generation;
    stop(); source = null; extras = []; clearResult(); $('options').disabled = true;
    $('upload').hidden = false; $('new').hidden = true;
    if (inputURL) URL.revokeObjectURL(inputURL);
    $('original-wrap').hidden = true; $('original').removeAttribute('src'); $('info').textContent = '';
    if ($('files')) { $('files').hidden = true; $('files').textContent = ''; }
    if (!file) return;
    GWFunnel.accepted(list.reduce((n, f) => n + f.size, 0));
    try {
      if (MULTI && list.length < 2) throw new Error('Choose at least two GIFs to combine.');
      if (MULTI && list.length > 20) throw new Error('Combine at most 20 GIFs at once.');
      if (list.reduce((n, f) => n + f.size, 0) > 40 * 1024 * 1024) throw new Error('Choose files totaling less than 40 MB.');
      const data = await file.arrayBuffer(); if (ticket !== generation) return;
      if (!/^GIF8[79]a$/.test(String.fromCharCode(...new Uint8Array(data, 0, Math.min(6, data.byteLength))))) throw new Error('Choose a valid GIF file.');
      const reader = new GifReader(new Uint8Array(data));
      if (!reader.numFrames()) throw new Error('This GIF has no frames.');
      if (reader.width * reader.height * 4 * (reader.numFrames() + 3) > 96 * 1024 * 1024) throw new Error('This GIF exceeds the decoded memory limit. Resize or shorten it first.');
      for (const other of list.slice(1)) {
        const buffer = await other.arrayBuffer(); if (ticket !== generation) return;
        if (!/^GIF8[79]a$/.test(String.fromCharCode(...new Uint8Array(buffer, 0, Math.min(6, buffer.byteLength)))))
          throw new Error('“' + other.name + '” is not a valid GIF file.');
        extras.push(buffer);
      }
      if ($('files') && list.length > 1) {
        // Playback order is the order chosen, so show it rather than leaving it implicit.
        $('files').textContent = '';
        list.forEach(f => { const li = document.createElement('li'); li.textContent = f.name; $('files').appendChild(li); });
        $('files').hidden = false;
      }
      source = data; inputURL = URL.createObjectURL(file); $('original').src = inputURL; $('original-wrap').hidden = false;
      $('upload').hidden = true; $('new').hidden = false;
      $('info').textContent = reader.width + ' × ' + reader.height + ' · ' + reader.numFrames() + ' frames'
        + (extras.length ? ' · ' + (extras.length + 1) + ' GIFs selected' : '');
      if ($('selection')) $('selection').placeholder = '1-' + reader.numFrames();
      if ($('width') && !MULTI && $('preset') && $('preset').value === 'custom') {
        $('width').value = reader.width; $('height').value = reader.height;
      }
      if ($('end')) { $('end').value = reader.numFrames(); $('end').max = $('start').max = reader.numFrames(); $('start').value = 1; }
      $('options').disabled = false; $('status').textContent = 'Ready. Choose settings, then apply.'; GWFunnel.ready();
    } catch (error) { $('status').textContent = error.message; GWFunnel.failure('decode'); }
  }
  $('file').addEventListener('change', () => load(MULTI ? $('file').files : $('file').files[0]));
  $('upload').addEventListener('click', () => $('file').click());
  $('new').addEventListener('click', () => $('file').click());
  $('upload').addEventListener('dragover', event => { event.preventDefault(); $('upload').classList.add('dragover'); });
  $('upload').addEventListener('dragleave', () => $('upload').classList.remove('dragover'));
  $('upload').addEventListener('drop', event => {
    event.preventDefault(); $('upload').classList.remove('dragover');
    if (!worker && event.dataTransfer.files.length) load(MULTI ? event.dataTransfer.files : event.dataTransfer.files[0]);
  });
  $('options').addEventListener('input', event => {
    clearResult(); $('status').textContent = 'Settings changed. Apply to preview the new result.';
    if ($('loop-mode')) $('repeats').disabled = $('loop-mode').value !== 'finite';
    if ($('color')) $('color').disabled = $('background').value !== 'color';
    if ($('colors')) $('colors').disabled = $('compression').value !== 'colors';
    if ($('selection')) $('selection').disabled = !!$('extract') && $('extract').value === 'all';
    // A preset picks the aspect ratio; keep the longer side and derive the other.
    if ($('preset') && event.target === $('preset') && $('preset').value !== 'custom') {
      const [w, h] = $('preset').value.split(':').map(Number);
      const base = Math.max(Number($('width').value) || 480, Number($('height').value) || 480);
      $('width').value = w >= h ? base : Math.round(base * w / h);
      $('height').value = h >= w ? base : Math.round(base * h / w);
    }
  });
  $('apply').addEventListener('click', () => {
    if (!source || worker) return;
    clearResult();
    const options = {tool};
    for (const key of ['rate','angle','axis','start','end','selection','extract',
                       'duration','compression','colors','width','height','fit']) {
      if ($(key)) options[key] = $(key).value;
    }
    // The worker wants a single background value, not a mode plus a colour.
    if ($('background')) options.background = $('background').value === 'color' ? $('color').value : 'transparent';
    if ($('boomerang')) options.boomerang = $('boomerang').checked;
    if ($('loop-mode')) options.repeats = $('loop-mode').value === 'once' ? -1 : $('loop-mode').value === 'forever' ? 0 : Number($('repeats').value);
    metric = GWFunnel.exportStarted(); $('options').disabled = true; $('file').disabled = $('new').disabled = true;
    $('progress').hidden = $('cancel').hidden = false; $('progress').value = 0; $('status').textContent = 'Processing on your device…';
    function failed(message, category) { if (metric) metric.fail(category); stop(); $('status').textContent = message; }
    try {
      worker = new Worker('/gif-utilities-worker.js');
      worker.onmessage = event => {
        const result = event.data;
        if (result.error) return failed(result.error, 'processing');
        if (result.progress !== undefined) { $('progress').value = result.progress; return; }
        if (result.frames) return renderFrames(result, failed);
        outputBlob = new Blob([result.bytes], {type: 'image/gif'}); outputURL = URL.createObjectURL(outputBlob);
        outputName = tool + '.gif';
        $('result').src = outputURL; $('result-wrap').hidden = false;
        $('download').href = outputURL; $('download').download = outputName; $('download').hidden = $('replay').hidden = $('continue-wrap').hidden = false;
        metric.complete(); stop();
        const size = (outputBlob.size / 1024).toFixed(1) + ' KB';
        // Compression is only meaningful against the original, so show both.
        const comparison = result.originalSize
          ? ' Original ' + (result.originalSize / 1024).toFixed(1) + ' KB · result ' + size
            + ' (' + Math.round((1 - outputBlob.size / result.originalSize) * 100) + '% smaller).'
          : '';
        $('status').textContent = 'Result ready · ' + size + '.' + comparison
          + (result.message ? ' ' + result.message : '')
          + (result.quantized ? ' Some composed frames required color reduction.' : '');
      };
      worker.onerror = () => failed('Processing failed. Try a smaller GIF.', 'processing');
      timer = setTimeout(() => failed('Processing timed out. Try a smaller GIF.', 'timeout'), 90000);
      const copy = source.slice(0);
      const extra = extras.map(b => b.slice(0));
      worker.postMessage({buffer: copy, options, extra}, [copy, ...extra]);
    } catch (_) { failed('Your browser could not start the GIF worker.', 'processing'); }
  });
  $('cancel').addEventListener('click', () => { stop(); $('status').textContent = 'Cancelled. You can change settings and try again.'; });
  // PNG rendering happens on the main thread after the worker returns frames, so
  // it watches the worker handle: terminating it is what cancels the render.
  function renderFrames(result, failed) {
    const running = worker;
    $('status').textContent = 'Creating PNG files…'; $('progress').value = 0;
    GWFrameDownloads.render(result,
      () => worker === running && worker !== null,
      (done, total) => { $('progress').value = Math.round(done / total * 100); })
      .then(out => {
        if (worker !== running || !worker) return;
        outputBlob = out.blob; outputURL = URL.createObjectURL(outputBlob);
        outputName = out.entries.length === 1 ? out.entries[0].name : 'frames.zip';
        $('download').href = outputURL; $('download').download = outputName; $('download').hidden = false;
        const gallery = $('frames');
        if (gallery) {
          out.entries.forEach(entry => {
            const url = URL.createObjectURL(entry.blob); frameURLs.push(url);
            const figure = document.createElement('figure');
            const link = document.createElement('a');
            link.href = url; link.download = entry.name;
            const img = document.createElement('img');
            img.src = url; img.alt = 'Frame ' + entry.number; img.loading = 'lazy';
            link.appendChild(img);
            const caption = document.createElement('figcaption');
            caption.textContent = 'Frame ' + entry.number;
            figure.append(link, caption); gallery.appendChild(figure);
          });
          gallery.hidden = false;
        }
        if (metric) metric.complete();
        stop();
        $('status').textContent = out.entries.length === 1
          ? 'One PNG ready · ' + (outputBlob.size / 1024).toFixed(1) + ' KB.'
          : out.entries.length + ' PNGs ready as a ZIP · ' + (outputBlob.size / 1024).toFixed(1)
            + ' KB. Individual frames are listed below.';
      })
      .catch(error => {
        if (worker !== running || !worker) return;
        failed(error.message === 'cancelled' ? 'Cancelled.' : error.message, 'processing');
      });
  }
  $('replay').addEventListener('click', () => {
    if (!outputBlob) return;
    URL.revokeObjectURL(outputURL); outputURL = URL.createObjectURL(outputBlob);
    $('result').src = outputURL; $('download').href = outputURL;
  });
  async function handoff(writeFile) {
    // Store bytes rather than Blob/File objects for WebKit IndexedDB compatibility.
    const payload = writeFile ? {buffer: await writeFile.arrayBuffer(), name: writeFile.name, type: writeFile.type} : null;
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('gifwidgets', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('files');
      req.onerror = req.onblocked = () => reject(new Error('Local storage is unavailable. Download the result and open it in the next tool.'));
      req.onsuccess = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('files')) { db.close(); reject(new Error('Local storage is unavailable. Download the result instead.')); return; }
        const tx = db.transaction('files', 'readwrite'), store = tx.objectStore('files');
        let file;
        if (payload) store.put(payload, 'pending');
        else { const read = store.get('pending'); read.onsuccess = () => { file = read.result; if (file && file.buffer instanceof ArrayBuffer) file = new File([file.buffer], file.name, {type:file.type}); store.delete('pending'); }; }
        tx.oncomplete = () => { db.close(); resolve(file); };
        tx.onerror = tx.onabort = () => { db.close(); reject(new Error('Could not save the local handoff. Download the GIF instead.')); };
      };
    });
  }
  $('continue').addEventListener('click', async () => {
    if (!outputBlob) return;
    $('continue').disabled = true;
    try { await handoff(new File([outputBlob], tool + '.gif', {type:'image/gif'})); location.href = $('next').value; }
    catch (error) { $('status').textContent = error.message; $('continue').disabled = false; }
  });
  if (new URLSearchParams(location.search).has('continue')) {
    const ticket = generation;
    handoff().then(file => { if (file && ticket === generation) load(file); }).catch(error => { $('status').textContent = error.message; });
  }
  // Keep preview URLs valid when the browser restores this page from its back cache.
  // The browser releases them on document destruction; replacement URLs are revoked above.
  window.addEventListener('pagehide', stop);
})();
