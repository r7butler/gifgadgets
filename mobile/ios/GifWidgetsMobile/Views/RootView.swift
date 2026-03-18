import SwiftUI
import UniformTypeIdentifiers

struct RootView: View {
    @ObservedObject var viewModel: EditorViewModel
    @State private var isImporting = false

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
                        isImporting = true
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
            isPresented: $isImporting,
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
        .sheet(item: $viewModel.shareItem) { item in
            ActivityView(activityItems: [item.url])
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
                Text("Import a GIF or short video, add timed captions, drag them directly on the frame, export a new GIF, and run on-device EdgeTAM tracking.")
                    .font(.body)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 28)
            }

            Button {
                isImporting = true
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
                captionListSection
                selectedCaptionSection
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
                        viewModel.toggleTrackingMode()
                    } label: {
                        Label(
                            viewModel.isTrackingMode ? "Cancel Tracking" : "Track Caption",
                            systemImage: "scope"
                        )
                    }
                    .buttonStyle(.bordered)
                    .disabled(viewModel.selectedCaptionID == nil)
                }

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
                .disabled(viewModel.isExporting || viewModel.frames.isEmpty)
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
