import ShardKit
import SwiftUI

struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var confirmingDisconnect = false

    var body: some View {
        Form {
            Section("资料库") {
                LabeledContent("仓库", value: model.repository?.displayName ?? "—")
                LabeledContent("分支", value: model.repository?.branch ?? "—")
                NavigationLink("更换仓库或令牌") {
                    SetupView(isReplacing: true)
                }
            }

            Section {
                LabeledContent("上次同步", value: model.lastSyncedAt?.formatted(date: .abbreviated, time: .shortened) ?? "从未")
                LabeledContent("远端提交", value: model.headCommit.map { String($0.prefix(7)) } ?? "—")
                LabeledContent("碎片 / 笔记", value: "\(model.index.fragments.count) / \(model.index.notes.count)")
                Button {
                    Task { await model.sync() }
                } label: {
                    HStack {
                        Text("立即同步")
                        Spacer()
                        if model.syncState == .syncing { ProgressView() }
                    }
                }
                .disabled(model.syncState == .syncing)
            } header: {
                Text("同步")
            } footer: {
                if case .failed(let message) = model.syncState {
                    Text(message).foregroundStyle(Theme.accent)
                } else {
                    Text("密匣、回收站和 .shard 内部文件不会下载到手机。")
                }
            }

            Section {
                Button("断开并清除本机数据", role: .destructive) {
                    confirmingDisconnect = true
                }
            }

            Section {
                LabeledContent("版本", value: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "")
            }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.canvas)
        .navigationTitle("设置")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("完成") { dismiss() }
            }
        }
        .confirmationDialog("断开后会删除手机上的离线副本和令牌，GitHub 上的内容不受影响。", isPresented: $confirmingDisconnect, titleVisibility: .visible) {
            Button("断开并清除", role: .destructive) {
                Task {
                    await model.disconnect()
                    dismiss()
                }
            }
        }
    }
}
