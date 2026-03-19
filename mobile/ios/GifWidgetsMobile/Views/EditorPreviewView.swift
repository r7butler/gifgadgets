import SwiftUI

struct EditorPreviewView: View {
    @ObservedObject var viewModel: EditorViewModel
    @State private var dragOrigins: [UUID: CGPoint] = [:]
    @State private var cropMoveStart: CropBox?
    @State private var cropResizeStart: CropBox?

    var body: some View {
        GeometryReader { geometry in
            let layout = CaptionRenderer.previewLayout(
                in: geometry.size,
                mediaSize: viewModel.mediaSize,
                topBar: viewModel.topBar,
                bottomBar: viewModel.bottomBar
            )

            ZStack {
                RoundedRectangle(cornerRadius: 28)
                    .fill(
                        LinearGradient(
                            colors: [
                                Color.black.opacity(0.92),
                                Color(red: 0.08, green: 0.09, blue: 0.14),
                            ],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        )
                    )

                if let frame = viewModel.currentFrame, layout.mediaRect != .zero {
                    if let topRect = layout.topBarRect {
                        barView(viewModel.topBar, rect: topRect, scale: layout.scale)
                    }

                    Image(decorative: frame.image, scale: 1)
                        .resizable()
                        .interpolation(.none)
                        .frame(width: layout.mediaRect.width, height: layout.mediaRect.height)
                        .position(x: layout.mediaRect.midX, y: layout.mediaRect.midY)
                        .clipShape(RoundedRectangle(cornerRadius: 18))

                    ForEach(viewModel.visibleOverlays) { overlay in
                        if let cgImage = overlay.cgImage {
                            let overlayLayout = CaptionRenderer.overlayLayout(
                                for: overlay,
                                mediaSize: viewModel.mediaSize,
                                in: layout.mediaRect,
                                frameIndex: viewModel.currentFrameIndex
                            )
                            overlayView(
                                overlay,
                                image: cgImage,
                                overlayLayout: overlayLayout,
                                mediaRect: layout.mediaRect
                            )
                        }
                    }

                    ForEach(viewModel.visibleCaptions) { caption in
                        let textLayout = CaptionRenderer.layout(
                            for: caption,
                            mediaSize: viewModel.mediaSize,
                            in: layout.mediaRect,
                            frameIndex: viewModel.currentFrameIndex
                        )
                        captionView(
                            caption,
                            textLayout: textLayout,
                            mediaRect: layout.mediaRect
                        )
                    }

                    if let bottomRect = layout.bottomBarRect {
                        barView(viewModel.bottomBar, rect: bottomRect, scale: layout.scale)
                    }

                    if viewModel.isCropMode {
                        cropOverlay(layout: layout)
                    } else if viewModel.isTrackingMode {
                        trackingOverlay(layout: layout)
                    }
                } else {
                    VStack(spacing: 12) {
                        Image(systemName: "sparkles.tv")
                            .font(.system(size: 42, weight: .semibold))
                            .foregroundStyle(.white.opacity(0.9))
                        Text("Import a GIF or video to start editing.")
                            .font(.headline)
                            .foregroundStyle(.white.opacity(0.9))
                        Text("Captions, overlays, crop controls, export, and EdgeTAM tracking all live here.")
                            .font(.subheadline)
                            .foregroundStyle(.white.opacity(0.65))
                            .multilineTextAlignment(.center)
                    }
                    .padding(24)
                }
            }
        }
        .frame(minHeight: 340)
    }

    private func overlayView(
        _ overlay: ImageOverlay,
        image: CGImage,
        overlayLayout: OverlayImageLayout,
        mediaRect: CGRect
    ) -> some View {
        let isSelected = overlay.id == viewModel.selectedOverlayID

        return Image(decorative: image, scale: 1)
            .resizable()
            .interpolation(.high)
            .frame(width: overlayLayout.rect.width, height: overlayLayout.rect.height)
            .overlay {
                RoundedRectangle(cornerRadius: 18)
                    .stroke(
                        isSelected ? Color.white.opacity(0.92) : Color.clear,
                        lineWidth: 2
                    )
                    .background(
                        RoundedRectangle(cornerRadius: 18)
                            .fill(isSelected ? Color.white.opacity(0.08) : Color.clear)
                    )
            }
            .opacity(Double(overlay.opacity.clamped(to: 0...1)))
            .rotationEffect(.degrees(Double(overlay.rotation)))
            .position(x: overlayLayout.rect.midX, y: overlayLayout.rect.midY)
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { value in
                        guard !viewModel.isTrackingMode, !viewModel.isCropMode else { return }
                        if dragOrigins[overlay.id] == nil {
                            dragOrigins[overlay.id] = overlay.interpolatedPosition(at: viewModel.currentFrameIndex)
                            viewModel.selectOverlay(overlay.id)
                        }
                        guard let origin = dragOrigins[overlay.id] else { return }
                        let nextPoint = CGPoint(
                            x: origin.x + (value.translation.width / max(mediaRect.width, 1)),
                            y: origin.y + (value.translation.height / max(mediaRect.height, 1))
                        ).clampedUnit()
                        viewModel.updateOverlayPosition(
                            overlayID: overlay.id,
                            normalizedPoint: nextPoint,
                            keyedToCurrentFrame: !overlay.motion.isEmpty
                        )
                    }
                    .onEnded { _ in
                        dragOrigins[overlay.id] = nil
                    }
            )
            .simultaneousGesture(
                TapGesture()
                    .onEnded {
                        guard !viewModel.isCropMode else { return }
                        viewModel.selectOverlay(overlay.id)
                    }
            )
    }

    private func captionView(_ caption: OnImageCaption, textLayout: CaptionTextLayout, mediaRect: CGRect) -> some View {
        let isSelected = caption.id == viewModel.selectedCaptionID
        let fontSize = max(12, caption.style.fontSize * textLayout.scale)
        let strokeColor = Color(rgbaHex: caption.style.strokeColorHex)

        return Text(caption.text.isEmpty ? " " : caption.text)
            .font(.custom(caption.style.fontName, size: fontSize))
            .multilineTextAlignment(.center)
            .foregroundStyle(Color(rgbaHex: caption.style.textColorHex))
            .frame(width: textLayout.rect.width, height: textLayout.rect.height)
            .background(
                RoundedRectangle(cornerRadius: 14)
                    .stroke(
                        isSelected ? Color.white.opacity(0.9) : Color.clear,
                        lineWidth: 2
                    )
                    .background(
                        RoundedRectangle(cornerRadius: 14)
                            .fill(isSelected ? Color.white.opacity(0.08) : Color.clear)
                    )
            )
            .shadow(color: strokeColor.opacity(0.85), radius: max(1, caption.style.strokeWidth * textLayout.scale * 0.5))
            .position(x: textLayout.rect.midX, y: textLayout.rect.midY)
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { value in
                        guard !viewModel.isTrackingMode, !viewModel.isCropMode else { return }
                        if dragOrigins[caption.id] == nil {
                            dragOrigins[caption.id] = caption.interpolatedPosition(at: viewModel.currentFrameIndex)
                            viewModel.selectCaption(caption.id)
                        }
                        guard let origin = dragOrigins[caption.id] else { return }
                        let nextPoint = CGPoint(
                            x: origin.x + (value.translation.width / max(mediaRect.width, 1)),
                            y: origin.y + (value.translation.height / max(mediaRect.height, 1))
                        ).clampedUnit()
                        viewModel.updateCaptionPosition(
                            captionID: caption.id,
                            normalizedPoint: nextPoint,
                            keyedToCurrentFrame: !caption.motion.isEmpty
                        )
                    }
                    .onEnded { _ in
                        dragOrigins[caption.id] = nil
                    }
            )
            .simultaneousGesture(
                TapGesture()
                    .onEnded {
                        guard !viewModel.isCropMode else { return }
                        viewModel.selectCaption(caption.id)
                    }
            )
    }

    private func cropOverlay(layout: PreviewLayout) -> some View {
        let cropRect = viewModel.cropBox.rect(in: layout.mediaRect)

        return ZStack {
            Path { path in
                path.addRect(layout.mediaRect)
                path.addRect(cropRect)
            }
            .fill(Color.black.opacity(0.52), style: FillStyle(eoFill: true))

            RoundedRectangle(cornerRadius: 18)
                .stroke(style: StrokeStyle(lineWidth: 2, dash: [10, 6]))
                .foregroundStyle(.white)
                .frame(width: cropRect.width, height: cropRect.height)
                .position(x: cropRect.midX, y: cropRect.midY)

            Rectangle()
                .fill(Color.clear)
                .frame(width: cropRect.width, height: cropRect.height)
                .position(x: cropRect.midX, y: cropRect.midY)
                .contentShape(Rectangle())
                .gesture(
                    DragGesture(minimumDistance: 0)
                        .onChanged { value in
                            if cropMoveStart == nil {
                                cropMoveStart = viewModel.cropBox
                            }
                            guard let start = cropMoveStart else { return }
                            var next = start
                            next.x = start.x + (value.translation.width / max(layout.mediaRect.width, 1))
                            next.y = start.y + (value.translation.height / max(layout.mediaRect.height, 1))
                            next.clamp()
                            viewModel.updateCropBox(next)
                        }
                        .onEnded { _ in
                            cropMoveStart = nil
                        }
                )

            Text("Crop")
                .font(.caption.weight(.semibold))
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(.ultraThinMaterial, in: Capsule())
                .position(x: cropRect.minX + 36, y: max(cropRect.minY - 18, layout.mediaRect.minY + 18))

            Circle()
                .fill(Color.white)
                .frame(width: 28, height: 28)
                .overlay {
                    Image(systemName: "arrow.up.left.and.arrow.down.right")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(.black)
                }
                .position(x: cropRect.maxX, y: cropRect.maxY)
                .gesture(
                    DragGesture(minimumDistance: 0)
                        .onChanged { value in
                            if cropResizeStart == nil {
                                cropResizeStart = viewModel.cropBox
                            }
                            guard let start = cropResizeStart else { return }
                            var next = start
                            next.width = start.width + (value.translation.width / max(layout.mediaRect.width, 1))
                            next.height = start.height + (value.translation.height / max(layout.mediaRect.height, 1))
                            next.clamp()
                            viewModel.updateCropBox(next)
                        }
                        .onEnded { _ in
                            cropResizeStart = nil
                        }
                )
        }
    }

    private func trackingOverlay(layout: PreviewLayout) -> some View {
        Rectangle()
            .fill(Color.clear)
            .frame(width: layout.mediaRect.width, height: layout.mediaRect.height)
            .position(x: layout.mediaRect.midX, y: layout.mediaRect.midY)
            .contentShape(Rectangle())
            .overlay(alignment: .top) {
                Text("Tap the object to track")
                    .font(.headline)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(.ultraThinMaterial, in: Capsule())
                    .padding(.top, 12)
            }
            .gesture(
                SpatialTapGesture()
                    .onEnded { value in
                        let point = CGPoint(
                            x: value.location.x / max(layout.mediaRect.width, 1),
                            y: value.location.y / max(layout.mediaRect.height, 1)
                        ).clampedUnit()
                        viewModel.handleTrackingTap(at: point)
                    }
            )
    }

    private func barView(_ bar: MemeBar, rect: CGRect, scale: CGFloat) -> some View {
        ZStack {
            RoundedRectangle(cornerRadius: 18)
                .fill(Color(rgbaHex: bar.backgroundColorHex))

            Text(bar.text.isEmpty ? " " : bar.text)
                .font(.custom(bar.fontName, size: max(14, bar.fontSize * scale)))
                .foregroundStyle(Color(rgbaHex: bar.textColorHex))
                .multilineTextAlignment(.center)
                .padding(.horizontal, 16)
        }
        .frame(width: rect.width, height: rect.height)
        .position(x: rect.midX, y: rect.midY)
    }
}
