# Image and GIF backgrounds

Continues the work in commit `9d37295`. Modal and the AWS Lambda backend are now
deployed (September 18, 2026); the tool pages were already live. Real browser-to-GPU
PNG and GIF tests passed after correcting the backend deployment/configuration.
The latest cancellation-race frontend refinements remain local until published.

| Tool | Route | Output |
| --- | --- | --- |
| Remove image background | `/remove-image-background/` | Transparent PNG |
| Change image background | `/change-image-background/` | PNG with a photo or solid color |
| Remove GIF background | `/remove-gif-background/` | Transparent animated GIF |
| Swap GIF background | `/swap-gif-background/` | GIF with a still image, repeating GIF, or solid color |

Select a keep point on each subject, using **Add another subject** for separate subjects.
Use **Keep area** or **Exclude area** beside the preview to refine the active subject,
then **Preview cutout**. A switchable green overlay shows the detected selection. Coordinate inputs provide
a keyboard alternative to clicking. GIF selections start on the first frame.
Exports retain source dimensions. GIF removal retains frame delays and loop count;
animated replacements merge foreground/background change times over one source
cycle and repeat with the source loop setting. When combining animations, zero
frame delays use a 100 ms fallback. GIF edges are binary, not partially transparent.

The tools use the existing themed workspace, responsive previews and settings,
homepage Image/GIF Tools cards, navigation, canonical metadata, FAQ schema,
sitemap and consent-based funnel events. Masks are reused for local background
changes and exports; replacement colors, files and fit changes refresh the preview
automatically. Download sits directly beneath the result. Selection changes invalidate the masks and require another
AI run. Background files and exported media stay on the device.

## Processing and limits

- `frontend/background-utilities.js`: selections, upload, asynchronous polling,
  cancellation, retry of transient status failures and preview/download lifecycle.
- `frontend/background-worker.js`: decoding, composition and real PNG/GIF encoding.
  Shared mask/timing helpers live in `background-core.js`; GIF disposal decoding
  and palette mapping live in `gif-codec.js`.
- `backend/handler.py`: private upload URLs, quota, durable submission deduplication,
  status and cancellation. Browser-supplied remote URLs and Modal IDs are ignored.
- `backend/tracker/segmentation.py`: coalesces all source frames with Pillow, applies
  EXIF orientation, fits inference images to a 1024-pixel side, prompts each object,
  unions masks, and returns gzip-compressed, bit-packed masks for every frame.
- `backend/tracker/modal_app.py`: authenticated CPU broker launches a separate L4
  GPU job. Polling never occupies a GPU. Segmentation runs SAM 3.1 through
  `transformers`, on its own image: the motion tracker keeps its pinned SAM 2 stack,
  so neither feature can break the other's dependencies and the tracker's cold start
  does not pay for SAM 3 weights. The gated `facebook/sam3.1` checkpoint is baked
  into the image at build time from the `gifwidgets-huggingface-token` secret.

**There is no frame-count cap or sampling.** Existing safeguards are 100 MB per
input, a 256 MiB estimated media-working budget in the browser, 32 selectable
objects, 128 points per object, and a one-hour GPU execution timeout. Encoded output
also has a 256 MiB check. These checks are not a guarantee against browser/server
memory exhaustion: canvases, encoders, downloaded masks and model state also use
memory. GIF pixels are decoded on demand using reusable buffers, rather than
storing every expanded frame. The media estimate includes compressed inputs plus
a fixed number of buffers based on pixel dimensions; masks and encoded output
still grow with animation length. Failure is reported rather than silently
dropping frames.

Source uploads are copied to immutable job-specific working keys before compute.
Successful status checks clean up source files; cancellation also deletes masks.
Completed masks remain available for download until the storage expiry rule takes
effect. Uploads abandoned before submission and jobs whose tabs close rely on the
existing private `track/` one-day S3 lifecycle rule. Lifecycle deletion is asynchronous.
Closing a tab is not cancellation; use **Cancel processing** to terminate compute.
If submission/cancellation cannot be confirmed, the UI says so; the server timeout
still applies. The `segment` entry in `FEATURES_DISABLED` stops new work while
allowing status and cancellation of existing jobs.

## GPU cost input

Keep the requested no-frame-cap behavior initially and measure real usage. Frame
count, object count, model startup, retained tracking state and repeated selections
all affect cost. SAM 3.1 is roughly 848M parameters against SAM 2.1 Tiny's 39M, so
per-frame inference is materially more expensive than the figures first measured here
— re-measure before assuming the old cost envelope holds, particularly for long GIFs,
where cost scales with frame count. In particular, inference frames load as 1024 × 1024 tensors:
a small source GIF can still create substantial server RAM pressure over many
frames. CPU offloading moves memory out of VRAM; it does not make that memory free
or eliminate growth with animation length. Client composition/encoding also grows
with output dimensions and frame count, including extra frames from a replacement GIF.

The existing `segmentation_started` / `segmentation_complete` logs include job IDs,
frame/object counts, dimensions, input/mask bytes, processing time and total time.
This finish pass adds `segmentation_failed` with elapsed time and error type. Logs
do not intentionally record selection points, media or presigned URLs. Hard process
termination/OOM may prevent a final log, so compare these with Modal task failures.

Monitor total daily spend, median/p95 runtime, failure/cancellation rate and runtime
per frame, grouped by object count and dimensions. Use Modal's actual billing data
and current account rates rather than claiming a flat price per GIF. A rough model
is billed GPU seconds × GPU rate, plus CPU/RAM, startup/idle tail and AWS costs.
`total_seconds` measures function execution, not every billable container second;
the worker's 60-second scale-down window can contribute an idle tail. Mask reuse
already avoids GPU expense when only the replacement background changes.

The API retains its shared 20 compute admissions/hour/IP quota and WAF protection.
These are not a global spending cap. If costs or failure rates become unacceptable,
use the segment kill switch while investigating; consider concurrency/usage budgets
or a different memory strategy before introducing a frame cap against the requested
behavior. No new cap, spending alert or infrastructure deployment was applied here.

## Deployment

1. Deploy `scripts/deploy-tracker.sh` with the existing Modal profile and
   `gifwidgets-modal-api-key` secret. This publishes both tracking and segmentation.
2. Verify Terraform's `modal_segmenter_url` points to the resulting **CPU broker**
   (`segment_api`), and retain the existing tracking URL. Apply infrastructure so
   Lambda receives `MODAL_SEGMENTER_URL` and the matching API key.
3. Run `scripts/deploy-backend.sh`; it includes `segmentation.py` in the Lambda zip
   for prompt validation. On a fresh installation, build the zip before applying
   infrastructure, following the README's bootstrap instructions.
4. Run `scripts/deploy-frontend.sh` to build/publish templates and invalidate caches.
5. Smoke-test one real image and a short GIF: select a subject, inspect all output
   frames, replace a background without another GPU submission, and cancel a job.
   Verify the Modal completion/failure logs and private working-file cleanup.

Local automated tests mock the remote inference boundary. They prove prompt/API
contracts, masks, composition and decoded exports; they do not prove model quality,
GPU image startup, live secrets, IAM, S3 CORS or deployed endpoint configuration.

## Validation

```sh
python3 build.py
python3 -m pytest tests/backend tests/build -q
npm run test:unit
npm run test:background-utilities
```

Python requires Jinja2, pytest, boto3, numpy, Pillow, moto with DynamoDB/S3 support,
FastAPI and httpx; use an isolated environment or the repository's Docker images.
Playwright requires Chromium, Firefox and WebKit installed. Browser tests inspect
actual downloaded pixels, alpha, frame counts, timing and loop count, plus prompt
refinement, cancellation/re-export, invalid masks/backgrounds, service failures and
transient polling recovery. Build tests check routes, discovery and frontend wiring.
CI now runs media unit tests and build tests as well as its existing backend and
Chromium integration suites.

Verified in this finishing pass: 132 backend/build tests (plus four subtests),
22 JavaScript unit tests, 36 background-tool browser cases and 75 existing GIF/image
browser regression cases passed. Browser coverage spans Chromium, Firefox and
WebKit. Desktop and mobile portrait previews were also inspected; no horizontal
overflow was observed. `git diff --check` passed. The Python test dependencies emit
two deprecation warnings, with no test failures.

## September 18 live diagnosis and repair

The site served the new tool pages while Lambda still ran older code: POST
`/api/segment/presign` returned 404. Deployed the tested backend code, configured
`MODAL_SEGMENTER_URL`, and synchronized the existing `IP_HASH_SALT` from Terraform
secrets into Lambda. Existing environment values were preserved with revision guards.
No secret values were printed. The AWS SSO session was valid by the time of repair.

The real browser tests clicked two separate objects in a 320 × 180 synthetic image
and a three-frame GIF. Downloaded results retained both subjects (alpha 255), removed
the background between them (alpha 0), and preserved all three GIF frames and loop
count 2. This validates actual mouse coordinates, upload, API, GPU, mask download and
export; it is not a broad assessment of segmentation quality on photographs.

All three Modal broker routes reject unauthenticated requests. The latest local
regression run passed 127 backend tests and 39 background browser cases across
Chromium, Firefox and WebKit.

The SAM 3.1 swap is verified as far as it can be without a GPU: validation, frame
extraction, prompt arithmetic and mask packing are covered by
`tests/backend/test_segmentation.py` against a stubbed model. The model calls
themselves — `init_video_session`, `add_inputs_to_inference_session`,
`propagate_in_video_iterator`, `post_process_masks` — are written against the
documented transformers API and have not been executed against real weights. Deploy
to Modal and run `scripts/smoke-test.sh` before trusting them.

`scripts/smoke-test.sh` now checks all four pages and all four segmentation API
routes using invalid requests that reach validation without launching paid work.
See `memory/background-debug-progress.md` for the latest operational handoff.

Live smoke checks after repair: **39 passed, 0 failed**.


## Color corruption and selection UX repair

The bundled `gifenc.quantize` and `applyPalette` functions expect packed 32-bit
ABGR pixels. `gif-codec.js` passed RGBA bytes, so frames exceeding the palette
limit were interpreted as individual red-channel pixels and then mapped with
incorrect spatial positions. This explains the red/striped failure pattern.
Explicit pixel packing fixes both GIF background tools and other GIF utilities
that share this encoder. PNG exports do not use this palette path.

Regression coverage now checks decoded colors and positions after quantization,
transparent pixels, non-aligned typed-array input, colorful image replacements,
and coalesced GIF frames with different local palettes. The gradient fixture's
mean absolute channel error fell from 137.6 to 1.875 (on a 0–255 scale).

All four tools now have nearby Keep/Exclude buttons, a selected-subject overlay,
clearer preview/download actions, automatic local background previews, and guided
retry messaging for empty masks. Loading another source resets replacement-file
mode; selecting another subject resets point mode to Keep. Keyboard coordinate
entry remains available. Selection changes still require an explicit AI run.

These changes are local and have not been deployed. Browser inference is mocked;
these regressions validate rendering and interaction, not model quality on the
user's exact GIF.

Validation for this repair: 63 background browser cases and 54 shared GIF browser
cases passed across Chromium, Firefox and WebKit; 42 JavaScript unit tests and
12 build tests (plus four subtests) passed. The 52-page build and diff checks passed.


## GIF loading below the advertised file-size limit

A 39 MB input was rejected by the previous eager decoder because the admission
estimate was `width × height × 4 × (frame count + 3) > 256 MiB`. The 100 MB limit
measured compressed file size; it did not guarantee the decoded frames would fit.

The background worker now retains compressed GIF data and frame timing metadata,
and decodes source/replacement frames on demand. The shared streaming compositor
reuses frame buffers, handles GIF disposal, and resets when an animated background
loops or a user exports again. Existing GIF utilities retain their collecting API.
Read-only block parsing uses views instead of copying the whole compressed file.
No frame cap, frame sampling, automatic resize, or raised memory ceiling was added.

Upload copy and memory errors now distinguish file size from editing memory and
identify oversized dimensions. Large dimensions, masks, GPU resources and output
size can still limit processing. This is an estimate, not a measurement of free
browser memory. These changes remain local until deployed.

Validation: 126 browser cases passed across Chromium, Firefox and WebKit,
including a synthetic 39 MiB/270-frame GIF loaded as both source and replacement,
complete streaming exports/re-exports under a bounded budget, and informative
oversized-dimension errors. Also passed: 45 unit tests, 12 build tests plus four
subtests, the 52-page build, JavaScript syntax checks and `git diff --check`.
The 39 MiB fixture uses a valid comment block to reach that compressed size; its
real expanded frames exceed the former cap. It is not the user's original GIF.


## Exclude selection guidance

Exclude points refine the currently selected subject and require at least one
Keep point on that same subject. They are model prompts, not a pixel eraser or
an independent selection of background to remove. An Exclude-only subject now
shows a warning beside Preview cutout immediately. Attempting a preview selects
the subject missing a Keep point and switches to Keep mode without deleting any
points. Mode guidance also identifies the active subject, and Exclude mode uses
red styling to match its markers.

Mixed positive/negative labels and coordinates are covered through the predictor
boundary, including Exclude-before-Keep ordering. These checks use mocked model
output and do not establish segmentation quality on the user's media. The user's
specific failure mode has not yet been confirmed. Changes remain local.
