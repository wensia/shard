import Foundation
import Observation
import ShardKit

/// App-wide state: which repository is mirrored, the offline index, and sync status.
@MainActor
@Observable
final class AppModel {
    enum SyncState: Equatable {
        case idle
        case syncing
        case failed(String)
    }

    private(set) var repository: GitHubRepository?
    private(set) var index = VaultIndex.empty
    private(set) var syncState = SyncState.idle
    private(set) var lastSyncedAt: Date?
    private(set) var headCommit: String?

    @ObservationIgnored private var store: VaultStore?
    @ObservationIgnored private var token: String?
    private static let repositoryKey = "repository"
    private static let lastSyncedKey = "lastSyncedAt"

    var isConfigured: Bool { repository != nil && token != nil }

    init() {
        let defaults = UserDefaults.standard
        #if DEBUG
        Self.applyDebugConfiguration(defaults)
        #endif
        if let data = defaults.data(forKey: Self.repositoryKey),
           let repository = try? JSONDecoder().decode(GitHubRepository.self, from: data),
           let token = TokenStore.load() {
            self.repository = repository
            self.token = token
            store = VaultStore(root: VaultStore.defaultRoot(for: repository))
            lastSyncedAt = defaults.object(forKey: Self.lastSyncedKey) as? Date
        }
    }

    /// Shows the offline mirror immediately, then refreshes from GitHub.
    func start() async {
        await reloadIndex()
        await sync()
    }

    /// Checks the token can see the branch before saving anything.
    func connect(repository: GitHubRepository, token: String) async throws {
        _ = try await GitHubRemote(repository: repository, token: token, apiBase: Self.apiBase).head()
        try TokenStore.save(token)
        if repository != self.repository {
            try? await store?.reset()
        }
        UserDefaults.standard.set(try JSONEncoder().encode(repository), forKey: Self.repositoryKey)
        self.repository = repository
        self.token = token
        store = VaultStore(root: VaultStore.defaultRoot(for: repository))
        index = .empty
        await start()
    }

    func disconnect() async {
        try? await store?.reset()
        TokenStore.delete()
        UserDefaults.standard.removeObject(forKey: Self.repositoryKey)
        UserDefaults.standard.removeObject(forKey: Self.lastSyncedKey)
        repository = nil
        token = nil
        store = nil
        index = .empty
        syncState = .idle
        lastSyncedAt = nil
        headCommit = nil
    }

    func sync() async {
        guard let store, let remote, syncState != .syncing else { return }
        syncState = .syncing
        do {
            let summary = try await store.sync(with: remote)
            headCommit = summary.headCommit
            if !summary.unchanged {
                await reloadIndex()
            }
            lastSyncedAt = Date()
            UserDefaults.standard.set(lastSyncedAt, forKey: Self.lastSyncedKey)
            syncState = .idle
        } catch {
            syncState = .failed(Self.describe(error))
        }
    }

    /// Serves `shard://vault/<path>` for the renderer (images under `assets/`).
    func vaultFile(_ path: String) async throws -> Data {
        guard let store, let remote else { throw RemoteError.notFound }
        return try await store.assetData(path, from: remote)
    }

    private var remote: GitHubRemote? {
        guard let repository, let token else { return nil }
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
    private static func applyDebugConfiguration(_ defaults: UserDefaults) {
        if defaults.bool(forKey: "debugReset") {
            TokenStore.delete()
            defaults.removeObject(forKey: repositoryKey)
            try? FileManager.default.removeItem(at: FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appending(path: "Vaults"))
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
        let documents = await store.loadDocuments()
        headCommit = await store.headCommit
        index = VaultIndex(documents: documents)
    }

    static func describe(_ error: Error) -> String {
        switch error {
        case RemoteError.unauthorized:
            return "令牌无效或已过期，请在设置里更新。"
        case RemoteError.notFound:
            return "找不到仓库或分支，或令牌没有这个仓库的访问权限。"
        case RemoteError.rateLimited(let resetAt):
            if let resetAt {
                return "GitHub 请求过于频繁，\(resetAt.formatted(date: .omitted, time: .shortened)) 后再试。"
            }
            return "GitHub 请求过于频繁，请稍后再试。"
        case RemoteError.truncatedTree:
            return "仓库文件太多，GitHub 返回的目录不完整。"
        case RemoteError.checksumMismatch(let path):
            return "下载的文件校验失败：\(path)"
        case RemoteError.http(let status, let message):
            return "GitHub 返回 \(status)：\(message)"
        case let error as URLError:
            return "网络不可用：\(error.localizedDescription)"
        default:
            return error.localizedDescription
        }
    }
}
