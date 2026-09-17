(() => {
  'use strict';
  const $ = id => document.getElementById('utility-' + id);
  const tool = document.querySelector('[data-tool]').dataset.tool;
  let file, worker, pending, duration = 0, busy = false, sourceURL, resultURL, generation = 0;
  const status = message => { $('status').textContent = message; };
  function setBusy(value) {
    busy = value;
    $('options').disabled = value || !file || !duration;
    $('upload').disabled = $('new').disabled = value;
    $('cancel').hidden = $('progress').hidden = !value;
  }
  function clearResult() {
    $('result').removeAttribute('src');
    if ($('result').load) $('result').load();
    if (resultURL) URL.revokeObjectURL(resultURL);
    resultURL = null;
    $('result-wrap').hidden = $('download').hidden = true;
    $('download').removeAttribute('href');
  }
  function stop() {
    generation++;
    if (worker) worker.terminate();
    worker = null;
    if (pending) { pending.reject(new Error('Processing cancelled.')); pending = null; }
  }
  function request(data, transfers = []) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { stop(); status('Processing timed out. Try a smaller file.'); setBusy(false); }, 240000);
      pending = {resolve: value => { clearTimeout(timeout); resolve(value); }, reject: error => { clearTimeout(timeout); reject(error); }};
      worker.postMessage(data, transfers);
    });
  }
  async function prepare() {
    if (worker) return;
    const current = generation;
    status('Loading video engine (about 31 MB on first use)…');
    worker = new Worker('/video-utilities-worker.js');
    worker.onmessage = ({data}) => {
      if (!pending) return;
      const task = pending; pending = null;
      if (data.type === 'error') task.reject(new Error(data.message)); else task.resolve(data);
    };
    worker.onerror = () => { const task = pending; pending = null; if (task) task.reject(new Error('Could not load the video engine. Reload and try again.')); };
    const bytes = await file.arrayBuffer();
    if (current !== generation) throw Error('Processing cancelled.');
    const result = await request({type: 'load', bytes, extension: file.name.split('.').pop().toLowerCase()}, [bytes]);
    duration = result.info.duration;
  }
  async function choose(selected) {
    if (!selected || busy) return;
    const extension = selected.name.split('.').pop().toLowerCase();
    if (!(tool === 'gif-to-mp4' ? ['gif'] : ['mp4','mov','webm']).includes(extension) || !selected.size || selected.size > 100 * 1024 * 1024) {
      status('Choose a ' + (tool === 'gif-to-mp4' ? 'GIF' : 'MP4, MOV or WebM') + ' file up to 100 MB.'); return;
    }
    stop(); clearResult(); duration = 0; file = selected;
    if (sourceURL) URL.revokeObjectURL(sourceURL);
    sourceURL = URL.createObjectURL(file);
    $('preview-note').hidden = true;
    $('original').src = sourceURL;
    $('original-wrap').hidden = false;
    $('upload').hidden = true; $('new').hidden = false;
    $('info').textContent = file.name + ' · ' + (file.size / 1048576).toFixed(2) + ' MB';
    window.GWFunnel?.accepted(file.size);
    setBusy(true);
    const current = generation;
    try {
      await prepare();
      if (current !== generation) return;
      if ($('start')) { $('start').value = '0'; $('start').max = duration; }
      if ($('end')) { $('end').value = duration; $('end').max = duration; }
      $('info').textContent += ' · ' + duration.toFixed(3) + ' seconds';
      status('Ready to export.'); window.GWFunnel?.ready();
    } catch (error) { if (current === generation) { stop(); status(error.message); window.GWFunnel?.failure('decode'); } }
    finally { setBusy(false); }
  }
  $('original').addEventListener('error', () => { $('preview-note').hidden = false; });
  $('upload').onclick = $('new').onclick = () => $('file').click();
  $('file').onchange = () => { choose($('file').files[0]); $('file').value = ''; };
  const stage = document.querySelector('.utility-stage');
  stage.ondragover = event => { event.preventDefault(); $('upload').classList.add('dragover'); };
  stage.ondragleave = () => $('upload').classList.remove('dragover');
  stage.ondrop = event => { event.preventDefault(); $('upload').classList.remove('dragover'); choose(event.dataTransfer.files[0]); };
  if ($('use-time')) $('use-time').onclick = () => {
    const time = $('original').currentTime;
    if (Number.isFinite(time)) { $('start').value = Math.min(time, Math.max(0, duration - .001)).toFixed(3); clearResult(); }
  };
  $('options').oninput = clearResult;
  $('cancel').onclick = () => { stop(); setBusy(false); status('Processing cancelled. Choose another file or export again.'); };
  $('apply').onclick = async () => {
    const start = $('start') ? $('start').valueAsNumber : 0;
    const end = $('end') ? $('end').valueAsNumber : duration;
    if (tool !== 'mute-video' && tool !== 'gif-to-mp4' && (!Number.isFinite(start) || start < 0 || start >= duration || !Number.isFinite(end) || end <= start || end > duration)) {
      status('Choose times within the video; end time must follow start time.'); return;
    }
    clearResult(); setBusy(true); const current = generation;
    const span = window.GWFunnel?.exportStarted();
    try {
      await prepare();
      status('Processing on your device…');
      const result = await request({type: 'export', tool, start, end});
      if (current !== generation) return;
      const blob = new Blob([result.bytes], {type: result.mime});
      resultURL = URL.createObjectURL(blob);
      $('result').src = $('download').href = resultURL;
      $('download').download = file.name.replace(/\.[^.]+$/, '') + '-' + tool + '.' + result.extension;
      $('download').textContent = 'Download ' + result.extension.toUpperCase();
      $('result-wrap').hidden = $('download').hidden = false;
      status('Ready · ' + (blob.size / 1048576).toFixed(2) + ' MB'); span?.complete();
    } catch (error) { span?.fail('encode'); if (current === generation) { stop(); status(error.message); } }
    finally { setBusy(false); }
  };
  window.addEventListener('pagehide', () => { stop(); if(sourceURL) URL.revokeObjectURL(sourceURL); if(resultURL) URL.revokeObjectURL(resultURL); });
})();
