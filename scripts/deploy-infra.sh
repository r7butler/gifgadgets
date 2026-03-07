#!/usr/bin/env bash
set -euo pipefail

# Ensure we're using the personal AWS profile
if [[ "${AWS_PROFILE:-}" != "personal" ]]; then
  echo "==> Setting AWS_PROFILE=personal"
  export AWS_PROFILE=personal
fi

# Deploy infrastructure with Terraform.
# Usage:
#   ./scripts/deploy-infra.sh                     # uses defaults from variables.tf
#   ./scripts/deploy-infra.sh plan                 # plan only
#   ./scripts/deploy-infra.sh destroy              # tear down

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TF_DIR="$(cd "$SCRIPT_DIR/../terraform" && pwd)"
ACTION="${1:-apply}"

# Check that lambda.zip exists before apply/plan
if [[ "$ACTION" != "destroy" && ! -f "$TF_DIR/lambda.zip" ]]; then
  echo "ERROR: terraform/lambda.zip not found."
  echo "Run ./scripts/deploy-backend.sh first."
  exit 1
fi

cd "$TF_DIR"

echo "==> terraform init"
terraform init -input=false

if [[ "$ACTION" == "plan" ]]; then
  echo "==> terraform plan"
  terraform plan
elif [[ "$ACTION" == "destroy" ]]; then
  echo "==> terraform destroy"
  terraform destroy
else
  echo "==> terraform apply"
  terraform apply

  echo ""
  echo "===== Deployment Outputs ====="
  terraform output
fi
