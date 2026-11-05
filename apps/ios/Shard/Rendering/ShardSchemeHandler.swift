import UniformTypeIdentifiers
import WebKit

/// Serves the bundled renderer (`shard://app/…`) and vault files (`shard://vault/…`)
/// to WKWebView. A custom scheme keeps the page same-origin, so the ES module
/// bundle and the Markdown parse worker load the way they do under Vite.
@MainActor
final class ShardSchemeHandler: NSObject, WKURLSchemeHandler {
    static let scheme = "shard"
    static let rendererIndexURL = URL(string: "shard://app/index.html")!

    /// Loads a vault-relative file such as `assets/52/<sha>.png`.
    var loadVaultFile: (@MainActor (String) async throws -> Data)?
    /// GET/HEAD resources requested by the shared app, such as authenticated images.
    var loadAPI: (@Sendable (URLRequest) async -> WebBridgeResponse)?

    private var activeTasks = Set<ObjectIdentifier>()
    private var operations: [ObjectIdentifier: Task<Void, Never>] = [:]
    private let rendererRoot: URL?

    init(resourceFolder: String = "Renderer") {
        rendererRoot = Bundle.main.resourceURL?.appending(path: resourceFolder, directoryHint: .isDirectory)
        super.init()
    }

    func webView(_ webView: WKWebView, start task: any WKURLSchemeTask) {
        let id = ObjectIdentifier(task)
        activeTasks.insert(id)
        guard let url = task.request.url, let host = url.host() else {
            finish(task, id: id, result: .failure(SchemeError.badRequest))
            return
        }
        let path = String(url.path(percentEncoded: false).drop(while: { $0 == "/" }))

        switch host {
        case "app":
            if path.hasPrefix("api/") {
                guard let loadAPI else {
                    finish(task, id: id, result: .failure(SchemeError.notFound))
                    return
                }
                let request = task.request
                operations[id] = Task { @MainActor [weak self] in
                    let response = await loadAPI(request)
                    guard !Task.isCancelled else { return }
                    self?.finish(task, id: id, response: response)
                }
            } else {
                let root = rendererRoot
                let resourcePath = path.isEmpty ? "index.html" : path
                operations[id] = Task { @MainActor [weak self] in
                    let result = await Task.detached(priority: .userInitiated) {
                        Self.readRendererFile(resourcePath, root: root)
                    }.value
                    guard !Task.isCancelled else { return }
                    self?.finish(task, id: id, result: result)
                }
            }
        case "vault":
            guard let loadVaultFile else {
                finish(task, id: id, result: .failure(SchemeError.notFound))
                return
            }
            operations[id] = Task { @MainActor [weak self] in
                do {
                    let data = try await loadVaultFile(path)
                    guard !Task.isCancelled else { return }
                    self?.finish(task, id: id, result: .success(data))
                } catch {
                    guard !Task.isCancelled else { return }
                    self?.finish(task, id: id, result: .failure(error))
                }
            }
        default:
            finish(task, id: id, result: .failure(SchemeError.notFound))
        }
    }

    func webView(_ webView: WKWebView, stop task: any WKURLSchemeTask) {
        let id = ObjectIdentifier(task)
        activeTasks.remove(id)
        operations.removeValue(forKey: id)?.cancel()
    }

    private nonisolated static func readRendererFile(_ path: String, root: URL?) -> Result<Data, Error> {
        guard let root else { return .failure(SchemeError.notFound) }
        let file = root.appending(path: path).standardizedFileURL
        // Refuse `..` escapes out of the renderer folder.
        guard !path.contains("\\"), file.path.hasPrefix(root.standardizedFileURL.path + "/") else {
            return .failure(SchemeError.badRequest)
        }
        return Result { try Data(contentsOf: file) }
    }

    /// WebKit raises if a stopped task is answered, so every reply checks it is still active.
    private func finish(_ task: any WKURLSchemeTask, id: ObjectIdentifier, result: Result<Data, Error>) {
        guard activeTasks.remove(id) != nil, let url = task.request.url else { return }
        operations.removeValue(forKey: id)
        switch result {
        case .success(let data):
            let response = HTTPURLResponse(
                url: url,
                statusCode: 200,
                httpVersion: "HTTP/1.1",
                headerFields: [
                    "Content-Type": Self.mimeType(for: url.pathExtension),
                    "Content-Length": String(data.count),
                    "Cache-Control": "no-cache",
                ]
            )!
            task.didReceive(response)
            task.didReceive(data)
            task.didFinish()
        case .failure(let error):
            task.didFailWithError(error)
        }
    }

    private func finish(_ task: any WKURLSchemeTask, id: ObjectIdentifier, response: WebBridgeResponse) {
        guard activeTasks.remove(id) != nil, let url = task.request.url else { return }
        operations.removeValue(forKey: id)
        // Account-scoped native storage owns offline files. WebKit must not retain
        // an independent, unpurgeable plaintext copy after a privacy operation.
        var headers = response.headers.filter { $0.key.lowercased() != "cache-control" }
        headers["Cache-Control"] = "no-store"
        guard let header = HTTPURLResponse(url: url, statusCode: response.status,
                                           httpVersion: "HTTP/1.1", headerFields: headers) else {
            task.didFailWithError(SchemeError.badRequest)
            return
        }
        task.didReceive(header)
        if task.request.httpMethod != "HEAD" { task.didReceive(response.body) }
        task.didFinish()
    }

    private static func mimeType(for pathExtension: String) -> String {
        switch pathExtension.lowercased() {
        case "html": "text/html; charset=utf-8"
        case "js", "mjs": "text/javascript; charset=utf-8"
        case "css": "text/css; charset=utf-8"
        case "json": "application/json"
        case "wasm": "application/wasm"
        case "woff2": "font/woff2"
        case "svg": "image/svg+xml"
        default: UTType(filenameExtension: pathExtension)?.preferredMIMEType ?? "application/octet-stream"
        }
    }

    enum SchemeError: Error {
        case badRequest
        case notFound
    }
}
