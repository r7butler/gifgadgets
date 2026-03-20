#!/usr/bin/env python3
"""Compatibility wrapper around the shared EdgeTAM CoreML export script."""

from __future__ import annotations

import runpy
from pathlib import Path


if __name__ == "__main__":
    shared_script = Path(__file__).resolve().parents[2] / "edgetam" / "export_coreml.py"
    runpy.run_path(str(shared_script), run_name="__main__")
