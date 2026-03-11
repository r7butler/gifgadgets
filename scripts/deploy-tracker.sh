#!/usr/bin/env bash
set -euo pipefail

# Deploy the gifcaption-tracker Lambda (SAM2 container image).
#
# Usage:
#   ./scripts/deploy-tracker.sh
#
# Phases:
#   1. terraform apply -target ECR repo (creates the registry if needed)
#   2. docker build + push to ECR
#   3. terraform apply with tracker_image_uri (creates/updates the Lambda)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TF_DIR="$PROJECT_DIR/terraform"
TRACKER_DIR="$PROJECT_DIR/backend/tracker"

# Ensure we're using the personal AWS profile
if [[ "${AWS_PROFILE:-}" != "personal" ]]; then
  echo "==> Setting AWS_PROFILE=personal"
  export AWS_PROFILE=personal
fi

AWS_REGION="us-east-1"
AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

echo "==> AWS account: $AWS_ACCOUNT_ID  region: $AWS_REGION"

# ── Phase 1: ensure ECR repository exists ────────────────────────────────────
echo ""
echo "==> Phase 1: creating ECR repository (if needed)..."
cd "$TF_DIR"
terraform init -input=false > /dev/null
terraform apply -input=false -auto-approve \
  -target=aws_ecr_repository.tracker \
  -target=aws_ecr_lifecycle_policy.tracker

ECR_URL=$(terraform output -raw tracker_ecr_url)
echo "==> ECR URL: $ECR_URL"

# ── Phase 2: build and push Docker image ─────────────────────────────────────
echo ""
echo "==> Phase 2: building Docker image..."
IMAGE_TAG="latest"
FULL_IMAGE_URI="${ECR_URL}:${IMAGE_TAG}"

# Authenticate Docker to ECR
aws ecr get-login-password --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin \
    "${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"

docker build --platform linux/amd64 \
  -t "$FULL_IMAGE_URI" \
  "$TRACKER_DIR"

echo "==> Pushing image to ECR..."
docker push "$FULL_IMAGE_URI"

# ── Phase 3: create/update the Lambda ────────────────────────────────────────
echo ""
echo "==> Phase 3: applying Terraform with image URI..."
cd "$TF_DIR"
terraform apply -input=false -auto-approve \
  -var="tracker_image_uri=${FULL_IMAGE_URI}"

TRACKER_URL=$(terraform output -raw tracker_function_url)
echo ""
echo "===== Tracker Deployed ====="
echo "Tracker URL: $TRACKER_URL"
echo ""
echo "Next: set TRACKER_BASE_URL in gif-tracker.js or re-run deploy-frontend.sh"
