import SwiftUI

@main
struct GifWidgetsMobileApp: App {
    @StateObject private var viewModel = EditorViewModel()

    var body: some Scene {
        WindowGroup {
            RootView(viewModel: viewModel)
        }
    }
}
