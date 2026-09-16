# Local export baseline

Recorded 2026-09-16 on Darwin x86_64, Playwright Chromium, one worker, three repetitions.

Synthetic flat graphics only. Video is a 10×10 smoke fixture. These numbers do not establish real-world photographic quality, mobile performance or superiority over ezgif. Page loading is excluded from task time and recorded separately in raw results. Automated input and download interaction are included.

| Tool | Input | Runs | Median ready (ms) | Median export (ms) | Median file-selection to saved-file (ms) | Output bytes |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| crop-gif | medium-flat | 3 | 388 | 2030 | 2492 | 338887 |
| crop-gif | small-flat | 3 | 104 | 467 | 774 | 69502 |
| gif-editor | medium-flat | 3 | 908 | 2091 | 3056 | 770116 |
| gif-editor | small-flat | 3 | 409 | 556 | 1012 | 141867 |
| gif-resizer | medium-flat | 3 | 383 | 1018 | 1513 | 228268 |
| gif-resizer | small-flat | 3 | 110 | 230 | 788 | 60092 |
| video-to-gif | test.mp4 | 3 | 931 | 392 | 1413 | 14918 |

All runs produced GIF downloads with the expected dimensions and the ordered four-event completion funnel. Animation fidelity, transparency, color fidelity and large-file safety need additional fixtures and validation.

The initial video run failed to produce an output within 90 seconds: controls were usable before clip initialization finished. After gating controls on initialization and bounding frame-rate detection, all three final video runs completed. This is a functional correction, not an encoder speed claim.

Next export investigation: compare a GIF optimization post-pass on the saved crop/caption outputs while checking appearance and timing. No encoder replacement is justified by this flat-graphics sample alone.

Reproduce with `npm run benchmark -- --repeat-each=3`. Input GIFs, output GIFs and raw JSON are regenerated in `test-results/benchmarks/`.
