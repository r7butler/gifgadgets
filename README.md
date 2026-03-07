# GifCaption

Upload GIFs and add captions at specific timestamps.

## Architecture

```
                  ┌──────────────┐
                  │  CloudFront  │
                  └──────┬───────┘
                         │
              ┌──────────┴──────────┐
              │                     │
     ┌────────▼────────┐   ┌───────▼────────┐
     │ S3 Static Site  │   │  Lambda (API)  │
     │ (frontend)      │   │  Function URL  │
     └─────────────────┘   └───┬────────┬───┘
                               │        │
                       ┌───────▼──┐  ┌──▼──────────┐
                       │ S3 GIF   │  │  DynamoDB    │
                       │ Assets   │  │  (metadata)  │
                       └──────────┘  └──────────────┘
```

**Flow:**
1. User opens site → CloudFront serves static frontend from S3
2. User uploads GIF → frontend calls Lambda API `POST /upload`
3. Lambda stores the GIF in the assets S3 bucket
4. Lambda writes metadata to DynamoDB
5. User views GIF → frontend calls `GET /gif/{id}` → Lambda returns metadata

## Prerequisites

- [Terraform](https://www.terraform.io/downloads) >= 1.3
- [AWS CLI](https://aws.amazon.com/cli/) configured with credentials
- Python 3.11 (for local development / packaging)
- A Unix-like shell or PowerShell

## Project Structure

```
gifcaption/
  frontend/          # Static HTML/JS/CSS site
    index.html       # Homepage
    create.html      # Upload page
    gif.html         # GIF viewer page
    app.js           # API helper functions
    styles.css       # Styles
  backend/           # Lambda function code
    handler.py       # Request handler
    requirements.txt # Python dependencies
  terraform/         # Infrastructure as Code
    main.tf          # Resources
    variables.tf     # Input variables
    outputs.tf       # Output values
  README.md
  .gitignore
```

## Deploying

### 1. Build the Lambda ZIP

Package the backend code into a zip file for Terraform to deploy:

```bash
cd backend
pip install -r requirements.txt -t package/
cp handler.py package/
cd package
zip -r ../../terraform/lambda.zip .
cd ../..
```

On **Windows PowerShell**:

```powershell
cd backend
pip install -r requirements.txt -t package/
Copy-Item handler.py -Destination package/
Compress-Archive -Path package/* -DestinationPath ../terraform/lambda.zip -Force
cd ..
```

### 2. Configure Terraform Variables

S3 bucket names must be globally unique. Edit `terraform/variables.tf` or pass overrides:

```bash
cd terraform
terraform init
terraform plan \
  -var="site_bucket_name=my-gifcaption-site" \
  -var="assets_bucket_name=my-gifcaption-assets"
```

### 3. Deploy Infrastructure

```bash
terraform apply \
  -var="site_bucket_name=my-gifcaption-site" \
  -var="assets_bucket_name=my-gifcaption-assets"
```

Note the outputs:

```
site_bucket_name   = "my-gifcaption-site"
assets_bucket_name = "my-gifcaption-assets"
cloudfront_url     = "https://d1234abcdef.cloudfront.net"
lambda_function_url = "https://abc123.lambda-url.us-east-1.on.aws/"
```

### 4. Update the Frontend API URL

Open `frontend/app.js` and set `API_BASE_URL` to the Lambda Function URL (without trailing slash):

```js
const API_BASE_URL = "https://abc123.lambda-url.us-east-1.on.aws";
```

### 5. Upload Frontend to S3

```bash
aws s3 sync frontend/ s3://my-gifcaption-site/ --delete
```

### 6. Invalidate CloudFront Cache (optional)

```bash
aws cloudfront create-invalidation \
  --distribution-id <DISTRIBUTION_ID> \
  --paths "/*"
```

## Testing the API

### Upload a GIF

```bash
# Base64-encode a GIF and upload
BASE64=$(base64 -w 0 path/to/sample.gif)

curl -X POST "https://abc123.lambda-url.us-east-1.on.aws/upload" \
  -H "Content-Type: application/json" \
  -d "{\"file\": \"$BASE64\", \"filename\": \"sample.gif\"}"
```

Expected response:

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "gif_url": "https://my-gifcaption-assets.s3.amazonaws.com/gifs/550e8400-e29b-41d4-a716-446655440000.gif",
  "created_at": "2026-03-06T12:00:00+00:00"
}
```

### Fetch a GIF

```bash
curl "https://abc123.lambda-url.us-east-1.on.aws/gif/550e8400-e29b-41d4-a716-446655440000"
```

Expected response:

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "gif_url": "https://my-gifcaption-assets.s3.amazonaws.com/gifs/550e8400-e29b-41d4-a716-446655440000.gif",
  "created_at": "2026-03-06T12:00:00+00:00"
}
```

## Terraform Commands Reference

| Command | Description |
|---|---|
| `terraform init` | Initialize the working directory |
| `terraform plan` | Preview changes |
| `terraform apply` | Apply changes |
| `terraform output` | Show output values |
| `terraform destroy` | Tear down all resources |

## Cleanup

```bash
cd terraform
terraform destroy \
  -var="site_bucket_name=my-gifcaption-site" \
  -var="assets_bucket_name=my-gifcaption-assets"
```

> **Note:** You must empty the S3 buckets before Terraform can delete them.
