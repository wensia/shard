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

    private var activeTasks = Set<ObjectIdentifier>()
    private let rendererRoot = Bundle.main.url(forResource: "Renderer", withExtension: nil)

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
            finish(task, id: id, result: readRendererFile(path))
        case "vault":
            guard let loadVaultFile else {
                finish(task, id: id, result: .failure(SchemeError.notFound))
                return
            }
            Task { @MainActor in
                do {
                    let data = try await loadVaultFile(path)
                    finish(task, id: id, result: .success(data))
                } catch {
                    finish(task, id: id, result: .failure(error))
                }
            }
        default:
            finish(task, id: id, result: .failure(SchemeError.notFound))
        }
    }

    func webView(_ webView: WKWebView, stop task: any WKURLSchemeTask) {
        activeTasks.remove(ObjectIdentifier(task))
    }

    private func readRendererFile(_ path: String) -> Result<Data, Error> {
        guard let rendererRoot else { return .failure(SchemeError.notFound) }
        let file = rendererRoot.appending(path: path).standardizedFileURL
        // Refuse `..` escapes out of the renderer folder.
        guard file.path.hasPrefix(rendererRoot.standardizedFileURL.path + "/") else {
            return .failure(SchemeError.badRequest)
        }
        return Result { try Data(contentsOf: file) }
    }

    /// WebKit raises if a stopped task is answered, so every reply checks it is still active.
    private func finish(_ task: any WKURLSchemeTask, id: ObjectIdentifier, result: Result<Data, Error>) {
        guard activeTasks.remove(id) != nil, let url = task.request.url else { return }
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

    private static func mimeType(for pathExtension: String) -> String {
        switch pathExtension.lowercased() {
        case "html": "text/html; charset=utf-8"
        case "js", "mjs": "text/javascript; charset=utf-8"
        case "css": "text/css; charset=utf-8"
        case "json": "application/json"
        case "svg": "image/svg+xml"
        default: UTType(filenameExtension: pathExtension)?.preferredMIMEType ?? "application/octet-stream"
        }
    }

    enum SchemeError: Error {
        case badRequest
        case notFound
    }
}
