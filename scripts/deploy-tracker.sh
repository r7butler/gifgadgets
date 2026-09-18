#!/usr/bin/env bash
set -euo pipefail

# Deploy the gifwidgets tracker to Modal.
#
# Prerequisites:
#   modal secret create gifwidgets-modal-api-key \
#     MODAL_API_KEY=<same value as modal_api_key in terraform/secrets.auto.tfvars>
#
# MODAL_API_KEY is required: startup fails if it is missing or empty.
# Both tracking and background segmentation use presigned URLs, not AWS keys.
#
# Usage:
#   ./scripts/deploy-tracker.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "==> Deploying gifwidgets-tracker to Modal..."
modal deploy "$PROJECT_DIR/backend/tracker/modal_app.py"

echo ""
echo "===== Tracker Deployed ====="
echo "Verify modal_tracker_url and modal_segmenter_url in Terraform match the deployed URLs."
echo "Apply infrastructure and deploy the Lambda backend before publishing the frontend."
