import CryptoKit
import Foundation
import Testing
@testable import ShardKit

private final class ServerProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler: (@Sendable (URLRequest) throws -> (Int, Data))?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            let (status, data) = try Self.handler!(request)
            client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil,
                headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
}

private final class ServerFixture: @unchecked Sendable {
    struct State {
        var files: [String: Data] = [:]
        var sequence = 1
        var loginStatus = 200
        var unauthorized = false
        var creates: [(key: String, body: Data)] = []
        var loginBodies: [[String: String]] = []
        var dropCreateResponse = false
        var corruptBlob = false
        var externalBlobs = false
        var mismatchedFetchSHA = false
        var blobRequests = 0
        var fetchRequests = 0
        var headersAreCorrect = true
    }
    private let lock = NSLock()
    private var state = State()
    func change(_ work: (inout State) -> Void) { lock.withLock { work(&state) } }
    func read<T>(_ work: (State) -> T) -> T { lock.withLock { work(state) } }
    private func bytes(_ request: URLRequest) -> Data {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return Data() }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            if count <= 0 { break }
            data.append(contentsOf: buffer.prefix(count))
        }
        return data
    }
    private func object(_ request: URLRequest) throws -> [String: Any] {
        try JSONSerialization.jsonObject(with: bytes(request)) as! [String: Any]
    }
    private func json(_ value: Any) throws -> Data { try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) }
    func respond(_ request: URLRequest) throws -> (Int, Data) {
        try lock.withLock {
            let path = request.url!.path
            if path == "/api/device/login" {
                state.loginBodies.append(try object(request) as! [String: String])
                if state.loginStatus == 200 { return (200, try json(["token": "test-device-token", "deviceId": "dev-fixture", "name": "测试 iPhone"])) }
                return (state.loginStatus, try json(["message": "测试登录拒绝"]))
            }
            state.headersAreCorrect = state.headersAreCorrect
                && request.value(forHTTPHeaderField: "Authorization") == "Bearer test-device-token"
                && request.value(forHTTPHeaderField: "X-Shard-UTC-Offset") != nil
            if state.unauthorized { return (401, try json(["message": "登录已失效。", "code": "UNAUTHENTICATED"])) }
            if path == "/api/sync/manifest" {
                let entries: [[String: Any]] = state.files.map { path, data in
                    ["path": path, "kind": "file", "sha": sha256(data), "size": data.count, "seq": state.sequence]
                }
                return (200, try json(["vaultId": "fixture-vault", "epoch": "fixture-epoch", "headSeq": state.sequence, "entries": entries]))
            }
            if path.hasPrefix("/api/blobs/") {
                state.blobRequests += 1
                guard state.externalBlobs else { return (404, Data()) }
                let hash = String(path.split(separator: "/").last!)
                guard let data = state.files.values.first(where: { sha256($0) == hash }) else { return (404, Data()) }
                return (200, state.corruptBlob ? Data("broken".utf8) : data)
            }
            if path == "/api/sync/fetch" {
                state.fetchRequests += 1
                let paths = try object(request)["paths"] as! [String]
                return (200, try json(["items": paths.map { path -> [String: Any] in
                    guard let data = state.files[path] else { return ["path": path, "missing": true] }
                    let hash = state.mismatchedFetchSHA ? String(repeating: "f", count: 64) : sha256(data)
                    if state.externalBlobs { return ["path": path, "sha": hash, "blob": true] }
                    return ["path": path, "sha": hash, "data": (state.corruptBlob ? Data("broken".utf8) : data).base64EncodedString()]
                }]))
            }
            if path == "/api/rpc/create_fragment" {
                let data = bytes(request)
                let key = request.value(forHTTPHeaderField: "Idempotency-Key") ?? ""
                let previous = state.creates.first(where: { $0.key == key })
                state.creates.append((key, data))
                if let previous {
                    return previous.body == data ? (200, try json(["ok": true])) : (422, try json(["message": "请求体变了"]))
                }
                let body = try JSONSerialization.jsonObject(with: data) as! [String: Any]
                let id = body["id"] as! String
                let date = body["createdAt"] as! String
                let content = body["content"] as! String
                let tags = body["tags"] as! [String]
                let file = "fragments/\(date.prefix(4))/\(date.dropFirst(5).prefix(2))/\(id).md"
                state.files[file] = Data("---\nid: '\(id)'\ncreated_at: '\(date)'\ntags: [\(tags.joined(separator: ", "))]\nsource: ios\n---\n\n\(content)\n".utf8)
                state.sequence += 1
                if state.dropCreateResponse {
                    state.dropCreateResponse = false
                    throw URLError(.networkConnectionLost)
                }
                return (200, try json(["ok": true]))
            }
            return (404, try json(["message": "not found"]))
        }
    }
}

private func sha256(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }

@Suite(.serialized)
struct ServerRemoteTests {
    private func environment() -> (ServerFixture, URLSession, ServerRemote) {
        let fixture = ServerFixture()
        ServerProtocol.handler = { try fixture.respond($0) }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [ServerProtocol.self]
        let session = URLSession(configuration: config)
        let account = ServerAccount(serverURL: URL(string: "https://shard.example.test")!, email: "me@example.test", deviceID: "dev-fixture", name: "测试 iPhone")
        return (fixture, session, ServerRemote(account: account, token: "test-device-token", session: session))
    }

    @Test func normalizesServerAddressesAndRejectsUnsafeInputs() throws {
        #expect(try ServerRemote.normalizeServer(" Shard.Example.com/ ").absoluteString == "https://shard.example.com")
        for address in ["http://localhost:18788", "http://127.0.0.1:18788", "http://127.8.9.10", "http://[::1]:18788"] {
            #expect(try ServerRemote.normalizeServer(address).scheme == "http")
        }
        for address in ["", "https://user:pass@shard.example.com", "https://shard.example.com/api", "https://shard.example.com?x=1", "https://shard.example.com/#token"] {
            #expect(throws: ServerError.invalidServer) { try ServerRemote.normalizeServer(address) }
        }
        for address in ["http://shard.example.com", "http://192.168.1.2", "http://localhost.example.com", "ftp://shard.example.com"] {
            #expect(throws: ServerError.insecureServer) { try ServerRemote.normalizeServer(address) }
        }
    }

    @Test func passwordLoginReturnsDeviceCredentialsAndKeepsPasswordOutOfAccount() async throws {
        let (fixture, session, _) = environment()
        defer { session.invalidateAndCancel() }
        let issued = try await ServerRemote.login(server: "shard.example.test/", email: " Me@EXAMPLE.TEST ", password: "fixture password", name: "测试 iPhone", session: session)
        #expect(issued.token == "test-device-token")
        #expect(issued.account.email == "me@example.test")
        #expect(issued.account.deviceID == "dev-fixture")
        #expect(fixture.read { $0.loginBodies.first! } == ["email": "me@example.test", "password": "fixture password", "name": "测试 iPhone", "kind": "desktop"])
        let saved = String(decoding: try JSONEncoder().encode(issued.account), as: UTF8.self)
        #expect(!saved.contains("password"))
        #expect(!saved.contains(issued.token))
    }

    @Test func handlesWrongPasswordSetupAndRevokedToken() async throws {
        let (fixture, session, remote) = environment()
        defer { session.invalidateAndCancel() }
        fixture.change { $0.loginStatus = 401 }
        await #expect(throws: ServerError.wrongCredentials) { try await ServerRemote.login(server: "shard.example.test", email: "me@example.test", password: "wrong", name: "iPhone", session: session) }
        fixture.change { $0.loginStatus = 409 }
        await #expect(throws: ServerError.setupRequired) { try await ServerRemote.login(server: "shard.example.test", email: "me@example.test", password: "fixture", name: "iPhone", session: session) }
        fixture.change { $0.unauthorized = true }
        await #expect(throws: RemoteError.unauthorized) { try await remote.head() }
    }

    @Test func refusesRedirectResponsesAndUntrustedStoredServerAddresses() async throws {
        let (fixture, session, _) = environment()
        defer { session.invalidateAndCancel() }
        fixture.change { $0.loginStatus = 302 }
        await #expect(throws: ServerError.redirected) {
            try await ServerRemote.login(server: "shard.example.test", email: "me@example.test", password: "fixture", name: "iPhone", session: session)
        }
        #expect(fixture.read { $0.loginBodies.count } == 1)
        let account = ServerAccount(serverURL: URL(string: "http://shard.example.test")!, email: "me@example.test", deviceID: "dev-fixture", name: "iPhone")
        let remote = ServerRemote(account: account, token: "test-device-token", session: session)
        await #expect(throws: ServerError.insecureServer) { try await remote.head() }
    }

    @Test func serverMirrorUsesSHA256AndExcludesPrivateFiles() async throws {
        let (fixture, session, remote) = environment()
        defer { session.invalidateAndCancel() }
        let image = Data([137, 80, 78, 71])
        fixture.change {
            $0.files = ["notes/计划.md": Data("# 计划\n保持同步 #计划".utf8), "assets/ab/image.png": image,
                        "lockbox/secret.md": Data("secret".utf8), ".trash/notes/deleted.md": Data("deleted".utf8), ".shard/config": Data("internal".utf8)]
        }
        let root = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = VaultStore(root: root)
        #expect(try await store.sync(with: remote).downloaded == 1)
        #expect(await store.loadDocuments().map(\.path) == ["notes/计划.md"])
        #expect(try await store.assetData("assets/ab/image.png", from: remote) == image)
        #expect(fixture.read { $0.headersAreCorrect })
        #expect(fixture.read { $0.blobRequests } == 0)
        #expect(fixture.read { $0.fetchRequests } == 2)
        #expect(try await store.sync(with: remote).unchanged)
        fixture.change { $0.files["notes/计划.md"] = Data("# 更新".utf8); $0.sequence += 1 }
        #expect(try await store.sync(with: remote).downloaded == 1)
        #expect(await store.loadDocuments().first?.body == "# 更新")
        let replacement = Data([137, 80, 78, 71, 1])
        fixture.change { $0.files["assets/ab/image.png"] = replacement; $0.sequence += 1 }
        _ = try await store.sync(with: remote)
        #expect(try await store.assetData("assets/ab/image.png", from: remote) == replacement)
    }

    @Test func rejectsCorruptDownloadsWithoutAdvancingMirror() async throws {
        let (fixture, session, remote) = environment()
        defer { session.invalidateAndCancel() }
        fixture.change { $0.files["notes/one.md"] = Data("valid content".utf8); $0.corruptBlob = true }
        let root = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = VaultStore(root: root)
        await #expect(throws: RemoteError.checksumMismatch(path: "notes/one.md")) { try await store.sync(with: remote) }
        #expect(await store.headCommit == nil)
    }

    @Test func fetchesLargeBlobsAndFreshActorAttachmentsAndRejectsSnapshotRaces() async throws {
        let (fixture, session, remote) = environment()
        defer { session.invalidateAndCancel() }
        let image = Data([137, 80, 78, 71])
        let hash = sha256(image)
        fixture.change { $0.files["assets/ab/picture.png"] = image; $0.externalBlobs = true }
        // No prior head()/tree(): AppModel creates a fresh remote for renderer files.
        #expect(try await remote.blob(hash) == image)
        #expect(fixture.read { $0.fetchRequests } == 1)
        #expect(fixture.read { $0.blobRequests } == 1)
        fixture.change { $0.mismatchedFetchSHA = true }
        await #expect(throws: RemoteError.checksumMismatch(path: "assets/ab/picture.png")) { try await remote.blob(hash) }
        #expect(fixture.read { $0.blobRequests } == 1)
    }

    @Test func droppedCreateResponseReplaysIdenticalRequestAndDoesNotDuplicateFragment() async throws {
        let (fixture, session, remote) = environment()
        defer { session.invalidateAndCancel() }
        let root = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        var store = VaultStore(root: root)
        let fragment = try NewFragment.make(content: "离线记一条 #手机", now: Date(timeIntervalSince1970: 1_793_435_000), timeZone: TimeZone(secondsFromGMT: 28_800)!)
        try await store.enqueue(fragment)
        fixture.change { $0.dropCreateResponse = true }
        await #expect(throws: URLError.self) { try await store.pushPending(to: remote) }
        #expect(await store.pending.count == 1)
        store = VaultStore(root: root)
        #expect(try await store.pushPending(to: remote) == 1)
        #expect(await store.pending.isEmpty)
        let requests = fixture.read { $0.creates }
        #expect(requests.count == 2)
        #expect(!requests[0].key.isEmpty && requests[0].key.count <= 128)
        #expect(requests[0].key == requests[1].key)
        #expect(requests[0].body == requests[1].body)
        #expect(fixture.read { $0.files.count } == 1)
        _ = try await store.sync(with: remote)
        #expect(await store.loadDocuments().count == 1)
        #expect(await store.loadDocuments().first?.source == "ios")
    }

    @Test func isolatesOfflineCachesByServerAndAccount() {
        let first = ServerAccount(serverURL: URL(string: "https://one.example")!, email: "one@example.com", deviceID: "1", name: "iPhone")
        let other = ServerAccount(serverURL: first.serverURL, email: "two@example.com", deviceID: "2", name: "iPhone")
        #expect(VaultStore.defaultRoot(for: first) != VaultStore.defaultRoot(for: other))
        let renewed = ServerAccount(serverURL: first.serverURL, email: first.email, deviceID: "3", name: "iPhone")
        #expect(VaultStore.defaultRoot(for: first) == VaultStore.defaultRoot(for: renewed))
    }
}

/// Opt-in interoperability check against a disposable real Rust server, never the user's vault.
@Suite struct ServerRemoteIntegrationTests {
    @Test(.enabled(if: ProcessInfo.processInfo.environment["SHARD_IOS_TEST_SERVER"] != nil,
                   "Requires the private Rust fixture on port 18790"))
    func logsInPullsAndCreatesAgainstRustServer() async throws {
        let environment = ProcessInfo.processInfo.environment
        guard let server = environment["SHARD_IOS_TEST_SERVER"],
              let email = environment["SHARD_IOS_TEST_EMAIL"],
              let password = environment["SHARD_IOS_TEST_PASSWORD"] else {
            Issue.record("Private fixture credentials are missing.")
            return
        }
        let base = try ServerRemote.normalizeServer(server)
        guard base.scheme == "http", base.port == 18790,
              ["localhost", "127.0.0.1", "[::1]", "::1"].contains(base.host ?? "") else {
            Issue.record("Integration writes are restricted to the private loopback fixture on port 18790.")
            return
        }
        let session = URLSession(configuration: .ephemeral)
        defer { session.invalidateAndCancel() }
        let credentials = try await ServerRemote.login(server: server, email: email, password: password,
                                                       name: "iOS Swift integration fixture", session: session)
        let remote = ServerRemote(account: credentials.account, token: credentials.token, session: session)
        let root = FileManager.default.temporaryDirectory.appending(path: "shard-ios-rust-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let store = VaultStore(root: root.appending(path: "first"))
        _ = try await store.sync(with: remote)
        let initial = await store.loadDocuments()
        #expect(!initial.isEmpty, "Seed the disposable server with at least one public note or fragment.")

        let marker = "iOS Rust integration \(UUID().uuidString) #手机测试"
        let fragment = try NewFragment.make(content: marker)
        try await store.enqueue(fragment)
        #expect(try await store.pushPending(to: remote) == 1)
        // Replay the same committed request to exercise the Rust idempotency ledger.
        try await remote.createFile(path: fragment.path, content: Data(fragment.text.utf8), message: "integration replay")
        let fresh = VaultStore(root: root.appending(path: "fresh"))
        _ = try await fresh.sync(with: remote)
        let matching = await fresh.loadDocuments().filter { $0.fragmentID == fragment.id }
        #expect(matching.count == 1)
        #expect(matching.first?.body.trimmingCharacters(in: .newlines) == marker)
        #expect(matching.first?.source == "ios")
        #expect(await store.pending.isEmpty)
    }
}
