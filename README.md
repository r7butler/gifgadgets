# GifGadgets

Free browser-based media tools: GIF editor with AI-powered caption tracking, image editor,
video-to-GIF converter, and photo format converters. No signup, no mandatory watermark.

**Live site:** [gifgadgets.com](https://gifgadgets.com) — `gifwidgets.com` and
`www.gifgadgets.com` permanently redirect to it.

## Architecture

Everything is served from a single CloudFront distribution on `gifgadgets.com`. The
static site comes from S3; `/api/*` is routed to a Lambda Function URL. A second
distribution serves public media at `content.gifwidgets.com`.

```
                        ┌──────────────┐
   gifgadgets.com  ───► │  CloudFront  │
                        └──────┬───────┘
                               │
                 ┌─────────────┴─────────────┐
                 │ /*                        │ /api/*
        ┌────────▼────────┐        ┌─────────▼────────┐
        │ S3 static site  │        │ Lambda (API)     │
        │ gifwidgets-     │        │ Function URL     │
        │ site-prod       │        │ + WAF rate limit │
        └─────────────────┘        └─────────┬────────┘
                                             │ presigned URLs
                        ┌────────────────────┼────────────────────┐
                        │                    │                    │
               ┌────────▼────────┐  ┌────────▼────────┐  ┌────────▼────────┐
               │ S3 assets       │  │ DynamoDB        │  │ Modal (GPU)     │
               │ gifwidgets-     │  │ job / rate-limit │  │ Tracker  (L4)   │
               │ assets-prod     │  │ records          │  │ Converter (T4)  │
               └────────┬────────┘  └─────────────────┘  └─────────────────┘
                        │
       content.gifwidgets.com (CloudFront) ──► share/ and gifs/ only
```

### How Modal is called

Lambda brokers every Modal request; browsers never talk to Modal directly.

1. Browser asks Lambda for a presigned S3 `PUT` and uploads its frames.
2. Browser calls `/api/track/submit`.
3. Lambda presigns a short-lived `GET` for that one object and sends the URL to Modal,
   along with a shared secret in the `X-Modal-Api-Key` header.
4. Modal fetches over plain HTTPS, runs inference, and returns the result.
5. Lambda deletes the S3 object.

**Modal holds no AWS credentials.** Each presigned URL grants access to a single object
for a few minutes, so there are no long-lived access keys to rotate or leak.

### Bucket exposure

The assets bucket is only readable through CloudFront under `share/*` and `gifs/*`.
The `convert/*` and `track/*` prefixes are internal working space reached solely by
Lambda and presigned URLs, and a lifecycle rule expires both after one day.

## Project structure

```
gifwidgets/
  frontend/                # Built output — deployed to S3 as-is
    index.html             # Homepage
    editor.html            # GIF caption editor
    gif.html               # GIF viewer
    app.js                 # apiFetch helper (adds x-amz-content-sha256)
    editor.js              # Editor orchestrator
    canvas-rendering.js    # Frame rendering
    gif-playback.js        # GIF loading/playback
    gif-timeline.js        # Visual timeline UI
    gif-export.js          # GIF encoding/export (client-side, gif.js)
    gif-tracker.js         # AI caption tracking client
    gif-tracker-worker.js  # Web Worker for tracker API calls
    editor-state.js        # Centralized state
    crop-gif/  gif-editor/  gif-editor-advanced/  gif-maker/
    gif-resizer/  image-editor/  photo-converter/  video-to-gif/
  src/
    pages/                 # Jinja2 page sources — edit these, not frontend/
    templates/             # Shared layout partials
  backend/
    handler.py             # Lambda API (upload, share, presign, track broker)
    requirements.txt
    tracker/modal_app.py   # SAM 2.1 object tracking + SAM 3.1 segmentation (L4 GPU)
    converter/modal_app.py # FFmpeg NVENC encoding (T4 GPU) — see note below
  terraform/
    main.tf                # S3, Lambda, CloudFront, WAF, DynamoDB, Route53
    variables.tf           # Input variables (defaults target production)
    outputs.tf
  scripts/                 # Deploy helpers — see Deploying
  build.py                 # Renders src/pages/**/*.html into frontend/
```

`frontend/` is generated. Edit `src/pages/` and rebuild; editing `frontend/` directly
gets overwritten on the next deploy.

> **Naming:** S3 buckets, `project_slug`, and the Modal app names still use
> `gifwidgets`. That is deliberate — they are invisible to users and to search
> engines, and renaming buckets would force recreation and a data copy.
> The public brand and domain live in `site.config.json`.

> **Note on the converter:** the Modal converter app and the Lambda routes
> `/convert/presign-upload` and `/convert-to-mp4` are not reachable from the current
> UI — video-to-GIF encodes client-side with gif.js. The app is deployed and
> credential-free, but nothing calls it. Wire it up or remove it.

## Prerequisites

- [Terraform](https://www.terraform.io/downloads) >= 1.10 (S3 native state locking)
- [AWS CLI v2](https://aws.amazon.com/cli/), signed in via IAM Identity Center
- [Modal CLI](https://modal.com/) (`pip install modal`)
- Python 3.11, Docker (for the frontend build)

### AWS access

Credentials come from IAM Identity Center (SSO) — there are no static access keys.

```bash
aws sso login --profile gifwidgets
source ./scripts/set-aws-profile.sh     # exports AWS_PROFILE, prints the account
```

The deploy scripts default to the `gifwidgets` profile and fail early with a clear
message if the session has expired. Terraform also fails fast if the credentials
resolve to an account other than `expected_account_id`.

### Modal workspace

The apps live in the `r7butler` workspace. If that is not your active Modal profile,
scope commands rather than switching globally:

```bash
export MODAL_PROFILE=r7butler
modal profile list      # confirm which workspace is active
```

### Secrets

Terraform reads two values from `terraform/secrets.auto.tfvars` (gitignored):

```hcl
github_issue_poster_pat = "..."   # fine-grained PAT, used by the Report an Issue button
modal_api_key           = "..."   # shared secret, openssl rand -hex 32
```

`modal_api_key` must match the `MODAL_API_KEY` key in the Modal secret
`gifwidgets-modal-api-key`. Lambda sends it as `X-Modal-Api-Key`; the Modal apps
reject requests that do not match.

The Modal apps refuse startup when `MODAL_API_KEY` is missing or empty.

## Deploying

State lives in S3 (`gifwidgets-tfstate-425750453898`) with native locking, so
`terraform init` needs no backend flags. Bucket names, domains, the ACM certificate,
and the hosted zone are all defaults in `variables.tf` — no `-var` flags required.

### 1. FFmpeg Lambda layer

Only needed on a fresh environment or to pick up a new FFmpeg release.

```bash
./scripts/build-ffmpeg-layer.sh
```

Downloads a static FFmpeg build, verifies the publisher's MD5, and pins the zip's
SHA-256 in `terraform/ffmpeg-layer.sha256` so an unexpected upstream change fails
loudly. Pass `FFMPEG_ALLOW_UPDATE=1` to accept a new build. `ffprobe` is deliberately
excluded — nothing calls it, and including it pushes the zip past Lambda's 50 MB
direct-upload limit.

### 2. Lambda + infrastructure

```bash
./scripts/deploy-backend.sh     # builds terraform/lambda.zip, updates the function
./scripts/deploy-infra.sh       # terraform apply
```

On a brand-new environment run `deploy-backend.sh` first so `lambda.zip` exists, then
`deploy-infra.sh` to create the function. The first `deploy-backend.sh` run ends with
an error from `update-function-code` because the function does not exist yet — expected.

### 3. Modal GPU endpoints

```bash
export MODAL_PROFILE=r7butler
./scripts/deploy-tracker.sh
./scripts/deploy-converter.sh
```

The endpoint URLs are derived from the workspace name. If they change, update
`modal_tracker_url` / `modal_segmenter_url` / `modal_converter_url` in `variables.tf` and re-apply so Lambda
points at the new endpoints. Nothing in the frontend references Modal URLs.

The tracker deployment also includes the asynchronous background segmentation
service used by `/remove-image-background/`, `/change-image-background/`,
`/remove-gif-background/` and `/swap-gif-background/`. See
[background tools](docs/background-utilities.md) for deployment order, validation,
limits and GPU cost monitoring. Run `npm run test:background-utilities` after a
template build to verify exports in Chromium, Firefox and WebKit.

### 4. Frontend

```bash
./scripts/deploy-frontend.sh
```

Renders `src/pages/` through Jinja2 in Docker, syncs to the site bucket, and issues a
CloudFront invalidation. No URL injection is needed — the API is same-origin at `/api`.

## Notes

**`x-amz-content-sha256` is required on API calls with a body.** CloudFront's OAC does
not hash the request body when signing to a Lambda Function URL, so the caller must
supply the payload hash or the request is rejected with a 403 signature error. The
`apiFetch` helper in `frontend/app.js` handles this; anything calling the API outside
that helper — curl, tests, scripts — has to set it too.

**GPU costs are separate from AWS.** Both Modal apps scale to zero, so idle is free,
but active GPU time is billed by Modal. The WAF rate limit on `/api` is the main thing
standing between a scraper and a surprising bill.

## Cleanup

```bash
cd terraform
terraform destroy
```

> Empty the S3 buckets first — Terraform cannot delete non-empty buckets. The state
> bucket is not managed by Terraform and must be removed separately.
