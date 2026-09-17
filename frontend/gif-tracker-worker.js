/* gif-tracker-worker.js — Modal SAM2 tracker
 *
 * Encodes GIF frames as JPEG, sends them to a Modal serverless GPU endpoint
 * running SAM2, and streams keyframes back to the main thread.
 *
 * After deploying modal_app.py, replace MODAL_ENDPOINT with the printed URL.
 *
 * Message protocol:
 *   IN  { type:'track', frames, clickX, clickY, clickFrameIdx }
 *         frames[i] = { data:ArrayBuffer (RGBA), width, height, frameIndex }
 *   OUT { type:'progress', text }
 *       { type:'keyframe', frame, x, y }   (normalised 0-1)
 *       { type:'done' }
 *       { type:'error', message }
 */

var MODAL_ENDPOINT = '/api/track/submit';

function post(msg) { self.postMessage(msg); }

async function apiFetch(url, options) {
  if (options && options.body) {
    var raw = typeof options.body === 'string'
      ? new TextEncoder().encode(options.body) : options.body;
    var hashBuf = await crypto.subtle.digest('SHA-256', raw);
    var hashHex = Array.from(new Uint8Array(hashBuf))
      .map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
    options.headers = options.headers || {};
    options.headers['x-amz-content-sha256'] = hashHex;
  }
  return fetch(url, options);
}

// The API returns a readable message for service-level failures (no GPU credit,
// endpoint down, throttled, rate limited). Prefer it over a raw status dump.
function apiError(status, text) {
  var friendly = null;
  try {
    var parsed = JSON.parse(text);
    if (parsed && typeof parsed.error === 'string') friendly = parsed.error;
  } catch (_) {}
  var err = new Error(friendly || ('Tracker API ' + status + ': ' + text));
  err.unavailable = status === 503 || status === 429;
  return err;
}

async function frameToJpegB64(frame) {
  var canvas = new OffscreenCanvas(frame.width, frame.height);
  var ctx    = canvas.getContext('2d');
  ctx.putImageData(
    new ImageData(new Uint8ClampedArray(frame.data), frame.width, frame.height),
    0, 0
  );
  var blob  = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
  var ab    = await blob.arrayBuffer();
  var bytes = new Uint8Array(ab);
  var CHUNK = 8192;
  var parts = [];
  for (var i = 0; i < bytes.length; i += CHUNK) {
    parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK)));
  }
  return btoa(parts.join(''));
}

async function doTracking(msg) {
  var frames = msg.frames;
  var total  = frames.length;

  post({ type: 'progress', text: 'Preparing…' });
  var framesB64 = [];
  for (var i = 0; i < total; i++) {
    framesB64.push(await frameToJpegB64(frames[i]));
  }

  // Step 1: Get presigned S3 URL from Lambda
  post({ type: 'progress', text: 'Creating motion keyframes…' });

  var presignResp = await apiFetch('/api/track/presign', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({}),
  });

  if (!presignResp.ok) {
    var presignText = await presignResp.text();
    throw apiError(presignResp.status, presignText);
  }

  var presign = await presignResp.json();
  if (presign.error) throw new Error(presign.error);

  // Step 2: Upload frames directly to S3 via presigned PUT
  var uploadResp = await fetch(presign.upload_url, {
    method:  'PUT',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ frames: framesB64 }),
  });

  if (!uploadResp.ok) {
    throw new Error('Frame upload failed: ' + uploadResp.status);
  }

  // Step 3: Tell Lambda to process via Modal
  var resp = await apiFetch(MODAL_ENDPOINT, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      s3_key:        presign.s3_key,
      frame_indices: frames.map(function (f) { return f.frameIndex; }),
      click_x:       msg.clickX / frames[0].width,
      click_y:       msg.clickY / frames[0].height,
      click_frame:   frames[msg.clickFrameIdx].frameIndex,
    }),
  });

  if (!resp.ok) {
    var text = await resp.text();
    throw apiError(resp.status, text);
  }

  var result = await resp.json();
  if (result.error) throw new Error(result.error);

  for (var i = 0; i < result.motion.length; i++) {
    var kf = result.motion[i];
    post({ type: 'keyframe', frame: kf.frame, x: kf.x, y: kf.y });
  }

  post({ type: 'done' });
}

self.onmessage = function (e) {
  if (e.data.type === 'warmup') {
    post({ type: 'warmup-pending' });
    apiFetch('/api/track/warmup', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ warmup: true }),
    }).then(function () {
      post({ type: 'warmup-done' });
    }).catch(function () {
      post({ type: 'warmup-done' });
    });
  } else if (e.data.type === 'track') {
    doTracking(e.data).catch(function (err) {
      post({ type: 'error', message: err.message, unavailable: !!err.unavailable });
    });
  }
};
