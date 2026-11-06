import ShardKit
import SwiftUI

/// `notes/` grouped by folder, the way the desktop library tree nests them.
struct NotesView: View {
    @Environment(AppModel.self) private var model
    @State private var query = ""

    var body: some View {
        NavigationStack {
            List {
                ForEach(sections, id: \.folder) { section in
                    Section(section.folder.isEmpty ? "笔记" : section.folder) {
                        ForEach(section.notes) { note in
                            NavigationLink(value: note) {
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(note.title).foregroundStyle(Theme.ink)
                                    let summary = Preview.documentDigest(note.body).summary
                                    if !summary.isEmpty {
                                        Text(summary)
                                            .font(.footnote)
                                            .foregroundStyle(Theme.mutedInk)
                                            .lineLimit(2)
                                    }
                                }
                            }
                            .accessibilityIdentifier("note-row")
                        }
                    }
                }
            }
            .overlay {
                if model.index.notes.isEmpty {
                    ContentUnavailableView("还没有笔记", systemImage: "doc.text", description: Text("资料库 notes/ 下的文档会出现在这里。"))
                }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.canvas)
            .refreshable { await model.sync() }
            .searchable(text: $query, prompt: "搜索笔记")
            .navigationTitle("笔记")
            .vaultDestinations()
        }
    }

    private var sections: [(folder: String, notes: [VaultDocument])] {
        let notes = query.isEmpty
            ? model.index.notes
            : model.index.search(query).filter { $0.kind == .note }
        let grouped = Dictionary(grouping: notes) { note in
            let relative = note.path.dropFirst("notes/".count)
            return (relative as NSString).deletingLastPathComponent
        }
        return grouped
            .map { (folder: $0.key, notes: $0.value) }
            .sorted { $0.folder.utf8.lexicographicallyPrecedes($1.folder.utf8) }
    }
}
