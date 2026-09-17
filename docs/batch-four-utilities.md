# Batch four: video tools

Four standalone, indexable utilities are grouped under Video Tools on the
homepage and linked from global navigation and footer:

- `/gif-to-mp4/`: one GIF cycle to H.264 MP4, black transparency background,
  dimensions padded to even values for player compatibility.
- `/video-frame-extractor/`: timestamp to a full-resolution PNG.
- `/trim-video/`: start/end seconds to H.264 MP4 with first audio track in AAC.
- `/mute-video/`: copies the first video stream and excludes all audio streams.
  MP4/MOV export MP4; WebM exports WebM. No video re-encoding.

All have canonical metadata, SoftwareApplication schema, visible FAQs and matching
FAQPage schema, sitemap entries, related cards and consent-gated funnel events.
The shared video template uses the approved upload/preview/sidebar layout and
existing theme styles. Existing video-to-GIF routes remain available.

## Processing and limits

`frontend/video-utilities.js` manages selection, previews, validation, cancellation,
object URLs and downloads. `video-utilities-worker.js` runs the pinned single-thread
`@ffmpeg/core@0.12.10` in a disposable worker. The roughly 31 MB WASM asset loads
only after selection, from the site's own origin, with no media uploads, backend
changes, SharedArrayBuffer or cross-origin isolation requirement. The dependency
is vendored with checksums, license and upstream source references.

Inputs are limited to 100 MiB and the GIF or MP4/MOV/WebM extensions appropriate
to each tool. Actual contents are probed by FFmpeg; extension alone does not imply
a valid file. A source can be processed even when the native browser preview
cannot decode its codec. Export times out after three minutes (a four-minute
watchdog also covers engine loading); device memory can impose lower practical
limits. This is intended for short clips, not long video editing. Cancellation
terminates the worker and subsequent export reloads the source. Changed settings
invalidate the previous download to avoid exporting stale results.

GIFs lose transparency in MP4. GIF loop counts are intentionally ignored: one
cycle is exported. Trimming re-encodes for accurate cuts and can alter quality;
muting preserves the video stream. Unsupported codecs/containers fail visibly.
The duration probe uses FFmpeg's reported timestamp precision (centiseconds).

## Verification

Build: `python build.py` with Jinja2 installed.
Metadata: `python -m unittest discover -s tests/build`.
Browser/output tests: `npm run test:video-utilities`.
Tests require native `ffmpeg` and `ffprobe` on PATH as independent output decoders,
plus installed Chromium, Firefox and WebKit Playwright browsers.

The audio fixture is synthetic, generated with FFmpeg testsrc2 (96×64, 10 fps,
two seconds) and a 440 Hz sine wave. Tests decode downloaded files and inspect
codec, duration, audio presence/removal, frame pixels, odd-size padding and alpha
flattening. They also cover invalid input, invalid trim ranges, cancellation,
retry, mobile overflow and lazy engine loading. RGB comparisons allow small
rounding differences between native and WASM FFmpeg versions.

No production deployment is performed as part of implementation. The existing
frontend deployment script includes the vendored WASM asset in its S3 sync.

Validation completed: 24 video checks across Chromium, Firefox and WebKit,
33 shared homepage/funnel checks, and nine build checks passed. Desktop/mobile
light and dark layouts were also captured and reviewed.
