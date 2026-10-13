import ShardKit
import SwiftUI

/// Connects the app to the vault repository. The token is checked against the branch
/// before anything is saved, and then lives only in the Keychain.
struct SetupView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    var isReplacing = false

    @State private var owner = ""
    @State private var name = ""
    @State private var branch = "main"
    @State private var token = ""
    @State private var isConnecting = false
    @State private var errorMessage: String?

    var body: some View {
        Form {
            Section {
                TextField("用户或组织，例如 wensia", text: $owner)
                TextField("仓库名，例如 shard-vault", text: $name)
                TextField("分支", text: $branch)
            } header: {
                Text("资料库仓库")
            } footer: {
                Text("桌面 Shard 推送资料库的那个 GitHub 仓库。")
            }

            Section {
                SecureField("github_pat_…", text: $token)
            } header: {
                Text("访问令牌")
            } footer: {
                VStack(alignment: .leading, spacing: 6) {
                    Text("在 GitHub 新建细粒度令牌：只选这一个仓库，权限给 Contents 读写。令牌只保存在本机钥匙串。")
                    Link("打开 GitHub 令牌设置", destination: URL(string: "https://github.com/settings/personal-access-tokens/new")!)
                }
            }

            if let errorMessage {
                Section {
                    Text(errorMessage).foregroundStyle(Theme.accent)
                }
            }

            Section {
                Button {
                    Task { await connect() }
                } label: {
                    HStack {
                        Text(isReplacing ? "保存" : "连接并同步")
                        Spacer()
                        if isConnecting { ProgressView() }
                    }
                }
                .disabled(!isComplete || isConnecting)
            }
        }
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
        .scrollContentBackground(.hidden)
        .background(Theme.canvas)
        .navigationTitle(isReplacing ? "更换仓库或令牌" : "连接资料库")
        .onAppear {
            if let repository = model.repository {
                owner = repository.owner
                name = repository.name
                branch = repository.branch
            }
        }
    }

    private var isComplete: Bool {
        [owner, name, branch, token].allSatisfy { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
    }

    private func connect() async {
        isConnecting = true
        errorMessage = nil
        defer { isConnecting = false }
        let repository = GitHubRepository(
            owner: owner.trimmingCharacters(in: .whitespaces),
            name: name.trimmingCharacters(in: .whitespaces),
            branch: branch.trimmingCharacters(in: .whitespaces)
        )
        do {
            try await model.connect(repository: repository, token: token.trimmingCharacters(in: .whitespacesAndNewlines))
            if isReplacing { dismiss() }
        } catch {
            errorMessage = AppModel.describe(error)
        }
    }
}
