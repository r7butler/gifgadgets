/* Fixed-schema, consent-gated task metrics. Never pass media, names or error text. */
(function () {
  'use strict';
  var tools = ['gif-editor', 'gif-editor-advanced', 'image-editor', 'gif-resizer',
    'crop-gif', 'gif-maker', 'video-to-gif', 'gif-speed', 'reverse-gif',
    'rotate-gif', 'flip-gif', 'gif-loop', 'trim-gif'];
  var converters = ['jpg-to-png', 'png-to-jpg', 'jpg-to-webp', 'png-to-webp',
    'webp-to-jpg', 'gif-to-png', 'svg-to-png', 'heic-to-jpg'];
  var parts = location.pathname.split('/').filter(Boolean);
  var tool = parts[0] === 'photo-converter' && converters.indexOf(parts[1]) !== -1
    ? parts[1] : tools.indexOf(parts[0]) !== -1 ? parts[0] : 'legacy-editor';
  var current;
  function bucket(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return 'unknown';
    if (bytes < 1024 * 1024) return 'under_1mb';
    if (bytes < 10 * 1024 * 1024) return '1_to_10mb';
    if (bytes < 50 * 1024 * 1024) return '10_to_50mb';
    return '50mb_plus';
  }
  function emit(name, task, start, category) {
    if (!window.GWAnalyticsAllowed || !window.GWAnalyticsAllowed() || typeof window.gtag !== 'function') return;
    var params = { tool_name: tool, size_bucket: task.bucket,
      duration_ms: Math.max(0, Math.round(performance.now() - start)),
      page_location: location.origin + location.pathname };
    if (category) params.failure_category = category;
    try { window.gtag('event', name, params); } catch (_) { /* Metrics never block a task. */ }
  }
  function fail(task, start, category) {
    var allowed = ['decode', 'read', 'encode', 'unsupported_output', 'timeout', 'validation', 'processing'];
    emit('tool_failure', task, start, allowed.indexOf(category) < 0 ? 'processing' : category);
  }
  window.GWFunnel = {
    accepted: function (bytes) {
      current = { bucket: bucket(bytes), started: performance.now(), ready: false };
      emit('file_accepted', current, current.started);
    },
    ready: function () {
      if (!current || current.ready) return;
      current.ready = true;
      emit('editor_ready', current, current.started);
    },
    failure: function (category) {
      if (current) fail(current, current.started, category);
    },
    trackingStarted: function () { return span(true); },
    exportStarted: function () { return span(false); }
  };
  function span(tracking) {
    var task = current || { bucket: 'unknown' };
    var start = performance.now(), ended = false;
    emit(tracking ? 'tracking_started' : 'export_started', task, start);
    return {
      complete: function () {
        if (ended) return;
        ended = true;
        emit(tracking ? 'tracking_completed' : 'export_completed', task, start);
      },
      fail: function (category) {
        if (ended) return;
        ended = true;
        if (tracking) emit('tracking_failed', task, start, 'processing');
        else fail(task, start, category);
      }
    };
  }
})();
