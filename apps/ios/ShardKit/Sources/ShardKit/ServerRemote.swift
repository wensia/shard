import CryptoKit
import Foundation

public struct ServerAccount: Codable, Hashable, Sendable {
    public let serverURL: URL
    public let email: String
    public let deviceID: String
    public let name: String

    public init(serverURL: URL, email: String, deviceID: String, name: String) {
        self.serverURL = serverURL
        self.email = email
        self.deviceID = deviceID
        self.name = name
    }
}

/// Only the device token is persisted by the app; the login password is never stored.
public struct ServerCredentials: Sendable {
    public let account: ServerAccount
    public let token: String
}

public enum ServerError: Error, LocalizedError, Equatable, Sendable {
    case invalidServer
    case insecureServer
    case wrongCredentials
    case setupRequired
    case invalidResponse
    case redirected

    public var errorDescription: String? {
        switch self {
        case .invalidServer: "服务器地址无效。"
        case .insecureServer: "服务器地址必须使用 HTTPS。"
        case .wrongCredentials: "邮箱或密码不正确。"
        case .setupRequired: "服务器尚未设置账号。"
        case .invalidResponse: "服务器响应无效。"
        case .redirected: "服务器地址发生跳转，请使用最终地址。"
        }
    }
}

/// A server-backed vault shares the existing offline mirror and durable outbox.
public actor ServerRemote: VaultRemote {
    public nonisolated let account: ServerAccount
    private let token: String
    private let session: URLSession
    private var snapshot: Snapshot?

    public init(account: ServerAccount, token: String, session: URLSession = .shared) {
        self.account = account
        self.token = token
        self.session = session
    }

    public static func login(server: String, email: String, password: String, name: String, session: URLSession = .shared) async throws -> ServerCredentials {
        let url = try normalizeServer(server)
        let email = email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        var request = URLRequest(url: url.appending(path: "api/device/login"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(LoginBody(email: email, password: password, name: name, kind: "desktop"))
        let data: Data
        do {
            data = try await send(request, session: session)
        } catch RemoteError.unauthorized {
            throw ServerError.wrongCredentials
        } catch RemoteError.http(status: 409, _) {
            throw ServerError.setupRequired
        }
        let reply: LoginReply
        do { reply = try JSONDecoder().decode(LoginReply.self, from: data) }
        catch { throw ServerError.invalidResponse }
        guard !reply.token.isEmpty, !reply.deviceId.isEmpty else { throw ServerError.invalidResponse }
        return ServerCredentials(
            account: ServerAccount(serverURL: url, email: email, deviceID: reply.deviceId, name: reply.name ?? name),
            token: reply.token
        )
    }

    public static func normalizeServer(_ input: String) throws -> URL {
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty,
              var components = URLComponents(string: text.contains("://") ? text : "https://\(text)"),
              let rawHost = components.host, !rawHost.isEmpty,
              components.user == nil, components.password == nil,
              components.query == nil, components.fragment == nil,
              components.path.isEmpty || components.path == "/"
        else { throw ServerError.invalidServer }
        let scheme = components.scheme?.lowercased()
        let host = rawHost.lowercased()
        let plainHost = host.trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        let octets = plainHost.split(separator: ".", omittingEmptySubsequences: false)
        let loopbackIPv4 = octets.count == 4 && octets.first == "127"
            && octets.allSatisfy { Int($0).map { (0...255).contains($0) } ?? false }
        let loopback = plainHost == "localhost" || plainHost == "::1" || loopbackIPv4
        guard scheme == "https" || scheme == "http" && loopback else { throw ServerError.insecureServer }
        components.scheme = scheme
        components.host = host
        components.path = ""
        guard let result = components.url else { throw ServerError.invalidServer }
        return result
    }

    public func head() async throws -> RemoteHead {
        let fresh: Snapshot = try await json("api/sync/manifest")
        snapshot = fresh
        return RemoteHead(commit: fresh.key, tree: fresh.key)
    }

    public func tree(_ sha: String) async throws -> [RemoteEntry] {
        if snapshot?.key != sha { _ = try await head() }
        guard let snapshot, snapshot.key == sha else { throw ServerError.invalidResponse }
        return snapshot.entries.compactMap { entry in
            guard entry.kind == "file", let hash = entry.sha,
                  !VaultPaths.isExcluded(entry.path),
                  VaultPaths.isSyncedDocument(entry.path) || VaultPaths.isAsset(entry.path)
            else { return nil }
            return RemoteEntry(path: entry.path, sha: hash, size: entry.size)
        }
    }

    public func blob(_ sha: String) async throws -> Data {
        guard Self.isSHA256(sha) else { throw ServerError.invalidResponse }
        if path(for: sha) == nil { _ = try await head() }
        guard let path = path(for: sha) else { throw RemoteError.notFound }
        let reply: FetchReply = try await json("api/sync/fetch", body: JSONEncoder().encode(FetchBody(paths: [path])))
        guard let item = reply.items.first(where: { $0.path == path }), item.missing != true else { throw RemoteError.notFound }
        // A file may move or change between the manifest snapshot and this read.
        // Do not advance the mirror using bytes from a different revision.
        guard item.sha == sha else { throw RemoteError.checksumMismatch(path: path) }
        let bytes: Data
        if item.blob == true {
            bytes = try await perform("api/blobs/\(sha)")
        } else {
            guard let encoded = item.data, let data = Data(base64Encoded: encoded) else { throw ServerError.invalidResponse }
            bytes = data
        }
        guard contentSHA(bytes) == sha else { throw RemoteError.checksumMismatch(path: path) }
        return bytes
    }

    private func path(for sha: String) -> String? {
        snapshot?.entries.first(where: {
            $0.kind == "file" && $0.sha == sha && !VaultPaths.isExcluded($0.path)
                && (VaultPaths.isSyncedDocument($0.path) || VaultPaths.isAsset($0.path))
        })?.path
    }

    public nonisolated func contentSHA(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    public func createFile(path: String, content: Data, message: String) async throws {
        guard VaultPaths.isSyncedDocument(path), path.hasPrefix("fragments/"),
              let text = String(data: content, encoding: .utf8)
        else { throw ServerError.invalidResponse }
        let fragment = VaultDocument.parse(path: path, text: text)
        guard let id = fragment.fragmentID, let createdAt = fragment.createdAt else { throw ServerError.invalidResponse }
        let body = CreateBody(content: fragment.body, tags: fragment.tags, source: "ios", id: id, createdAt: createdAt)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        // Includes the original bytes: queue replays retain the key and body, while a
        // different write with the same fragment id cannot impersonate an old retry.
        let key = "ios-create-\(id)-\(contentSHA(content))"
        do {
            _ = try await perform("api/rpc/create_fragment", body: encoder.encode(body), idempotencyKey: key)
        } catch RemoteError.http(status: 409, _) {
            // The server canonicalizes YAML. After its idempotency retention expires,
            // compare parsed fields instead of requiring byte-identical frontmatter.
            guard let existingSHA = try await fileBlobSHA(path: path),
                  let existingText = String(data: try await blob(existingSHA), encoding: .utf8)
            else { throw RemoteError.conflict(path: path) }
            let existing = VaultDocument.parse(path: path, text: existingText)
            guard existing.fragmentID == id, existing.createdAt == createdAt,
                  existing.body.trimmingCharacters(in: .whitespacesAndNewlines) == fragment.body.trimmingCharacters(in: .whitespacesAndNewlines),
                  Set(existing.tags) == Set(fragment.tags), existing.source == "ios"
            else { throw RemoteError.conflict(path: path) }
        }
        snapshot = nil
    }

    public func fileBlobSHA(path: String) async throws -> String? {
        let reply: FetchReply = try await json("api/sync/fetch", body: JSONEncoder().encode(FetchBody(paths: [path])))
        guard let item = reply.items.first(where: { $0.path == path }), item.missing != true else { return nil }
        return item.sha
    }

    private func json<T: Decodable>(_ path: String, body: Data? = nil) async throws -> T {
        let data = try await perform(path, body: body)
        do { return try JSONDecoder().decode(T.self, from: data) }
        catch { throw ServerError.invalidResponse }
    }

    private func perform(_ path: String, body: Data? = nil, idempotencyKey: String? = nil) async throws -> Data {
        let server = try Self.normalizeServer(account.serverURL.absoluteString)
        var request = URLRequest(url: server.appending(path: path))
        request.httpMethod = body == nil ? "GET" : "POST"
        request.httpBody = body
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue(String(TimeZone.current.secondsFromGMT() / 60), forHTTPHeaderField: "X-Shard-UTC-Offset")
        if body != nil { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        if let idempotencyKey { request.setValue(idempotencyKey, forHTTPHeaderField: "Idempotency-Key") }
        return try await Self.send(request, session: session)
    }

    private static func send(_ original: URLRequest, session: URLSession) async throws -> Data {
        var request = original
        request.timeoutInterval = 30
        request.httpShouldHandleCookies = false
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("shard-ios/0.1", forHTTPHeaderField: "User-Agent")
        let (data, response) = try await session.data(for: request, delegate: RefuseRedirects())
        guard let response = response as? HTTPURLResponse else { throw ServerError.invalidResponse }
        if (200..<300).contains(response.statusCode) { return data }
        if (300..<400).contains(response.statusCode) { throw ServerError.redirected }
        let problem = try? JSONDecoder().decode(Problem.self, from: data)
        switch response.statusCode {
        case 401: throw RemoteError.unauthorized
        case 404: throw RemoteError.notFound
        case 429: throw RemoteError.rateLimited(resetAt: nil)
        default: throw RemoteError.http(status: response.statusCode, message: problem?.message ?? "服务器返回 HTTP \(response.statusCode)。")
        }
    }

    private static func isSHA256(_ hash: String) -> Bool {
        hash.count == 64 && hash.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
    }

    private struct LoginBody: Encodable { let email: String; let password: String; let name: String; let kind: String }
    private struct LoginReply: Decodable { let token: String; let deviceId: String; let name: String? }
    private struct Problem: Decodable { let message: String }
    private struct FetchBody: Encodable { let paths: [String] }
    private struct FetchReply: Decodable {
        struct Item: Decodable { let path: String; let sha: String?; let missing: Bool?; let blob: Bool?; let data: String? }
        let items: [Item]
    }
    private struct CreateBody: Encodable { let content: String; let tags: [String]; let source: String; let id: String; let createdAt: String }
    private struct Snapshot: Decodable {
        struct Entry: Decodable { let path: String; let kind: String; let sha: String?; let size: Int }
        let vaultId: String
        let epoch: String
        let headSeq: Int64
        let entries: [Entry]
        var key: String { "\(vaultId):\(epoch):\(headSeq)" }
    }
}

private final class RefuseRedirects: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}
