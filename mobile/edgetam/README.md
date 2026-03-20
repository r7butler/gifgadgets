# EdgeTAM Export

Use [export_coreml.py](/Users/robertb/Projects/gifcaption/mobile/edgetam/export_coreml.py) to export the CoreML assets required by the iOS app from a local EdgeTAM checkout.

Example:

```bash
python mobile/edgetam/export_coreml.py \
  --edgetam-root /path/to/EdgeTAM \
  --output-dir mobile/ios/GifWidgetsMobile/Resources/EdgeTAM
```

Expected outputs:

- `edgetam_image_encoder.mlpackage`
- `edgetam_prompt_encoder.mlpackage`
- `edgetam_mask_decoder.mlpackage`
- `edgetam_image_pe.npy`

## Docker

You can also export from Docker without installing the Python dependencies locally. The container clones EdgeTAM, installs its requirements, and writes the assets back into this repo through a bind mount of `mobile/`.

Build and run:

```bash
chmod +x mobile/edgetam/run-docker-export.sh
EDGETAM_CHECKPOINT_PATH=/absolute/path/to/edgetam.pt \
./mobile/edgetam/run-docker-export.sh
```

By default, outputs are written to:

```bash
mobile/ios/GifWidgetsMobile/Resources/EdgeTAM
```

Optional environment variables:

- `EDGETAM_REF`: checkout a specific branch, tag, or commit after cloning
- `EDGETAM_REPO_URL`: override the repository URL
- `OUTPUT_DIR`: override the in-container output path, for example `/workspace/mobile/somewhere-else`
