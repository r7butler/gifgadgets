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

Select a keep point on each subject, using **Add object** for separate subjects.
Additional keep/exclude points refine the active object. Coordinate inputs provide
a keyboard alternative to clicking. GIF selections start on the first frame.
Exports retain source dimensions. GIF removal retains frame delays and loop count;
animated replacements merge foreground/background change times over one source
cycle and repeat with the source loop setting. When combining animations, zero
frame delays use a 100 ms fallback. GIF edges are binary, not partially transparent.

The tools use the existing themed workspace, responsive previews and settings,
homepage Image/GIF Tools cards, navigation, canonical metadata, FAQ schema,
sitemap and consent-based funnel events. Masks are reused for local background
changes and exports. Selection changes invalidate the masks and require another
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
  GPU job. Polling never occupies a GPU. SAM2 is pinned to a commit with compatible
  PyTorch/torchvision versions; its dependency requirements are recorded in
  [upstream setup.py](https://github.com/facebookresearch/sam2/blob/2b90b9f5ceec907a1c18123530e92e794ad901a4/setup.py).

**There is no frame-count cap or sampling.** Existing safeguards are 100 MB per
input, a 256 MiB decoded-media working budget in the browser, 32 selectable
objects, 128 points per object, and a one-hour GPU execution timeout. Encoded output
also has a 256 MiB check. These checks are not a guarantee against browser/server
memory exhaustion: canvases, encoders, downloaded masks and model state also use
memory. Failure is reported rather than silently dropping frames.

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
all affect cost. In particular, SAM2 loads inference frames as 1024 × 1024 tensors:
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

The deployed SAM2 image lacks its optional `_C` hole-filling extension; inference
works but that optional post-processing is skipped. All three Modal broker routes
reject unauthenticated requests. The latest local regression run passed 122 backend
tests and 39 background browser cases across Chromium, Firefox and WebKit.

`scripts/smoke-test.sh` now checks all four pages and all four segmentation API
routes using invalid requests that reach validation without launching paid work.
See `memory/background-debug-progress.md` for the latest operational handoff.

Live smoke checks after repair: **39 passed, 0 failed**.
