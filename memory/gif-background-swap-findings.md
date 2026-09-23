# GIF background-swap investigation — September 22, 2026

## Symptom and confirmed cause

User supplied a screenshot of a 320×320, ten-frame Homer GIF. The replacement
result was almost solid red with vertical striping and no recognizable subject.
The source GIF itself was not supplied, so that exact file is not reproduced.

The previous investigation reproduced a shared GIF palette-overflow bug consistent
with this symptom. The bundled gifenc quantizer/palette mapper expects one packed
32-bit ABGR value per pixel. `paletteFrame` previously passed separate RGBA bytes.
Once a composed frame exceeded the palette capacity, channels were interpreted as
independent pixels, corrupting both color and spatial layout. Simple few-color
smoke fixtures bypassed this branch and therefore missed the bug.

`frontend/gif-codec.js` now explicitly packs each pixel before both `quantize` and
`applyPalette`. The previous measured gradient mean channel error fell from 137.6
to 1.875 on a 0–255 scale. This fix is already committed; it was not recreated in
this resumed turn.

## State discovered when resuming

- Clean working tree at the start; HEAD `28b3588`.
- Commits since the earlier interruption include the codec/UI repairs (`a353d53`),
  a SAM 3.1 migration (`85f5610`), and text prompts (`28b3588`). Preserve these changes.
- Direct GET of production `/gif-codec.js` confirms the packed-pixel fix is LIVE:
  it contains `gifenc.quantize(packed, ...)`, not the old RGBA-byte call.
- Earlier notes saying the palette fix was only local are historical and are
  superseded by this observation. This does not prove deployment of every later
  model/frontend change.
- Earlier successful real GPU smoke tests used SAM2. They must not be presented
  as validation of the later SAM 3.1/text-prompt implementation. The newer commit
  notes explicitly say those model calls had not run against real weights.

## Current verification

- Shared GIF/background core unit tests: 21 passed.
- Targeted browser cases cover colorful image replacement, animated-background
  timing, and coalesced source frames with multiple local palettes. Run in all
  three browsers; results pending at initial checkpoint (exec 77758).
- Dedicated palette tests and a production-served Chromium colorful-replacement
  check are running. The production browser check mocks only segmentation API
  responses; it exercises the real served frontend/worker/encoder without running
  paid GPU jobs. It does not validate inference quality.

## If the original symptom persists

Obtain the original GIF and resulting exported GIF plus chosen replacement/settings.
Determine whether the downloaded file is corrupt or only the preview. Inspect mask
coverage separately from palette output. A missing/poor subject mask can produce a
plain replacement background, but does not explain color-striping by itself.
Do not roll back newer SAM3/text work or redeploy infrastructure based only on this
screenshot. No code or deployments changed in this resumed investigation so far.

### Verification update

All 21 shared GIF/background unit tests, two dedicated palette tests, and nine
local browser cases passed (three scenarios × three browser engines).
The first attempt to use the current test unchanged against production failed at
its *new text-prompt UI wording* assertion, before export. Production still says
“Select the objects to keep,” while current HEAD says “Describe what to keep.”
This is evidence of frontend version differences, not a reproduced encoder defect.
A temporary production-compatible fixture adjusts only that expected wording and
mock URLs to the HTTPS production origin. Its colorful-export check PASSED: decoded downloaded GIF colors, positions,
frame delays and loop count were correct using the production-served assets.
The temporary fixture was removed after the run.

No additional application-code fix was necessary for the confirmed color bug.
Only this findings file and the handoff entry were added on September 22.
The original Homer GIF and actual inference quality remain unverified.

## SAM 3.1 integration follow-up — September 23, 2026

The prior Transformers migration was not a working SAM 3.1 deployment. Replaced
it with Meta's native multiplex model at pinned source revision
`2345a4ad109ac29c569da749c91d84f10dc08c40`, using
`facebook/sam3.1/sam3.1_multiplex.pt`. Both text and click selection use that
checkpoint, on a separate Python 3.12 / torch 2.7.1 / L4 image. The motion tracker
still uses its existing SAM 2 image. The Hugging Face token was stored only in
Modal secret `gifwidgets-huggingface-token` (`HF_TOKEN`), not in repository files.

Real inference exposed and resolved several integration defects:

- Meta's package needed an explicit `psutil` runtime dependency.
- The upstream predictor passes unsupported `offload_state_to_cpu`; use the
  underlying model's `init_state`/`add_prompt`/`propagate_in_video` API instead.
- Still images use `add_prompt` results directly. Propagating a one-frame video
  can filter away valid text detections.
- GIF propagation sets `is_last_batch=True` to flush buffered tracks.
- Point-only GIFs need empty `cached_frame_outputs` entries before prompting.
  Otherwise upstream `_build_sam2_output` returns empty masks for frames without
  prior text detections. This was observed as a subject present only on frame 0;
  the corrected real GPU run retained it on all six frames.

Verification so far:

- 140 backend tests passed in Docker; 8 background-core tests passed.
- 93 background browser regressions passed across Chromium, Firefox and WebKit
  (these use mocked inference and are distinct from the real GPU checks).
- Production API + real weights: truck image clicked mask ~30% foreground;
  text `truck` ~29.4%; six-frame people GIF with text `person` ~23.8–24.8% per
  frame; clicked person ~9.7–10.4% per frame after the cache fix.
- Actual clicked truck cutout was visually inspected against a blue background.
- `scripts/smoke-segmentation.py` now supports repeatable real inference checks;
  `--require-every-frame` is useful for fixtures whose subjects stay visible.

Modal and Lambda were deployed. Frontend publication and final browser downloads
are pending the renewed AWS SSO session at this checkpoint. Do not describe them
as completed based on the inference checks above.

### Deployment and end-to-end completion

AWS SSO was refreshed, frontend assets published to `gifwidgets-site-prod`, and
CloudFront invalidation created. All 39 production health checks passed.
Unmocked Chromium tests then exercised all four **production** pages with real
SAM 3.1 requests and downloaded the resulting files:

- Remove image: clicked truck; PNG contains 122,305 transparent pixels of 174,592.
- Change image background: text `truck`; PNG has the requested blue background
  (corner RGBA `[20,150,210,255]`) and no transparent pixels.
- Remove GIF: text `person`; six-frame GIF has transparent background and visible
  foreground in every frame.
- Swap GIF: two clicked subjects plus an exclude point; six-frame GIF has the
  requested blue background and visible foreground in every frame.
- Both GIF downloads retain delays `[7,10,13,7,10,13]` centiseconds and loop count 2.

Final first/last-frame cutouts were also visually inspected. Local diagnostic
fixtures and exports are in `/tmp/gifwidgets-sam31-smoke`; the temporary live
browser driver is `/tmp/gifwidgets-live-background.cjs`. These are not repository
assets. The final backend suite passed 140 tests. The SAM 3.1 worker, Lambda
backend, and selection UI are now live; the preceding pending-deployment checkpoint
is superseded. No claim is made about the original unavailable Homer GIF.
