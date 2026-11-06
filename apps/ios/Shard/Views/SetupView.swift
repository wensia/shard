import ShardKit
import SwiftUI

struct SetupView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    var isReplacing = false

    @State private var server = ""
    @State private var email = ""
    @State private var password = ""
    @State private var revealed = false
    @State private var isConnecting = false
    @State private var errorMessage: String?

    var body: some View {
        Form {
            Section {
                TextField("服务器地址", text: $server)
                    .keyboardType(.URL)
                    .textContentType(.URL)
                    .accessibilityIdentifier("server-address")
                TextField("邮箱", text: $email)
                    .keyboardType(.emailAddress)
                    .textContentType(.username)
                    .accessibilityIdentifier("login-email")
                HStack {
                    PasswordTextField(text: $password, revealed: revealed) {
                        Task { await login() }
                    }
                    Button {
                        revealed.toggle()
                    } label: {
                        Image(systemName: revealed ? "eye.slash" : "eye")
                            .foregroundStyle(Theme.mutedInk)
                            .frame(minWidth: Theme.minimumTouchTarget, minHeight: Theme.minimumTouchTarget)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(revealed ? "隐藏密码" : "显示密码")
                    .accessibilityIdentifier("password-visibility")
                }
            }
            .disabled(isConnecting)

            if let errorMessage {
                Section {
                    Text(errorMessage)
                        .foregroundStyle(Theme.accent)
                        .accessibilityIdentifier("login-error")
                }
            }

            Section {
                Button {
                    Task { await login() }
                } label: {
                    HStack {
                        Text("登录")
                        Spacer()
                        if isConnecting { ProgressView() }
                    }
                }
                .disabled(!isComplete || isConnecting)
                .accessibilityIdentifier("login-submit")
            }
            Section {
                NavigationLink("使用 GitHub 连接") {
                    GitHubSetupView(isReplacing: isReplacing)
                }
                .disabled(isConnecting)
            }
        }
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
        .scrollContentBackground(.hidden)
        .background(Theme.canvas)
        .navigationTitle("登录")
        .onAppear {
            server = model.serverAccount?.serverURL.absoluteString ?? UserDefaults.standard.string(forKey: "debugServer") ?? ""
            email = model.serverAccount?.email ?? ""
            errorMessage = model.authenticationError
        }
    }

    private var isComplete: Bool {
        !server.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !password.isEmpty
    }

    private func login() async {
        guard !isConnecting, isComplete else { return }
        isConnecting = true
        errorMessage = nil
        defer { isConnecting = false }
        do {
            try await model.login(server: server, email: email, password: password, name: "Shard · \(UIDevice.current.model)")
            password = ""
            if isReplacing { dismiss() }
        } catch {
            errorMessage = AppModel.describe(error)
        }
    }
}

/// The original GitHub connection remains available for existing vaults.
struct GitHubSetupView: View {
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

            if isReplacing, !model.pending.isEmpty {
                Section {
                    Text("还有 \(model.pending.count) 条碎片没推送。换到别的仓库或分支会清掉本机副本和这些碎片；只更新令牌不受影响。")
                        .font(.footnote)
                        .foregroundStyle(Theme.accent)
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
