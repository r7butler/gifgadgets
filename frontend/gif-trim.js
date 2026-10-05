/* Trim GIF timeline. Drag an edge of the window to choose the first or last frame,
   drag its middle to move it, or press outside it to scrub. The preview loops the
   selection. The sidebar's frame inputs stay the source of truth and the keyboard
   route: dragging writes to them, and typing in them moves the window. */
(() => {
  'use strict';
  const $ = id => document.getElementById('utility-' + id);
  // Longest preview side. Large GIFs are scaled down so the preview frames cost far
  // less memory than the full-size frames the encoder decodes on Apply.
  const PREVIEW_MAX = 720;
  const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
  const seconds = ms => (ms / 1000).toFixed(2).replace(/\.?0+$/, '') + ' s';
  const full = document.createElement('canvas'), scratch = document.createElement('canvas');
  let frames = [], worker = null, ticket = 0, timer = null, drag = null, shown = 0, first = 1, last = 1;
  let playing = !matchMedia('(prefers-reduced-motion: reduce)').matches;

  function reset() {
    ticket++; clearTimeout(timer); drag = null; frames = [];
    if (worker) worker.terminate();
    worker = null;
    $('trim').hidden = $('trim-preview').hidden = true; $('original').hidden = false;
  }

  function load(buffer, count) {
    reset();
    if (count < 2) return;
    const mine = ticket;
    try { worker = new Worker('/gif-decode.js'); } catch (_) { return; }
    worker.onmessage = ({data}) => {
      if (mine !== ticket) return;
      if (data.frame) add(data.frame);
      else if (data.complete) ready();
      else if (data.error) reset();
    };
    // Without a preview the frame inputs still work, so a failure just leaves them.
    worker.onerror = () => { if (mine === ticket) reset(); };
    const copy = buffer.slice(0);
    worker.postMessage(copy, [copy]);
  }

  function add({pixels, width, height, delay}) {
    let image = new ImageData(pixels, width, height);
    const scale = Math.min(1, PREVIEW_MAX / Math.max(width, height));
    if (scale < 1) {
      if (!frames.length) {
        full.width = width; full.height = height;
        scratch.width = Math.max(1, Math.round(width * scale)); scratch.height = Math.max(1, Math.round(height * scale));
      }
      full.getContext('2d').putImageData(image, 0, 0);
      const ctx = scratch.getContext('2d', {willReadFrequently: true});
      ctx.drawImage(full, 0, 0, scratch.width, scratch.height);
      image = ctx.getImageData(0, 0, scratch.width, scratch.height);
    }
    frames.push({image, delay});
  }

  function ready() {
    worker.terminate(); worker = null;
    full.width = full.height = 0;
    const {width, height} = frames[0].image;
    scratch.width = width; scratch.height = height;
    $('trim-preview').width = width; $('trim-preview').height = height;
    first = 1; last = frames.length;
    fromInputs(true);
    $('trim-preview').hidden = $('trim').hidden = false; $('original').hidden = true;
    drawStrip(); sync(); restart(); playButton();
  }

  // ── Preview playback ──

  function show(index) {
    shown = index;
    $('trim-preview').getContext('2d').putImageData(frames[index].image, 0, 0);
    $('trim-playhead').style.left = (index + .5) / frames.length * 100 + '%';
  }
  function schedule() {
    clearTimeout(timer);
    if (!playing || drag || !frames.length) return;
    timer = setTimeout(() => {
      show(shown + 1 > last - 1 || shown < first - 1 ? first - 1 : shown + 1);
      schedule();
    }, frames[shown].delay);
  }
  function restart() { show(first - 1); schedule(); }
  function playButton() {
    $('trim-play').setAttribute('aria-label', playing ? 'Pause preview' : 'Play preview');
    $('trim-play').querySelector('.utility-trim-pause').hidden = !playing;
    $('trim-play').querySelector('.utility-trim-resume').hidden = playing;
  }
  $('trim-play').addEventListener('click', () => {
    playing = !playing; playButton();
    if (playing) schedule(); else clearTimeout(timer);
  });

  // ── Selection ──

  function sync() {
    const count = frames.length, left = (first - 1) / count * 100, right = last / count * 100;
    $('trim-window').style.left = left + '%';
    $('trim-window').style.width = right - left + '%';
    $('trim-handle-start').style.left = left + '%';
    $('trim-handle-end').style.left = right + '%';
    const ms = frames.slice(first - 1, last).reduce((sum, frame) => sum + frame.delay, 0);
    $('trim-summary').textContent = 'Frames ' + first + '–' + last + ' · '
      + (last - first + 1) + ' of ' + count + ' · ' + seconds(ms);
  }

  // Invalid or half-typed values leave the window where it is; Apply reports them.
  function fromInputs(quiet) {
    if (!frames.length || drag) return;
    const start = Number($('start').value), end = Number($('end').value);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > frames.length) return;
    if (start === first && end === last) return;
    first = start; last = end;
    if (quiet === true) return;
    sync();
    if (playing) restart(); else show(first - 1);
  }
  $('start').addEventListener('input', fromInputs);
  $('end').addEventListener('input', fromInputs);

  // ── Dragging ──
  // Edges and the window move by whole frames relative to where the drag began, so
  // touching a handle never nudges it. Positions are frame boundaries, 0 to count.

  $('trim-track').addEventListener('pointerdown', event => {
    if (!frames.length || $('options').disabled || event.button > 0) return;
    event.preventDefault();
    const rect = $('trim-frames').getBoundingClientRect(), cell = rect.width / frames.length;
    const x = event.clientX - rect.left, left = (first - 1) * cell, right = last * cell;
    const toLeft = Math.abs(x - left), toRight = Math.abs(x - right);
    const reach = event.pointerType === 'mouse' ? 12 : 22;
    const mode = Math.min(toLeft, toRight) <= reach ? (toLeft <= toRight ? 'start' : 'end')
      : x > left && x < right ? 'move' : 'scrub';
    drag = {mode, x, rect, cell, first, last};
    clearTimeout(timer);
    $('trim-track').setPointerCapture(event.pointerId);
    $('trim-track').classList.toggle('dragging', mode === 'move');
    update(event);
  });

  function update(event) {
    if (!drag) return;
    const count = frames.length, x = event.clientX - drag.rect.left;
    const shift = Math.round((x - drag.x) / drag.cell);
    if (drag.mode === 'scrub') { show(clamp(Math.floor(x / drag.cell), 0, count - 1)); return; }
    if (drag.mode === 'move') {
      const span = drag.last - drag.first;
      first = clamp(drag.first + shift, 1, count - span); last = first + span;
      show(first - 1);
    } else {
      // The dragged edge may cross the fixed one, which then becomes the other end.
      const fixed = drag.mode === 'start' ? drag.last : drag.first - 1;
      const moving = clamp((drag.mode === 'start' ? drag.first - 1 : drag.last) + shift, 0, count);
      let low = Math.min(moving, fixed), high = Math.max(moving, fixed);
      if (low === high) { if (high < count) high++; else low--; }
      first = low + 1; last = high;
      show(moving > fixed ? last - 1 : first - 1);
    }
    $('start').value = first; $('end').value = last;
    sync();
  }

  function finish() {
    if (!drag) return;
    const changed = drag.first !== first || drag.last !== last;
    drag = null;
    $('trim-track').classList.remove('dragging');
    // One input event per drag, so the page clears a stale result once, on release.
    if (changed) $('end').dispatchEvent(new Event('input', {bubbles: true}));
    if (playing) restart();
  }
  $('trim-track').addEventListener('pointermove', update);
  $('trim-track').addEventListener('pointerup', finish);
  $('trim-track').addEventListener('pointercancel', finish);

  // ── Filmstrip ──

  function drawStrip() {
    const box = $('trim-frames'), canvas = $('trim-strip'), ratio = window.devicePixelRatio || 1;
    const width = box.clientWidth, height = box.clientHeight;
    if (!frames.length || !width || !height) return;
    canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
    const ctx = canvas.getContext('2d'), source = scratch.getContext('2d');
    const fw = scratch.width, fh = scratch.height;
    // Tiles keep roughly the GIF's shape; extreme shapes are cropped to fit.
    const tile = clamp(height * fw / fh, height / 2, height * 2), aspect = tile / height;
    const sw = Math.min(fw, fh * aspect), sh = Math.min(fh, fw / aspect);
    for (let t = 0; t * tile < width; t++) {
      const index = Math.min(frames.length - 1, Math.floor((t + .5) * tile / width * frames.length));
      source.putImageData(frames[index].image, 0, 0);
      ctx.drawImage(scratch, (fw - sw) / 2, (fh - sh) / 2, sw, sh,
        Math.round(t * tile * ratio), 0, Math.ceil(tile * ratio), canvas.height);
    }
  }
  new ResizeObserver(drawStrip).observe($('trim-frames'));

  window.addEventListener('pagehide', () => { clearTimeout(timer); if (worker) reset(); });
  window.addEventListener('pageshow', schedule);

  window.GWTrim = {load, reset};
})();
