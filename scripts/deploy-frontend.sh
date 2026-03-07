#!/usr/bin/env bash
set -euo pipefail

# Ensure we're using the personal AWS profile
if [[ "${AWS_PROFILE:-}" != "personal" ]]; then
  echo "==> Setting AWS_PROFILE=personal"
  export AWS_PROFILE=personal
fi

# Deploy frontend: inject API URL into app.js and sync to S3.
# Usage:
#   ./scripts/deploy-frontend.sh                   # auto-reads terraform outputs
#   ./scripts/deploy-frontend.sh <lambda_url>      # manually provide the API URL

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TF_DIR="$PROJECT_DIR/terraform"
FRONTEND_DIR="$PROJECT_DIR/frontend"

# Resolve the Lambda Function URL
if [[ -n "${1:-}" ]]; then
  LAMBDA_URL="$1"
else
  echo "==> Reading Lambda Function URL from Terraform output..."
  LAMBDA_URL=$(cd "$TF_DIR" && terraform output -raw lambda_function_url)
fi

# Strip trailing slash
LAMBDA_URL="${LAMBDA_URL%/}"
echo "==> API URL: $LAMBDA_URL"

# Resolve the site bucket name
SITE_BUCKET=$(cd "$TF_DIR" && terraform output -raw site_bucket_name)
echo "==> Site bucket: $SITE_BUCKET"

# Inject API_BASE_URL into app.js (in-place via temp copy)
echo "==> Injecting API_BASE_URL into app.js..."
sed -i.bak "s|const API_BASE_URL = \".*\"|const API_BASE_URL = \"${LAMBDA_URL}\"|" "$FRONTEND_DIR/app.js"
rm -f "$FRONTEND_DIR/app.js.bak"

# Sync to S3
echo "==> Syncing frontend to s3://$SITE_BUCKET/ ..."
aws s3 sync "$FRONTEND_DIR/" "s3://$SITE_BUCKET/" --delete

# Invalidate CloudFront cache
echo "==> Invalidating CloudFront cache..."
DISTRIBUTION_ID=$(cd "$TF_DIR" && terraform output -raw cloudfront_url | grep -oP 'https://\K[^.]+')
# The distribution ID isn't directly in outputs; use aws cli to find it by domain
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
