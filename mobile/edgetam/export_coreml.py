#!/usr/bin/env python3
"""
Export EdgeTAM CoreML assets plus positional encoding for the GifWidgets iOS app.

This script expects a local checkout of the official EdgeTAM repo with its
checkpoint and CoreML exporter available.

Example:
  python mobile/edgetam/export_coreml.py \
    --edgetam-root /path/to/EdgeTAM \
    --output-dir mobile/ios/GifWidgetsMobile/Resources/EdgeTAM
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from pathlib import Path


EXPECTED_OUTPUTS = (
    "edgetam_image_encoder.mlpackage",
    "edgetam_prompt_encoder.mlpackage",
    "edgetam_mask_decoder.mlpackage",
    "edgetam_image_pe.npy",
)


def run(cmd: list[str], cwd: Path) -> None:
    print("+", " ".join(cmd))
    subprocess.run(cmd, cwd=str(cwd), check=True)


def require_paths(paths: list[Path]) -> None:
    missing = [path for path in paths if not path.exists()]
    if missing:
        formatted = "\n".join(str(path) for path in missing)
        raise SystemExit(f"Missing required EdgeTAM files:\n{formatted}")


def copy_output(source: Path, destination: Path) -> None:
    if source.is_dir():
        if destination.exists():
            shutil.rmtree(destination)
        shutil.copytree(source, destination)
    else:
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)
    print("Copied", destination)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Export EdgeTAM CoreML assets for the GifWidgets iOS app"
    )
    parser.add_argument(
        "--edgetam-root",
        required=True,
        help="Path to a local facebookresearch/EdgeTAM checkout",
    )
    parser.add_argument(
        "--output-dir",
        required=True,
        help="Directory where the exported assets should be copied",
    )
    parser.add_argument(
        "--temp-output-dir",
        help="Optional intermediate output directory inside the EdgeTAM checkout",
    )
    return parser.parse_args()


def export_dense_pe(config: Path, checkpoint: Path, output_path: Path, cwd: Path) -> None:
    py_script = """
import numpy as np
import torch
from hydra import compose, initialize_config_dir
from hydra.core.global_hydra import GlobalHydra
from hydra.utils import instantiate
from omegaconf import OmegaConf
from sam2.build_sam import _load_checkpoint

config_path = r"{config}"
checkpoint_path = r"{checkpoint}"
output_path = r"{output}"
config_dir = r"{config_dir}"
config_name = "{config_name}"

GlobalHydra.instance().clear()
with initialize_config_dir(config_dir=config_dir, version_base=None):
    cfg = compose(config_name=config_name)
OmegaConf.resolve(cfg)
model = instantiate(cfg.model, _recursive_=True)
_load_checkpoint(model, checkpoint_path)
model = model.to(torch.device("cpu")).eval()

with torch.no_grad():
    image_pe = model.sam_prompt_encoder.get_dense_pe().detach().cpu().numpy()

np.save(output_path, image_pe.astype(np.float32))
print("Saved", output_path)
""".format(
        config=str(config),
        checkpoint=str(checkpoint),
        output=str(output_path),
        config_dir=str(config.parent),
        config_name=config.stem,
    )

    run([sys.executable, "-c", py_script], cwd=cwd)


def main() -> int:
    args = parse_args()

    edgetam_root = Path(args.edgetam_root).expanduser().resolve()
    output_dir = Path(args.output_dir).expanduser().resolve()

    if not edgetam_root.exists():
        raise SystemExit(f"EdgeTAM checkout not found: {edgetam_root}")

    checkpoint = edgetam_root / "checkpoints" / "edgetam.pt"
    config = edgetam_root / "sam2" / "configs" / "edgetam.yaml"
    export_script = edgetam_root / "coreml" / "export_to_coreml.py"

    require_paths([checkpoint, config, export_script])

    temp_output_dir = (
        Path(args.temp_output_dir).expanduser().resolve()
        if args.temp_output_dir
        else (edgetam_root / "coreml_models").resolve()
    )
    temp_output_dir.mkdir(parents=True, exist_ok=True)

    run(
        [
            sys.executable,
            str(export_script),
            "--sam2_cfg",
            str(config),
            "--sam2_checkpoint",
            str(checkpoint),
            "--output_dir",
            str(temp_output_dir),
        ],
        cwd=edgetam_root,
    )

    export_dense_pe(
        config=config,
        checkpoint=checkpoint,
        output_path=temp_output_dir / "edgetam_image_pe.npy",
        cwd=edgetam_root,
    )

    output_dir.mkdir(parents=True, exist_ok=True)
    for filename in EXPECTED_OUTPUTS:
        source = temp_output_dir / filename
        if not source.exists():
            raise SystemExit(f"Expected exporter output was not created: {source}")
        copy_output(source, output_dir / filename)

    print("Export complete.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
