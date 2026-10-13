import SwiftUI

struct RootView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        if model.isConfigured {
            MainView()
        } else {
            NavigationStack {
                SetupView()
            }
        }
    }
}

/// Navigation value for a tag's timeline.
struct TagRoute: Hashable, Identifiable {
    let name: String
    var id: String { name }
}
