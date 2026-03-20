#!/usr/bin/env bash
set -euo pipefail

repo_url="${EDGETAM_REPO_URL:-https://github.com/facebookresearch/EdgeTAM.git}"
repo_ref="${EDGETAM_REF:-}"
edgetam_root="${EDGETAM_ROOT:-/opt/edgetam}"
output_dir="${OUTPUT_DIR:-/workspace/mobile/ios/GifWidgetsMobile/Resources/EdgeTAM}"
checkpoint_src="${EDGETAM_CHECKPOINT_PATH:-}"
checkpoint_dst="${edgetam_root}/checkpoints/edgetam.pt"

echo "Preparing EdgeTAM checkout in ${edgetam_root}"
if [[ ! -d "${edgetam_root}/.git" ]]; then
  rm -rf "${edgetam_root}"
  git clone --depth 1 "${repo_url}" "${edgetam_root}"
fi

if [[ -n "${repo_ref}" ]]; then
  git -C "${edgetam_root}" fetch --depth 1 origin "${repo_ref}"
  git -C "${edgetam_root}" checkout --force FETCH_HEAD
fi

python -m pip install --upgrade pip setuptools wheel

if [[ -f "${edgetam_root}/requirements.txt" ]]; then
  python -m pip install -r "${edgetam_root}/requirements.txt"
fi

if [[ -f "${edgetam_root}/pyproject.toml" || -f "${edgetam_root}/setup.py" ]]; then
  python -m pip install -e "${edgetam_root}"
fi

if [[ -n "${checkpoint_src}" ]]; then
  mkdir -p "$(dirname "${checkpoint_dst}")"
  cp "${checkpoint_src}" "${checkpoint_dst}"
fi

if [[ ! -f "${checkpoint_dst}" ]]; then
  cat <<EOF
Missing EdgeTAM checkpoint at ${checkpoint_dst}

Provide it by either:
  1. Mounting a checkpoint file and setting EDGETAM_CHECKPOINT_PATH
  2. Pre-populating ${edgetam_root}/checkpoints/edgetam.pt inside the container
EOF
  exit 1
fi

mkdir -p "${output_dir}"

python /workspace/mobile/edgetam/export_coreml.py \
  --edgetam-root "${edgetam_root}" \
  --output-dir "${output_dir}" \
  "$@"
