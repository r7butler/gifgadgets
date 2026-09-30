/* The background segmentation service (SAM 3 on Modal) as one call: upload a
   source, submit what to keep, poll, and return the masks. Shared by the
   background tools and the GIF editor's Background section. */
(function (root) {
  'use strict';

  async function api(route, body) {
    const encoded = JSON.stringify(body), raw = new TextEncoder().encode(encoded);
    const digest = await crypto.subtle.digest('SHA-256', raw);
    const hash = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
    const response = await fetch('/api/segment/' + route, {method: 'POST', headers: {'Content-Type': 'application/json', 'x-amz-content-sha256': hash}, body: encoded, signal: AbortSignal.timeout(45000)});
    let result; try { result = await response.json(); } catch (_) { throw Error('Background removal is unavailable. Please try again later.'); }
    if (!response.ok) { const error = Error(result.error || 'Background processing failed.'); error.status = response.status; throw error; }
    return result;
  }

  // The worker reports nothing until it has a GPU and a loaded model. A warm
  // worker may not have reported by the first poll, so only claim a cold start
  // from the second poll on.
  function progressText(result, polls, count) {
    if (result.phase === 'starting' && polls > 1) return 'Starting GPU…';
    const frames = result.frames || count;
    if (result.frame > 0 && frames > 1) return `Finding objects: frame ${result.frame} of ${frames}…`;
    return `Finding objects in ${frames} frame${frames === 1 ? '' : 's'}…`;
  }

  async function cancelRemote(run) {
    if (run.submission) { try { await run.submission; } catch (_) {} }
    // Even an interrupted submit may have started compute; cancellation checks
    // its saved server-side reference rather than assuming no job was launched.
    if (!run.submission || !run.job) return;
    for (let i = 0; i < 12; i++) {
      try { await api('cancel', {job_id: run.job}); return; }
      catch (error) { if (error.status !== 409 || i === 11) throw error; await new Promise(r => setTimeout(r, 1000)); }
    }
  }

  /**
   * Segment `source`, a Blob of MIME `type` with `frames` frames, keeping what
   * `text` describes or else the clicked `objects`. `onStatus(message)` and
   * `onProgress(done, total)` report along the way (a null total means no
   * measurable progress); neither is called before start() returns.
   *
   * Returns a run. `run.result` resolves to the gunzipped masks, or to null
   * once `run.cancel()` has been called. After a failure, `run.submission` is
   * set if paid work may have started; `run.cancelRemote()` stops it.
   */
  function start({source, type, text, objects, frames, onStatus = () => {}, onProgress = () => {}}) {
    const run = {cancelled: false, controller: new AbortController(), job: null, submission: null};
    run.cancelRemote = () => cancelRemote(run);
    run.cancel = () => { run.cancelled = true; run.controller.abort(); return cancelRemote(run); };
    run.result = (async () => {
      await null;
      if (run.cancelled) return null;
      onStatus(text ? 'Uploading source to find what you described…' : 'Uploading source for AI object selection…');
      const issued = await api('presign', {content_type: type}); run.job = issued.job_id;
      if (run.cancelled) return null;
      const upload = await fetch(issued.upload_url, {method: 'PUT', headers: {'Content-Type': type}, body: source, signal: AbortSignal.any([run.controller.signal, AbortSignal.timeout(300000)])});
      if (!upload.ok) throw Error('Source upload failed. Try again.');
      if (run.cancelled) return null;
      run.submission = api('submit', text ? {job_id: run.job, text} : {job_id: run.job, objects});
      await run.submission;
      const started = Date.now();
      onProgress(0, null);
      let result, pollFailures = 0, polls = 0;
      while (!run.cancelled) {
        if (Date.now() - started > 3700000) throw Error('This job exceeded its processing time. Try a smaller file.');
        try {
          result = await api('status', {job_id: run.job}); pollFailures = 0; polls++;
        } catch (error) {
          // A transient polling failure must not discard a paid job already running.
          if (run.cancelled) return null;
          if ((error.status && error.status < 500 && error.status !== 429) || ++pollFailures > 3) throw error;
          onStatus('Connection interrupted. Checking your existing job again…');
          await new Promise(r => setTimeout(r, 2000 * pollFailures)); continue;
        }
        if (run.cancelled) return null;
        if (result.state === 'complete') break;
        if (result.state !== 'running') throw Error(result.error || 'Segmentation was cancelled.');
        onStatus(`${progressText(result, polls, frames)} ${Math.round((Date.now() - started) / 1000)}s. You can cancel this job.`);
        if (result.frame > 0 && result.frames > 1) onProgress(result.frame, result.frames);
        await new Promise(r => setTimeout(r, 2000));
      }
      if (run.cancelled) return null;
      onProgress(0, null);
      const response = await fetch(result.mask_url, {signal: AbortSignal.any([run.controller.signal, AbortSignal.timeout(120000)])});
      if (!response.ok) throw Error('Could not download the masks. Please try again.');
      const compressed = await response.blob();
      const buffer = await new Response(compressed.stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
      return run.cancelled ? null : buffer;
    })().catch(error => { if (run.cancelled) return null; throw error; });
    return run;
  }

  root.GWSegment = {start};
})(window);
