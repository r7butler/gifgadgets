#!/usr/bin/env bash
set -euo pipefail

# Ensure we're using the personal AWS profile
if [[ "${AWS_PROFILE:-}" != "personal" ]]; then
  echo "==> Setting AWS_PROFILE=personal"
  export AWS_PROFILE=personal
fi

# Deploy frontend: build templates and sync to S3.
# The API is routed through CloudFront at /api (same origin), so no URL injection needed.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TF_DIR="$PROJECT_DIR/terraform"
FRONTEND_DIR="$PROJECT_DIR/frontend"

# Resolve the site bucket name
SITE_BUCKET=$(cd "$TF_DIR" && terraform output -raw site_bucket_name)
echo "==> Site bucket: $SITE_BUCKET"

# Build HTML from Jinja2 templates
echo "==> Building HTML from templates..."
docker build -f "$PROJECT_DIR/Dockerfile.build" -t gifwidgets-build "$PROJECT_DIR"
docker run --rm -v "$PROJECT_DIR:/app" gifwidgets-build

# Sync to S3
echo "==> Syncing frontend to s3://$SITE_BUCKET/ ..."
aws s3 sync "$FRONTEND_DIR/" "s3://$SITE_BUCKET/" --delete

# Invalidate CloudFront cache
echo "==> Invalidating CloudFront cache..."
CF_DOMAIN=$(cd "$TF_DIR" && terraform output -raw cloudfront_url | sed 's|https://||')
DISTRIBUTION_ID=$(aws cloudfront list-distributions \
  --query "DistributionList.Items[?DomainName=='${CF_DOMAIN}'].Id" \
  --output text)

if [[ -n "$DISTRIBUTION_ID" ]]; then
  aws cloudfront create-invalidation \
    --distribution-id "$DISTRIBUTION_ID" \
    --paths "/*" \
    --output text > /dev/null
  echo "==> CloudFront invalidation created."
else
  echo "==> WARNING: Could not determine CloudFront distribution ID. Skipping invalidation."
fi

echo ""
echo "===== Frontend Deployed ====="
echo "Site URL: $(cd "$TF_DIR" && terraform output -raw cloudfront_url)"
