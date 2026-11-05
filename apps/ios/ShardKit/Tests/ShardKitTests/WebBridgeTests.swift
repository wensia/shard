import Foundation
import CryptoKit
import Testing
@testable import ShardKit

struct WebBridgeTests {
    @Test func ssePreservesBlankSeparatorsIDsUnicodeAndCRLF() throws {
        let input = "event: vault-changed\nid: 8\ndata: {\"text\":\"中文🙂\"}\n\n: heartbeat\r\n\r\ndata: tail"
        var framer = WebSSEFramer()
        var chunks: [String] = []
        for byte in input.utf8 { if let line = try framer.push(byte) { chunks.append(line) } }
        if let final = framer.finish() { chunks.append(final) }
        #expect(chunks.joined() == input)
        #expect(chunks.contains("\n"))
        #expect(chunks.contains("\r\n"))
        #expect(chunks.contains("id: 8\n"))
    }

    @Test func serverConfirmedErasureRemovesEveryPublicCopyAndRejectsOldCaptureRetry() async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = VaultStore(root: root)
        let secret = "sealed body must leave no public copy"
        let first = try await store.captureForWeb(content: secret, tags: nil, requestKey: "secret-request")
        let other = try await store.captureForWeb(content: "unrelated pending record", tags: nil, requestKey: "other-request")
        let item = try #require(await store.pending.first)
        let file = root.appending(path: "files").appending(path: item.path)
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        let raw = Data(item.text.utf8)
        try raw.write(to: file)
        let hash = SHA256.hash(data: raw).map { String(format: "%02x", $0) }.joined()
        let manifest: [String: Any] = ["headCommit": "vault:epoch:3", "documents": [item.path: hash], "assets": [String: String]()]
        try JSONSerialization.data(withJSONObject: manifest).write(to: root.appending(path: "manifest.json"))
        let cache = WebBridgeCache(accountRoot: root)
        try await cache.save(WebCachedResponse(status: 200, headers: [:], body: Data(secret.utf8)),
                             path: "/api/rpc/list_fragments", method: "POST", body: Data("{}".utf8))
        let reopened = VaultStore(root: root)
        try await reopened.erasePublicCopies(ids: [item.id], paths: [])
        #expect(!FileManager.default.fileExists(atPath: file.path))
        #expect(await reopened.pending.map(\.id) == [other.fragmentID!])
        #expect(await reopened.loadDocuments().map(\.fragmentID) == [other.fragmentID])
        #expect(await cache.read(path: "/api/rpc/list_fragments", method: "POST", body: Data("{}".utf8)) == nil)
        let afterRestart = VaultStore(root: root)
        await #expect(throws: VaultStore.StoreError.erasedCapture) {
            try await afterRestart.captureForWeb(content: secret, tags: nil, requestKey: "secret-request")
        }
        #expect(await afterRestart.loadDocuments().allSatisfy { $0.fragmentID != first.fragmentID })
        let receipt = try Data(contentsOf: root.appending(path: "web-capture-receipts.json"))
        #expect(!String(decoding: receipt, as: UTF8.self).contains(secret))
        #expect(!String(decoding: try Data(contentsOf: root.appending(path: "outbox.json")), as: UTF8.self).contains(secret))
    }

    @Test func interruptedErasureRecoversBeforeReadingAndRawNoteFallbackRetainsFrontmatter() async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let notePath = "notes/中文笔记.md"
        let text = "---\ntags: [项目]\ncustom: value\n---\n第一行\\\n第二行\n"
        let file = root.appending(path: "files").appending(path: notePath)
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        let raw = Data(text.utf8)
        try raw.write(to: file)
        let hash = SHA256.hash(data: raw).map { String(format: "%02x", $0) }.joined()
        let manifest: [String: Any] = ["headCommit": "vault:epoch:3", "documents": [notePath: hash], "assets": [String: String]()]
        try JSONSerialization.data(withJSONObject: manifest).write(to: root.appending(path: "manifest.json"))
        let store = VaultStore(root: root)
        #expect(try await store.cachedFile(notePath).data == raw)
        #expect(try await store.cachedBlob(hash) == raw)
        let pathHash = SHA256.hash(data: Data(notePath.utf8)).map { String(format: "%02x", $0) }.joined()
        try JSONSerialization.data(withJSONObject: ["ids": [String](), "pathHashes": [pathHash]])
            .write(to: root.appending(path: "web-public-erasure.json"))
        let reopened = VaultStore(root: root)
        #expect(await reopened.loadDocuments().isEmpty)
        #expect(!FileManager.default.fileExists(atPath: file.path))
        #expect(!(await reopened.publicErasurePending))
        await #expect(throws: RemoteError.notFound) { try await reopened.cachedFile(notePath) }
    }

    @Test func trashDirectoryNeverRemovesAnActiveCaptureSharingItsYearFolder() async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = VaultStore(root: root)
        let fresh = try await store.captureForWeb(content: "still queued", tags: nil, requestKey: "fresh")
        let year = fresh.path.split(separator: "/").prefix(2).joined(separator: "/")
        try await store.erasePublicCopies(ids: [], paths: [".trash/" + year])
        #expect(await store.pending.map(\.id) == [fresh.fragmentID!])
        #expect(await store.loadDocuments().map(\.fragmentID) == [fresh.fragmentID])
    }

    @Test func requestPolicyKeepsTheNativeOriginAndRefusesEscapes() {
        for path in ["/api/rpc/list_fragments", "/api/files/notes/%E4%B8%AD%E6%96%87%20a.md", "/api/history/3?download=1", "/api/files/notes/50%25.png"] {
            #expect(WebBridgePolicy.validPath(path, method: "GET"))
        }
        for path in ["https://example.com/api/x", "//example.com/api/x", "/other", "/api/../secret", "/api/%2e%2e/secret",
                     "/api/%252e%252e/secret", "/api/files/a/../../secret", "/api//x", "/api/x#secret", "/api/\\evil"] {
            #expect(!WebBridgePolicy.validPath(path, method: "GET"))
        }
        #expect(!WebBridgePolicy.validPath("/api/x", method: "CONNECT"))
    }

    @Test func onlySuccessfulPublicReadsAndEncryptedSnapshotsAreCached() async throws {
        #expect(WebBridgePolicy.canCache(path: "/api/rpc/lockbox_snapshot", method: "POST"))
        #expect(!WebBridgePolicy.canCache(path: "/api/auth/state", method: "GET"))
        #expect(!WebBridgePolicy.canCache(path: "/api/auth/login", method: "POST"))
        #expect(!WebBridgePolicy.canCache(path: "/api/rpc/update_fragment", method: "POST"))
        #expect(!WebBridgePolicy.canCache(path: "/api/rpc/search_vault", method: "POST"))
        let root = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let cache = WebBridgeCache(accountRoot: root)
        let body = Data("{}".utf8)
        let data = Data("{\"fragments\":[]}".utf8)
        try await cache.save(WebCachedResponse(status: 200, headers: ["content-type": "application/json"], body: data),
                             path: "/api/rpc/list_fragments", method: "POST", body: body)
        try await cache.save(WebCachedResponse(status: 401, headers: [:], body: Data("unauthorized".utf8)),
                             path: "/api/rpc/list_fragments", method: "POST", body: body)
        #expect(await cache.read(path: "/api/rpc/list_fragments", method: "POST", body: body)?.body == data)
        let other = WebBridgeCache(accountRoot: root.appending(path: "another-account"))
        #expect(await other.read(path: "/api/rpc/list_fragments", method: "POST", body: body) == nil)
        #expect(await cache.read(path: "/api/rpc/list_fragments", method: "POST", body: Data("{\"different\":1}".utf8)) == nil)
    }

    @Test func webCapturePersistsOneIdentityAcrossRetriesAndRestart() async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = VaultStore(root: root)
        let first = try await store.captureForWeb(content: "第一行\\\n第二行", tags: ["项目"], requestKey: "request-1")
        let again = try await store.captureForWeb(content: "第一行\\\n第二行", tags: ["项目"], requestKey: "request-1")
        #expect(first.fragmentID == again.fragmentID)
        #expect(first.createdAt == again.createdAt)
        #expect(again.tags == ["inbox", "项目"])
        #expect(await store.pending.count == 1)
        // The queue remains the original array format, with optional extra fields only.
        let encoded = try Data(contentsOf: root.appending(path: "outbox.json"))
        #expect((try JSONSerialization.jsonObject(with: encoded) as? [[String: Any]])?.count == 1)
        let reopened = VaultStore(root: root)
        let afterRestart = try await reopened.captureForWeb(content: "第一行\\\n第二行", tags: ["项目"], requestKey: "request-1")
        #expect(afterRestart.fragmentID == first.fragmentID)
        #expect(await reopened.pending.count == 1)
        await #expect(throws: RemoteError.conflict(path: first.path)) {
            try await reopened.captureForWeb(content: "不同正文", tags: ["项目"], requestKey: "request-1")
        }
        // A completed/discarded receipt never creates a second queue item under the old key.
        try await reopened.discard(first.fragmentID!)
        let completed = try await reopened.captureForWeb(content: "第一行\\\n第二行", tags: ["项目"], requestKey: "request-1")
        #expect(completed.fragmentID == first.fragmentID)
        #expect(!completed.isPending)
        #expect(await reopened.pending.isEmpty)
    }

    @Test func queuedRequestKeyRecoversAnInterruptedReceiptWrite() async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = VaultStore(root: root)
        let first = try await store.captureForWeb(content: "保存后响应丢失", tags: nil, requestKey: "lost-response")
        try FileManager.default.removeItem(at: root.appending(path: "web-capture-receipts.json"))
        let reopened = VaultStore(root: root)
        let retry = try await reopened.captureForWeb(content: "保存后响应丢失", tags: nil, requestKey: "lost-response")
        #expect(retry.fragmentID == first.fragmentID)
        #expect(await reopened.pending.count == 1)
    }

    @Test func ownerEmailChangeRetainsTheOriginalCacheAndOldMetadataStillDecodes() throws {
        let original = ServerAccount(serverURL: URL(string: "https://example.test")!, email: "before@example.test", deviceID: "device", name: "Phone")
        let changed = ServerAccount(serverURL: original.serverURL, email: "after@example.test", deviceID: original.deviceID,
                                    name: original.name, storageEmail: original.email)
        #expect(VaultStore.defaultRoot(for: original) == VaultStore.defaultRoot(for: changed))
        let independent = ServerAccount(serverURL: original.serverURL, email: changed.email, deviceID: "another", name: "Phone")
        #expect(VaultStore.defaultRoot(for: original) != VaultStore.defaultRoot(for: independent))
        let oldJSON = Data("{\"serverURL\":\"https://example.test\",\"email\":\"before@example.test\",\"deviceID\":\"device\",\"name\":\"Phone\"}".utf8)
        #expect(try JSONDecoder().decode(ServerAccount.self, from: oldJSON) == original)
        #expect(try JSONDecoder().decode(ServerAccount.self, from: JSONEncoder().encode(changed)).storageEmail == original.email)
    }

    @Test func explicitCaptureTagsCannotBypassPrivateContentRejection() {
        #expect(throws: NewFragment.Failure.lockboxNotSupported) {
            try NewFragment.make(content: "#密匣 私密内容", tags: [])
        }
    }

    @Test func syncedCaptureBridgesASnapshotGapWithoutResurrectingDeletedContent() async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = VaultStore(root: root)
        let first = try await store.captureForWeb(content: "补交成功后立即断网", tags: nil, requestKey: "synced-capture")
        let item = try #require(await store.pending.first)
        let data = Data(item.text.utf8)
        let file = root.appending(path: "files").appending(path: item.path)
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data.write(to: file)
        try Data("[]".utf8).write(to: root.appending(path: "outbox.json"))
        let hash = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        let manifest: [String: Any] = ["headCommit": "vault:epoch:2", "documents": [item.path: hash], "assets": [String: String]()]
        let manifestData = try JSONSerialization.data(withJSONObject: manifest)
        try manifestData.write(to: root.appending(path: "manifest.json"))
        let afterSync = VaultStore(root: root)
        #expect(await afterSync.pending.isEmpty)
        #expect(await afterSync.uncachedWebCaptures(cachedIDs: []).map(\.fragmentID) == [first.fragmentID])
        #expect(await afterSync.uncachedWebCaptures(cachedIDs: [item.id]).isEmpty)
        // A real sync deletion removes the mirror entry even before a Web cache ever saw it.
        let emptyManifest: [String: Any] = ["headCommit": "vault:epoch:3", "documents": [String: String](), "assets": [String: String]()]
        try JSONSerialization.data(withJSONObject: emptyManifest).write(to: root.appending(path: "manifest.json"))
        #expect(await VaultStore(root: root).uncachedWebCaptures(cachedIDs: []).isEmpty)
        try manifestData.write(to: root.appending(path: "manifest.json"))
        try await afterSync.markWebObserved(ids: [item.id])
        // Once observed in an authoritative Web snapshot/mutation, an old mirror cannot revive it.
        #expect(await VaultStore(root: root).uncachedWebCaptures(cachedIDs: []).isEmpty)
    }
}
