# Batch-one GIF utilities

Implemented routes: /gif-speed/, /reverse-gif/, /rotate-gif/, /flip-gif/,
/gif-loop/ and /trim-gif/. These are indexable pages with the working tool on the
page, unique metadata, structured data, homepage cards, navigation and sitemap
entries. They use the existing brand configuration and consent-gated tool funnel.

Shared implementation:

- `src/templates/gif-utility.html`: controls, instructions and accessible status.
- `frontend/gif-utilities.js`: file lifecycle, preview/download, cancellation,
  timeout, metrics and IndexedDB handoff to another utility, resize or captions.
- `frontend/gif-utilities-worker.js`: metadata edits and frame transformations.

Speed and looping preserve compressed image blocks. Speed rounds nonzero delays
to GIF centiseconds; zero/missing delays stay unchanged, and browser playback
minimums still apply. Loop controls distinguish play once, forever, and additional
repeats after the initial play.

Other transformations composite frame disposal before reordering/trimming,
preserve raw delays and repeat metadata, and encode full-canvas frames using the
vendored omggif writer. Exact palettes are retained where possible; the existing
gifenc quantizer is used only when a composed frame exceeds its available palette.
The UI reports color reduction. No existing editor encoder is replaced.

Limits: 40 MB input, a conservative 96 MiB decoded-frame budget, and a separate
96 MiB output allocation cap. These are guards, not a guarantee of total browser
memory use. Worker cancellation terminates processing; timeout is 90 seconds.
Input and output previews remain local. No automatic server fallback is used.

Applying new settings always starts from this page's original input. Continue with
result passes the encoded output to the next tool without downloading/reselecting.
It does not yet carry a non-destructive operation history between tools; further
pixel transformations may re-encode. Existing resize/caption export behavior still
applies when continuing into those editors.

Validation commands:

```
node --test tests/gif-utilities.test.cjs
python -m unittest discover -s tests/build
npm run test:gif-utilities
```

Output tests check actual GIF pixels, delays, dimensions, loop flags, transparency,
disposal 2/3, invalid inputs, palette overflow and single-frame/zero-delay files.
Browser tests exercise real downloaded files, stale-result invalidation, consent,
cancellation, mobile viewport layout and cross-tool handoff in Chromium, Firefox
and WebKit. Production smoke tests include all six routes. Real mobile hardware
and a broad photographic corpus remain useful manual qualification steps.

This batch is implemented locally; deployment is a separate step.
