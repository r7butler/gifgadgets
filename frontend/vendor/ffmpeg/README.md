# FFmpeg WebAssembly core

Unmodified UMD artifacts from `@ffmpeg/core@0.12.10` (single thread):
https://registry.npmjs.org/@ffmpeg/core/-/core-0.12.10.tgz

Package license: GPL-2.0-or-later. See COPYING.GPLv2.
Upstream source and build instructions: https://github.com/ffmpegwasm/ffmpeg.wasm
FFmpeg source: https://github.com/FFmpeg/FFmpeg/tree/n5.1.4
Upstream Dockerfile and build scripts describe linked libraries and their licenses.

The engine is served locally and fetched only after a file is chosen. It runs
inside video-utilities-worker.js without SharedArrayBuffer or COOP/COEP headers.
No media is sent to any server. A cancelled job terminates its worker.

Verify files using ../SHA256SUMS. Update these pinned artifacts deliberately and
run the video utility tests on Chromium, Firefox and WebKit after updates.
