#!/usr/bin/env bash
set -euo pipefail

# Deploy backend: package Lambda code into a zip for Terraform.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BACKEND_DIR="$PROJECT_DIR/backend"
OUTPUT_ZIP="$PROJECT_DIR/terraform/lambda.zip"

echo "==> Cleaning previous build artifacts..."
rm -rf "$BACKEND_DIR/package" "$OUTPUT_ZIP"

echo "==> Installing Python dependencies..."
pip install -r "$BACKEND_DIR/requirements.txt" -t "$BACKEND_DIR/package" --quiet

echo "==> Copying handler..."
cp "$BACKEND_DIR/handler.py" "$BACKEND_DIR/package/"

echo "==> Creating lambda.zip..."
(cd "$BACKEND_DIR/package" && zip -r "$OUTPUT_ZIP" . -q)

echo "==> Cleaning up..."
rm -rf "$BACKEND_DIR/package"

echo "==> Done! Lambda zip created at: terraform/lambda.zip"
