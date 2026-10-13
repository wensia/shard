import Foundation

/// Where the vault lives on GitHub.
public struct GitHubRepository: Codable, Hashable, Sendable {
    public var owner: String
    public var name: String
    public var branch: String

    public init(owner: String, name: String, branch: String = "main") {
        self.owner = owner
        self.name = name
        self.branch = branch
    }

    public var displayName: String { "\(owner)/\(name)" }
}

/// One blob in the remote tree.
public struct RemoteEntry: Hashable, Sendable, Codable {
    public let path: String
    public let sha: String
    public let size: Int
}

public struct RemoteHead: Hashable, Sendable {
    public let commit: String
    public let tree: String
}

public enum RemoteError: Error, Equatable, Sendable {
    /// Token missing, expired or revoked (401).
    case unauthorized
    /// Repository or branch not visible to this token (404).
    case notFound
    /// Primary or secondary rate limit; `resetAt` when GitHub reports it.
    case rateLimited(resetAt: Date?)
    case http(status: Int, message: String)
    case invalidResponse
    case truncatedTree
    case checksumMismatch(path: String)
    /// The path already exists remotely with different content (never expected for new fragment ids).
    case conflict(path: String)
}

/// The sync layer's view of a remote vault, so GitHub can later be swapped for another host.
public protocol VaultRemote: Sendable {
    func head() async throws -> RemoteHead
    func tree(_ sha: String) async throws -> [RemoteEntry]
    func blob(_ sha: String) async throws -> Data
    /// Commits a new file on the branch. Throws `RemoteError.alreadyExists` if the path is taken.
    func createFile(path: String, content: Data, message: String) async throws
    /// Blob SHA of a file on the branch, or nil when it does not exist.
    func fileBlobSHA(path: String) async throws -> String?
}

extension RemoteError {
    /// GitHub answers 422 when `PUT contents` targets an existing path without its sha.
    static let alreadyExists = RemoteError.http(status: 422, message: "already exists")
}

/// GitHub REST v3 (`api.github.com`), authenticated with a fine-grained token.
public struct GitHubRemote: VaultRemote {
    public static let defaultAPIBase = URL(string: "https://api.github.com")!

    public let repository: GitHubRepository
    private let token: String
    private let session: URLSession
    private let baseURL: URL

    /// `apiBase` is only overridden by debug builds pointing at `scripts/mock-github.py`.
    public init(repository: GitHubRepository, token: String, apiBase: URL = defaultAPIBase, session: URLSession = .shared) {
        self.repository = repository
        self.token = token
        self.baseURL = apiBase
        self.session = session
    }

    public func head() async throws -> RemoteHead {
        struct Branch: Decodable {
            struct Commit: Decodable {
                struct Inner: Decodable {
                    struct Tree: Decodable { let sha: String }
                    let tree: Tree
                }
                let sha: String
                let commit: Inner
            }
            let commit: Commit
        }
        // `branches/{name}` accepts names with slashes, unlike `git/trees/{ref}`.
        let branch: Branch = try await getJSON(repoPath("branches", repository.branch))
        return RemoteHead(commit: branch.commit.sha, tree: branch.commit.commit.tree.sha)
    }

    public func tree(_ sha: String) async throws -> [RemoteEntry] {
        struct Tree: Decodable {
            struct Item: Decodable {
                let path: String
                let type: String
                let sha: String
                let size: Int?
            }
            let tree: [Item]
            let truncated: Bool
        }
        let tree: Tree = try await getJSON(repoPath("git", "trees", sha), query: [URLQueryItem(name: "recursive", value: "1")])
        if tree.truncated {
            throw RemoteError.truncatedTree
        }
        return tree.tree
            .filter { $0.type == "blob" }
            .map { RemoteEntry(path: $0.path, sha: $0.sha, size: $0.size ?? 0) }
    }

    public func blob(_ sha: String) async throws -> Data {
        var request = request(repoPath("git", "blobs", sha))
        request.setValue("application/vnd.github.raw+json", forHTTPHeaderField: "Accept")
        return try await send(request)
    }

    public func createFile(path: String, content: Data, message: String) async throws {
        struct Body: Encodable {
            let message: String
            let content: String
            let branch: String
        }
        var request = request(contentsPath(path), method: "PUT")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(
            Body(message: message, content: content.base64EncodedString(), branch: repository.branch)
        )
        do {
            _ = try await send(request)
        } catch RemoteError.http(status: 422, _) {
            throw RemoteError.alreadyExists
        }
    }

    public func fileBlobSHA(path: String) async throws -> String? {
        struct File: Decodable { let sha: String }
        do {
            let file: File = try await getJSON(contentsPath(path), query: [URLQueryItem(name: "ref", value: repository.branch)])
            return file.sha
        } catch RemoteError.notFound {
            return nil
        }
    }

    private func contentsPath(_ path: String) -> [String] {
        ["repos", repository.owner, repository.name, "contents"] + path.split(separator: "/").map(String.init)
    }

    // MARK: - HTTP

    func repoPath(_ components: String...) -> [String] {
        ["repos", repository.owner, repository.name] + components
    }

    func request(_ path: [String], query: [URLQueryItem] = [], method: String = "GET") -> URLRequest {
        var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)!
        // Encode each segment so branch names like `feat/x` stay one segment.
        let prefix = components.percentEncodedPath.hasSuffix("/") ? String(components.percentEncodedPath.dropLast()) : components.percentEncodedPath
        components.percentEncodedPath = prefix + "/" + path.map(Self.encodeSegment).joined(separator: "/")
        components.queryItems = query.isEmpty ? nil : query
        var request = URLRequest(url: components.url!)
        request.httpMethod = method
        request.timeoutInterval = 30
        request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("2022-11-28", forHTTPHeaderField: "X-GitHub-Api-Version")
        return request
    }

    func getJSON<T: Decodable>(_ path: [String], query: [URLQueryItem] = []) async throws -> T {
        let data = try await send(request(path, query: query))
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw RemoteError.invalidResponse
        }
    }

    func send(_ request: URLRequest) async throws -> Data {
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw RemoteError.invalidResponse }
        if (200..<300).contains(http.statusCode) {
            return data
        }
        throw Self.error(status: http.statusCode, headers: http, body: data)
    }

    static func error(status: Int, headers: HTTPURLResponse, body: Data) -> RemoteError {
        let message = (try? JSONDecoder().decode([String: String?].self, from: body))?["message"] ?? nil
        let remaining = headers.value(forHTTPHeaderField: "x-ratelimit-remaining")
        switch status {
        case 401:
            return .unauthorized
        case 404:
            return .notFound
        case 403 where remaining == "0", 429:
            let reset = headers.value(forHTTPHeaderField: "x-ratelimit-reset")
                .flatMap(TimeInterval.init)
                .map(Date.init(timeIntervalSince1970:))
            return .rateLimited(resetAt: reset)
        default:
            return .http(status: status, message: message ?? HTTPURLResponse.localizedString(forStatusCode: status))
        }
    }

    static func encodeSegment(_ segment: String) -> String {
        var allowed = CharacterSet.urlPathAllowed
        allowed.remove("/")
        return segment.addingPercentEncoding(withAllowedCharacters: allowed) ?? segment
    }
}
