import CryptoKit
import Foundation

public enum WebBridgePolicy {
    public static func validPath(_ path: String, method: String) -> Bool {
        guard ["GET", "HEAD", "POST", "PUT", "DELETE"].contains(method),
              let url = URLComponents(string: path), url.scheme == nil, url.host == nil,
              url.fragment == nil, path.hasPrefix("/api/"), !path.contains("\\"), !path.contains("\u{0}")
        else { return false }
        var decoded = url.percentEncodedPath
        for _ in 0..<3 {
            let previous = decoded
            let next = decoded.removingPercentEncoding ?? decoded
            decoded = next
            let parts = decoded.split(separator: "/", omittingEmptySubsequences: false)
            guard parts.first == "", parts.dropFirst().allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." }) else { return false }
            if previous == decoded { break }
        }
        return decoded.hasPrefix("/api/") && !decoded.contains("\\") && !decoded.contains("\u{0}")
    }

    public static func canCache(path: String, method: String) -> Bool {
        if method == "GET" || method == "HEAD" {
            return path.hasPrefix("/api/files/") || path.hasPrefix("/api/blobs/")
        }
        guard method == "POST", path.hasPrefix("/api/rpc/") else { return false }
        let command = String(path.dropFirst("/api/rpc/".count))
        return ["list_fragments", "list_library_tree", "list_mind_maps", "list_csv_files", "list_diagram_documents",
                "list_markdown_dialect_migration", "read_property_registry", "read_graph_fragment", "read_mind_map",
                "read_csv_file", "read_dataset", "lockbox_snapshot"].contains(command)
    }
}

public struct WebCachedResponse: Codable, Sendable {
    public var status: Int
    public var headers: [String: String]
    public var body: Data

    public init(status: Int, headers: [String: String], body: Data) {
        self.status = status
        self.headers = headers
        self.body = body
    }
}

/// Account-scoped, successful read responses only. This never persists a WebKit cookie,
/// login password, device token, or a decrypted lockbox view.
public actor WebBridgeCache {
    private let root: URL

    public init(accountRoot: URL) { root = accountRoot.appending(path: "web-cache", directoryHint: .isDirectory) }

    public func read(path: String, method: String, body: Data) -> WebCachedResponse? {
        guard WebBridgePolicy.canCache(path: path, method: method),
              let data = try? Data(contentsOf: file(path: path, method: method, body: body))
        else { return nil }
        return try? JSONDecoder().decode(WebCachedResponse.self, from: data)
    }

    public func save(_ response: WebCachedResponse, path: String, method: String, body: Data) throws {
        guard (200..<300).contains(response.status), WebBridgePolicy.canCache(path: path, method: method) else { return }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try JSONEncoder().encode(response).write(to: file(path: path, method: method, body: body), options: .atomic)
    }

    public func removeAll() throws {
        if FileManager.default.fileExists(atPath: root.path) { try FileManager.default.removeItem(at: root) }
    }

    private func file(path: String, method: String, body: Data) -> URL {
        var data = Data("\(method)\n\(path)\n".utf8)
        data.append(body)
        let key = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        return root.appending(path: key + ".json")
    }
}

/// URLSession.AsyncBytes.lines drops empty lines. SSE must preserve them because they
/// terminate events; accumulate complete UTF-8 lines directly from the original bytes.
public struct WebSSEFramer: Sendable {
    private var buffer = Data()
    public init() {}

    public mutating func push(_ byte: UInt8) throws -> String? {
        guard buffer.count < 1_048_576 else { throw ServerError.invalidResponse }
        buffer.append(byte)
        guard byte == 10 else { return nil }
        let line = String(decoding: buffer, as: UTF8.self)
        buffer.removeAll(keepingCapacity: true)
        return line
    }

    public mutating func finish() -> String? {
        guard !buffer.isEmpty else { return nil }
        defer { buffer.removeAll(keepingCapacity: false) }
        return String(decoding: buffer, as: UTF8.self)
    }
}
