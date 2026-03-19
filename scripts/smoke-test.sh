#!/usr/bin/env bash
set -euo pipefail

# Smoke test — quick health checks against a live environment.
# Tests that pages are served correctly through CloudFront.
# API endpoints use IAM-signed requests via CloudFront OAC,
# so they can't be tested directly with curl — those are covered
# by the backend pytest suite instead.
#
# Usage:
#   ./scripts/smoke-test.sh                                        # tests prod
#   BASE_URL=https://dev.gifwidgets.com ./scripts/smoke-test.sh    # tests dev

BASE_URL="${BASE_URL:-https://gifwidgets.com}"
PASSED=0
FAILED=0

check() {
  local name="$1"
  local result="$2"
  if [[ "$result" == "true" ]]; then
    echo "  PASS  $name"
    PASSED=$((PASSED + 1))
  else
    echo "  FAIL  $name"
    FAILED=$((FAILED + 1))
  fi
}

echo "Smoke testing: $BASE_URL"
echo ""

# Homepage
STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/")
check "Homepage returns 200" "$([[ "$STATUS" == "200" ]] && echo true || echo false)"

BODY=$(curl -s "$BASE_URL/")
check "Homepage contains GifWidgets" "$([[ "$BODY" == *"GifWidgets"* ]] && echo true || echo false)"

# Tool pages
for TOOL in gif-editor gif-maker video-to-gif image-editor gif-resizer crop-gif photo-converter; do
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/$TOOL/")
  check "$TOOL page returns 200" "$([[ "$STATUS" == "200" ]] && echo true || echo false)"
done

# Tool editor pages (the actual app UI)
for TOOL in gif-editor gif-maker video-to-gif image-editor gif-resizer crop-gif; do
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/$TOOL/edit/")
  check "$TOOL/edit page returns 200" "$([[ "$STATUS" == "200" ]] && echo true || echo false)"
done

# Photo converter sub-tools
for CONV in jpg-to-png png-to-jpg jpg-to-webp png-to-webp webp-to-jpg gif-to-png svg-to-png heic-to-jpg; do
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/photo-converter/$CONV/")
  check "photo-converter/$CONV returns 200" "$([[ "$STATUS" == "200" ]] && echo true || echo false)"
done

# Key static assets load
BODY=$(curl -s "$BASE_URL/gif-editor/edit/")
check "Editor page contains canvas element" "$([[ "$BODY" == *"preview-canvas"* ]] && echo true || echo false)"
check "Editor page loads JavaScript" "$([[ "$BODY" == *"editor.js"* ]] && echo true || echo false)"

echo ""
echo "Results: $PASSED passed, $FAILED failed"

if [[ "$FAILED" -gt 0 ]]; then
  exit 1
fi
