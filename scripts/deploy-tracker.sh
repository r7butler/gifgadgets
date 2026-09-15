#!/usr/bin/env bash
set -euo pipefail

# Deploy the gifwidgets tracker to Modal.
#
# Prerequisites:
#   modal secret create gifwidgets-tracker-aws \
#     AWS_ACCESS_KEY_ID=<key> \
#     AWS_SECRET_ACCESS_KEY=<secret> \
#     ASSETS_BUCKET=<bucket-name>
#
#   modal secret create gifwidgets-modal-api-key \
#     MODAL_API_KEY=<same value as modal_api_key in terraform/secrets.auto.tfvars>
#
# MODAL_API_KEY is required: startup fails if it is missing or empty.
#
# Usage:
#   ./scripts/deploy-tracker.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "==> Deploying gifwidgets-tracker to Modal..."
modal deploy "$PROJECT_DIR/backend/tracker/modal_app.py"

echo ""
echo "===== Tracker Deployed ====="
echo "Update MODAL_ENDPOINT in frontend/gif-tracker-worker.js if the URL changed,"
echo "then run ./scripts/deploy-frontend.sh"
