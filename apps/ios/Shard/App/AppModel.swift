import Foundation
import Observation
import ShardKit

/// Active vault connection, offline index, and sync status.
@MainActor
@Observable
final class AppModel {
    enum SyncState: Equatable {
        case idle
        case syncing
        case failed(String)
    }

    private(set) var repository: GitHubRepository?
    private(set) var serverAccount: ServerAccount?
    private(set) var isRestoring = true
    private(set) var authenticationError: String?
    private(set) var index = VaultIndex.empty
    private(set) var syncState = SyncState.idle
    private(set) var lastSyncedAt: Date?
    private(set) var headCommit: String?
    /// Fragments captured here that are not committed yet.
    private(set) var pending: [PendingFragment] = []

    @ObservationIgnored private var store: VaultStore?
    private var token: String?
    @ObservationIgnored private var syncOperation: Task<(any Error)?, Never>?
    @ObservationIgnored private var credentialCleanup: Task<Void, Never>?
    @ObservationIgnored private var connectionRevision = UUID()
    @ObservationIgnored private var isChangingConnection = false
    /// A sync asked for while one was running; run once more when it ends.
    @ObservationIgnored private var syncRequested = false
    private nonisolated static let repositoryKey = "repository"
    private nonisolated static let lastSyncedKey = "lastSyncedAt"

    var isConfigured: Bool { (repository != nil || serverAccount != nil) && token != nil }

    private nonisolated static func restore() -> (GitHubRepository?, ServerAccount?, String?, VaultStore?, Date?) {
        let defaults = UserDefaults.standard
        #if DEBUG
        Self.applyDebugConfiguration(defaults)
        #endif
        if let data = defaults.data(forKey: "serverAccount"),
           let account = try? JSONDecoder().decode(ServerAccount.self, from: data) {
            return (nil, account, TokenStore.loadServer(account), VaultStore(root: VaultStore.defaultRoot(for: account)),
                    defaults.object(forKey: Self.lastSyncedKey) as? Date)
        }
        if let data = defaults.data(forKey: Self.repositoryKey),
           let repository = try? JSONDecoder().decode(GitHubRepository.self, from: data),
           let token = TokenStore.load() {
            return (repository, nil, token, VaultStore(root: VaultStore.defaultRoot(for: repository)),
                    defaults.object(forKey: Self.lastSyncedKey) as? Date)
        }
        return (nil, nil, nil, nil, nil)
    }

    /// Shows the offline mirror immediately, then refreshes from GitHub.
    func start() async {
        if isRestoring {
            let restored = await Task.detached { Self.restore() }.value
            (repository, serverAccount, token, store, lastSyncedAt) = restored
            isRestoring = false
        }
        await reloadIndex()
        if isConfigured { await sync() }
    }

    func login(server: String, email: String, password: String, name: String) async throws {
        guard !isChangingConnection else { throw ConnectionError.syncing }
        isChangingConnection = true
        defer { isChangingConnection = false }
        let url = try ServerRemote.normalizeServer(server)
        let normalizedEmail = email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if !pending.isEmpty && (serverAccount?.serverURL != url || serverAccount?.email != normalizedEmail) {
            throw ConnectionError.pending
        }
        await cancelSync()
        let credentials = try await ServerRemote.login(server: server, email: email, password: password, name: name)
        let account = credentials.account
        let restoredStore = try await Task.detached {
            try TokenStore.saveServer(credentials.token, for: account)
            UserDefaults.standard.set(try JSONEncoder().encode(account), forKey: "serverAccount")
            return VaultStore(root: VaultStore.defaultRoot(for: account))
        }.value
        repository = nil
        serverAccount = account
        token = credentials.token
        store = restoredStore
        authenticationError = nil
        index = .empty
        lastSyncedAt = nil
        await reloadIndex()
        Task { await sync() }
    }

    func signOutServer() async {
        guard !isChangingConnection, let account = serverAccount else { return }
        isChangingConnection = true
        defer { isChangingConnection = false }
        await cancelSync()
        token = nil
        authenticationError = nil
        store = nil
        index = .empty
        pending = []
        headCommit = nil
        lastSyncedAt = nil
        await Task.detached { TokenStore.deleteServer(account) }.value
    }

    /// Checks the token can see the branch before saving anything.
    func connect(repository: GitHubRepository, token: String) async throws {
        guard !isChangingConnection else { throw ConnectionError.syncing }
        isChangingConnection = true
        defer { isChangingConnection = false }
        if !pending.isEmpty && (serverAccount != nil || self.repository != repository) { throw ConnectionError.pending }
        await cancelSync()
        _ = try await GitHubRemote(repository: repository, token: token, apiBase: Self.apiBase).head()
        let previousServer = serverAccount
        let restoredStore = try await Task.detached {
            try TokenStore.save(token)
            let defaults = UserDefaults.standard
            defaults.set(try JSONEncoder().encode(repository), forKey: Self.repositoryKey)
            defaults.removeObject(forKey: "serverAccount")
            if let previousServer { TokenStore.deleteServer(previousServer) }
            return VaultStore(root: VaultStore.defaultRoot(for: repository))
        }.value
        self.repository = repository
        serverAccount = nil
        self.token = token
        store = restoredStore
        index = .empty
        await reloadIndex()
        Task { await sync() }
    }

    func disconnect() async {
        if serverAccount != nil { await signOutServer(); return }
        guard !isChangingConnection else { return }
        isChangingConnection = true
        defer { isChangingConnection = false }
        await cancelSync()
        try? await store?.reset()
        await Task.detached {
            TokenStore.delete()
            UserDefaults.standard.removeObject(forKey: Self.repositoryKey)
            UserDefaults.standard.removeObject(forKey: Self.lastSyncedKey)
        }.value
        repository = nil
        token = nil
        store = nil
        index = .empty
        pending = []
        syncState = .idle
        lastSyncedAt = nil
        headCommit = nil
    }

    /// Pushes captured fragments first, then pulls the remote head.
    func sync() async {
        guard !isChangingConnection, isConfigured, let store, let remote else { return }
        guard syncState != .syncing else {
            syncRequested = true
            return
        }
        syncState = .syncing
        let revision = connectionRevision
        let operation = Task { () -> (any Error)? in
            var failure: (any Error)?
            do {
                _ = try await store.pushPending(to: remote)
            } catch {
                failure = error
            }
            if Task.isCancelled { return failure }
            do {
                _ = try await store.sync(with: remote)
            } catch {
                failure = failure ?? error
            }
            return failure
        }
        syncOperation = operation
        let failure = await operation.value
        guard revision == connectionRevision else { return }
        syncOperation = nil
        await reloadIndex()
        guard revision == connectionRevision else { return }
        if let failure, case RemoteError.unauthorized = failure, serverAccount != nil {
            await expireServerSession(revision: revision)
            return
        }
        if failure == nil {
            lastSyncedAt = Date()
            UserDefaults.standard.set(lastSyncedAt, forKey: Self.lastSyncedKey)
        }
        syncState = failure.map { .failed(Self.describe($0)) } ?? .idle
        if syncRequested {
            syncRequested = false
            await sync()
        }
    }

    private func cancelSync() async {
        let operation = syncOperation
        connectionRevision = UUID()
        operation?.cancel()
        syncOperation = nil
        syncRequested = false
        syncState = .idle
        _ = await operation?.value
        await credentialCleanup?.value
        credentialCleanup = nil
    }

    private func expireServerSession(revision: UUID) async {
        guard revision == connectionRevision, token != nil, let account = serverAccount else { return }
        token = nil
        authenticationError = "登录已失效，请重新登录。"
        syncState = .idle
        syncRequested = false
        let cleanup = Task.detached { TokenStore.deleteServer(account) }
        credentialCleanup = cleanup
        await cleanup.value
        if revision == connectionRevision { credentialCleanup = nil }
    }

    /// Queues a fragment (it shows in the timeline at once) and pushes it in the background.
    func capture(_ text: String) async throws {
        guard !isChangingConnection, isConfigured, let store else { throw RemoteError.unauthorized }
        let revision = connectionRevision
        let fragment = try await Task.detached { try NewFragment.make(content: text) }.value
        try await store.enqueue(fragment)
        guard revision == connectionRevision else { return }
        pending = await store.pending
        await reloadIndex()
        Task { await sync() }
    }

    func discardPending(_ id: String) async {
        guard !isChangingConnection else { return }
        try? await store?.discard(id)
        pending = await store?.pending ?? []
        await reloadIndex()
    }

    /// Serves `shard://vault/<path>` for the renderer (images under `assets/`).
    func vaultFile(_ path: String) async throws -> Data {
        guard let store, let remote else { throw RemoteError.notFound }
        let revision = connectionRevision
        do {
            return try await store.assetData(path, from: remote)
        } catch RemoteError.unauthorized {
            await expireServerSession(revision: revision)
            throw RemoteError.unauthorized
        }
    }

    private var remote: (any VaultRemote)? {
        guard let token else { return nil }
        if let serverAccount { return ServerRemote(account: serverAccount, token: token) }
        guard let repository else { return nil }
        return GitHubRemote(repository: repository, token: token, apiBase: Self.apiBase)
    }

    private static var apiBase: URL {
        #if DEBUG
        if let override = UserDefaults.standard.string(forKey: "githubAPIBase"), let url = URL(string: override) {
            return url
        }
        #endif
        return GitHubRemote.defaultAPIBase
    }

    #if DEBUG
    /// UI tests launch with `-debugRepository owner/name@branch -debugToken x -githubAPIBase http://127.0.0.1:18787`
    /// to skip the setup form and read from `scripts/mock-github.py`.
    private nonisolated static func applyDebugConfiguration(_ defaults: UserDefaults) {
        if defaults.bool(forKey: "debugReset") {
            if let data = defaults.data(forKey: "serverAccount"),
               let account = try? JSONDecoder().decode(ServerAccount.self, from: data) { TokenStore.deleteServer(account) }
            TokenStore.delete()
            defaults.removeObject(forKey: "serverAccount")
            defaults.removeObject(forKey: repositoryKey)
            let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            for directory in ["Vaults", "ServerVaults"] {
                try? FileManager.default.removeItem(at: support.appending(path: directory))
            }
        }
        guard let spec = defaults.string(forKey: "debugRepository"),
              let token = defaults.string(forKey: "debugToken"),
              let match = spec.wholeMatch(of: /([^\/]+)\/([^@]+)@(.+)/)
        else { return }
        let repository = GitHubRepository(owner: String(match.1), name: String(match.2), branch: String(match.3))
        try? TokenStore.save(token)
        defaults.set(try? JSONEncoder().encode(repository), forKey: repositoryKey)
    }
    #endif

    private func reloadIndex() async {
        guard let store else { return }
        let revision = connectionRevision
        let documents = await store.loadDocuments()
        let head = await store.headCommit
        let pending = await store.pending
        let index = await Task.detached { VaultIndex(documents: documents) }.value
        guard revision == connectionRevision else { return }
        self.headCommit = head
        self.pending = pending
        self.index = index
    }

    static func describe(_ error: Error) -> String {
        switch error {
        case RemoteError.unauthorized:
            return "登录已失效，请重新连接。"
        case RemoteError.notFound:
            return "找不到内容或没有访问权限。"
        case RemoteError.rateLimited(let resetAt):
            if let resetAt {
                return "请求过于频繁，\(resetAt.formatted(date: .omitted, time: .shortened)) 后再试。"
            }
            return "请求过于频繁，请稍后再试。"
        case RemoteError.truncatedTree:
            return "仓库文件太多，GitHub 返回的目录不完整。"
        case RemoteError.checksumMismatch(let path):
            return "下载的文件校验失败：\(path)"
        case RemoteError.conflict(let path):
            return "远端已有同名文件且内容不同：\(path)。可在设置里查看这条待同步内容。"
        case NewFragment.Failure.emptyContent:
            return "写点什么再发送。"
        case NewFragment.Failure.lockboxNotSupported:
            return "手机端暂不支持密匣，去掉 #密匣 再发送。"
        case RemoteError.http(let status, let message):
            return "服务器返回 \(status)：\(message)"
        case let error as URLError:
            return "网络不可用：\(error.localizedDescription)"
        default:
            return error.localizedDescription
        }
    }
}

private enum ConnectionError: LocalizedError {
    case pending
    case syncing

    var errorDescription: String? {
        switch self {
        case .pending: "还有未同步内容，请先完成同步。"
        case .syncing: "正在同步，请稍后重试。"
        }
    }
}
