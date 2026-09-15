#!/usr/bin/env bash
set -euo pipefail

# AWS profile: defaults to the gifwidgets SSO profile, override with AWS_PROFILE=...
if [[ -z "${AWS_ACCESS_KEY_ID:-}" && -z "${AWS_WEB_IDENTITY_TOKEN_FILE:-}" ]]; then
  export AWS_PROFILE="${AWS_PROFILE:-gifwidgets}"
fi
if ! aws sts get-caller-identity >/dev/null 2>&1; then
  echo "ERROR: no valid AWS credentials for profile '${AWS_PROFILE:-environment}'."
  echo "Run: aws sso login --profile ${AWS_PROFILE:-gifwidgets}"
  exit 1
fi
echo "==> AWS_PROFILE=${AWS_PROFILE:-environment} ($(aws sts get-caller-identity --query Account --output text))"

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
aws s3 sync "$FRONTEND_DIR/" "s3://$SITE_BUCKET/" --delete --exclude "g/*"

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
