#!/usr/bin/env bash
set -euo pipefail

# Deploy the gifwidgets GPU video converter to Modal.
#
# Prerequisites:
#   modal secret create gifwidgets-aws \
#     AWS_ACCESS_KEY_ID=<key> \
#     AWS_SECRET_ACCESS_KEY=<secret> \
#     ASSETS_BUCKET=<bucket-name>
#
#   modal secret create gifwidgets-modal-api-key \
#     MODAL_API_KEY=<same value as modal_api_key in terraform/secrets.auto.tfvars>
#
# MODAL_API_KEY is required: the auth check in modal_app.py is skipped entirely
# when it is unset, which would leave this GPU endpoint open to the internet.
#
# Usage:
#   ./scripts/deploy-converter.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "==> Deploying gifwidgets-converter to Modal..."
modal deploy "$PROJECT_DIR/backend/converter/modal_app.py"

echo ""
echo "===== Converter Deployed ====="
echo "Update MODAL_CONVERTER_ENDPOINT in frontend/video-editor/edit/index.html if the URL changed,"
echo "then run ./scripts/deploy-frontend.sh"
