import SwiftUI
import UIKit
import CoreGraphics

struct MotionKeyframe: Identifiable, Hashable, Codable {
    let id: UUID
    var frameIndex: Int
    var x: CGFloat
    var y: CGFloat

    init(id: UUID = UUID(), frameIndex: Int, x: CGFloat, y: CGFloat) {
        self.id = id
        self.frameIndex = frameIndex
        self.x = x
        self.y = y
    }
}

struct CaptionStyle: Hashable, Codable {
    var fontName: String = "Impact"
    var fontSize: CGFloat = 42
    var textColorHex: String = "#FFFFFFFF"
    var strokeColorHex: String = "#000000FF"
    var strokeWidth: CGFloat = 5
}

struct OnImageCaption: Identifiable, Hashable, Codable {
    let id: UUID
    var text: String
    var x: CGFloat
    var y: CGFloat
    var startFrame: Int
    var endFrame: Int
    var style: CaptionStyle
    var motion: [MotionKeyframe]

    init(
        id: UUID = UUID(),
        text: String,
        x: CGFloat,
        y: CGFloat,
        startFrame: Int,
        endFrame: Int,
        style: CaptionStyle = CaptionStyle(),
        motion: [MotionKeyframe] = []
    ) {
        self.id = id
        self.text = text
        self.x = x
        self.y = y
        self.startFrame = startFrame
        self.endFrame = endFrame
        self.style = style
        self.motion = motion.sorted(by: { $0.frameIndex < $1.frameIndex })
    }

    static func `default`(frameCount: Int) -> OnImageCaption {
        OnImageCaption(
            text: "Caption",
            x: 0.5,
            y: 0.78,
            startFrame: 0,
            endFrame: max(frameCount - 1, 0)
        )
    }

    func isVisible(at frameIndex: Int) -> Bool {
        frameIndex >= startFrame && frameIndex <= endFrame
    }

    func interpolatedPosition(at frameIndex: Int) -> CGPoint {
        interpolatedPoint(from: motion, frameIndex: frameIndex, fallback: CGPoint(x: x, y: y))
    }

    mutating func remap(after cropBox: CropBox) {
        let remapped = cropBox.remap(point: CGPoint(x: x, y: y))
        x = remapped.x
        y = remapped.y
        motion = motion.map { keyframe in
            let point = cropBox.remap(point: CGPoint(x: keyframe.x, y: keyframe.y))
            return MotionKeyframe(frameIndex: keyframe.frameIndex, x: point.x, y: point.y)
        }
    }
}

struct ImageOverlay: Identifiable, Hashable {
    let id: UUID
    var name: String
    var imageData: Data
    var x: CGFloat
    var y: CGFloat
    var scale: CGFloat
    var rotation: CGFloat
    var opacity: CGFloat
    var startFrame: Int
    var endFrame: Int
    var motion: [MotionKeyframe]

    init(
        id: UUID = UUID(),
        name: String,
        imageData: Data,
        x: CGFloat,
        y: CGFloat,
        scale: CGFloat,
        rotation: CGFloat = 0,
        opacity: CGFloat = 1,
        startFrame: Int,
        endFrame: Int,
        motion: [MotionKeyframe] = []
    ) {
        self.id = id
        self.name = name
        self.imageData = imageData
        self.x = x
        self.y = y
        self.scale = scale
        self.rotation = rotation
        self.opacity = opacity
        self.startFrame = startFrame
        self.endFrame = endFrame
        self.motion = motion.sorted(by: { $0.frameIndex < $1.frameIndex })
    }

    static func make(
        data: Data,
        name: String,
        mediaSize: CGSize,
        frameCount: Int
    ) -> ImageOverlay? {
        guard let image = UIImage(data: data), let cgImage = image.cgImage else {
            return nil
        }
        let maxDim = max(mediaSize.width, mediaSize.height)
        let imageMax = max(CGFloat(cgImage.width), CGFloat(cgImage.height))
        let scale = imageMax > maxDim * 0.5 ? (maxDim * 0.5) / imageMax : 1
        return ImageOverlay(
            name: name,
            imageData: data,
            x: 0.18,
            y: 0.18,
            scale: scale,
            startFrame: 0,
            endFrame: max(frameCount - 1, 0)
        )
    }

    var image: UIImage? {
        UIImage(data: imageData)
    }

    var cgImage: CGImage? {
        image?.cgImage
    }

    var pixelSize: CGSize {
        guard let cgImage else { return .zero }
        return CGSize(width: cgImage.width, height: cgImage.height)
    }

    func isVisible(at frameIndex: Int) -> Bool {
        frameIndex >= startFrame && frameIndex <= endFrame
    }

    func interpolatedPosition(at frameIndex: Int) -> CGPoint {
        interpolatedPoint(from: motion, frameIndex: frameIndex, fallback: CGPoint(x: x, y: y))
    }

    mutating func remap(after cropBox: CropBox) {
        let remapped = cropBox.remap(point: CGPoint(x: x, y: y))
        x = remapped.x
        y = remapped.y
        motion = motion.map { keyframe in
            let point = cropBox.remap(point: CGPoint(x: keyframe.x, y: keyframe.y))
            return MotionKeyframe(frameIndex: keyframe.frameIndex, x: point.x, y: point.y)
        }
    }
}

struct MemeBar: Hashable, Codable {
    enum Position: String, Codable {
        case top
        case bottom
    }

    var position: Position
    var isEnabled: Bool
    var text: String
    var height: CGFloat
    var fontName: String
    var fontSize: CGFloat
    var textColorHex: String
    var backgroundColorHex: String

    init(position: Position) {
        self.position = position
        self.isEnabled = false
        self.text = ""
        self.height = 84
        self.fontName = "Impact"
        self.fontSize = 38
        self.textColorHex = "#000000FF"
        self.backgroundColorHex = "#FFFFFFFF"
    }
}

enum MediaKind: String {
    case gif
    case video
}

struct EditorFrame: Identifiable {
    let id = UUID()
    let image: CGImage
    let delay: TimeInterval
}

struct LoadedMedia {
    var frames: [EditorFrame]
    var mediaSize: CGSize
    var originalFilename: String
    var kind: MediaKind
}

struct CropBox: Hashable, Codable {
    var x: CGFloat
    var y: CGFloat
    var width: CGFloat
    var height: CGFloat

    static let full = CropBox(x: 0, y: 0, width: 1, height: 1)

    mutating func clamp(minimumSize: CGFloat = 0.08) {
        width = width.clamped(to: minimumSize...1)
        height = height.clamped(to: minimumSize...1)
        x = x.clamped(to: 0...(1 - width))
        y = y.clamped(to: 0...(1 - height))
    }

    func rect(in mediaRect: CGRect) -> CGRect {
        CGRect(
            x: mediaRect.minX + mediaRect.width * x,
            y: mediaRect.minY + mediaRect.height * y,
            width: mediaRect.width * width,
            height: mediaRect.height * height
        )
    }

    func pixelRect(in mediaSize: CGSize) -> CGRect {
        let startX = Int(round(x * mediaSize.width))
        let startY = Int(round(y * mediaSize.height))
        let endX = Int(round((x + width) * mediaSize.width))
        let endY = Int(round((y + height) * mediaSize.height))
        let clampedX = max(0, min(Int(mediaSize.width) - 1, startX))
        let clampedY = max(0, min(Int(mediaSize.height) - 1, startY))
        let clampedEndX = max(clampedX + 1, min(Int(mediaSize.width), endX))
        let clampedEndY = max(clampedY + 1, min(Int(mediaSize.height), endY))
        return CGRect(
            x: clampedX,
            y: clampedY,
            width: clampedEndX - clampedX,
            height: clampedEndY - clampedY
        )
    }

    func remap(point: CGPoint) -> CGPoint {
        let remappedX = ((point.x - x) / max(width, 0.001)).clamped(to: 0...1)
        let remappedY = ((point.y - y) / max(height, 0.001)).clamped(to: 0...1)
        return CGPoint(x: remappedX, y: remappedY)
    }
}

struct AlertItem: Identifiable {
    let id = UUID()
    let title: String
    let message: String
}

struct ShareItem: Identifiable {
    let id = UUID()
    let url: URL
}

struct WebsiteShareResult: Identifiable {
    let id = UUID()
    let slug: String
    let shareURL: URL
    let mediaURL: URL
}

enum EditorError: LocalizedError {
    case message(String)

    var errorDescription: String? {
        switch self {
        case .message(let message):
            return message
        }
    }
}

enum EditorFonts {
    static let supported = [
        "Impact",
        "AvenirNext-Bold",
        "HelveticaNeue-Bold",
        "ChalkboardSE-Bold",
        "Noteworthy-Bold",
        "MarkerFelt-Wide",
    ]
}

extension Array where Element == EditorFrame {
    var averageDelay: TimeInterval {
        guard !isEmpty else { return 0.1 }
        let sum = reduce(0) { partialResult, frame in
            partialResult + frame.delay
        }
        return sum / Double(count)
    }
}

private func interpolatedPoint(
    from motion: [MotionKeyframe],
    frameIndex: Int,
    fallback: CGPoint
) -> CGPoint {
    guard !motion.isEmpty else {
        return fallback
    }
    let sorted = motion.sorted(by: { $0.frameIndex < $1.frameIndex })
    if sorted.count == 1 {
        return CGPoint(x: sorted[0].x, y: sorted[0].y)
    }
    if frameIndex <= sorted[0].frameIndex {
        return CGPoint(x: sorted[0].x, y: sorted[0].y)
    }
    if let last = sorted.last, frameIndex >= last.frameIndex {
        return CGPoint(x: last.x, y: last.y)
    }

    for pairIndex in 0..<(sorted.count - 1) {
        let left = sorted[pairIndex]
        let right = sorted[pairIndex + 1]
        if frameIndex >= left.frameIndex && frameIndex < right.frameIndex {
            let span = CGFloat(max(right.frameIndex - left.frameIndex, 1))
            let progress = CGFloat(frameIndex - left.frameIndex) / span
            return CGPoint(
                x: left.x + ((right.x - left.x) * progress),
                y: left.y + ((right.y - left.y) * progress)
            )
        }
    }
    return fallback
}

extension CGSize {
    func aspectFit(in container: CGSize) -> CGSize {
        guard width > 0, height > 0, container.width > 0, container.height > 0 else {
            return .zero
        }
        let scale = min(container.width / width, container.height / height)
        return CGSize(width: width * scale, height: height * scale)
    }
}

extension CGFloat {
    func clamped(to range: ClosedRange<CGFloat>) -> CGFloat {
        Swift.min(Swift.max(self, range.lowerBound), range.upperBound)
    }
}

extension CGPoint {
    func clampedUnit() -> CGPoint {
        CGPoint(x: x.clamped(to: 0...1), y: y.clamped(to: 0...1))
    }
}

extension UIColor {
    convenience init(rgbaHex: String) {
        let cleaned = rgbaHex
            .trimmingCharacters(in: CharacterSet.alphanumerics.inverted)
            .uppercased()
        let value = UInt64(cleaned, radix: 16) ?? 0

        let r, g, b, a: UInt64
        switch cleaned.count {
        case 6:
            r = (value & 0xFF0000) >> 16
            g = (value & 0x00FF00) >> 8
            b = value & 0x0000FF
            a = 0xFF
        case 8:
            r = (value & 0xFF000000) >> 24
            g = (value & 0x00FF0000) >> 16
            b = (value & 0x0000FF00) >> 8
            a = value & 0x000000FF
        default:
            r = 255
            g = 255
            b = 255
            a = 255
        }

        self.init(
            red: CGFloat(r) / 255,
            green: CGFloat(g) / 255,
            blue: CGFloat(b) / 255,
            alpha: CGFloat(a) / 255
        )
    }

    var rgbaHexString: String {
        var red: CGFloat = 0
        var green: CGFloat = 0
        var blue: CGFloat = 0
        var alpha: CGFloat = 0
        getRed(&red, green: &green, blue: &blue, alpha: &alpha)
        return String(
            format: "#%02X%02X%02X%02X",
            Int(red * 255),
            Int(green * 255),
            Int(blue * 255),
            Int(alpha * 255)
        )
    }
}

extension Color {
    init(rgbaHex: String) {
        self.init(UIColor(rgbaHex: rgbaHex))
    }
}
