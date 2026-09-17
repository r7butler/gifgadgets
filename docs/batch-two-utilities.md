# Batch-two GIF utilities

Implemented routes: `/photo-converter/gif-to-png/` (frame extraction),
`/remove-gif-frames/`, `/compress-gif/`, `/gif-canvas/` and `/combine-gifs/`.
Like batch one, each is an indexable page with the working tool on it, unique
metadata, structured data, a homepage card and a sitemap entry, and each uses the
consent-gated tool funnel.

## Shared implementation

Batch two reuses `src/templates/gif-utility.html`, `frontend/gif-utilities.js`
and `frontend/gif-utilities.css` rather than introducing a second pattern. It
adds:

- `frontend/gif-utilities-batch.js`: multi-input decoding, frame selection,
  canvas fitting and re-encoding. Loaded by the worker via `importScripts`, so it
  shares `check`, `blocks`, `decodeFrames` and `paletteFrame` with batch one.
- `frontend/gif-frame-downloads.js`: PNG rendering and a standards-compliant
  uncompressed ZIP. PNG is already compressed, so the ZIP stores entries.

`BATCH_TOOLS` in the worker selects `transformBatch` over the batch-one
`transform`. Anything not in that list keeps the original path unchanged.

## Frame extraction lives on the existing converter

Extraction is served from `/photo-converter/gif-to-png/` rather than a new route.
That URL already existed and is already in Search Console, so a redundant
`extract-gif-frames` page would have split the same intent across two URLs. The
page sets `utility_path` so its canonical stays on the original address while its
slug (`extract-frames`) drives the controls.

One frame downloads as a PNG; several download as a ZIP, with individual PNGs
also listed in a gallery below the workspace. The export is capped at 500 frames
and by the same 96 MiB budget as everything else.

## Behaviour worth knowing

**Remove frames** offers two duration modes. *Preserve* adds each removed frame's
delay to the preceding retained frame, so the animation keeps its total length;
removed leading frames push their time onto the first retained frame instead.
*Shorten* discards that time. Preserve can fail on extreme inputs, because a
single GIF frame delay cannot exceed 65535 centiseconds; the tool says so rather
than silently truncating.

**Compress** has two methods. *Remove comments* rebuilds the file without comment
extensions and leaves image data byte-identical — that path is genuinely
lossless. *Reduce colors* re-encodes with a smaller palette and is not. If
re-encoding produces a larger file than the comment-stripped original, the
smaller original image data is kept and the status says so. No target size is
promised and none should be.

**Fit to canvas** and **combine** share the dimension, fit and background
controls. `pad` centres without resizing, `contain` fits inside, `cover` fills
and crops. Transparency survives unless a solid background is chosen. Combine
plays each input once in the order selected, applies one speed multiplier to the
result, and applies the loop setting to the whole animation rather than per
input.

## Limits

40 MB total input (not per file), 2–20 files for combine, a 96 MiB decoded-frame
budget shared across all inputs, and a separate 96 MiB output cap. Combine also
checks the output canvas against the total frame count before starting, since
joining several GIFs onto a large canvas grows faster than either input suggests.

## Tests

- `tests/gif-utilities.test.cjs` runs the worker under `node:vm` and asserts
  actual decoded output: frame counts, delay arithmetic for both duration modes,
  canvas dimensions, background opacity, combine ordering and loop counts. Note
  that arrays crossing the `vm` boundary need `Array.from` before a strict deep
  compare, or the realm mismatch fails the assertion.
- `tests/e2e/gif-utilities.spec.js` drives each page in Chromium, Firefox and
  WebKit, downloads the result and decodes it — including checking the PNG and
  ZIP magic bytes for extraction, so a stale or empty blob cannot pass.
