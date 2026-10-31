import SwiftUI

@main
struct ShardApp: App {
    @State private var model = AppModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .tint(Theme.accent)
                .task {
                    await model.start()
                }
                .onChange(of: scenePhase) { _, phase in
                    // Pull whatever the desktop pushed while the app was in the background.
                    if phase == .active, model.isConfigured {
                        Task { await model.sync() }
                    }
                }
        }
    }
}
