import ShardKit
import SwiftUI

struct TagsView: View {
    @Environment(AppModel.self) private var model
    @State private var query = ""

    var body: some View {
        NavigationStack {
            List(filtered) { tag in
                NavigationLink(value: TagRoute(name: tag.name)) {
                    HStack {
                        Text("#\(tag.name)").foregroundStyle(Theme.tagInk)
                        Spacer()
                        Text("\(tag.count)")
                            .font(.subheadline.monospacedDigit())
                            .foregroundStyle(Theme.mutedInk)
                    }
                }
                .accessibilityIdentifier("tag-row")
            }
            .overlay {
                if model.index.tags.isEmpty {
                    ContentUnavailableView("还没有标签", systemImage: "number", description: Text("在碎片里写 #标签 就会出现在这里。"))
                }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.canvas)
            .refreshable { await model.sync() }
            .searchable(text: $query, prompt: "筛选标签")
            .navigationTitle("标签")
            .vaultDestinations()
        }
    }

    private var filtered: [VaultIndex.TagCount] {
        guard !query.isEmpty else { return model.index.tags }
        return model.index.tags.filter { $0.name.range(of: query, options: [.caseInsensitive, .widthInsensitive]) != nil }
    }
}

struct TagTimelineView: View {
    let tag: String
    @Environment(AppModel.self) private var model

    var body: some View {
        DocumentList(
            documents: model.index.fragments(taggedWith: tag),
            emptyTitle: "没有碎片",
            emptyMessage: "这个标签下暂时没有内容。"
        )
        .navigationTitle("#\(tag)")
        .navigationBarTitleDisplayMode(.inline)
    }
}
