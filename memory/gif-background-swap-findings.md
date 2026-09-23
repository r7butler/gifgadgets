# GIF background-swap investigation — September 22, 2026

## September 23 GIF GPU memory follow-up

- User reported L4 OOM in group_norm: 20.24 GiB allocated, requesting another
  1.27 GiB. Pinned SAM 3.1 builder defaults to 16-frame grounding and postprocess
  batches; adapter now sets both batch sizes to one without resetting tracking
  state or sampling frames. Worker enables expandable CUDA segments and logs
  peak allocated/reserved GPU memory. All 142 backend tests passed.
- Initial patch was local only; user retried before deployment and saw the same
  error. Subsequently deployed successfully to r7butler/gifwidgets-tracker.
- Production API real-model check: repeated six-frame people fixture to 36 frames
  (512x288). Text `person` returned nonempty foreground on all 36 frames, with
  6838 MiB peak allocated / 6992 MiB reserved; processing 14.404 seconds.
- Click (.5,.5) completed all 36 frames without OOM: 6297 MiB peak allocated,
  6992 MiB reserved. Its require-every-frame assertion FAILED because the track
  disappeared on later frames. Do not describe this as a mask-quality pass.
- User's failing source GIF has not been supplied or reproduced. Deployment
  and these tests establish memory behavior for this fixture only.

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

## September 23 handoff: exact lizard GIF empty-mask failure

User requested this handoff before the investigation was complete. Next agent
should continue from these facts; do not claim the cause has been isolated.

### User report and exact source

- Source now available: `/Users/robertb/Downloads/captioned (5).gif`.
  Pillow confirms 220 x 179 pixels, 19 frames. Screenshot shows a green cartoon
  gecko/lizard on a dark background. Text prompt is exactly `lizard`.
- User says this selection used to work. Original failing job:
  `d5f39c80ff504f85a71595d642337ae0`, Sep 23 18:45 UTC.
- Original logs completed 19/19 propagation, then `segment_file` raised
  `ValueError('Nothing matched that selection. Try describing the subject differently, or click it directly.')`.
  All returned masks were empty; peak allocated 6480 MiB, reserved 6648 MiB.
  This particular failure was not an OOM.
- The displayed missing `freqs_cis_real`/`freqs_cis_imag` checkpoint keys are
  buffers initialized from positional frequencies by upstream `vitdet.py`.
  The warning alone is not evidence of broken learned weights.
- CPU broker `backend/tracker/modal_app.py` `/status` catches all exceptions
  and replaces the useful no-match message with generic "Segmentation failed.
  Try a smaller file or different selection." That explains the misleading UI.

### Confirmed reproduction

Ran the existing smoke script against production with the actual supplied GIF:

```
python scripts/smoke-segmentation.py '/Users/robertb/Downloads/captioned (5).gif' --text lizard --output /tmp/gifwidgets-lizard-live.gz --require-every-frame
```

Job `7fa1a9074ea5433b8e8789c67fc990d6` failed with the same generic API error.
The smoke process exited 1 and its finally block attempted cancellation/cleanup.
No successful mask bundle was obtained. This confirms the live symptom, not
whether the detector or tracking filters are responsible.

### Hypotheses and source inspected

- Recent OOM fix sets both `batched_grounding_batch_size` and
  `postprocess_batch_size` from upstream 16 to 1. This is a regression SUSPECT,
  not a proven cause. Need controlled old/current comparison on the same GPU.
- Exact pinned upstream source already exists at `/tmp/gifwidgets-sam31-source`;
  `git rev-parse HEAD` returned `2345a4ad109ac29c569da749c91d84f10dc08c40`.
- Builder config around line 1170: detection threshold .4, new detection
  threshold .65, hotstart delay 15, unmatched/duplicate thresholds 8,
  masklet confirmation enabled. Tracking can discard an initially detected
  object. Need initial result plus raw per-frame/filter diagnostics to tell.
- `_postprocess_output` and `_postprocess_output_batched` both filter removed,
  suppressed, unconfirmed and zero-area objects. Merely changing batch size
  is not proof of changed filtering semantics.

### Temporary comparison script and environment

- Diagnostic script: `/tmp/gifwidgets-lizard-probe.py` (not in repository).
- Imports existing `backend/tracker/modal_app.py` locally to reuse the exact
  `segment_image`, checkpoint and mounted adapter. Guards that local import
  with `if modal.is_local()`; remote sets `diagnostic_image = None`.
- Temporary app `gifwidgets-lizard-diagnostic`, currently configured for L40S,
  timeout 900. Does NOT deploy/change production.
- Planned combinations `(grounding, postprocess)`:
  `(1,1), (16,16), (1,16), (16,1)`.
  Records initial object IDs/probabilities/pixels and all-frame mask coverage.
- Deletes `buffer_cpu_batched` / `buffer_gpu_batched` attributes between runs
  if present. Do NOT set them to None: upstream checks hasattr before indexing.
- Local default `python` / `modal` use Python 3.9 and cannot build this Python
  3.12 image's serialized weight-fetch function. A usable temporary environment
  was created at `/tmp/gifwidgets-modal-diagnostic-venv` using Python 3.12.2.
  Installed `modal==1.2.6` (same as existing CLI), `cbor2<6` and dependencies.
  Newer Modal install attempts failed because cbor2 6 needed missing Rust.
- Run command (network escalation needed in sandbox):

```
MODAL_PROFILE=r7butler /tmp/gifwidgets-modal-diagnostic-venv/bin/modal run /tmp/gifwidgets-lizard-probe.py
```

### Latest diagnostic failure: FIX BEFORE RETRY

L40S run https://modal.com/apps/r7butler/main/ap-R3Oi4tFQjAd3EioYC7m2Tb
loaded weights and completed the first `(1,1)` inference at 19:14 UTC, BUT
script failed in its `finally` before printing or returning the comparison.

`segmenter.release()` was outside `torch.inference_mode()`, while the session
had been created inside it. Upstream `reset_state` mutates inference tensors,
raising:

```
RuntimeError: Inplace update to inference tensor outside InferenceMode is not allowed.
```

Fix the TEMPORARY SCRIPT's finally to wrap `segmenter.release()` in
`with torch.inference_mode():`. Production already wraps the whole segment_file
call (including release) in inference_mode; this is a diagnostic-script bug,
not the user's regression. No comparison results were saved or printed, and
`/tmp/gifwidgets-lizard-results.json` is not yet a successful artifact.
The remaining three combinations have NOT run.

At handoff the CLI session ID was `65123`; it had printed the remote traceback
and "Stopping app - uncaught exception raised locally". It may need a final
poll to finish. Earlier A100-80GB run was stopped explicitly after a long startup
wait; earlier remote-import-path failure also stopped. Their apps:
`ap-ZNpzbSm5ieajWP8AjJNWXt` and `ap-BMkk2rxRFyVqruxTtmnDci`.
L40S started promptly, so prefer it for the comparison.

### Next steps and workspace state

1. Fix diagnostic cleanup context and rerun comparison. Filter huge upstream
   initial weight-loading logs when collecting output; final 64 missing buffers
   warning is the relevant one after full checkpoint load.
2. If both batch settings fail, instrument initial detection and tracking
   filtering; test a still first frame and a direct keep click as controls.
   If current fails and old works, use cross-combinations to isolate which
   setting changes behavior. Keep the low-memory objective.
3. Apply a justified fix only after evidence. The misleading API error can
   separately be repaired while keeping unexpected internal errors sanitized.
4. Validate actual GIF on deployed L4 before claiming production is fixed.
   No deployment was performed during this investigation.

No repository application code or tests were changed in this turn. Existing
uncommitted changes MUST be preserved: `backend/tracker/modal_app.py`,
`backend/tracker/segmentation.py`, `tests/backend/test_modal_auth.py`,
`tests/backend/test_segmentation.py`, and this memory file (prior memory changes
plus this handoff). Existing changes belong to the previous OOM fix.
No new unit tests were run; the exact real production request failed as above.
User explicitly asked to save progress for another agent, so stop investigation
work after saving this handoff.

## September 23 resolution: lizard GIF empty mask

Cause isolated. It is model semantics, not a regression or pipeline bug.

- Fixed the temporary probe's cleanup (`release()` inside `inference_mode`) and
  ran all four `(grounding, postprocess)` batch combinations on L40S
  (app `ap-4Cq2vbw7HVoB8DBPNuqzaf`). All four: zero initial detections on
  frame 0 and 0.0 coverage on all 19 frames. The OOM batch-size fix is cleared.
- Model input was inspected visually: `load_frames` output is the intact,
  correctly coloured gecko. Not an input/flattening problem.
- `suppress_det_close_to_boundary` only tests box centres (2.5% margin), so it
  does not affect this centred subject.
- Second probe (`probe2.log` in that session's scratchpad; not a repo asset)
  temporarily lowered all detection thresholds to 0.05 on frame 0. Top scores:
  `lizard` 0.081, `green lizard` 0.110, still-image `lizard` 0.107 versus
  `gecko` 0.801, `frog` 0.902, `animal` 0.867, `cartoon character` 0.914,
  `creature` 0.910. Production threshold is 0.4 (new tracks 0.65), so
  `lizard` correctly returns nothing. A keep click at (.5,.55) tracked the
  subject on all 19 frames at 39–44% coverage with default thresholds.
- "Used to work" could not be verified. Text prompts never ran on real weights
  before the native SAM 3.1 migration, so it may refer to clicking.
- Lowering thresholds or accepting the best sub-threshold detection was NOT
  done: at 0.08 almost any prompt would select something.

Repository fix (local, not yet deployed): segmentation.py adds
`SelectionError(ValueError)` for user-safe messages. `segment_media` returns
`{'error': message}` for them (the CPU broker cannot unpickle worker-module
exception types), the broker `/status` relays that as `failed` with the real
message, and Lambda/frontend already pass `error` through. Unexpected errors
stay generic. Failure log gains `message` only for SelectionError (never
prompt/URLs). 145 backend tests pass. Needs a Modal deploy of
`backend/tracker/modal_app.py`; no Lambda or frontend change is required.

Deployed Sep 23 to r7butler/gifwidgets-tracker (Modal only). Production smoke
with the exact GIF: `lizard` now fails with "Nothing matched that selection..."
instead of the generic message; `gecko` succeeded on all 19 frames at
33–39% coverage. Changes remain uncommitted.
