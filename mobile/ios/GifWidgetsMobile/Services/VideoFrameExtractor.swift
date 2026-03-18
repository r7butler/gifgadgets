import Foundation
import AVFoundation

enum VideoFrameExtractor {
    static func loadFrames(
        from url: URL,
        preferredFPS: Double = 12,
        maxFrames: Int = 120
    ) async throws -> LoadedMedia {
        let asset = AVURLAsset(url: url)
        let duration = try await asset.load(.duration)
        let durationSeconds = CMTimeGetSeconds(duration)
        guard durationSeconds.isFinite, durationSeconds > 0 else {
            throw EditorError.message("The selected video could not be read.")
        }

        let tracks = try await asset.loadTracks(withMediaType: .video)
        guard let track = tracks.first else {
            throw EditorError.message("No video track was found in the selected file.")
        }

        let nominalFrameRate = try await track.load(.nominalFrameRate)
        let nominalFPS = nominalFrameRate > 0 ? Double(nominalFrameRate) : preferredFPS
        let sampleFPS = max(1, min(nominalFPS, preferredFPS))
        let estimatedFrameCount = max(1, Int((durationSeconds * sampleFPS).rounded(.up)))
        let strideMultiplier = max(1, Int(ceil(Double(estimatedFrameCount) / Double(maxFrames))))
        let step = 1.0 / sampleFPS * Double(strideMultiplier)

        let generator = AVAssetImageGenerator(asset: asset)
        generator.appliesPreferredTrackTransform = true
        generator.requestedTimeToleranceBefore = .zero
        generator.requestedTimeToleranceAfter = .zero

        var images: [EditorFrame] = []
        var mediaSize = CGSize.zero
        var currentTime = 0.0

        while currentTime < durationSeconds {
            let time = CMTime(seconds: currentTime, preferredTimescale: 600)
            do {
                let cgImage = try generator.copyCGImage(at: time, actualTime: nil)
                if mediaSize == .zero {
                    mediaSize = CGSize(width: cgImage.width, height: cgImage.height)
                }
                images.append(EditorFrame(image: cgImage, delay: step))
            } catch {
                // Skip failed frame extracts rather than failing the whole import.
            }
            currentTime += step
        }

        if images.isEmpty {
            throw EditorError.message("No frames could be extracted from the selected video.")
        }

        return LoadedMedia(
            frames: images,
            mediaSize: mediaSize,
            originalFilename: url.deletingPathExtension().lastPathComponent,
            kind: .video
        )
    }
}
