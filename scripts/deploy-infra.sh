#!/usr/bin/env bash
set -euo pipefail

# AWS profile: defaults to the gifwidgets SSO profile, override with AWS_PROFILE=...
export AWS_PROFILE="${AWS_PROFILE:-gifwidgets}"
if ! aws sts get-caller-identity >/dev/null 2>&1; then
  echo "ERROR: no valid AWS credentials for profile '$AWS_PROFILE'."
  echo "Run: aws sso login --profile $AWS_PROFILE"
  exit 1
fi
echo "==> AWS_PROFILE=$AWS_PROFILE ($(aws sts get-caller-identity --query Account --output text))"

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
  terraform apply --auto-approve

  echo ""
  echo "===== Deployment Outputs ====="
  terraform output
fi
