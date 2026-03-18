#!/usr/bin/env python3
"""
Export the official non-quantized EdgeTAM CoreML assets plus image positional
encoding for the GifWidgets iOS app.

Usage:
  python mobile/ios/scripts/export_edgetam_assets.py \
    --edgetam-root /path/to/EdgeTAM \
    --output-dir mobile/ios/GifWidgetsMobile/Resources/EdgeTAM
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path


def run(cmd: list[str], cwd: Path) -> None:
    print("+", " ".join(cmd))
    subprocess.run(cmd, cwd=str(cwd), check=True)


def main() -> int:
    parser = argparse.ArgumentParser(description="Export EdgeTAM CoreML assets for the iOS app")
    parser.add_argument("--edgetam-root", required=True, help="Path to a local facebookresearch/EdgeTAM checkout")
    parser.add_argument("--output-dir", required=True, help="Where the exported assets should be copied")
    args = parser.parse_args()

    edgetam_root = Path(args.edgetam_root).expanduser().resolve()
    output_dir = Path(args.output_dir).expanduser().resolve()

    if not edgetam_root.exists():
        raise SystemExit(f"EdgeTAM checkout not found: {edgetam_root}")

    checkpoint = edgetam_root / "checkpoints" / "edgetam.pt"
    config = edgetam_root / "sam2" / "configs" / "edgetam.yaml"
    export_script = edgetam_root / "coreml" / "export_to_coreml.py"

    missing = [path for path in (checkpoint, config, export_script) if not path.exists()]
    if missing:
        raise SystemExit("Missing required EdgeTAM files:\n" + "\n".join(str(path) for path in missing))

    temp_output = edgetam_root / "coreml_models"
    temp_output.mkdir(exist_ok=True)

    run(
        [
            sys.executable,
            str(export_script),
            "--sam2_cfg",
            str(config),
            "--sam2_checkpoint",
            str(checkpoint),
            "--output_dir",
            str(temp_output),
        ],
        cwd=edgetam_root,
    )

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

GlobalHydra.instance().clear()
config_dir = r"{config_dir}"
config_name = "edgetam"
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
        output=str(temp_output / "edgetam_image_pe.npy"),
        config_dir=str(config.parent),
    )

    run([sys.executable, "-c", py_script], cwd=edgetam_root)

    output_dir.mkdir(parents=True, exist_ok=True)
    for filename in [
        "edgetam_image_encoder.mlpackage",
        "edgetam_prompt_encoder.mlpackage",
        "edgetam_mask_decoder.mlpackage",
        "edgetam_image_pe.npy",
    ]:
        source = temp_output / filename
        destination = output_dir / filename
        if source.is_dir():
            if destination.exists():
                shutil.rmtree(destination)
            shutil.copytree(source, destination)
        else:
            shutil.copy2(source, destination)
        print("Copied", destination)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
