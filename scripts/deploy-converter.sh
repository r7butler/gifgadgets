#!/usr/bin/env bash
set -euo pipefail

# Deploy the gifcaption GPU video converter to Modal.
#
# Prerequisites:
#   modal secret create gifcaption-aws \
#     AWS_ACCESS_KEY_ID=<key> \
#     AWS_SECRET_ACCESS_KEY=<secret> \
#     ASSETS_BUCKET=<bucket-name>
#
# Usage:
#   ./scripts/deploy-converter.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "==> Deploying gifcaption-converter to Modal..."
modal deploy "$PROJECT_DIR/backend/converter/modal_app.py"

echo ""
echo "===== Converter Deployed ====="
echo "Update MODAL_CONVERTER_ENDPOINT in frontend/video-editor/edit/index.html if the URL changed,"
echo "then run ./scripts/deploy-frontend.sh"
