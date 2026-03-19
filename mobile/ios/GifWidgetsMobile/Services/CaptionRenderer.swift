import SwiftUI
import UIKit

struct PreviewLayout {
    let compositeRect: CGRect
    let mediaRect: CGRect
    let topBarRect: CGRect?
    let bottomBarRect: CGRect?
    let scale: CGFloat
}

struct CaptionTextLayout {
    let rect: CGRect
    let scale: CGFloat
}

struct OverlayImageLayout {
    let rect: CGRect
    let scale: CGFloat
}

enum CaptionRenderer {
    static func canvasSize(for mediaSize: CGSize, topBar: MemeBar, bottomBar: MemeBar) -> CGSize {
        CGSize(
            width: mediaSize.width,
            height: mediaSize.height + barHeight(topBar) + barHeight(bottomBar)
        )
    }

    static func previewLayout(
        in containerSize: CGSize,
        mediaSize: CGSize,
        topBar: MemeBar,
        bottomBar: MemeBar
    ) -> PreviewLayout {
        let compositeSize = canvasSize(for: mediaSize, topBar: topBar, bottomBar: bottomBar)
        guard compositeSize.width > 0, compositeSize.height > 0 else {
            return PreviewLayout(
                compositeRect: .zero,
                mediaRect: .zero,
                topBarRect: nil,
                bottomBarRect: nil,
                scale: 1
            )
        }

        let fitSize = compositeSize.aspectFit(in: containerSize)
        let scale = fitSize.width / compositeSize.width
        let origin = CGPoint(
            x: (containerSize.width - fitSize.width) / 2,
            y: (containerSize.height - fitSize.height) / 2
        )

        let topHeight = barHeight(topBar) * scale
        let bottomHeight = barHeight(bottomBar) * scale
        let topRect = topBar.isEnabled
            ? CGRect(x: origin.x, y: origin.y, width: fitSize.width, height: topHeight)
            : nil
        let mediaRect = CGRect(
            x: origin.x,
            y: origin.y + topHeight,
            width: fitSize.width,
            height: mediaSize.height * scale
        )
        let bottomRect = bottomBar.isEnabled
            ? CGRect(
                x: origin.x,
                y: mediaRect.maxY,
                width: fitSize.width,
                height: bottomHeight
            )
            : nil

        return PreviewLayout(
            compositeRect: CGRect(origin: origin, size: fitSize),
            mediaRect: mediaRect,
            topBarRect: topRect,
            bottomBarRect: bottomRect,
            scale: scale
        )
    }

    static func layout(
        for caption: OnImageCaption,
        mediaSize: CGSize,
        in mediaRect: CGRect,
        frameIndex: Int
    ) -> CaptionTextLayout {
        guard mediaSize.width > 0 else {
            return CaptionTextLayout(rect: .zero, scale: 1)
        }
        let scale = mediaRect.width / mediaSize.width
        let maxWidth = mediaRect.width * 0.82
        let fontSize = max(12, caption.style.fontSize * scale)
        let stroke = max(1, caption.style.strokeWidth * scale)
        let size = measureText(
            caption.text,
            fontName: caption.style.fontName,
            fontSize: fontSize,
            strokeWidth: stroke,
            maxWidth: maxWidth
        )
        let position = caption.interpolatedPosition(at: frameIndex).clampedUnit()
        let center = CGPoint(
            x: mediaRect.minX + (mediaRect.width * position.x),
            y: mediaRect.minY + (mediaRect.height * position.y)
        )
        let rect = CGRect(
            x: center.x - (size.width / 2),
            y: center.y - (size.height / 2),
            width: size.width,
            height: size.height
        )
        return CaptionTextLayout(rect: rect, scale: scale)
    }

    static func overlayLayout(
        for overlay: ImageOverlay,
        mediaSize: CGSize,
        in mediaRect: CGRect,
        frameIndex: Int
    ) -> OverlayImageLayout {
        guard mediaSize.width > 0, mediaRect.width > 0, mediaRect.height > 0 else {
            return OverlayImageLayout(rect: .zero, scale: 1)
        }

        let renderScale = mediaRect.width / mediaSize.width
        let pixelSize = overlay.pixelSize
        guard pixelSize.width > 0, pixelSize.height > 0 else {
            return OverlayImageLayout(rect: .zero, scale: renderScale)
        }

        let position = overlay.interpolatedPosition(at: frameIndex).clampedUnit()
        let center = CGPoint(
            x: mediaRect.minX + (mediaRect.width * position.x),
            y: mediaRect.minY + (mediaRect.height * position.y)
        )
        let size = CGSize(
            width: pixelSize.width * max(overlay.scale, 0.05) * renderScale,
            height: pixelSize.height * max(overlay.scale, 0.05) * renderScale
        )
        let rect = CGRect(
            x: center.x - (size.width / 2),
            y: center.y - (size.height / 2),
            width: size.width,
            height: size.height
        )

        return OverlayImageLayout(rect: rect, scale: renderScale)
    }

    static func compositeImage(
        frame: EditorFrame,
        frameIndex: Int,
        mediaSize: CGSize,
        captions: [OnImageCaption],
        overlays: [ImageOverlay],
        topBar: MemeBar,
        bottomBar: MemeBar
    ) -> CGImage? {
        let canvasSize = canvasSize(for: mediaSize, topBar: topBar, bottomBar: bottomBar)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = false

        let renderer = UIGraphicsImageRenderer(size: canvasSize, format: format)
        let image = renderer.image { context in
            let topHeight = barHeight(topBar)
            let mediaRect = CGRect(x: 0, y: topHeight, width: mediaSize.width, height: mediaSize.height)
            if topBar.isEnabled {
                drawBar(topBar, in: CGRect(x: 0, y: 0, width: canvasSize.width, height: topHeight))
            }
            UIImage(cgImage: frame.image).draw(in: mediaRect)
            for overlay in overlays where overlay.isVisible(at: frameIndex) {
                drawOverlay(overlay, frameIndex: frameIndex, mediaSize: mediaSize, in: mediaRect)
            }
            for caption in captions where caption.isVisible(at: frameIndex) {
                drawCaption(caption, frameIndex: frameIndex, mediaSize: mediaSize, in: mediaRect)
            }
            if bottomBar.isEnabled {
                drawBar(
                    bottomBar,
                    in: CGRect(
                        x: 0,
                        y: mediaRect.maxY,
                        width: canvasSize.width,
                        height: barHeight(bottomBar)
                    )
                )
            }
        }
        return image.cgImage
    }

    static func barHeight(_ bar: MemeBar) -> CGFloat {
        bar.isEnabled ? bar.height : 0
    }

    private static func drawBar(_ bar: MemeBar, in rect: CGRect) {
        UIColor(rgbaHex: bar.backgroundColorHex).setFill()
        UIBezierPath(rect: rect).fill()

        let paragraph = NSMutableParagraphStyle()
        paragraph.alignment = .center

        let font = UIFont(name: bar.fontName, size: bar.fontSize) ?? UIFont.systemFont(ofSize: bar.fontSize, weight: .heavy)
        let attributes: [NSAttributedString.Key: Any] = [
            .font: font,
            .foregroundColor: UIColor(rgbaHex: bar.textColorHex),
            .paragraphStyle: paragraph,
        ]
        let inset = rect.insetBy(dx: rect.width * 0.04, dy: 8)
        NSAttributedString(string: bar.text, attributes: attributes).draw(
            with: inset,
            options: [.usesLineFragmentOrigin, .usesFontLeading],
            context: nil
        )
    }

    private static func drawCaption(
        _ caption: OnImageCaption,
        frameIndex: Int,
        mediaSize: CGSize,
        in mediaRect: CGRect
    ) {
        let layout = layout(for: caption, mediaSize: mediaSize, in: mediaRect, frameIndex: frameIndex)
        let attributed = attributedCaption(
            text: caption.text,
            fontName: caption.style.fontName,
            fontSize: max(12, caption.style.fontSize * layout.scale),
            textColorHex: caption.style.textColorHex,
            strokeColorHex: caption.style.strokeColorHex,
            strokeWidth: max(1, caption.style.strokeWidth * layout.scale)
        )
        attributed.draw(
            with: layout.rect,
            options: [.usesLineFragmentOrigin, .usesFontLeading],
            context: nil
        )
    }

    private static func drawOverlay(
        _ overlay: ImageOverlay,
        frameIndex: Int,
        mediaSize: CGSize,
        in mediaRect: CGRect
    ) {
        guard let cgImage = overlay.cgImage, let context = UIGraphicsGetCurrentContext() else {
            return
        }

        let layout = overlayLayout(for: overlay, mediaSize: mediaSize, in: mediaRect, frameIndex: frameIndex)
        guard layout.rect != .zero else { return }

        context.saveGState()
        context.translateBy(x: layout.rect.midX, y: layout.rect.midY)
        context.rotate(by: overlay.rotation * (.pi / 180))
        context.setAlpha(max(0, min(1, overlay.opacity)))
        context.draw(
            cgImage,
            in: CGRect(
                x: -(layout.rect.width / 2),
                y: -(layout.rect.height / 2),
                width: layout.rect.width,
                height: layout.rect.height
            )
        )
        context.restoreGState()
    }

    private static func attributedCaption(
        text: String,
        fontName: String,
        fontSize: CGFloat,
        textColorHex: String,
        strokeColorHex: String,
        strokeWidth: CGFloat
    ) -> NSAttributedString {
        let paragraph = NSMutableParagraphStyle()
        paragraph.alignment = .center
        let font = UIFont(name: fontName, size: fontSize) ?? UIFont.systemFont(ofSize: fontSize, weight: .heavy)
        let attributes: [NSAttributedString.Key: Any] = [
            .font: font,
            .foregroundColor: UIColor(rgbaHex: textColorHex),
            .strokeColor: UIColor(rgbaHex: strokeColorHex),
            .strokeWidth: -strokeWidth,
            .paragraphStyle: paragraph,
        ]
        return NSAttributedString(string: text, attributes: attributes)
    }

    private static func measureText(
        _ text: String,
        fontName: String,
        fontSize: CGFloat,
        strokeWidth: CGFloat,
        maxWidth: CGFloat
    ) -> CGSize {
        let attributed = attributedCaption(
            text: text.isEmpty ? " " : text,
            fontName: fontName,
            fontSize: fontSize,
            textColorHex: "#FFFFFFFF",
            strokeColorHex: "#000000FF",
            strokeWidth: strokeWidth
        )
        let rect = attributed.boundingRect(
            with: CGSize(width: maxWidth, height: .greatestFiniteMagnitude),
            options: [.usesLineFragmentOrigin, .usesFontLeading],
            context: nil
        ).integral

        return CGSize(
            width: max(rect.width + 20, 40),
            height: max(rect.height + 12, fontSize + 12)
        )
    }
}
