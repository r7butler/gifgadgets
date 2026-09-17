(function () {
  'use strict';
  const $ = id => document.getElementById('utility-' + id);
  const tool = document.querySelector('[data-tool]').dataset.tool;
  let source, worker, timer, metric, inputURL, outputURL, outputBlob, generation = 0;
  function clearResult() {
    if (outputURL) URL.revokeObjectURL(outputURL);
    outputURL = null; outputBlob = null;
    $('download').hidden = $('replay').hidden = $('result-wrap').hidden = $('continue-wrap').hidden = true;
    $('result').removeAttribute('src'); $('download').removeAttribute('href');
  }
  function stop() {
    if (worker) worker.terminate();
    worker = null; clearTimeout(timer); metric = null;
    $('cancel').hidden = $('progress').hidden = true;
    $('file').disabled = $('new').disabled = false; $('options').disabled = !source;
  }
  async function load(file) {
    const ticket = ++generation;
    stop(); source = null; clearResult(); $('options').disabled = true;
    $('upload').hidden = false; $('new').hidden = true;
    if (inputURL) URL.revokeObjectURL(inputURL);
    $('original-wrap').hidden = true; $('original').removeAttribute('src'); $('info').textContent = '';
    if (!file) return;
    GWFunnel.accepted(file.size);
    try {
      if (file.size > 40 * 1024 * 1024) throw new Error('Choose a GIF under 40 MB.');
      const data = await file.arrayBuffer(); if (ticket !== generation) return;
      if (!/^GIF8[79]a$/.test(String.fromCharCode(...new Uint8Array(data, 0, Math.min(6, data.byteLength))))) throw new Error('Choose a valid GIF file.');
      const reader = new GifReader(new Uint8Array(data));
      if (!reader.numFrames()) throw new Error('This GIF has no frames.');
      if (reader.width * reader.height * 4 * (reader.numFrames() + 3) > 96 * 1024 * 1024) throw new Error('This GIF exceeds the decoded memory limit. Resize or shorten it first.');
      source = data; inputURL = URL.createObjectURL(file); $('original').src = inputURL; $('original-wrap').hidden = false;
      $('upload').hidden = true; $('new').hidden = false;
      $('info').textContent = reader.width + ' × ' + reader.height + ' · ' + reader.numFrames() + ' frames';
      if ($('end')) { $('end').value = reader.numFrames(); $('end').max = $('start').max = reader.numFrames(); $('start').value = 1; }
      $('options').disabled = false; $('status').textContent = 'Ready. Choose settings, then apply.'; GWFunnel.ready();
    } catch (error) { $('status').textContent = error.message; GWFunnel.failure('decode'); }
  }
  $('file').addEventListener('change', () => load($('file').files[0]));
  $('upload').addEventListener('click', () => $('file').click());
  $('new').addEventListener('click', () => $('file').click());
  $('upload').addEventListener('dragover', event => { event.preventDefault(); $('upload').classList.add('dragover'); });
  $('upload').addEventListener('dragleave', () => $('upload').classList.remove('dragover'));
  $('upload').addEventListener('drop', event => {
    event.preventDefault(); $('upload').classList.remove('dragover');
    if (!worker && event.dataTransfer.files.length) load(event.dataTransfer.files[0]);
  });
  $('options').addEventListener('input', () => {
    clearResult(); $('status').textContent = 'Settings changed. Apply to preview the new result.';
    if ($('loop-mode')) $('repeats').disabled = $('loop-mode').value !== 'finite';
  });
  $('apply').addEventListener('click', () => {
    if (!source || worker) return;
    clearResult();
    const options = {tool};
    for (const key of ['rate','angle','axis','start','end']) if ($(key)) options[key] = $(key).value;
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
        outputBlob = new Blob([result.bytes], {type: 'image/gif'}); outputURL = URL.createObjectURL(outputBlob);
        $('result').src = outputURL; $('result-wrap').hidden = false;
        $('download').href = outputURL; $('download').download = tool + '.gif'; $('download').hidden = $('replay').hidden = $('continue-wrap').hidden = false;
        metric.complete(); stop();
        $('status').textContent = 'Result ready · ' + (outputBlob.size / 1024).toFixed(1) + ' KB.' + (result.quantized ? ' Some composed frames required color reduction.' : '');
      };
      worker.onerror = () => failed('Processing failed. Try a smaller GIF.', 'processing');
      timer = setTimeout(() => failed('Processing timed out. Try a smaller GIF.', 'timeout'), 90000);
      const copy = source.slice(0); worker.postMessage({buffer: copy, options}, [copy]);
    } catch (_) { failed('Your browser could not start the GIF worker.', 'processing'); }
  });
  $('cancel').addEventListener('click', () => { stop(); $('status').textContent = 'Cancelled. You can change settings and try again.'; });
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
