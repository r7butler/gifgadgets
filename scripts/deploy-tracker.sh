#!/usr/bin/env bash
set -euo pipefail

# Deploy the gifwidgets tracker to Modal.
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
