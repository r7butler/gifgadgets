# Batch-three bulk image utilities

Implemented routes: `/bulk-resize-images/`, `/bulk-compress-images/`,
`/bulk-convert-images/` and `/image-contact-sheet/`. Each is an indexable page
with the working tool on it, unique metadata, `SoftwareApplication` and
`FAQPage` structured data, a homepage card, a sitemap entry and the
consent-gated tool funnel.

These are the first tools that operate on still images rather than GIFs, so the
nav entry that read "Image Editor" now reads "Image Tools" and points at the
homepage `#image-tools` section, which lists the editor alongside the four new
tools.

## No worker, deliberately

The GIF utilities need a worker because decoding an animation means LZW-decoding
every frame in JavaScript. A bulk image operation is one decode plus one encode
per file, and the browser already performs both off the main thread —
`createImageBitmap` decodes asynchronously and `canvas.toBlob` encodes
asynchronously. So `frontend/image-utilities.js` runs on the main thread and
yields between files, which keeps progress reporting and cancellation simple and
avoids shipping another worker bundle.

`createImageBitmap` is also what applies EXIF orientation (`imageOrientation:
'from-image'`), so a rotated phone photo comes out upright. There is an `<img>`
fallback for browsers or formats where it throws.

## Shared pieces

- `src/templates/image-utility.html` — the image counterpart to
  `gif-utility.html`. Same `utility_slug` / `utility_title` /
  `utility_description` / `utility_help` / `utility_faq` contract.
- `frontend/image-geometry.js` — pure arithmetic: resize modes, cell layout,
  letterboxing and the canvas size guard. No DOM, so it is unit tested directly
  under `node:vm` in `tests/image-geometry.test.cjs`.
- `frontend/zip.js` — the ZIP writer, extracted from
  `gif-frame-downloads.js` so both tracks share one implementation. Entries are
  stored, not deflated, because JPEG, PNG and WebP are already compressed. It
  also owns `uniqueName`, which stops two files called `photo.jpg` overwriting
  each other in the archive.
- `frontend/utilities.css` — renamed from `gif-utilities.css` and now serves
  both tracks. `.tool-utility` is the root class and carries
  `--utility-accent`; `.image-utility` overrides it to the blue image category
  colour.

## Behaviour worth knowing

**Resize** has five modes. Fit, set width, set height and scale by percentage
all preserve the aspect ratio and never crop. Exact size is the only mode that
crops, taking the centre of the image after scaling it to cover the frame. Fit
does not enlarge unless asked; exact size always may, because filling a larger
frame from a smaller source has no other option.

**Compress** will not hand back a larger file. If re-encoding produces something
bigger than the original, and neither the format nor the dimensions were
changed, the original bytes are returned and the summary reports it as kept
unchanged. This matters most for PNG, which has no quality setting: a PNG kept
as PNG is usually a no-op here, and the page says so rather than implying a
reduction it cannot deliver.

Re-encoding through a canvas drops EXIF, including camera model and GPS
coordinates. That is a privacy improvement, but it also means the tool is not
suitable if you need that metadata preserved. The FAQ states it.

**Convert** reads PNG, JPG, WebP, GIF, BMP and AVIF and writes JPG, PNG and
WebP. Where a browser cannot encode a chosen format, `canvas.toBlob` silently
substitutes PNG; `encode()` compares `blob.type` against what was requested and
reports the failure instead of handing over a mislabelled file. An animated GIF
contributes only its first frame — the GIF tools handle animation.

**Contact sheet** scales each image to fit its cell and centres it, so nothing
is cropped. Image order is whatever order the browser reports from the file
picker, usually alphabetical; the sidebar lists the files so it can be checked
before building. Sheets are capped at 8000 px per side and about 40 megapixels,
past which browser canvas support stops being dependable — the tool reports the
size it would have needed rather than exporting a blank image.

## Limits

60 files and 100 MB per run, 50 megapixels per source image, 8000 px and 40
megapixels per output. One result downloads directly; several are bundled into a
single ZIP and each is also listed individually beneath the tool so an
individual file can be saved without unpacking.

## Tests

- `tests/image-geometry.test.cjs` — the layout arithmetic and ZIP naming.
- `tests/e2e/image-utilities.spec.js` — builds PNG fixtures in Node, drives each
  tool, downloads the result, unpacks the ZIP, verifies entry CRCs and reads the
  PNG and JPEG headers to assert real output dimensions. Runs in Chromium,
  Firefox and WebKit. The WebP assertion branches on whether the browser can
  actually encode WebP, so it covers the unsupported-format path too.
- `tests/build/test_site.py::test_bulk_image_utilities_are_discoverable` — the
  sitemap, homepage card, canonical and nav anchor.
