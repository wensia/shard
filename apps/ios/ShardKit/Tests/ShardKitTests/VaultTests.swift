import Foundation
import Testing
@testable import ShardKit

/// In-memory remote: a map of path → content, with a commit id that changes on edit.
private actor FakeRemote: VaultRemote {
    var files: [String: Data]
    var commit = 1
    var blobRequests: [String] = []
    var corrupt: Set<String> = []

    init(_ files: [String: String]) {
        self.files = files.mapValues { Data($0.utf8) }
    }

    func set(_ path: String, _ text: String?) {
        files[path] = text.map { Data($0.utf8) }
        commit += 1
    }

    func corruptBlob(of path: String) {
        corrupt.insert(VaultStore.gitBlobSHA(files[path]!))
    }

    nonisolated func head() async throws -> RemoteHead {
        let commit = await self.commit
        return RemoteHead(commit: "c\(commit)", tree: "t\(commit)")
    }

    nonisolated func tree(_ sha: String) async throws -> [RemoteEntry] {
        await files.map { RemoteEntry(path: $0.key, sha: VaultStore.gitBlobSHA($0.value), size: $0.value.count) }
    }

    nonisolated func blob(_ sha: String) async throws -> Data {
        try await lookup(sha)
    }

    nonisolated func createFile(path: String, content: Data, message: String) async throws {
        try await create(path, content)
    }

    nonisolated func fileBlobSHA(path: String) async throws -> String? {
        await files[path].map(VaultStore.gitBlobSHA)
    }

    var createRequests: [String] = []
    var failNextCreate = false

    private func create(_ path: String, _ content: Data) throws {
        createRequests.append(path)
        if failNextCreate {
            failNextCreate = false
            // The commit lands but the response is lost, as on a dropped connection.
            files[path] = content
            commit += 1
            throw URLError(.networkConnectionLost)
        }
        if files[path] != nil {
            throw RemoteError.alreadyExists
        }
        files[path] = content
        commit += 1
    }

    func dropNextCreateResponse() {
        failNextCreate = true
    }

    private func lookup(_ sha: String) throws -> Data {
        blobRequests.append(sha)
        guard let data = files.values.first(where: { VaultStore.gitBlobSHA($0) == sha }) else {
            throw RemoteError.notFound
        }
        return corrupt.contains(sha) ? data + Data("x".utf8) : data
    }
}

private func temporaryRoot() -> URL {
    FileManager.default.temporaryDirectory.appending(path: "shardkit-\(UUID().uuidString)", directoryHint: .isDirectory)
}

private let fragmentText = """
---
id: 20261013-182233-1a2b3c4d-5e6f70
created_at: 2026-10-13T18:22:33.683399+08:00
updated_at: 2026-10-13T18:22:33.683399+08:00
tags:
- inbox
- 骑行
category: null
ai_status: none
source: desktop
---

坡道上先稳住踏频。#骑行
"""

@Suite struct VaultDocumentTests {
    @Test func parsesFragmentFrontmatterAsWritten() {
        let document = VaultDocument.parse(path: "fragments/2026/10/a.md", text: fragmentText)
        #expect(document.kind == .fragment)
        #expect(document.fragmentID == "20261013-182233-1a2b3c4d-5e6f70")
        #expect(document.createdAt == "2026-10-13T18:22:33.683399+08:00")
        #expect(document.tags == ["inbox", "骑行"])
        #expect(document.source == "desktop")
        #expect(document.pinned == false)
        #expect(document.body == "坡道上先稳住踏频。#骑行")
    }

    @Test func quotedNullStaysText() {
        let text = "---\nid: x\ntags:\n- 'null'\ncategory: null\nsource: 'null'\npinned: true\n---\n\nbody"
        let document = VaultDocument.parse(path: "fragments/x.md", text: text)
        #expect(document.tags == ["null"])
        #expect(document.source == "null")
        #expect(document.pinned)
    }

    @Test func notesWithoutFrontmatterUseFileNameAndBodyTags() {
        let document = VaultDocument.parse(path: "notes/产品/判断.md", text: "# 判断\n\n先记下来 #产品")
        #expect(document.kind == .note)
        #expect(document.title == "判断")
        #expect(document.body == "# 判断\n\n先记下来 #产品")
        #expect(document.tags == ["产品"])
    }

    @Test func unreadableFrontmatterFallsBackToPlainText() {
        let text = "---\ntags: [unclosed\n---\nbody"
        let document = VaultDocument.parse(path: "fragments/bad.md", text: text)
        #expect(document.body == text)
        #expect(document.fragmentID == nil)
    }

    @Test func pathRulesKeepPrivateAreasOut() {
        #expect(VaultPaths.isSyncedDocument("fragments/2026/10/a.md"))
        #expect(VaultPaths.isSyncedDocument("notes/a/b.md"))
        #expect(!VaultPaths.isSyncedDocument("lockbox/fragments/a.md"))
        #expect(!VaultPaths.isSyncedDocument("notes/.hidden/a.md"))
        #expect(!VaultPaths.isSyncedDocument("fragments/a.txt"))
        #expect(VaultPaths.isExcluded(".trash/fragments/a.md"))
        #expect(VaultPaths.isExcluded(".shard/notes.sqlite3"))
        #expect(VaultPaths.isAsset("assets/52/abc.png"))
    }
}

@Suite struct VaultIndexTests {
    private func fragment(_ name: String, created: String, tags: [String] = ["inbox"], pinned: Bool = false, body: String = "") -> VaultDocument {
        VaultDocument(
            path: "fragments/\(name).md", kind: .fragment, fragmentID: name, title: name, body: body,
            tags: tags, createdAt: created, updatedAt: created, pinned: pinned, source: "desktop"
        )
    }

    @Test func timelinePutsPinnedFirstThenNewest() {
        let index = VaultIndex(documents: [
            fragment("old", created: "2026-01-01T00:00:00+08:00"),
            fragment("new", created: "2026-10-01T00:00:00+08:00"),
            fragment("pinned", created: "2025-01-01T00:00:00+08:00", pinned: true),
        ])
        #expect(index.fragments.map(\.fragmentID) == ["pinned", "new", "old"])
    }

    @Test func tagsCountFragmentsAndSkipInbox() {
        let index = VaultIndex(documents: [
            fragment("a", created: "1", tags: ["inbox", "骑行"]),
            fragment("b", created: "2", tags: ["inbox", "骑行", "复盘"]),
        ])
        #expect(index.tags.map(\.name) == ["骑行", "复盘"])
        #expect(index.tags.first?.count == 2)
        #expect(index.fragments(taggedWith: "复盘").map(\.fragmentID) == ["b"])
    }

    @Test func searchRequiresEveryKeyword() {
        let index = VaultIndex(documents: [
            fragment("a", created: "1", body: "银行 房贷 利率"),
            fragment("b", created: "2", body: "银行 存款"),
            VaultDocument.parse(path: "notes/房贷.md", text: "银行 资料"),
        ])
        #expect(index.search("银行 房贷").map(\.path) == ["fragments/a.md", "notes/房贷.md"])
        #expect(index.search("ＢＡＮＫ").isEmpty)
        #expect(index.search("   ").isEmpty)
    }
}

@Suite struct VaultStoreTests {
    @Test func gitBlobSHAMatchesGit() {
        // `printf 'hello\n' | git hash-object --stdin`
        #expect(VaultStore.gitBlobSHA(Data("hello\n".utf8)) == "ce013625030ba8dba906f756967f9e9ca394464a")
    }

    @Test func syncMirrorsDocumentsAndSkipsPrivateFiles() async throws {
        let remote = FakeRemote([
            "fragments/2026/10/a.md": fragmentText,
            "notes/n.md": "# note",
            "lockbox/fragments/secret.md": "encrypted",
            ".trash/fragments/old.md": "deleted",
            "assets/52/img.png": "png",
            "datasets/table.csv": "a,b",
        ])
        let store = VaultStore(root: temporaryRoot())

        let first = try await store.sync(with: remote)
        #expect(first.downloaded == 2)
        let paths = await store.loadDocuments().map(\.path).sorted()
        #expect(paths == ["fragments/2026/10/a.md", "notes/n.md"])

        let again = try await store.sync(with: remote)
        #expect(again.unchanged)
    }

    @Test func syncDownloadsOnlyChangesAndRemovesDeletions() async throws {
        let remote = FakeRemote(["notes/a.md": "a", "notes/b.md": "b"])
        let root = temporaryRoot()
        let store = VaultStore(root: root)
        _ = try await store.sync(with: remote)

        await remote.set("notes/a.md", "a2")
        await remote.set("notes/b.md", nil)
        let before = await remote.blobRequests.count
        let summary = try await store.sync(with: remote)
        #expect(summary.downloaded == 1)
        #expect(summary.removed == 1)
        #expect(await remote.blobRequests.count == before + 1)

        // A fresh store on the same root reads the persisted mirror.
        let reopened = VaultStore(root: root)
        let documents = await reopened.loadDocuments()
        #expect(documents.map(\.body) == ["a2"])
    }

    @Test func corruptedBlobFailsWithoutAdvancingHead() async throws {
        let remote = FakeRemote(["notes/a.md": "a"])
        await remote.corruptBlob(of: "notes/a.md")
        let store = VaultStore(root: temporaryRoot())
        await #expect(throws: RemoteError.checksumMismatch(path: "notes/a.md")) {
            try await store.sync(with: remote)
        }
        #expect(await store.headCommit == nil)
    }

    @Test func assetsAreFetchedOnceThenServedFromCache() async throws {
        let remote = FakeRemote(["notes/a.md": "![x](assets/52/img.png)", "assets/52/img.png": "png-bytes"])
        let store = VaultStore(root: temporaryRoot())
        _ = try await store.sync(with: remote)
        let before = await remote.blobRequests.count

        let data = try await store.assetData("assets/52/img.png", from: remote)
        #expect(String(decoding: data, as: UTF8.self) == "png-bytes")
        _ = try await store.assetData("assets/52/img.png", from: remote)
        #expect(await remote.blobRequests.count == before + 1)

        await #expect(throws: VaultStore.StoreError.unsafePath("assets/../../etc/passwd")) {
            try await store.assetData("assets/../../etc/passwd", from: remote)
        }
    }
}

@Suite struct GitHubRemoteTests {
    @Test func branchNamesWithSlashesStayOneSegment() {
        let remote = GitHubRemote(repository: GitHubRepository(owner: "wensia", name: "shard-vault", branch: "feat/x"), token: "t")
        let request = remote.request(remote.repoPath("branches", "feat/x"))
        #expect(request.url?.absoluteString == "https://api.github.com/repos/wensia/shard-vault/branches/feat%2Fx")
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer t")
    }

    @Test func statusCodesMapToRemoteErrors() {
        func response(_ status: Int, _ headers: [String: String] = [:]) -> HTTPURLResponse {
            HTTPURLResponse(url: URL(string: "https://api.github.com")!, statusCode: status, httpVersion: nil, headerFields: headers)!
        }
        #expect(GitHubRemote.error(status: 401, headers: response(401), body: Data()) == .unauthorized)
        #expect(GitHubRemote.error(status: 404, headers: response(404), body: Data()) == .notFound)
        let limited = GitHubRemote.error(
            status: 403,
            headers: response(403, ["x-ratelimit-remaining": "0", "x-ratelimit-reset": "1800000000"]),
            body: Data()
        )
        #expect(limited == .rateLimited(resetAt: Date(timeIntervalSince1970: 1_800_000_000)))
        let other = GitHubRemote.error(status: 422, headers: response(422), body: Data(#"{"message":"Invalid request"}"#.utf8))
        #expect(other == .http(status: 422, message: "Invalid request"))
    }
}

@Suite struct TagRangeTests {
    @Test func rangesCoverTheSameTagsExtractFinds() {
        let text = "坡道 #骑行，#复盘 abc#no (#括号) #."
        let spans = ShardTags.tagRanges(in: text).map { String(text[$0]) }
        #expect(spans == ["#骑行", "#复盘", "#括号"])
        #expect(spans.map { String($0.dropFirst()) } == ShardTags.extractTags(text))
    }
}

@Suite struct OutboxTests {
    private func capture(_ text: String, id: String) throws -> NewFragment {
        try NewFragment.make(content: text, now: Date(timeIntervalSince1970: 1_791_886_953), timeZone: TimeZone(secondsFromGMT: 8 * 3600)!, id: id)
    }

    @Test func queuedFragmentsShowAsPendingAndSurviveAPull() async throws {
        let remote = FakeRemote(["notes/a.md": "a"])
        let root = temporaryRoot()
        let store = VaultStore(root: root)
        try await store.enqueue(capture("手机上记的 #测试", id: "20261013-182233-00000000-000001"))

        _ = try await store.sync(with: remote)
        let pending = await store.loadDocuments().filter(\.isPending)
        #expect(pending.map(\.path) == ["fragments/2026/10/20261013-182233-00000000-000001.md"])
        #expect(pending.first?.tags == ["inbox", "测试"])

        // The outbox is persisted on its own, independent of the mirror manifest.
        #expect(await VaultStore(root: root).pending.count == 1)
    }

    @Test func pushCommitsInOrderAndMirrorsWithoutRedownloading() async throws {
        let remote = FakeRemote(["notes/a.md": "a"])
        let store = VaultStore(root: temporaryRoot())
        _ = try await store.sync(with: remote)
        let first = try capture("第一条", id: "20261013-182233-00000000-000001")
        let second = try capture("第二条", id: "20261013-182233-00000000-000002")
        try await store.enqueue(first)
        try await store.enqueue(second)

        #expect(try await store.pushPending(to: remote) == 2)
        #expect(await remote.createRequests == [first.path, second.path])
        #expect(await remote.files[first.path] == Data(first.text.utf8))
        #expect(await store.pending.isEmpty)

        let before = await remote.blobRequests.count
        let summary = try await store.sync(with: remote)
        #expect(summary.downloaded == 0)
        #expect(await remote.blobRequests.count == before)
        #expect(await store.loadDocuments().filter(\.isPending).isEmpty)
    }

    @Test func retryAfterLostResponseDoesNotDuplicate() async throws {
        let remote = FakeRemote([:])
        let store = VaultStore(root: temporaryRoot())
        let fragment = try capture("网络断了", id: "20261013-182233-00000000-000003")
        try await store.enqueue(fragment)

        await remote.dropNextCreateResponse()
        await #expect(throws: URLError.self) { try await store.pushPending(to: remote) }
        #expect(await store.pending.count == 1)

        #expect(try await store.pushPending(to: remote) == 1)
        #expect(await remote.files.count == 1)
        #expect(await store.pending.isEmpty)
    }

    @Test func differentContentAtTheSamePathIsAConflict() async throws {
        let fragment = try capture("我的内容", id: "20261013-182233-00000000-000004")
        let remote = FakeRemote([fragment.path: "别人的内容"])
        let store = VaultStore(root: temporaryRoot())
        try await store.enqueue(fragment)

        await #expect(throws: RemoteError.conflict(path: fragment.path)) {
            try await store.pushPending(to: remote)
        }
        #expect(await store.pending.count == 1)
        try await store.discard(fragment.id)
        #expect(await store.pending.isEmpty)
    }
}
