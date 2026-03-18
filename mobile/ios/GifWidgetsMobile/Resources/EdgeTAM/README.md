# EdgeTAM Assets

Drop the exported non-quantized EdgeTAM assets into this folder before building the iOS app:

- `edgetam_image_encoder.mlpackage`
- `edgetam_prompt_encoder.mlpackage`
- `edgetam_mask_decoder.mlpackage`
- `edgetam_image_pe.npy`

The Xcode project includes this folder as a folder reference, so anything placed here is copied into the app bundle automatically.

Use the helper script at [export_edgetam_assets.py](/Users/robertb/Projects/gifcaption/mobile/ios/scripts/export_edgetam_assets.py) to generate the CoreML packages and positional encoding from a local EdgeTAM checkout.
