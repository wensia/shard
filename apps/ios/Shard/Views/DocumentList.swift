import ShardKit
import SwiftUI

/// Card list used by the timeline, tag timelines and search results.
struct DocumentList: View {
    let documents: [VaultDocument]
    var emptyTitle = "还没有内容"
    var emptyMessage = "下拉同步，或在桌面 Shard 里记一条。"

    var body: some View {
        ScrollView {
            if documents.isEmpty {
                ContentUnavailableView(emptyTitle, systemImage: "square.stack", description: Text(emptyMessage))
                    .padding(.top, 80)
            } else {
                LazyVStack(spacing: 12) {
                    ForEach(documents) { document in
                        NavigationLink(value: document) {
                            DocumentCard(document: document)
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("document-card")
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
            }
        }
        .background(Theme.canvas)
    }
}

struct DocumentCard: View {
    let document: VaultDocument

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            header
            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: 10))
        .overlay {
            RoundedRectangle(cornerRadius: 10).strokeBorder(Theme.line.opacity(0.5), lineWidth: 0.5)
        }
        .contentShape(RoundedRectangle(cornerRadius: 10))
    }

    @ViewBuilder private var header: some View {
        let typeLabel = ContentType.label(for: document.typeTag)
        let date = DisplayDate.short(document.createdAt)
        if document.kind == .fragment, !date.isEmpty || typeLabel != nil || document.pinned || document.isPending {
            HStack(spacing: 6) {
                Text(date)
                if let typeLabel {
                    Text(typeLabel)
                        .padding(.horizontal, 5)
                        .padding(.vertical, 1)
                        .background(Theme.fill, in: RoundedRectangle(cornerRadius: 4))
                }
                Spacer(minLength: 0)
                if document.isPending {
                    Label("待同步", systemImage: "arrow.up.circle")
                        .foregroundStyle(Theme.accent)
                        .accessibilityIdentifier("pending-badge")
                }
                if document.pinned {
                    Image(systemName: "pin.fill").foregroundStyle(Theme.accent)
                }
            }
            .font(.caption)
            .foregroundStyle(Theme.mutedInk)
        }
    }

    @ViewBuilder private var content: some View {
        if document.kind == .note || document.typeTag == "document" {
            let digest = Preview.documentDigest(document.body)
            Text(document.kind == .note ? document.title : (digest.title.isEmpty ? "无标题" : digest.title))
                .font(.headline)
                .foregroundStyle(Theme.ink)
            if !digest.summary.isEmpty {
                Text(digest.summary)
                    .font(.subheadline)
                    .foregroundStyle(Theme.mutedInk)
                    .lineLimit(3)
            }
        } else {
            Text(Preview.highlighted(document.body))
                .font(.body)
                .foregroundStyle(Theme.ink)
                .lineLimit(10)
                .lineSpacing(3)
        }
    }
}
