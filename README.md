# GifWidgets

Free browser-based media tools: GIF editor with AI-powered caption tracking, image editor, video trimmer, video-to-GIF converter, and photo format converters. No signup, no mandatory watermark.

**Live site:** [gifwidgets.com](https://gifwidgets.com)

## Architecture

```
                  ┌──────────────┐
                  │  CloudFront  │
                  └──────┬───────┘
                         │
              ┌──────────┼──────────┐
              │          │          │
     ┌────────▼───────┐ │  ┌───────▼────────┐
     │ S3 Static Site │ │  │  Lambda (API)  │
     │ (frontend)     │ │  │  Function URL  │
     └────────────────┘ │  └───────┬────────┘
                        │          │
                 ┌──────▼─────┐    │
                 │  S3 GIF    │◄───┘
                 │  Assets    │
                 └────────────┘

     ┌─────────────────────────────────────────────┐
     │          Modal (Serverless GPU)              │
     │                                              │
     │  ┌─────────────────┐  ┌───────────────────┐ │
     │  │ Tracker (L40S)  │  │ Converter (T4)    │ │
     │  │ SAM 2.1 — AI    │  │ FFmpeg NVENC —    │ │
     │  │ object tracking  │  │ WebM → MP4        │ │
     │  └─────────────────┘  └───────────────────┘ │
     └─────────────────────────────────────────────┘
```

## Project Structure

```
gifcaption/
  frontend/
    index.html             # Homepage
    editor.html            # GIF caption editor
    create.html            # Upload page
    gif.html               # GIF viewer
    editor.js              # Editor orchestrator
    canvas-rendering.js    # Frame rendering
    gif-playback.js        # GIF loading/playback
    gif-timeline.js        # Visual timeline UI
    gif-export.js          # GIF encoding/export
    gif-tracker.js         # AI caption tracking (Modal client)
    gif-tracker-worker.js  # Web Worker for tracker API calls
    editor-state.js        # Centralized state
    app.js                 # Backend API helpers
    styles.css             # Styles
    image-editor/          # Image editing tool
    trim-video/            # Video trimmer (uses converter Modal app)
    video-to-gif/          # Video-to-GIF converter
    gif-editor/            # GIF editing tools
    photo-converter/       # Format converters (jpg↔png↔webp, heic→jpg, etc.)
  backend/
    handler.py             # Lambda API (upload, share, presign, convert)
    requirements.txt
    tracker/
      modal_app.py         # SAM 2.1 video object tracking (L40S GPU)
    converter/
      modal_app.py         # NVENC hardware video encoding (T4 GPU)
  terraform/
    main.tf                # AWS resources (S3, Lambda, CloudFront, Route53, ACM)
    variables.tf           # Input variables
    outputs.tf             # Output values
  scripts/
    deploy-backend.sh      # Deploy Lambda
    deploy-frontend.sh     # Deploy frontend to S3
    deploy-tracker.sh      # Deploy tracker Modal app
    deploy-converter.sh    # Deploy converter Modal app
    deploy-infra.sh        # Apply Terraform
    set-aws-profile.sh     # AWS credential setup
```

## Prerequisites

- [Terraform](https://www.terraform.io/downloads) >= 1.3
- [AWS CLI](https://aws.amazon.com/cli/) configured with credentials
- [Modal](https://modal.com/) CLI (`pip install modal && modal setup`)
- Python 3.11

## Deploying

### AWS Infrastructure

```bash
cd terraform
terraform init
terraform apply \
  -var="site_bucket_name=gifwidgets-site" \
  -var="assets_bucket_name=gifwidgets-assets"
```

Update `API_BASE_URL` in `frontend/app.js` with the Lambda Function URL from `terraform output`.

### Frontend

```bash
aws s3 sync frontend/ s3://gifwidgets-site/ --delete
aws cloudfront create-invalidation --distribution-id <ID> --paths "/*"
```

### Modal GPU Endpoints

```bash
# AI object tracker (SAM 2.1 on L40S)
modal deploy backend/tracker/modal_app.py

# Video converter (FFmpeg NVENC on T4)
modal deploy backend/converter/modal_app.py
```

After deploying, update the endpoint URLs in:
- `frontend/gif-tracker-worker.js` → `MODAL_ENDPOINT`
- `frontend/trim-video/edit/index.html` → `MODAL_CONVERTER_ENDPOINT`

### Lambda Backend

```bash
cd backend
pip install -r requirements.txt -t package/
cp handler.py package/
cd package && zip -r ../../terraform/lambda.zip . && cd ../..
```

Or use the deploy scripts in `scripts/`.

## Cleanup

```bash
cd terraform
terraform destroy \
  -var="site_bucket_name=gifwidgets-site" \
  -var="assets_bucket_name=gifwidgets-assets"
```

> **Note:** Empty the S3 buckets before Terraform can delete them.
