#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
image_tag="${IMAGE_TAG:-gifwidgets-edgetam-export}"

docker build \
  -f "${repo_root}/mobile/edgetam/Dockerfile" \
  -t "${image_tag}" \
  "${repo_root}"

docker_args=(
  run
  --rm
  -v "${repo_root}/mobile:/workspace/mobile"
)

if [[ -n "${EDGETAM_CHECKPOINT_PATH:-}" ]]; then
  checkpoint_host_path="$(cd "$(dirname "${EDGETAM_CHECKPOINT_PATH}")" && pwd)/$(basename "${EDGETAM_CHECKPOINT_PATH}")"
  docker_args+=(
    -v "${checkpoint_host_path}:/checkpoints/edgetam.pt:ro"
    -e "EDGETAM_CHECKPOINT_PATH=/checkpoints/edgetam.pt"
  )
fi

if [[ -n "${EDGETAM_REF:-}" ]]; then
  docker_args+=(-e "EDGETAM_REF=${EDGETAM_REF}")
fi

if [[ -n "${EDGETAM_REPO_URL:-}" ]]; then
  docker_args+=(-e "EDGETAM_REPO_URL=${EDGETAM_REPO_URL}")
fi

if [[ -n "${OUTPUT_DIR:-}" ]]; then
  docker_args+=(-e "OUTPUT_DIR=${OUTPUT_DIR}")
fi

docker "${docker_args[@]}" "${image_tag}" "$@"
