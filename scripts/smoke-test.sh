#!/usr/bin/env bash
set -euo pipefail

# Smoke test — quick health checks against a live environment.
# Tests that pages are served correctly through CloudFront.
# API requests go through CloudFront OAC with an explicit body hash.
# Invalid background requests check route availability without launching GPU work.
#
# Usage:
#   ./scripts/smoke-test.sh                                        # tests prod
#   BASE_URL=https://dev.gifgadgets.com ./scripts/smoke-test.sh    # tests dev
#
# Defaults follow site.config.json so a rebrand does not need edits here.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SITE_CONFIG="$SCRIPT_DIR/../site.config.json"
cfg() { python3 -c "import json,sys;print(json.load(open(sys.argv[1]))[sys.argv[2]])" "$SITE_CONFIG" "$1"; }

BASE_URL="${BASE_URL:-$(cfg site_url)}"
SITE_BRAND="${SITE_BRAND:-$(cfg site_brand)}"
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
check "Homepage contains $SITE_BRAND" "$([[ "$BODY" == *"$SITE_BRAND"* ]] && echo true || echo false)"

# Tool pages
for TOOL in gif-editor gif-maker video-to-gif image-editor gif-resizer crop-gif photo-converter gif-speed reverse-gif rotate-gif flip-gif gif-loop trim-gif remove-image-background change-image-background remove-gif-background swap-gif-background; do
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

# A page can be published while its API is still running an older deployment.
# These malformed requests must reach validation (400), not a missing route (404).
# They do not reserve a quota slot, upload media or start paid work.
BODY_HASH=$(python3 -c "import hashlib; print(hashlib.sha256(b'{}').hexdigest())")
for ACTION in presign submit status cancel; do
  STATUS=$(curl -s --max-time 45 -o /dev/null -w "%{http_code}" \
    -H 'Content-Type: application/json' -H "x-amz-content-sha256: $BODY_HASH" \
    --data '{}' "$BASE_URL/api/segment/$ACTION")
  check "segment/$ACTION reaches API validation" "$([[ "$STATUS" == "400" ]] && echo true || echo false)"
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
