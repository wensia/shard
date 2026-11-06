import ShardKit
import SwiftUI

struct MainView: View {
    var body: some View {
        TabView {
            TimelineView()
                .tabItem { Label("碎片", systemImage: "square.stack") }
            TagsView()
                .tabItem { Label("标签", systemImage: "number") }
            NotesView()
                .tabItem { Label("笔记", systemImage: "doc.text") }
        }
    }
}

/// Destinations shared by every tab's NavigationStack.
struct VaultDestinations: ViewModifier {
    func body(content: Content) -> some View {
        content
            .navigationDestination(for: VaultDocument.self) { DocumentDetailView(document: $0) }
            .navigationDestination(for: TagRoute.self) { TagTimelineView(tag: $0.name) }
    }
}

extension View {
    func vaultDestinations() -> some View {
        modifier(VaultDestinations())
    }
}
