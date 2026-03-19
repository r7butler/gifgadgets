import Foundation
import ImageIO
import UniformTypeIdentifiers

enum GIFExporter {
    static func export(
        media: LoadedMedia,
        captions: [OnImageCaption],
        overlays: [ImageOverlay],
        topBar: MemeBar,
        bottomBar: MemeBar
    ) throws -> URL {
        let baseName = sanitizedFilename(media.originalFilename)
        let outputURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("\(baseName)-captioned-\(Int(Date().timeIntervalSince1970)).gif")

        if FileManager.default.fileExists(atPath: outputURL.path) {
            try FileManager.default.removeItem(at: outputURL)
        }

        guard let destination = CGImageDestinationCreateWithURL(
            outputURL as CFURL,
            UTType.gif.identifier as CFString,
            media.frames.count,
            nil
        ) else {
            throw EditorError.message("Could not create the output GIF.")
        }

        let globalProperties = [
            kCGImagePropertyGIFDictionary as String: [
                kCGImagePropertyGIFLoopCount as String: 0,
            ],
        ] as CFDictionary
        CGImageDestinationSetProperties(destination, globalProperties)

        for (index, frame) in media.frames.enumerated() {
            guard let composed = CaptionRenderer.compositeImage(
                frame: frame,
                frameIndex: index,
                mediaSize: media.mediaSize,
                captions: captions,
                overlays: overlays,
                topBar: topBar,
                bottomBar: bottomBar
            ) else {
                continue
            }
            let frameProperties = [
                kCGImagePropertyGIFDictionary as String: [
                    kCGImagePropertyGIFDelayTime as String: max(frame.delay, 0.02),
                ],
            ] as CFDictionary
            CGImageDestinationAddImage(destination, composed, frameProperties)
        }

        guard CGImageDestinationFinalize(destination) else {
            throw EditorError.message("The exported GIF could not be finalized.")
        }

        return outputURL
    }

    private static func sanitizedFilename(_ filename: String) -> String {
        let pattern = "[^A-Za-z0-9_-]+"
        let cleaned = filename.replacingOccurrences(
            of: pattern,
            with: "-",
            options: .regularExpression
        )
        return cleaned.isEmpty ? "gifwidgets" : cleaned
    }
}
