import Foundation
import SwiftUI

@MainActor
final class EditorViewModel: ObservableObject {
    @Published var media: LoadedMedia?
    @Published var captions: [OnImageCaption] = []
    @Published var currentFrameIndex: Int = 0
    @Published var selectedCaptionID: UUID?
    @Published var isPlaying = false
    @Published var topBar = MemeBar(position: .top)
    @Published var bottomBar = MemeBar(position: .bottom)
    @Published var isTrackingMode = false
    @Published var trackingMessage: String?
    @Published var alertItem: AlertItem?
    @Published var shareItem: ShareItem?
    @Published var isExporting = false

    private var playbackTimer: Timer?
    private let trackingService = EdgeTAMTrackingService()

    var frames: [EditorFrame] {
        media?.frames ?? []
    }

    var mediaSize: CGSize {
        media?.mediaSize ?? .zero
    }

    var currentFrame: EditorFrame? {
        guard frames.indices.contains(currentFrameIndex) else { return nil }
        return frames[currentFrameIndex]
    }

    var selectedCaptionIndex: Int? {
        guard let selectedCaptionID else { return nil }
        return captions.firstIndex(where: { $0.id == selectedCaptionID })
    }

    var visibleCaptions: [OnImageCaption] {
        captions.filter { $0.isVisible(at: currentFrameIndex) }
    }

    func open(url: URL) async {
        stopPlayback()
        let hadScope = url.startAccessingSecurityScopedResource()
        defer {
            if hadScope {
                url.stopAccessingSecurityScopedResource()
            }
        }

        do {
            let pathExtension = url.pathExtension.lowercased()
            let loaded: LoadedMedia
            if pathExtension == "gif" {
                loaded = try GIFDecoder.loadFrames(from: url)
            } else {
                loaded = try await VideoFrameExtractor.loadFrames(from: url)
            }

            media = loaded
            captions = []
            currentFrameIndex = 0
            selectedCaptionID = nil
            topBar = MemeBar(position: .top)
            bottomBar = MemeBar(position: .bottom)
            isTrackingMode = false
            trackingMessage = nil
        } catch {
            alertItem = AlertItem(
                title: "Import Failed",
                message: error.localizedDescription
            )
        }
    }

    func addCaption() {
        guard let media else { return }
        let caption = OnImageCaption.default(frameCount: media.frames.count)
        captions.append(caption)
        selectedCaptionID = caption.id
    }

    func selectCaption(_ id: UUID) {
        selectedCaptionID = id
    }

    func removeSelectedCaption() {
        guard let selectedCaptionID else { return }
        captions.removeAll { $0.id == selectedCaptionID }
        self.selectedCaptionID = captions.first?.id
    }

    func updateCaptionPosition(captionID: UUID, normalizedPoint: CGPoint, keyedToCurrentFrame: Bool) {
        guard let index = captions.firstIndex(where: { $0.id == captionID }) else { return }
        let clamped = normalizedPoint.clampedUnit()
        if keyedToCurrentFrame {
            if let motionIndex = captions[index].motion.firstIndex(where: { $0.frameIndex == currentFrameIndex }) {
                captions[index].motion[motionIndex].x = clamped.x
                captions[index].motion[motionIndex].y = clamped.y
            } else {
                captions[index].motion.append(MotionKeyframe(
                    frameIndex: currentFrameIndex,
                    x: clamped.x,
                    y: clamped.y
                ))
                captions[index].motion.sort(by: { $0.frameIndex < $1.frameIndex })
            }
        } else {
            captions[index].x = clamped.x
            captions[index].y = clamped.y
        }
    }

    func clearMotionForSelectedCaption() {
        guard let selectedCaptionIndex else { return }
        let currentPosition = captions[selectedCaptionIndex].interpolatedPosition(at: currentFrameIndex)
        captions[selectedCaptionIndex].x = currentPosition.x
        captions[selectedCaptionIndex].y = currentPosition.y
        captions[selectedCaptionIndex].motion = []
    }

    func togglePlayback() {
        if isPlaying {
            stopPlayback()
        } else {
            startPlayback()
        }
    }

    func startPlayback() {
        guard frames.count > 1 else { return }
        isPlaying = true
        scheduleNextFrame()
    }

    func stopPlayback() {
        isPlaying = false
        playbackTimer?.invalidate()
        playbackTimer = nil
    }

    func exportGIF() async {
        guard let media else { return }
        isExporting = true
        defer { isExporting = false }

        do {
            let url = try GIFExporter.export(
                media: media,
                captions: captions,
                topBar: topBar,
                bottomBar: bottomBar
            )
            shareItem = ShareItem(url: url)
        } catch {
            alertItem = AlertItem(
                title: "Export Failed",
                message: error.localizedDescription
            )
        }
    }

    func toggleTrackingMode() {
        guard selectedCaptionIndex != nil else {
            alertItem = AlertItem(
                title: "Select a Caption",
                message: "Choose a caption before starting EdgeTAM tracking."
            )
            return
        }
        isTrackingMode.toggle()
        trackingMessage = isTrackingMode
            ? "Tap the object in the preview to begin EdgeTAM tracking."
            : nil
    }

    func handleTrackingTap(at normalizedPoint: CGPoint) {
        guard isTrackingMode else { return }
        isTrackingMode = false

        Task {
            await runTracking(from: normalizedPoint)
        }
    }

    func sampledTrackingFrameIndices() -> [Int] {
        guard !frames.isEmpty else { return [] }
        let averageDelay = frames.averageDelay
        let fps = averageDelay > 0 ? 1.0 / averageDelay : 10
        let stepSize = max(1, Int(floor(fps / 10)))
        var indices = Array(stride(from: 0, to: frames.count, by: stepSize))
        if !indices.contains(currentFrameIndex) {
            indices.append(currentFrameIndex)
        }
        return indices.sorted()
    }

    private func runTracking(from normalizedPoint: CGPoint) async {
        guard let selectedCaptionIndex else { return }
        let sampled = sampledTrackingFrameIndices()

        do {
            trackingMessage = "Preparing EdgeTAM…"
            let motion = try await trackingService.track(
                frames: frames,
                sampledFrameIndices: sampled,
                clickFrameIndex: currentFrameIndex,
                normalizedPoint: normalizedPoint
            ) { [weak self] update in
                Task { @MainActor in
                    self?.trackingMessage = update.message
                }
            }

            captions[selectedCaptionIndex].motion = motion
            trackingMessage = "Tracked \(motion.count) keyframes."
        } catch {
            trackingMessage = nil
            alertItem = AlertItem(
                title: "Tracking Failed",
                message: error.localizedDescription
            )
        }
    }

    private func scheduleNextFrame() {
        playbackTimer?.invalidate()
        guard isPlaying, frames.indices.contains(currentFrameIndex) else { return }

        let delay = max(frames[currentFrameIndex].delay, 0.02)
        playbackTimer = Timer.scheduledTimer(withTimeInterval: delay, repeats: false) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self else { return }
                guard self.isPlaying, !self.frames.isEmpty else { return }
                self.currentFrameIndex = (self.currentFrameIndex + 1) % self.frames.count
                self.scheduleNextFrame()
            }
        }
    }

    deinit {
        playbackTimer?.invalidate()
    }
}
