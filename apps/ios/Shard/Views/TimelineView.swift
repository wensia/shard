import ShardKit
import SwiftUI

struct TimelineView: View {
    @Environment(AppModel.self) private var model
    @State private var query = ""
    @State private var showingSettings = false

    var body: some View {
        NavigationStack {
            Group {
                if query.isEmpty {
                    DocumentList(documents: model.index.fragments)
                } else {
                    DocumentList(
                        documents: model.index.search(query),
                        emptyTitle: "没有找到",
                        emptyMessage: "多个关键词需要同时命中。"
                    )
                }
            }
            .safeAreaInset(edge: .top, spacing: 0) { SyncBanner() }
            .refreshable { await model.sync() }
            .searchable(text: $query, prompt: "搜索碎片和笔记")
            .navigationTitle("碎片")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    SyncIndicator()
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("设置", systemImage: "gearshape") { showingSettings = true }
                }
            }
            .sheet(isPresented: $showingSettings) {
                NavigationStack { SettingsView() }
            }
            .vaultDestinations()
        }
    }
}

/// Spinner while syncing; nothing when idle.
struct SyncIndicator: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        if model.syncState == .syncing {
            ProgressView().controlSize(.small)
        }
    }
}

/// Shown when the last sync failed; the offline mirror stays readable underneath.
struct SyncBanner: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        if case .failed(let message) = model.syncState {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(Theme.accent)
                Text(message)
                    .font(.footnote)
                    .foregroundStyle(Theme.ink)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Button("重试") { Task { await model.sync() } }
                    .font(.footnote.weight(.semibold))
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .background(Theme.fill)
        }
    }
}
