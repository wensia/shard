import CryptoKit
import Foundation

public struct SyncSummary: Equatable, Sendable {
    public let headCommit: String
    public let downloaded: Int
    public let removed: Int

    /// The remote head had not moved since the last sync.
    public var unchanged: Bool { downloaded == 0 && removed == 0 }
}

/// A fragment captured on the phone and waiting to be committed.
public struct PendingFragment: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let path: String
    public let text: String
}

/// Offline mirror of the vault's Markdown, lazily cached attachments, and the outbox of
/// fragments captured here.
///
/// Layout under `root`: `files/<vault path>` for content, `manifest.json` mapping each
/// mirrored path to its git blob SHA (so a sync downloads only blobs that changed), and
/// `outbox.json`, kept apart from the mirror so a pull never drops unsent fragments.
public actor VaultStore {
    struct Manifest: Codable {
        var headCommit: String?
        var documents: [String: String] = [:]
        var assets: [String: String] = [:]
    }

    public enum StoreError: Error, Equatable {
        case unsafePath(String)
        case unknownAsset(String)
    }

    public let root: URL
    private var manifest: Manifest
    private var outbox: [PendingFragment]
    private var isPushing = false
    private let downloadConcurrency = 8

    public init(root: URL) {
        self.root = root
        let decoder = JSONDecoder()
        manifest = (try? decoder.decode(Manifest.self, from: Data(contentsOf: root.appending(path: "manifest.json")))) ?? Manifest()
        outbox = (try? decoder.decode([PendingFragment].self, from: Data(contentsOf: root.appending(path: "outbox.json")))) ?? []
    }

    /// `Application Support/Vaults/<owner>/<repo>/<branch>`; one mirror per repository and branch.
    public static func defaultRoot(for repository: GitHubRepository) -> URL {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return [repository.owner, repository.name, repository.branch].reduce(support.appending(path: "Vaults")) {
            $0.appending(path: $1.replacingOccurrences(of: "/", with: "%2F"), directoryHint: .isDirectory)
        }
    }

    public var headCommit: String? { manifest.headCommit }

    public var pending: [PendingFragment] { outbox }

    /// Mirrored documents plus outbox fragments the mirror does not have yet.
    public func loadDocuments() -> [VaultDocument] {
        let mirrored: [VaultDocument] = manifest.documents.keys.compactMap { path in
            guard let url = try? fileURL(path),
                  let data = try? Data(contentsOf: url),
                  let text = String(data: data, encoding: .utf8)
            else { return nil }
            return VaultDocument.parse(path: path, text: text)
        }
        let unsent = outbox
            .filter { manifest.documents[$0.path] == nil }
            .map { VaultDocument.parse(path: $0.path, text: $0.text, isPending: true) }
        return mirrored + unsent
    }

    // MARK: - Outbox

    public func enqueue(_ fragment: NewFragment) throws {
        outbox.append(PendingFragment(id: fragment.id, path: fragment.path, text: fragment.text))
        try saveOutbox()
    }

    /// Gives up on a queued fragment (only offered for one that keeps failing).
    public func discard(_ id: String) throws {
        outbox.removeAll { $0.id == id }
        try saveOutbox()
    }

    /// Commits queued fragments oldest first, stopping at the first failure so the
    /// remaining ones keep their order. Returns how many were committed.
    public func pushPending(to remote: any VaultRemote) async throws -> Int {
        guard !isPushing else { return 0 }
        isPushing = true
        defer { isPushing = false }

        var pushed = 0
        while let next = outbox.first {
            let data = Data(next.text.utf8)
            try await create(next, data: data, on: remote)
            outbox.removeFirst()
            try saveOutbox()
            // Mirror it right away so the timeline does not flicker before the next pull;
            // the pull then finds the same blob SHA and downloads nothing.
            try write(data, to: next.path)
            manifest.documents[next.path] = Self.gitBlobSHA(data)
            try saveManifest()
            pushed += 1
        }
        return pushed
    }

    private func create(_ item: PendingFragment, data: Data, on remote: any VaultRemote) async throws {
        do {
            try await remote.createFile(path: item.path, content: data, message: "手机记录：新增碎片 \(item.id)")
        } catch RemoteError.alreadyExists {
            // A retry after a lost response: the commit already landed if the content matches.
            guard try await remote.fileBlobSHA(path: item.path) == Self.gitBlobSHA(data) else {
                throw RemoteError.conflict(path: item.path)
            }
        }
    }

    private func saveOutbox() throws {
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try JSONEncoder().encode(outbox).write(to: root.appending(path: "outbox.json"), options: .atomic)
    }

    /// Brings the mirror up to the remote head: downloads changed blobs, removes deleted ones.
    public func sync(with remote: any VaultRemote) async throws -> SyncSummary {
        let head = try await remote.head()
        if head.commit == manifest.headCommit {
            return SyncSummary(headCommit: head.commit, downloaded: 0, removed: 0)
        }

        var documents: [String: String] = [:]
        var assets: [String: String] = [:]
        for entry in try await remote.tree(head.tree) where !VaultPaths.isExcluded(entry.path) {
            if VaultPaths.isSyncedDocument(entry.path) {
                documents[entry.path] = entry.sha
            } else if VaultPaths.isAsset(entry.path) {
                assets[entry.path] = entry.sha
            }
        }

        let changed = try documents.filter { path, sha in
            try manifest.documents[path] != sha || !FileManager.default.fileExists(atPath: fileURL(path).path)
        }
        try await download(changed, from: remote)

        let removed = manifest.documents.keys.filter { documents[$0] == nil }
        for path in removed {
            try? FileManager.default.removeItem(at: fileURL(path))
        }

        // Only now does the mirror claim this head; an interrupted sync simply re-diffs.
        // The outbox lives in its own file and is untouched here.
        manifest = Manifest(headCommit: head.commit, documents: documents, assets: assets)
        try saveManifest()
        return SyncSummary(headCommit: head.commit, downloaded: changed.count, removed: removed.count)
    }

    /// An attachment such as `assets/52/<sha256>.png`, from cache or fetched on first use.
    public func assetData(_ path: String, from remote: any VaultRemote) async throws -> Data {
        let url = try fileURL(path)
        if let cached = try? Data(contentsOf: url) {
            return cached
        }
        guard let sha = manifest.assets[path] else {
            throw StoreError.unknownAsset(path)
        }
        let data = try await remote.blob(sha)
        try Self.verify(data, sha: sha, path: path)
        try write(data, to: path)
        return data
    }

    /// Deletes the whole mirror and outbox (e.g. when switching repositories).
    public func reset() throws {
        if FileManager.default.fileExists(atPath: root.path) {
            try FileManager.default.removeItem(at: root)
        }
        manifest = Manifest()
        outbox = []
    }

    // MARK: - Internals

    private func download(_ blobs: [String: String], from remote: any VaultRemote) async throws {
        var pending = blobs.makeIterator()
        try await withThrowingTaskGroup(of: (String, Data).self) { group in
            func startNext() -> Bool {
                guard let (path, sha) = pending.next() else { return false }
                group.addTask {
                    let data = try await remote.blob(sha)
                    try Self.verify(data, sha: sha, path: path)
                    return (path, data)
                }
                return true
            }
            for _ in 0..<downloadConcurrency where !startNext() { break }
            while let (path, data) = try await group.next() {
                try write(data, to: path)
                _ = startNext()
            }
        }
    }

    private func write(_ data: Data, to path: String) throws {
        let url = try fileURL(path)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data.write(to: url, options: .atomic)
    }

    private func saveManifest() throws {
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        try encoder.encode(manifest).write(to: root.appending(path: "manifest.json"), options: .atomic)
    }

    /// Maps a vault path into `files/`, refusing anything that could escape it.
    private func fileURL(_ path: String) throws -> URL {
        let components = path.split(separator: "/", omittingEmptySubsequences: false)
        guard !path.hasPrefix("/"), !components.isEmpty,
              !components.contains(where: { $0.isEmpty || $0 == "." || $0 == ".." })
        else { throw StoreError.unsafePath(path) }
        return components.reduce(root.appending(path: "files", directoryHint: .isDirectory)) {
            $0.appending(path: String($1))
        }
    }

    /// Git blob id: SHA-1 of `blob <size>\0<content>`.
    static func gitBlobSHA(_ data: Data) -> String {
        var hasher = Insecure.SHA1()
        hasher.update(data: Data("blob \(data.count)\u{0}".utf8))
        hasher.update(data: data)
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }

    static func verify(_ data: Data, sha: String, path: String) throws {
        guard gitBlobSHA(data) == sha else {
            throw RemoteError.checksumMismatch(path: path)
        }
    }
}
