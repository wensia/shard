import ShardKit
import SwiftUI

/// Full rendering of one fragment or note through the bundled `@shard/markdown` page.
struct DocumentDetailView: View {
    let document: VaultDocument
    @Environment(AppModel.self) private var model
    @State private var openedTag: TagRoute?

    var body: some View {
        MarkdownWebView(
            payload: payload,
            loadVaultFile: { try await model.vaultFile($0) },
            onOpenTag: { openedTag = TagRoute(name: $0) }
        )
        .background(Theme.canvas)
        .ignoresSafeArea(edges: .bottom)
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .navigationDestination(item: $openedTag) { TagTimelineView(tag: $0.name) }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                ShareLink(item: document.body)
            }
        }
    }

    private var isDocumentLayout: Bool {
        document.kind == .note || document.typeTag == "document"
    }

    private var title: String {
        switch document.kind {
        case .note: document.title
        case .fragment: ContentType.label(for: document.typeTag) ?? "碎片"
        }
    }

    private var payload: RenderPayload {
        guard document.kind == .fragment else {
            return RenderPayload(kind: .document, content: document.body)
        }
        let meta = RenderPayload.Meta(
            date: DisplayDate.short(document.createdAt),
            typeLabel: ContentType.label(for: document.typeTag),
            pinned: document.pinned,
            tags: document.tags.filter { $0 != ShardTags.inbox && $0 != document.typeTag }
        )
        return RenderPayload(
            kind: isDocumentLayout ? .document : .fragment,
            content: document.body,
            hideTags: true,
            meta: meta
        )
    }
}
