import SwiftUI

struct RootView: View {
    @Environment(AppModel.self) private var model
    @State private var showingLegacySetup = false
    @State private var webColorMode = "system"

    var body: some View {
        if model.isRestoring {
            ProgressView()
        } else if model.repository != nil, model.isConfigured {
            MainView()
        } else if model.isConfigured, model.webRequiresLegacyOffline {
            MainView()
                .safeAreaInset(edge: .top) {
                    HStack {
                        Text("离线缓存").foregroundStyle(Theme.mutedInk)
                        Spacer()
                        Button("重试") { Task { await model.retryWebWorkspace() } }
                    }
                    .font(.footnote)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 8)
                    .background(Theme.canvas)
                }
        } else {
            WebAppView(model: model, head: model.headCommit, pendingCount: model.pending.count,
                       syncState: model.syncState, onLegacy: { showingLegacySetup = true },
                       onAppearance: { webColorMode = $0 })
                .id(WebAppView.identity(for: model))
                .ignoresSafeArea(.container)
                .preferredColorScheme(webColorMode == "system" ? nil : webColorMode == "dark" ? .dark : .light)
                .sheet(isPresented: $showingLegacySetup) {
                    NavigationStack { GitHubSetupView(isReplacing: true) }
                }
        }
    }
}

/// Navigation value for a tag's timeline.
struct TagRoute: Hashable, Identifiable {
    let name: String
    var id: String { name }
}
