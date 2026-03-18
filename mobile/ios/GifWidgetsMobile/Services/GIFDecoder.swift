import Foundation
import ImageIO
import UniformTypeIdentifiers

enum GIFDecoder {
    static func loadFrames(from url: URL) throws -> LoadedMedia {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else {
            throw EditorError.message("Could not open the selected GIF.")
        }

        let frameCount = CGImageSourceGetCount(source)
        guard frameCount > 0 else {
            throw EditorError.message("The selected GIF has no frames.")
        }

        var frames: [EditorFrame] = []
        frames.reserveCapacity(frameCount)

        var mediaSize = CGSize.zero
        for index in 0..<frameCount {
            guard let cgImage = CGImageSourceCreateImageAtIndex(source, index, nil) else {
                continue
            }
            if mediaSize == .zero {
                mediaSize = CGSize(width: cgImage.width, height: cgImage.height)
            }

            let properties = (CGImageSourceCopyPropertiesAtIndex(source, index, nil) as? [CFString: Any]) ?? [:]
            let delay = frameDelay(from: properties)
            frames.append(EditorFrame(image: cgImage, delay: delay))
        }

        guard !frames.isEmpty else {
            throw EditorError.message("None of the GIF frames could be decoded.")
        }

        return LoadedMedia(
            frames: frames,
            mediaSize: mediaSize,
            originalFilename: url.deletingPathExtension().lastPathComponent,
            kind: .gif
        )
    }

    private static func frameDelay(from properties: [CFString: Any]) -> TimeInterval {
        guard
            let gifDictionary = properties[kCGImagePropertyGIFDictionary] as? [CFString: Any]
        else {
            return 0.1
        }

        let unclamped = gifDictionary[kCGImagePropertyGIFUnclampedDelayTime] as? Double
        let clamped = gifDictionary[kCGImagePropertyGIFDelayTime] as? Double
        let raw = unclamped ?? clamped ?? 0.1
        return max(raw, 0.02)
    }
}
