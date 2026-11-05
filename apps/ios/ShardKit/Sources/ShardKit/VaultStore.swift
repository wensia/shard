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
    public let requestKey: String?
    public let requestFingerprint: String?

    public init(id: String, path: String, text: String, requestKey: String? = nil, requestFingerprint: String? = nil) {
        self.id = id
        self.path = path
        self.text = text
        self.requestKey = requestKey
        self.requestFingerprint = requestFingerprint
    }
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
        case erasedCapture
        case publicErasurePending
    }

    private struct Erasure: Codable {
        var ids: Set<String>
        var pathHashes: Set<String>
    }

    public let root: URL
    private var manifest: Manifest
    private var outbox: [PendingFragment]
    private var captureReceipts: [String: PendingFragment]
    private var webObserved: Set<String>
    private var erasedRequests: Set<String>
    private var erasure: Erasure?
    private var isPushing = false
    private let downloadConcurrency = 8

    public init(root: URL) {
        self.root = root
        let decoder = JSONDecoder()
        manifest = (try? decoder.decode(Manifest.self, from: Data(contentsOf: root.appending(path: "manifest.json")))) ?? Manifest()
        outbox = (try? decoder.decode([PendingFragment].self, from: Data(contentsOf: root.appending(path: "outbox.json")))) ?? []
        captureReceipts = (try? decoder.decode([String: PendingFragment].self,
            from: Data(contentsOf: root.appending(path: "web-capture-receipts.json")))) ?? [:]
        webObserved = (try? decoder.decode(Set<String>.self,
            from: Data(contentsOf: root.appending(path: "web-capture-observed.json")))) ?? []
        erasedRequests = (try? decoder.decode(Set<String>.self,
            from: Data(contentsOf: root.appending(path: "web-capture-erased.json")))) ?? []
        erasure = try? decoder.decode(Erasure.self, from: Data(contentsOf: root.appending(path: "web-public-erasure.json")))
    }

    /// `Application Support/Vaults/<owner>/<repo>/<branch>`; one mirror per repository and branch.
    public static func defaultRoot(for repository: GitHubRepository) -> URL {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return [repository.owner, repository.name, repository.branch].reduce(support.appending(path: "Vaults")) {
            $0.appending(path: $1.replacingOccurrences(of: "/", with: "%2F"), directoryHint: .isDirectory)
        }
    }

    /// A server/account has a separate mirror and outbox from GitHub and other accounts.
    public static func defaultRoot(for account: ServerAccount) -> URL {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let key = SHA256.hash(data: Data("\(account.serverURL.absoluteString)\n\(account.storageEmail ?? account.email)".utf8))
            .map { String(format: "%02x", $0) }.joined()
        return support.appending(path: "ServerVaults", directoryHint: .isDirectory).appending(path: key, directoryHint: .isDirectory)
    }

    public var headCommit: String? { manifest.headCommit }

    public var pending: [PendingFragment] {
        outbox.filter { !isErasedPath($0.path) && erasure?.ids.contains($0.id) != true }
    }

    /// Mirrored documents plus outbox fragments the mirror does not have yet.
    public func loadDocuments() -> [VaultDocument] {
        try? completePublicErasure()
        let mirrored: [VaultDocument] = manifest.documents.keys.compactMap { path in
            guard !isErasedPath(path) else { return nil }
            guard let url = try? fileURL(path),
                  let data = try? Data(contentsOf: url),
                  let text = String(data: data, encoding: .utf8)
            else { return nil }
            return VaultDocument.parse(path: path, text: text)
        }
        let unsent = outbox
            .filter { manifest.documents[$0.path] == nil && !isErasedPath($0.path) && erasure?.ids.contains($0.id) != true }
            .map { VaultDocument.parse(path: $0.path, text: $0.text, isPending: true) }
        return mirrored + unsent
    }

    // MARK: - Outbox

    public func enqueue(_ fragment: NewFragment) throws {
        outbox.append(PendingFragment(id: fragment.id, path: fragment.path, text: fragment.text))
        try saveOutbox()
    }

    /// A Web request retry reuses the first durable fragment, including after it has synced.
    /// The old array-shaped outbox remains readable by previous app versions.
    public func captureForWeb(content: String, tags: [String]?, requestKey: String) throws -> VaultDocument {
        try completePublicErasure()
        guard !erasedRequests.contains(requestKey) else { throw StoreError.erasedCapture }
        let fingerprintData = try JSONSerialization.data(withJSONObject: ["content": content, "tags": tags ?? [], "explicitTags": tags != nil], options: [.sortedKeys])
        let fingerprint = SHA256.hash(data: fingerprintData).map { String(format: "%02x", $0) }.joined()
        if let existing = captureReceipts[requestKey] ?? outbox.first(where: { $0.requestKey == requestKey }) {
            guard existing.requestFingerprint == fingerprint else { throw RemoteError.conflict(path: existing.path) }
            try? rememberCapture(existing)
            return VaultDocument.parse(path: existing.path, text: existing.text,
                                       isPending: outbox.contains(where: { $0.id == existing.id }))
        }
        let fragment = try NewFragment.make(content: content, tags: tags)
        let item = PendingFragment(id: fragment.id, path: fragment.path, text: fragment.text,
                                   requestKey: requestKey, requestFingerprint: fingerprint)
        outbox.append(item)
        do { try saveOutbox() }
        catch { outbox.removeAll { $0.id == item.id }; throw error }
        // If this write fails, the queued requestKey recovers the same receipt on retry/start.
        try? rememberCapture(item)
        return VaultDocument.parse(path: item.path, text: item.text, isPending: true)
    }

    public func cachedFile(_ path: String) throws -> (data: Data, sha: String) {
        try completePublicErasure()
        guard !isErasedPath(path) else { throw RemoteError.notFound }
        if let item = outbox.first(where: { $0.path == path }) {
            let data = Data(item.text.utf8)
            return (data, SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined())
        }
        guard let sha = manifest.documents[path] ?? manifest.assets[path] else { throw RemoteError.notFound }
        let data = try Data(contentsOf: fileURL(path))
        let actual = sha.count == 64
            ? SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
            : Self.gitBlobSHA(data)
        guard actual == sha else { throw RemoteError.checksumMismatch(path: path) }
        return (data, sha)
    }

    public func cachedBlob(_ sha: String) throws -> Data {
        guard sha.count == 64, sha.allSatisfy({ $0.isHexDigit }) else { throw RemoteError.notFound }
        if let path = (manifest.documents.merging(manifest.assets) { old, _ in old }).first(where: { $0.value == sha })?.key {
            return try cachedFile(path).data
        }
        throw RemoteError.notFound
    }

    public var publicErasurePending: Bool { erasure != nil }

    public func recoverPublicErasure() throws { try completePublicErasure() }

    public func retiredWebCaptureIDs() -> Set<String> {
        let publicIDs = Set(loadDocuments().compactMap(\.fragmentID)).union(outbox.map(\.id))
        return Set(captureReceipts.values.map(\.id)).subtracting(publicIDs)
    }

    /// A server-confirmed seal/delete must remove every native public copy before ack.
    /// The recovery intent contains only opaque IDs/path hashes, never titles or content.
    public func erasePublicCopies(ids: Set<String>, paths: [String]) throws {
        var hashes = erasure?.pathHashes ?? []
        var allIDs = ids.union(erasure?.ids ?? [])
        // Trash keeps the original vault-relative path after its .trash/ prefix.
        let selections = paths.map { (path: $0.hasPrefix(".trash/") ? String($0.dropFirst(7)) : $0, descendants: !$0.hasPrefix(".trash/")) }
        let matches: (String) -> Bool = { path in
            selections.contains { path == $0.path || ($0.descendants && path.hasPrefix($0.path + "/")) }
        }
        for item in outbox + Array(captureReceipts.values) where matches(item.path) {
            allIDs.insert(item.id)
        }
        for path in Array(manifest.documents.keys) + Array(manifest.assets.keys) {
            if matches(path) { hashes.insert(Self.pathHash(path)) }
            if !allIDs.isEmpty, VaultPaths.isSyncedDocument(path),
               let data = try? Data(contentsOf: fileURL(path)), let text = String(data: data, encoding: .utf8),
               VaultDocument.parse(path: path, text: text).fragmentID.map(allIDs.contains) == true {
                hashes.insert(Self.pathHash(path))
            }
        }
        for item in outbox + Array(captureReceipts.values)
            where allIDs.contains(item.id) || matches(item.path) {
            hashes.insert(Self.pathHash(item.path))
        }
        erasure = Erasure(ids: allIDs, pathHashes: hashes)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try JSONEncoder().encode(erasure).write(to: root.appending(path: "web-public-erasure.json"), options: .atomic)
        try completePublicErasure()
    }

    private func completePublicErasure() throws {
        guard let intent = erasure else { return }
        let cache = root.appending(path: "web-cache")
        if FileManager.default.fileExists(atPath: cache.path) { try FileManager.default.removeItem(at: cache) }
        let erased: (PendingFragment) -> Bool = { item in
            intent.ids.contains(item.id) || intent.pathHashes.contains(Self.pathHash(item.path))
        }
        let receipts = captureReceipts.filter { erased($0.value) }
        erasedRequests.formUnion(receipts.keys)
        erasedRequests.formUnion(outbox.filter(erased).compactMap(\.requestKey))
        try JSONEncoder().encode(erasedRequests).write(to: root.appending(path: "web-capture-erased.json"), options: .atomic)
        outbox.removeAll(where: erased)
        captureReceipts = captureReceipts.filter { !erased($0.value) }
        try saveOutbox()
        try JSONEncoder().encode(captureReceipts).write(to: root.appending(path: "web-capture-receipts.json"), options: .atomic)
        for path in Array(manifest.documents.keys) + Array(manifest.assets.keys) where intent.pathHashes.contains(Self.pathHash(path)) {
            let file = try fileURL(path)
            if FileManager.default.fileExists(atPath: file.path) { try FileManager.default.removeItem(at: file) }
            manifest.documents.removeValue(forKey: path)
            manifest.assets.removeValue(forKey: path)
        }
        webObserved.formUnion(intent.ids)
        try JSONEncoder().encode(webObserved).write(to: root.appending(path: "web-capture-observed.json"), options: .atomic)
        try saveManifest()
        try FileManager.default.removeItem(at: root.appending(path: "web-public-erasure.json"))
        erasure = nil
    }

    private func isErasedPath(_ path: String) -> Bool { erasure?.pathHashes.contains(Self.pathHash(path)) == true }
    private static func pathHash(_ path: String) -> String {
        SHA256.hash(data: Data(path.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    /// A synced capture may be newer than the last Web RPC cache. Overlay only captures
    /// still in the current mirror, until a real server response has represented them.
    public func uncachedWebCaptures(cachedIDs: Set<String>) -> [VaultDocument] {
        let own = Set(captureReceipts.values.map(\.id)).subtracting(webObserved).subtracting(cachedIDs)
        guard !own.isEmpty else { return [] }
        return loadDocuments().filter { !$0.isPending && $0.fragmentID.map(own.contains) == true }
    }

    public func markWebObserved(ids: Set<String>, paths: [String] = []) throws {
        let affected = captureReceipts.values.filter { item in
            ids.contains(item.id) || paths.contains { item.path == $0 || item.path.hasPrefix($0 + "/") }
        }.map(\.id)
        let next = webObserved.union(affected)
        guard next != webObserved else { return }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try JSONEncoder().encode(next).write(to: root.appending(path: "web-capture-observed.json"), options: .atomic)
        webObserved = next
    }

    /// Gives up on a queued fragment (only offered for one that keeps failing).
    public func discard(_ id: String) throws {
        outbox.removeAll { $0.id == id }
        try saveOutbox()
    }

    /// Commits queued fragments oldest first, stopping at the first failure so the
    /// remaining ones keep their order. Returns how many were committed.
    public func pushPending(to remote: any VaultRemote) async throws -> Int {
        try completePublicErasure()
        guard !isPushing else { return 0 }
        isPushing = true
        defer { isPushing = false }

        var pushed = 0
        while let next = outbox.first {
            try rememberCapture(next)
            let data = Data(next.text.utf8)
            try await create(next, data: data, on: remote)
            outbox.removeFirst()
            try saveOutbox()
            // Mirror it right away so the timeline does not flicker before the next pull;
            // the pull then finds the same blob SHA and downloads nothing.
            try write(data, to: next.path)
            manifest.documents[next.path] = remote.contentSHA(data)
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
            guard try await remote.fileBlobSHA(path: item.path) == remote.contentSHA(data) else {
                throw RemoteError.conflict(path: item.path)
            }
        }
    }

    private func saveOutbox() throws {
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try JSONEncoder().encode(outbox).write(to: root.appending(path: "outbox.json"), options: .atomic)
    }

    private func rememberCapture(_ item: PendingFragment) throws {
        guard let key = item.requestKey, captureReceipts[key] == nil else { return }
        captureReceipts[key] = item
        do {
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            try JSONEncoder().encode(captureReceipts).write(to: root.appending(path: "web-capture-receipts.json"), options: .atomic)
        } catch {
            captureReceipts.removeValue(forKey: key)
            throw error
        }
    }

    /// Brings the mirror up to the remote head: downloads changed blobs, removes deleted ones.
    public func sync(with remote: any VaultRemote) async throws -> SyncSummary {
        try completePublicErasure()
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
        guard let sha = manifest.assets[path] else {
            throw StoreError.unknownAsset(path)
        }
        if let cached = try? Data(contentsOf: url), remote.contentSHA(cached) == sha {
            return cached
        }
        let data = try await remote.blob(sha)
        guard remote.contentSHA(data) == sha else { throw RemoteError.checksumMismatch(path: path) }
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
        captureReceipts = [:]
        webObserved = []
        erasedRequests = []
        erasure = nil
    }

    // MARK: - Internals

    private func download(_ blobs: [String: String], from remote: any VaultRemote) async throws {
        var pending = blobs.makeIterator()
        try await withThrowingTaskGroup(of: (String, Data).self) { group in
            func startNext() -> Bool {
                guard let (path, sha) = pending.next() else { return false }
                group.addTask {
                    let data = try await remote.blob(sha)
                    guard remote.contentSHA(data) == sha else { throw RemoteError.checksumMismatch(path: path) }
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
