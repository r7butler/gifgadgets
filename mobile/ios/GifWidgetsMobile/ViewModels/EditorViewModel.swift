import Foundation
import SwiftUI

@MainActor
final class EditorViewModel: ObservableObject {
    private enum TrackingTarget {
        case caption(UUID)
        case overlay(UUID)
    }

    @Published var media: LoadedMedia?
    @Published var captions: [OnImageCaption] = []
    @Published var overlays: [ImageOverlay] = []
    @Published var currentFrameIndex: Int = 0
    @Published var selectedCaptionID: UUID?
    @Published var selectedOverlayID: UUID?
    @Published var isPlaying = false
    @Published var topBar = MemeBar(position: .top)
    @Published var bottomBar = MemeBar(position: .bottom)
    @Published var isTrackingMode = false
    @Published var isCropMode = false
    @Published var cropBox = CropBox.full
    @Published var trackingMessage: String?
    @Published var alertItem: AlertItem?
    @Published var shareItem: ShareItem?
    @Published var websiteShareResult: WebsiteShareResult?
    @Published var isExporting = false
    @Published var isSharingToWebsite = false

    private var playbackTimer: Timer?
    private let trackingService = EdgeTAMTrackingService()
    private let websiteShareService = WebsiteShareService()

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

    var selectedOverlayIndex: Int? {
        guard let selectedOverlayID else { return nil }
        return overlays.firstIndex(where: { $0.id == selectedOverlayID })
    }

    var visibleCaptions: [OnImageCaption] {
        captions.filter { $0.isVisible(at: currentFrameIndex) }
    }

    var visibleOverlays: [ImageOverlay] {
        overlays.filter { $0.isVisible(at: currentFrameIndex) }
    }

    var hasTrackableSelection: Bool {
        selectedTrackingTarget != nil
    }

    var trackingButtonTitle: String {
        if isTrackingMode {
            return "Cancel Tracking"
        }
        switch selectedTrackingTarget {
        case .caption:
            return "Track Caption"
        case .overlay:
            return "Track Overlay"
        case nil:
            return "Track Selection"
        }
    }

    var canApplyCrop: Bool {
        cropBox != .full
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
            overlays = []
            currentFrameIndex = 0
            selectedCaptionID = nil
            selectedOverlayID = nil
            topBar = MemeBar(position: .top)
            bottomBar = MemeBar(position: .bottom)
            isTrackingMode = false
            isCropMode = false
            cropBox = .full
            trackingMessage = nil
            websiteShareResult = nil
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
        selectedOverlayID = nil
    }

    func addOverlay(from url: URL) async {
        guard let media else {
            alertItem = AlertItem(
                title: "Import Media First",
                message: "Open a GIF or video before adding an overlay."
            )
            return
        }

        let hadScope = url.startAccessingSecurityScopedResource()
        defer {
            if hadScope {
                url.stopAccessingSecurityScopedResource()
            }
        }

        do {
            let data = try Data(contentsOf: url)
            guard let overlay = ImageOverlay.make(
                data: data,
                name: url.lastPathComponent,
                mediaSize: media.mediaSize,
                frameCount: media.frames.count
            ) else {
                throw EditorError.message("The selected image could not be loaded as an overlay.")
            }

            overlays.append(overlay)
            selectedOverlayID = overlay.id
            selectedCaptionID = nil
        } catch {
            alertItem = AlertItem(
                title: "Overlay Failed",
                message: error.localizedDescription
            )
        }
    }

    func selectCaption(_ id: UUID) {
        selectedCaptionID = id
        selectedOverlayID = nil
    }

    func selectOverlay(_ id: UUID) {
        selectedOverlayID = id
        selectedCaptionID = nil
    }

    func removeSelectedCaption() {
        guard let selectedCaptionID else { return }
        captions.removeAll { $0.id == selectedCaptionID }
        self.selectedCaptionID = captions.first?.id
    }

    func removeSelectedOverlay() {
        guard let selectedOverlayID else { return }
        overlays.removeAll { $0.id == selectedOverlayID }
        self.selectedOverlayID = overlays.first?.id
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

    func updateOverlayPosition(overlayID: UUID, normalizedPoint: CGPoint, keyedToCurrentFrame: Bool) {
        guard let index = overlays.firstIndex(where: { $0.id == overlayID }) else { return }
        let clamped = normalizedPoint.clampedUnit()
        if keyedToCurrentFrame {
            if let motionIndex = overlays[index].motion.firstIndex(where: { $0.frameIndex == currentFrameIndex }) {
                overlays[index].motion[motionIndex].x = clamped.x
                overlays[index].motion[motionIndex].y = clamped.y
            } else {
                overlays[index].motion.append(MotionKeyframe(
                    frameIndex: currentFrameIndex,
                    x: clamped.x,
                    y: clamped.y
                ))
                overlays[index].motion.sort(by: { $0.frameIndex < $1.frameIndex })
            }
        } else {
            overlays[index].x = clamped.x
            overlays[index].y = clamped.y
        }
    }

    func clearMotionForSelectedCaption() {
        guard let selectedCaptionIndex else { return }
        let currentPosition = captions[selectedCaptionIndex].interpolatedPosition(at: currentFrameIndex)
        captions[selectedCaptionIndex].x = currentPosition.x
        captions[selectedCaptionIndex].y = currentPosition.y
        captions[selectedCaptionIndex].motion = []
    }

    func clearMotionForSelectedOverlay() {
        guard let selectedOverlayIndex else { return }
        let currentPosition = overlays[selectedOverlayIndex].interpolatedPosition(at: currentFrameIndex)
        overlays[selectedOverlayIndex].x = currentPosition.x
        overlays[selectedOverlayIndex].y = currentPosition.y
        overlays[selectedOverlayIndex].motion = []
    }

    func setCropMode(_ enabled: Bool) {
        guard enabled != isCropMode else { return }
        isCropMode = enabled
        if enabled {
            isTrackingMode = false
            trackingMessage = nil
        }
    }

    func updateCropBox(_ nextCropBox: CropBox) {
        var next = nextCropBox
        next.clamp()
        cropBox = next
    }

    func resetCrop() {
        cropBox = .full
    }

    func applyCrop() {
        guard var media, canApplyCrop else { return }

        let pixelRect = cropBox.pixelRect(in: media.mediaSize).integral
        let croppedFrames = media.frames.compactMap { frame -> EditorFrame? in
            guard let croppedImage = frame.image.cropping(to: pixelRect) else { return nil }
            return EditorFrame(image: croppedImage, delay: frame.delay)
        }

        guard !croppedFrames.isEmpty else {
            alertItem = AlertItem(
                title: "Crop Failed",
                message: "The selected crop area could not be applied."
            )
            return
        }

        media.frames = croppedFrames
        media.mediaSize = CGSize(width: pixelRect.width, height: pixelRect.height)
        self.media = media
        captions = captions.map { caption in
            var next = caption
            next.remap(after: cropBox)
            next.startFrame = next.startFrame.clamped(to: 0...max(croppedFrames.count - 1, 0))
            next.endFrame = next.endFrame.clamped(to: next.startFrame...max(croppedFrames.count - 1, 0))
            return next
        }
        overlays = overlays.map { overlay in
            var next = overlay
            next.remap(after: cropBox)
            next.startFrame = next.startFrame.clamped(to: 0...max(croppedFrames.count - 1, 0))
            next.endFrame = next.endFrame.clamped(to: next.startFrame...max(croppedFrames.count - 1, 0))
            return next
        }
        cropBox = .full
        isCropMode = false
        currentFrameIndex = min(currentFrameIndex, max(croppedFrames.count - 1, 0))
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
        guard media != nil else { return }
        isExporting = true
        defer { isExporting = false }

        do {
            let url = try buildExportURL()
            shareItem = ShareItem(url: url)
        } catch {
            alertItem = AlertItem(
                title: "Export Failed",
                message: error.localizedDescription
            )
        }
    }

    func shareToWebsite() async {
        guard media != nil else { return }
        isSharingToWebsite = true
        defer { isSharingToWebsite = false }

        do {
            let url = try buildExportURL()
            let result = try await websiteShareService.shareGIF(
                fileURL: url,
                title: suggestedShareTitle,
                filename: suggestedShareFilename
            )
            websiteShareResult = result
        } catch {
            alertItem = AlertItem(
                title: "Share Failed",
                message: error.localizedDescription
            )
        }
    }

    func presentSystemShare(for url: URL) {
        shareItem = ShareItem(url: url)
    }

    func toggleTrackingMode() {
        guard let target = selectedTrackingTarget else {
            alertItem = AlertItem(
                title: "Select Something First",
                message: "Choose a caption or overlay before starting EdgeTAM tracking."
            )
            return
        }

        isTrackingMode.toggle()
        if isTrackingMode {
            isCropMode = false
            trackingMessage = "Tap the object in the preview to begin EdgeTAM tracking for the selected \(trackingTargetName(target))."
        } else {
            trackingMessage = nil
        }
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

    private var selectedTrackingTarget: TrackingTarget? {
        if let selectedOverlayID {
            return .overlay(selectedOverlayID)
        }
        if let selectedCaptionID {
            return .caption(selectedCaptionID)
        }
        return nil
    }

    private var suggestedShareTitle: String {
        let captionText = captions.first(where: { !$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty })?.text
        let topText = topBar.text.trimmingCharacters(in: .whitespacesAndNewlines)
        let bottomText = bottomBar.text.trimmingCharacters(in: .whitespacesAndNewlines)
        let mediaName = media?.originalFilename.replacingOccurrences(of: "-", with: " ")

        for candidate in [captionText, topText, bottomText, mediaName] {
            if let candidate, !candidate.isEmpty {
                return candidate
            }
        }

        return "Captioned GIF"
    }

    private var suggestedShareFilename: String {
        let base = media?.originalFilename.isEmpty == false ? media?.originalFilename : "gifwidgets"
        return "\(base ?? "gifwidgets")-captioned.gif"
    }

    private func buildExportURL() throws -> URL {
        guard let media else {
            throw EditorError.message("There is no media loaded to export.")
        }

        return try GIFExporter.export(
            media: media,
            captions: captions,
            overlays: overlays,
            topBar: topBar,
            bottomBar: bottomBar
        )
    }

    private func runTracking(from normalizedPoint: CGPoint) async {
        guard let target = selectedTrackingTarget else { return }
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

            switch target {
            case .caption(let id):
                guard let index = captions.firstIndex(where: { $0.id == id }) else { return }
                captions[index].motion = motion
            case .overlay(let id):
                guard let index = overlays.firstIndex(where: { $0.id == id }) else { return }
                overlays[index].motion = motion
            }

            trackingMessage = "Tracked \(motion.count) keyframes."
        } catch {
            trackingMessage = nil
            alertItem = AlertItem(
                title: "Tracking Failed",
                message: error.localizedDescription
            )
        }
    }

    private func trackingTargetName(_ target: TrackingTarget) -> String {
        switch target {
        case .caption:
            return "caption"
        case .overlay:
            return "overlay"
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

private extension Int {
    func clamped(to range: ClosedRange<Int>) -> Int {
        Swift.min(Swift.max(self, range.lowerBound), range.upperBound)
    }
}
