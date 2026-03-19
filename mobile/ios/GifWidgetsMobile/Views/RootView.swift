import SwiftUI
import UniformTypeIdentifiers
import UIKit

struct RootView: View {
    @ObservedObject var viewModel: EditorViewModel
    @State private var isImportingMedia = false
    @State private var isImportingOverlay = false

    var body: some View {
        NavigationStack {
            Group {
                if viewModel.frames.isEmpty {
                    emptyState
                } else {
                    editor
                }
            }
            .navigationTitle("GifWidgets")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Import") {
                        isImportingMedia = true
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    if !viewModel.frames.isEmpty {
                        Button(viewModel.isPlaying ? "Pause" : "Play") {
                            viewModel.togglePlayback()
                        }
                    }
                }
            }
        }
        .fileImporter(
            isPresented: $isImportingMedia,
            allowedContentTypes: [.gif, .movie, .mpeg4Movie, .quickTimeMovie],
            allowsMultipleSelection: false
        ) { result in
            switch result {
            case .success(let urls):
                guard let url = urls.first else { return }
                Task {
                    await viewModel.open(url: url)
                }
            case .failure(let error):
                viewModel.alertItem = AlertItem(
                    title: "Import Failed",
                    message: error.localizedDescription
                )
            }
        }
        .fileImporter(
            isPresented: $isImportingOverlay,
            allowedContentTypes: [.image],
            allowsMultipleSelection: false
        ) { result in
            switch result {
            case .success(let urls):
                guard let url = urls.first else { return }
                Task {
                    await viewModel.addOverlay(from: url)
                }
            case .failure(let error):
                viewModel.alertItem = AlertItem(
                    title: "Overlay Failed",
                    message: error.localizedDescription
                )
            }
        }
        .sheet(item: $viewModel.shareItem) { item in
            ActivityView(activityItems: [item.url])
        }
        .sheet(item: $viewModel.websiteShareResult) { result in
            WebsiteShareSheet(
                result: result,
                onShare: { url in
                    viewModel.presentSystemShare(for: url)
                }
            )
        }
        .alert(item: $viewModel.alertItem) { item in
            Alert(
                title: Text(item.title),
                message: Text(item.message),
                dismissButton: .default(Text("OK"))
            )
        }
    }

    private var emptyState: some View {
        VStack(spacing: 24) {
            Spacer(minLength: 40)
            VStack(spacing: 14) {
                Image(systemName: "sparkles.rectangle.stack")
                    .font(.system(size: 52, weight: .semibold))
                    .foregroundStyle(.white)
                    .padding(22)
                    .background(
                        RoundedRectangle(cornerRadius: 24)
                            .fill(
                                LinearGradient(
                                    colors: [
                                        Color(red: 0.05, green: 0.2, blue: 0.18),
                                        Color(red: 0.12, green: 0.08, blue: 0.2),
                                    ],
                                    startPoint: .topLeading,
                                    endPoint: .bottomTrailing
                                )
                            )
                    )
                Text("Native GIF editing for iPhone and iPad")
                    .font(.title2.weight(.bold))
                Text("Import a GIF or short video, add timed captions, layer image overlays, crop the frame, export a new GIF, publish a website share page, and run on-device EdgeTAM tracking.")
                    .font(.body)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 28)
            }

            Button {
                isImportingMedia = true
            } label: {
                Label("Import Media", systemImage: "square.and.arrow.down")
                    .font(.headline)
                    .padding(.horizontal, 20)
                    .padding(.vertical, 14)
            }
            .buttonStyle(.borderedProminent)

            Spacer()
        }
        .padding()
    }

    private var editor: some View {
        ScrollView {
            VStack(spacing: 18) {
                EditorPreviewView(viewModel: viewModel)

                if let trackingMessage = viewModel.trackingMessage {
                    statusCard(trackingMessage)
                }

                playbackSection
                actionSection
                cropSection
                captionListSection
                selectedCaptionSection
                overlayListSection
                selectedOverlaySection
                barSection(title: "Top Bar", bar: bindingForBar(.top))
                barSection(title: "Bottom Bar", bar: bindingForBar(.bottom))
            }
            .padding()
        }
    }

    private var playbackSection: some View {
        GroupBox("Playback") {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Button(viewModel.isPlaying ? "Pause" : "Play") {
                        viewModel.togglePlayback()
                    }
                    .buttonStyle(.borderedProminent)

                    Button("Stop") {
                        viewModel.stopPlayback()
                        viewModel.currentFrameIndex = 0
                    }
                    .buttonStyle(.bordered)

                    Spacer()

                    Text(frameLabel)
                        .font(.callout.monospacedDigit())
                        .foregroundStyle(.secondary)
                }

                Slider(
                    value: Binding(
                        get: { Double(viewModel.currentFrameIndex) },
                        set: { viewModel.currentFrameIndex = Int($0.rounded()) }
                    ),
                    in: 0...Double(max(viewModel.frames.count - 1, 0)),
                    step: 1
                )
            }
        }
    }

    private var actionSection: some View {
        GroupBox("Actions") {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Button {
                        viewModel.addCaption()
                    } label: {
                        Label("Add Caption", systemImage: "text.badge.plus")
                    }
                    .buttonStyle(.borderedProminent)

                    Button {
                        isImportingOverlay = true
                    } label: {
                        Label("Add Overlay", systemImage: "photo.badge.plus")
                    }
                    .buttonStyle(.bordered)
                }

                HStack {
                    Button {
                        viewModel.toggleTrackingMode()
                    } label: {
                        Label(viewModel.trackingButtonTitle, systemImage: "scope")
                    }
                    .buttonStyle(.bordered)
                    .disabled(!viewModel.hasTrackableSelection)

                    Button {
                        viewModel.setCropMode(!viewModel.isCropMode)
                    } label: {
                        Label(viewModel.isCropMode ? "Done Cropping" : "Crop", systemImage: "crop")
                    }
                    .buttonStyle(.bordered)
                }

                HStack {
                    Button {
                        Task {
                            await viewModel.exportGIF()
                        }
                    } label: {
                        if viewModel.isExporting {
                            HStack {
                                ProgressView()
                                Text("Exporting…")
                            }
                        } else {
                            Label("Export GIF", systemImage: "square.and.arrow.up")
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(viewModel.isExporting || viewModel.isSharingToWebsite || viewModel.frames.isEmpty)

                    Button {
                        Task {
                            await viewModel.shareToWebsite()
                        }
                    } label: {
                        if viewModel.isSharingToWebsite {
                            HStack {
                                ProgressView()
                                Text("Publishing…")
                            }
                        } else {
                            Label("Share to Website", systemImage: "link.badge.plus")
                        }
                    }
                    .buttonStyle(.bordered)
                    .disabled(viewModel.isExporting || viewModel.isSharingToWebsite || viewModel.frames.isEmpty)
                }

                Text("Website share uploads a public GIF to the existing GifWidgets share flow and returns a live share URL.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var cropSection: some View {
        GroupBox("Crop") {
            VStack(alignment: .leading, spacing: 14) {
                Toggle(
                    "Crop Mode",
                    isOn: Binding(
                        get: { viewModel.isCropMode },
                        set: { viewModel.setCropMode($0) }
                    )
                )

                Text(viewModel.isCropMode
                    ? "Drag the crop box directly on the preview or fine-tune the values below."
                    : "Use crop mode to position the crop box on the preview. Apply Crop updates the loaded media and remaps captions and overlays.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)

                VStack(alignment: .leading, spacing: 6) {
                    Text("Left: \(Int(viewModel.cropBox.x * 100))%")
                    Slider(
                        value: cropBinding(\.x),
                        in: 0...max(0, 1 - viewModel.cropBox.width),
                        step: 0.01
                    )
                }

                VStack(alignment: .leading, spacing: 6) {
                    Text("Top: \(Int(viewModel.cropBox.y * 100))%")
                    Slider(
                        value: cropBinding(\.y),
                        in: 0...max(0, 1 - viewModel.cropBox.height),
                        step: 0.01
                    )
                }

                VStack(alignment: .leading, spacing: 6) {
                    Text("Width: \(Int(viewModel.cropBox.width * 100))%")
                    Slider(
                        value: cropBinding(\.width),
                        in: 0.08...max(0.08, 1 - viewModel.cropBox.x),
                        step: 0.01
                    )
                }

                VStack(alignment: .leading, spacing: 6) {
                    Text("Height: \(Int(viewModel.cropBox.height * 100))%")
                    Slider(
                        value: cropBinding(\.height),
                        in: 0.08...max(0.08, 1 - viewModel.cropBox.y),
                        step: 0.01
                    )
                }

                HStack {
                    Button("Reset") {
                        viewModel.resetCrop()
                    }
                    .buttonStyle(.bordered)
                    .disabled(viewModel.cropBox == .full)

                    Spacer()

                    Button("Apply Crop") {
                        viewModel.applyCrop()
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(!viewModel.canApplyCrop)
                }
            }
        }
    }

    private var captionListSection: some View {
        GroupBox("Captions") {
            if viewModel.captions.isEmpty {
                Text("No captions yet. Add one to start editing.")
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                VStack(spacing: 8) {
                    ForEach(viewModel.captions) { caption in
                        Button {
                            viewModel.selectCaption(caption.id)
                        } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(caption.text.isEmpty ? "Untitled Caption" : caption.text)
                                        .lineLimit(1)
                                        .font(.headline)
                                    Text("Frames \(caption.startFrame) – \(caption.endFrame)")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                                Spacer()
                                if !caption.motion.isEmpty {
                                    Text("\(caption.motion.count) keyframes")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                            }
                            .padding(10)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(
                                RoundedRectangle(cornerRadius: 14)
                                    .fill(
                                        viewModel.selectedCaptionID == caption.id
                                            ? Color.accentColor.opacity(0.18)
                                            : Color.secondary.opacity(0.08)
                                    )
                            )
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
    }

    private var selectedCaptionSection: some View {
        GroupBox("Selected Caption") {
            if let index = viewModel.selectedCaptionIndex {
                VStack(alignment: .leading, spacing: 14) {
                    TextField("Caption text", text: bindingForCaption(index, \.text), axis: .vertical)
                        .textFieldStyle(.roundedBorder)

                    Picker("Font", selection: bindingForCaptionStyle(index, \.fontName)) {
                        ForEach(EditorFonts.supported, id: \.self) { fontName in
                            Text(fontName).tag(fontName)
                        }
                    }
                    .pickerStyle(.menu)

                    VStack(alignment: .leading, spacing: 6) {
                        Text("Font Size: \(Int(viewModel.captions[index].style.fontSize))")
                            .font(.subheadline.weight(.medium))
                        Slider(
                            value: bindingForCaptionStyle(index, \.fontSize),
                            in: 16...96,
                            step: 1
                        )
                    }

                    VStack(alignment: .leading, spacing: 6) {
                        Text("Stroke Width: \(Int(viewModel.captions[index].style.strokeWidth))")
                            .font(.subheadline.weight(.medium))
                        Slider(
                            value: bindingForCaptionStyle(index, \.strokeWidth),
                            in: 0...12,
                            step: 1
                        )
                    }

                    ColorPicker(
                        "Text Color",
                        selection: colorBinding(
                            get: { viewModel.captions[index].style.textColorHex },
                            set: { viewModel.captions[index].style.textColorHex = $0 }
                        )
                    )

                    ColorPicker(
                        "Stroke Color",
                        selection: colorBinding(
                            get: { viewModel.captions[index].style.strokeColorHex },
                            set: { viewModel.captions[index].style.strokeColorHex = $0 }
                        )
                    )

                    HStack {
                        Stepper(
                            "Start \(viewModel.captions[index].startFrame)",
                            value: bindingForCaption(index, \.startFrame),
                            in: 0...viewModel.captions[index].endFrame
                        )
                        Stepper(
                            "End \(viewModel.captions[index].endFrame)",
                            value: bindingForCaption(index, \.endFrame),
                            in: viewModel.captions[index].startFrame...max(viewModel.frames.count - 1, 0)
                        )
                    }
                    .font(.subheadline)

                    HStack {
                        Button("Clear Motion") {
                            viewModel.clearMotionForSelectedCaption()
                        }
                        .buttonStyle(.bordered)
                        .disabled(viewModel.captions[index].motion.isEmpty)

                        Spacer()

                        Button(role: .destructive) {
                            viewModel.removeSelectedCaption()
                        } label: {
                            Label("Delete", systemImage: "trash")
                        }
                        .buttonStyle(.bordered)
                    }
                }
            } else {
                Text("Pick a caption from the list to edit its timing and styling.")
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    private var overlayListSection: some View {
        GroupBox("Overlays") {
            if viewModel.overlays.isEmpty {
                Text("No overlays yet. Add an image to layer it over the media.")
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                VStack(spacing: 8) {
                    ForEach(viewModel.overlays) { overlay in
                        Button {
                            viewModel.selectOverlay(overlay.id)
                        } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(overlay.name)
                                        .lineLimit(1)
                                        .font(.headline)
                                    Text("Frames \(overlay.startFrame) – \(overlay.endFrame)")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                                Spacer()
                                if !overlay.motion.isEmpty {
                                    Text("\(overlay.motion.count) keyframes")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                            }
                            .padding(10)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(
                                RoundedRectangle(cornerRadius: 14)
                                    .fill(
                                        viewModel.selectedOverlayID == overlay.id
                                            ? Color.orange.opacity(0.18)
                                            : Color.secondary.opacity(0.08)
                                    )
                            )
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
    }

    private var selectedOverlaySection: some View {
        GroupBox("Selected Overlay") {
            if let index = viewModel.selectedOverlayIndex {
                let overlay = viewModel.overlays[index]
                VStack(alignment: .leading, spacing: 14) {
                    Text(overlay.name)
                        .font(.headline)

                    Text("\(Int(overlay.pixelSize.width)) × \(Int(overlay.pixelSize.height)) px")
                        .font(.caption)
                        .foregroundStyle(.secondary)

                    VStack(alignment: .leading, spacing: 6) {
                        Text("Scale: \(overlay.scale, specifier: "%.2f")")
                        Slider(
                            value: bindingForOverlay(index, \.scale),
                            in: 0.05...3,
                            step: 0.01
                        )
                    }

                    VStack(alignment: .leading, spacing: 6) {
                        Text("Rotation: \(Int(overlay.rotation))°")
                        Slider(
                            value: bindingForOverlay(index, \.rotation),
                            in: -180...180,
                            step: 1
                        )
                    }

                    VStack(alignment: .leading, spacing: 6) {
                        Text("Opacity: \(Int(overlay.opacity * 100))%")
                        Slider(
                            value: bindingForOverlay(index, \.opacity),
                            in: 0.1...1,
                            step: 0.01
                        )
                    }

                    HStack {
                        Stepper(
                            "Start \(overlay.startFrame)",
                            value: bindingForOverlay(index, \.startFrame),
                            in: 0...overlay.endFrame
                        )
                        Stepper(
                            "End \(overlay.endFrame)",
                            value: bindingForOverlay(index, \.endFrame),
                            in: overlay.startFrame...max(viewModel.frames.count - 1, 0)
                        )
                    }
                    .font(.subheadline)

                    HStack {
                        Button("Clear Motion") {
                            viewModel.clearMotionForSelectedOverlay()
                        }
                        .buttonStyle(.bordered)
                        .disabled(overlay.motion.isEmpty)

                        Spacer()

                        Button(role: .destructive) {
                            viewModel.removeSelectedOverlay()
                        } label: {
                            Label("Delete", systemImage: "trash")
                        }
                        .buttonStyle(.bordered)
                    }
                }
            } else {
                Text("Pick an overlay from the list to edit its placement, timing, and appearance.")
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    private func barSection(title: String, bar: Binding<MemeBar>) -> some View {
        GroupBox(title) {
            VStack(alignment: .leading, spacing: 14) {
                Toggle("Enabled", isOn: bar.isEnabled)
                TextField("Text", text: bar.text, axis: .vertical)
                    .textFieldStyle(.roundedBorder)
                Picker("Font", selection: bar.fontName) {
                    ForEach(EditorFonts.supported, id: \.self) { font in
                        Text(font).tag(font)
                    }
                }
                .pickerStyle(.menu)
                VStack(alignment: .leading, spacing: 6) {
                    Text("Height: \(Int(bar.wrappedValue.height))")
                    Slider(value: bar.height, in: 48...140, step: 1)
                }
                VStack(alignment: .leading, spacing: 6) {
                    Text("Font Size: \(Int(bar.wrappedValue.fontSize))")
                    Slider(value: bar.fontSize, in: 16...84, step: 1)
                }
                ColorPicker(
                    "Text Color",
                    selection: colorBinding(
                        get: { bar.wrappedValue.textColorHex },
                        set: { bar.wrappedValue.textColorHex = $0 }
                    )
                )
                ColorPicker(
                    "Background Color",
                    selection: colorBinding(
                        get: { bar.wrappedValue.backgroundColorHex },
                        set: { bar.wrappedValue.backgroundColorHex = $0 }
                    )
                )
            }
        }
    }

    private func statusCard(_ message: String) -> some View {
        HStack(spacing: 12) {
            ProgressView()
            Text(message)
                .font(.subheadline)
            Spacer()
        }
        .padding(14)
        .background(
            RoundedRectangle(cornerRadius: 18)
                .fill(Color.secondary.opacity(0.12))
        )
    }

    private func bindingForCaption<Value>(
        _ index: Int,
        _ keyPath: WritableKeyPath<OnImageCaption, Value>
    ) -> Binding<Value> {
        Binding(
            get: { viewModel.captions[index][keyPath: keyPath] },
            set: { viewModel.captions[index][keyPath: keyPath] = $0 }
        )
    }

    private func bindingForCaptionStyle<Value>(
        _ index: Int,
        _ keyPath: WritableKeyPath<CaptionStyle, Value>
    ) -> Binding<Value> {
        Binding(
            get: { viewModel.captions[index].style[keyPath: keyPath] },
            set: { viewModel.captions[index].style[keyPath: keyPath] = $0 }
        )
    }

    private func bindingForOverlay<Value>(
        _ index: Int,
        _ keyPath: WritableKeyPath<ImageOverlay, Value>
    ) -> Binding<Value> {
        Binding(
            get: { viewModel.overlays[index][keyPath: keyPath] },
            set: { viewModel.overlays[index][keyPath: keyPath] = $0 }
        )
    }

    private func bindingForBar(_ position: MemeBar.Position) -> Binding<MemeBar> {
        Binding(
            get: {
                position == .top ? viewModel.topBar : viewModel.bottomBar
            },
            set: { newValue in
                if position == .top {
                    viewModel.topBar = newValue
                } else {
                    viewModel.bottomBar = newValue
                }
            }
        )
    }

    private func cropBinding(_ keyPath: WritableKeyPath<CropBox, CGFloat>) -> Binding<CGFloat> {
        Binding(
            get: { viewModel.cropBox[keyPath: keyPath] },
            set: { newValue in
                var next = viewModel.cropBox
                next[keyPath: keyPath] = newValue
                next.clamp()
                viewModel.updateCropBox(next)
            }
        )
    }

    private func colorBinding(
        get: @escaping () -> String,
        set: @escaping (String) -> Void
    ) -> Binding<Color> {
        Binding(
            get: { Color(rgbaHex: get()) },
            set: { newValue in
                set(UIColor(newValue).rgbaHexString)
            }
        )
    }

    private var frameLabel: String {
        guard !viewModel.frames.isEmpty else { return "0 / 0" }
        return "\(viewModel.currentFrameIndex + 1) / \(viewModel.frames.count)"
    }
}

private struct WebsiteShareSheet: View {
    let result: WebsiteShareResult
    let onShare: (URL) -> Void

    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Your GIF is live")
                            .font(.title2.weight(.bold))
                        Text("This creates a public GifWidgets share page and media URL.")
                            .foregroundStyle(.secondary)
                    }

                    linkCard(title: "Share Page", url: result.shareURL)
                    linkCard(title: "Direct Media", url: result.mediaURL)

                    Button {
                        UIPasteboard.general.url = result.shareURL
                    } label: {
                        Label("Copy Share Link", systemImage: "link")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)

                    Button {
                        onShare(result.shareURL)
                    } label: {
                        Label("Open Share Sheet", systemImage: "square.and.arrow.up")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)

                    Button {
                        openURL(result.shareURL)
                    } label: {
                        Label("Open Share Page", systemImage: "safari")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                }
                .padding()
            }
            .navigationTitle("Website Share")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") {
                        dismiss()
                    }
                }
            }
        }
    }

    private func linkCard(title: String, url: URL) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.headline)
            Text(url.absoluteString)
                .font(.callout.monospaced())
                .textSelection(.enabled)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(
            RoundedRectangle(cornerRadius: 18)
                .fill(Color.secondary.opacity(0.08))
        )
    }
}
