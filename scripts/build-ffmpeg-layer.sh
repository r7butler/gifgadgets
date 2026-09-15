#!/usr/bin/env bash
set -euo pipefail

# Builds terraform/ffmpeg-layer.zip — a Lambda layer containing the static ffmpeg
# binary at bin/, which Lambda mounts at /opt/bin (see backend/handler.py:619).
#
# Source: John Van Sickle's static amd64 builds, the de-facto standard for Lambda
# ffmpeg layers. The download is verified against the publisher's MD5, and the
# resulting zip's SHA-256 is pinned in terraform/ffmpeg-layer.sha256 so that an
# unexpected upstream change is caught instead of silently shipping.
#
# Usage:
#   ./scripts/build-ffmpeg-layer.sh              # build, enforcing the pinned hash
#   FFMPEG_ALLOW_UPDATE=1 ./scripts/build-ffmpeg-layer.sh   # accept a new upstream build

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TF_DIR="$(cd "$SCRIPT_DIR/../terraform" && pwd)"
OUT_ZIP="$TF_DIR/ffmpeg-layer.zip"
PIN_FILE="$TF_DIR/ffmpeg-layer.sha256"
BASE_URL="https://johnvansickle.com/ffmpeg/releases"
TARBALL="ffmpeg-release-amd64-static.tar.xz"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "==> Downloading $TARBALL"
curl -fsSL "$BASE_URL/$TARBALL" -o "$WORK/$TARBALL"
curl -fsSL "$BASE_URL/$TARBALL.md5" -o "$WORK/$TARBALL.md5"

echo "==> Verifying publisher MD5"
(cd "$WORK" && md5sum -c "$TARBALL.md5" 2>/dev/null || {
  # macOS has no md5sum; fall back to md5 -q
  expected="$(awk '{print $1}' "$TARBALL.md5")"
  actual="$(md5 -q "$TARBALL")"
  [[ "$expected" == "$actual" ]] || { echo "ERROR: MD5 mismatch (expected $expected, got $actual)"; exit 1; }
  echo "$TARBALL: OK"
})

echo "==> Extracting"
tar -xJf "$WORK/$TARBALL" -C "$WORK"
SRC_DIR="$(find "$WORK" -maxdepth 1 -type d -name 'ffmpeg-*-amd64-static' | head -1)"
[[ -n "$SRC_DIR" ]] || { echo "ERROR: could not locate extracted ffmpeg directory"; exit 1; }
VERSION="$(basename "$SRC_DIR" | sed -E 's/ffmpeg-(.*)-amd64-static/\1/')"
echo "    ffmpeg version: $VERSION"

# ffprobe is deliberately excluded: nothing in the codebase invokes it, and
# including it pushes the zip past Lambda's 50 MB direct-upload limit.
echo "==> Packaging layer (bin/ffmpeg)"
mkdir -p "$WORK/layer/bin"
cp "$SRC_DIR/ffmpeg" "$WORK/layer/bin/"
chmod 755 "$WORK/layer/bin/ffmpeg"
rm -f "$OUT_ZIP"
# -X strips extra file attributes so the zip is reproducible across machines
(cd "$WORK/layer" && zip -rqX "$OUT_ZIP" bin)

ACTUAL_SHA="$(shasum -a 256 "$OUT_ZIP" | awk '{print $1}')"

if [[ -f "$PIN_FILE" ]]; then
  PINNED_SHA="$(awk '{print $1}' "$PIN_FILE")"
  if [[ "$ACTUAL_SHA" != "$PINNED_SHA" ]]; then
    if [[ "${FFMPEG_ALLOW_UPDATE:-}" == "1" ]]; then
      echo "==> Upstream changed; updating pin to $ACTUAL_SHA"
      printf '%s  ffmpeg-layer.zip  # ffmpeg %s\n' "$ACTUAL_SHA" "$VERSION" > "$PIN_FILE"
    else
      echo "ERROR: built zip does not match the pinned hash."
      echo "  pinned: $PINNED_SHA"
      echo "  built:  $ACTUAL_SHA  (ffmpeg $VERSION)"
      echo "Upstream published a new build. Review, then re-run with FFMPEG_ALLOW_UPDATE=1"
      exit 1
    fi
  else
    echo "==> SHA-256 matches pin"
  fi
else
  echo "==> Recording initial pin: $ACTUAL_SHA"
  printf '%s  ffmpeg-layer.zip  # ffmpeg %s\n' "$ACTUAL_SHA" "$VERSION" > "$PIN_FILE"
fi

echo "==> Done: terraform/ffmpeg-layer.zip (ffmpeg $VERSION)"
