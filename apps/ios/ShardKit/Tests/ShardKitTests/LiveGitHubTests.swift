import Foundation
import Testing
@testable import ShardKit

/// Read-only check against the real GitHub API. Runs only when a token is provided:
///
///     SHARD_GITHUB_TOKEN=$(gh auth token) SHARD_GITHUB_REPO=wensia/shard-vault@main swift test --filter LiveGitHub
@Suite(.enabled(if: ProcessInfo.processInfo.environment["SHARD_GITHUB_TOKEN"] != nil))
struct LiveGitHubTests {
    private var remote: GitHubRemote {
        let env = ProcessInfo.processInfo.environment
        let spec = env["SHARD_GITHUB_REPO"] ?? "wensia/shard-vault@main"
        let match = spec.wholeMatch(of: /([^\/]+)\/([^@]+)@(.+)/)!
        let repository = GitHubRepository(owner: String(match.1), name: String(match.2), branch: String(match.3))
        return GitHubRemote(repository: repository, token: env["SHARD_GITHUB_TOKEN"]!)
    }

    @Test func mirrorsTheRealVaultWithoutPrivateFiles() async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "shardkit-live-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let store = VaultStore(root: root)

        let summary = try await store.sync(with: remote)
        let documents = await store.loadDocuments()
        #expect(summary.downloaded > 0)
        #expect(documents.contains { $0.kind == .fragment && $0.fragmentID != nil })
        #expect(documents.allSatisfy { VaultPaths.isSyncedDocument($0.path) })

        let files = FileManager.default.enumerator(atPath: root.appending(path: "files").path)?.allObjects as? [String] ?? []
        #expect(!files.contains { $0.hasPrefix("lockbox") || $0.hasPrefix(".trash") || $0.hasPrefix(".shard") })
        print("live: \(summary.downloaded) files, head \(summary.headCommit.prefix(7))")

        // fileBlobSHA (contents API) must agree with the tree's blob SHA.
        if let fragment = documents.first(where: { $0.kind == .fragment }) {
            let sha = try await remote.fileBlobSHA(path: fragment.path)
            let local = try Data(contentsOf: root.appending(path: "files").appending(path: fragment.path))
            #expect(sha == VaultStore.gitBlobSHA(local))
        }
        #expect(try await remote.fileBlobSHA(path: "fragments/no-such-file.md") == nil)
    }
}
