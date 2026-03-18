# GifWidgets iOS

This folder contains a native SwiftUI iOS app that mirrors the core GifWidgets GIF editor workflow:

- import a GIF or video
- scrub frames and play the animation
- add on-image captions
- adjust per-caption text, font, colors, and frame ranges
- drag captions directly on the preview
- export a captioned GIF
- track captions on-device with non-quantized EdgeTAM CoreML models

## Project layout

- `GifWidgetsMobile.xcodeproj/`: Xcode project
- `GifWidgetsMobile/`: app source, assets, and bundled EdgeTAM resource folder
- `scripts/export_edgetam_assets.py`: helper script to export EdgeTAM CoreML assets and positional encoding

## EdgeTAM setup

The repo does not vendor Meta's EdgeTAM weights. To enable tracking:

1. Clone the official EdgeTAM repo locally.
2. Export the non-quantized CoreML models and positional encoding:

```bash
python mobile/ios/scripts/export_edgetam_assets.py \
  --edgetam-root /path/to/EdgeTAM \
  --output-dir mobile/ios/GifWidgetsMobile/Resources/EdgeTAM
```

3. Build the app in Xcode. The `Resources/EdgeTAM` folder is included as a folder reference, so any exported assets dropped there are copied into the app bundle automatically.

Expected files:

- `edgetam_image_encoder.mlpackage`
- `edgetam_prompt_encoder.mlpackage`
- `edgetam_mask_decoder.mlpackage`
- `edgetam_image_pe.npy`

## Build

Open [GifWidgetsMobile.xcodeproj](/Users/robertb/Projects/gifcaption/mobile/ios/GifWidgetsMobile.xcodeproj) in Xcode and run the `GifWidgetsMobile` target on an iPhone or simulator.

## Notes

- The editor is intentionally native, not a web view wrapper.
- The tracking pipeline follows the official EdgeTAM CoreML split-model export and updates caption motion keyframes from mask centroids.
- The UI mirrors the core website editor flow, but it is not yet a full 1:1 feature clone of every web-only control.
