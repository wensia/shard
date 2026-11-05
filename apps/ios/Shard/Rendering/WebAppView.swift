import CryptoKit
import ShardKit
import SwiftUI
import WebKit

/// Hosts the website's actual app bundle. Native code owns credentials and I/O.
struct WebAppView: UIViewRepresentable {
    let model: AppModel
    let head: String?
    let pendingCount: Int
    let syncState: AppModel.SyncState
    var onLegacy: @MainActor () -> Void
    var onAppearance: @MainActor (String) -> Void

    static func identity(for model: AppModel) -> String {
        guard model.isConfigured, let account = model.serverAccount else { return "login" }
        return account.serverURL.absoluteString + "\n" + (account.storageEmail ?? account.email)
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(model: model, onLegacy: onLegacy, onAppearance: onAppearance)
    }

    func makeUIView(context: Context) -> WKWebView {
        let coordinator = context.coordinator
        let configuration = WKWebViewConfiguration()
        // A separate persistent store keeps each account's drafts and preferences
        // without making a previous account's localStorage available after logout.
        configuration.websiteDataStore = WKWebsiteDataStore(forIdentifier: Self.storeID(Self.identity(for: model)))
        configuration.setURLSchemeHandler(coordinator.schemeHandler, forURLScheme: ShardSchemeHandler.scheme)
        configuration.userContentController.addScriptMessageHandler(
            ReplyHandler(coordinator), contentWorld: .page, name: Coordinator.messageName
        )
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.isOpaque = false
        view.backgroundColor = UIColor(named: "Canvas")
        view.scrollView.backgroundColor = .clear
        view.scrollView.contentInsetAdjustmentBehavior = .never
        view.scrollView.bounces = false // the shared app owns its inner viewports
        view.navigationDelegate = coordinator
        #if DEBUG
        view.isInspectable = true
        #endif
        coordinator.webView = view
        coordinator.connectScheme()
        view.load(URLRequest(url: ShardSchemeHandler.rendererIndexURL))
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {
        context.coordinator.onLegacy = onLegacy
        context.coordinator.onAppearance = onAppearance
        context.coordinator.update(head: head, pending: pendingCount, sync: syncState)
    }

    static func dismantleUIView(_ view: WKWebView, coordinator: Coordinator) {
        coordinator.invalidate()
        view.configuration.userContentController.removeScriptMessageHandler(forName: Coordinator.messageName, contentWorld: .page)
        view.navigationDelegate = nil
        view.stopLoading()
    }

    private static func storeID(_ identity: String) -> UUID {
        let hex = SHA256.hash(data: Data(identity.utf8)).prefix(16).map { String(format: "%02x", $0) }.joined()
        let groups = [8, 4, 4, 4, 12]
        var index = hex.startIndex
        let value = groups.map { length -> String in
            let end = hex.index(index, offsetBy: length)
            defer { index = end }
            return String(hex[index..<end])
        }.joined(separator: "-")
        return UUID(uuidString: value)!
    }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate {
        static let messageName = "shardApp"
        let schemeHandler = ShardSchemeHandler(resourceFolder: "WebApp")
        let model: AppModel
        weak var webView: WKWebView?
        var onLegacy: @MainActor () -> Void
        var onAppearance: @MainActor (String) -> Void
        private var session: WebBridgeSession!
        private var generation = UUID()
        private var active = true
        private var operations: [UUID: Task<Void, Never>] = [:]
        private var lastHead: String?
        private var lastPending: Int?
        private var lastSync: AppModel.SyncState?

        init(model: AppModel, onLegacy: @escaping @MainActor () -> Void,
             onAppearance: @escaping @MainActor (String) -> Void) {
            self.model = model
            self.onLegacy = onLegacy
            self.onAppearance = onAppearance
            super.init()
            session = makeSession()
        }

        private func makeSession() -> WebBridgeSession {
            WebBridgeSession(model: model) { [weak self] event in self?.emit(event) }
        }

        func connectScheme() {
            let session = session!
            schemeHandler.loadAPI = { request in
                let message = await Task.detached {
                    let headers = request.allHTTPHeaderFields?.filter {
                        ["accept", "range", "if-none-match", "if-modified-since"].contains($0.key.lowercased())
                    }
                    return WebBridgeMessage(type: "request", path: Self.apiPath(request.url),
                                     method: request.httpMethod ?? "GET", headers: headers,
                                     bodyBase64: request.httpBody?.base64EncodedString())
                }.value
                return await session.handle(message)
            }
        }

        private nonisolated static func apiPath(_ url: URL?) -> String? {
            guard let url, url.scheme == "shard", url.host == "app" else { return nil }
            return url.path(percentEncoded: true) + (url.query(percentEncoded: true).map { "?" + $0 } ?? "")
        }

        func receive(_ message: WKScriptMessage,
                     reply: @escaping @MainActor @Sendable (Any?, String?) -> Void) {
            guard active, message.frameInfo.isMainFrame,
                  let source = message.frameInfo.request.url,
                  source.scheme == "shard", source.host == "app",
                  let body = message.body as? [String: Any], let type = body["type"] as? String,
                  ["bootstrap", "request", "stream", "cancel", "share", "legacy", "sync", "appearance"].contains(type)
            else { reply(nil, "原生通道拒绝了这个请求。"); return }
            let request = WebBridgeMessage(
                type: type, id: body["id"] as? String, path: body["path"] as? String,
                method: body["method"] as? String, headers: body["headers"] as? [String: String],
                bodyBase64: body["bodyBase64"] as? String, fileName: body["fileName"] as? String
            )
            if type == "legacy" {
                onLegacy()
                reply(["status": 200, "headers": ["content-type": "application/json"], "bodyBase64": "e30="], nil)
                return
            }
            let page = generation
            let key = UUID()
            let session = session!
            operations[key] = Task { @MainActor [weak self] in
                let response: WebBridgeResponse
                if request.type == "appearance" {
                    let mode = await Task.detached { () -> String? in
                        guard let encoded = request.bodyBase64, encoded.utf8.count <= 512,
                              let data = Data(base64Encoded: encoded),
                              let value = (try? JSONSerialization.jsonObject(with: data)) as? [String: String],
                              let mode = value["mode"], ["system", "light", "dark"].contains(mode) else { return nil }
                        return mode
                    }.value
                    guard let self, self.active, self.generation == page, let mode else {
                        self?.operations.removeValue(forKey: key)
                        reply(nil, "外观设置无效。")
                        return
                    }
                    self.onAppearance(mode)
                    response = .json([:])
                } else if request.type == "share" {
                    response = await self?.share(request) ?? .error("CANCELLED", "操作已取消。", status: 499)
                } else {
                    response = await session.handle(request)
                }
                let encoded = await Task.detached { response.body.base64EncodedString() }.value
                guard let self, self.active, page == self.generation, !Task.isCancelled else {
                    reply(nil, "操作已取消。")
                    return
                }
                self.operations.removeValue(forKey: key)
                reply(["status": response.status, "headers": response.headers, "bodyBase64": encoded], nil)
            }
        }

        func update(head: String?, pending: Int, sync: AppModel.SyncState) {
            if let lastPending, lastHead != head || lastPending != pending {
                emit(WebBridgeEvent(type: "vault-changed"))
            }
            if lastSync != sync { emit(WebBridgeEvent(type: "state-changed")) }
            lastHead = head
            lastPending = pending
            lastSync = sync
        }

        private func emit(_ event: WebBridgeEvent) {
            guard active, let webView else { return }
            let page = generation
            Task { @MainActor [weak self, weak webView] in
                let json = await Task.detached { () -> String? in
                    guard let data = try? JSONEncoder().encode(event) else { return nil }
                    return String(data: data, encoding: .utf8)
                }.value
                guard self?.active == true, self?.generation == page, let webView, let json else { return }
                _ = try? await webView.callAsyncJavaScript(
                    "window.dispatchEvent(new CustomEvent('shard:ios-event',{detail:JSON.parse(eventJSON)}))",
                    arguments: ["eventJSON": json], in: nil, contentWorld: .page
                )
            }
        }

        func invalidate() {
            active = false
            generation = UUID()
            operations.values.forEach { $0.cancel() }
            operations.removeAll()
            let session = session!
            Task { await session.stop() }
        }

        func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
            generation = UUID()
            operations.values.forEach { $0.cancel() }
            operations.removeAll()
        }

        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
            guard let url = action.request.url else { return .cancel }
            if url.scheme == "shard", url.host == "app" {
                if url.path.hasPrefix("/api/") {
                    let response = await session.handle(WebBridgeMessage(type: "request", path: Self.apiPath(url), method: "GET"))
                    if (200..<300).contains(response.status) {
                        let filename = Self.downloadName(response.headers) ?? url.lastPathComponent
                        let encoded = await Task.detached { response.body.base64EncodedString() }.value
                        _ = await share(WebBridgeMessage(type: "share", bodyBase64: encoded, fileName: filename))
                    } else { presentError("暂时无法下载，请稍后重试。") }
                    return .cancel
                }
                return .allow
            }
            if action.navigationType == .linkActivated,
               let scheme = url.scheme?.lowercased(), ["https", "http", "mailto"].contains(scheme) {
                await UIApplication.shared.open(url)
            }
            return .cancel
        }

        private static func downloadName(_ headers: [String: String]) -> String? {
            let value = headers.first { $0.key.lowercased() == "content-disposition" }?.value
            return value?.split(separator: ";").map { $0.trimmingCharacters(in: .whitespaces) }
                .first { $0.hasPrefix("filename=") }.map { String($0.dropFirst(9)).trimmingCharacters(in: CharacterSet(charactersIn: "\"")) }
        }

        private func share(_ request: WebBridgeMessage) async -> WebBridgeResponse {
            let page = generation
            let file = await Task.detached { () -> URL? in
                guard let encoded = request.bodyBase64, encoded.utf8.count <= 96 * 1024 * 1024,
                      let bytes = Data(base64Encoded: encoded) else { return nil }
                let requested = (request.fileName ?? "Shard.txt") as NSString
                let name = requested.lastPathComponent
                guard !name.isEmpty, name != ".", name != "..", !name.contains("\\") else { return nil }
                let folder = FileManager.default.temporaryDirectory.appending(path: "shard-share-" + UUID().uuidString)
                do {
                    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
                    let file = folder.appending(path: name)
                    try bytes.write(to: file, options: [.atomic, .completeFileProtectionUnlessOpen])
                    return file
                } catch { return nil }
            }.value
            guard let file, active, generation == page, !Task.isCancelled,
                  let presenter = presenter(), !(presenter is UIActivityViewController) else {
                if let file { await Task.detached { try? FileManager.default.removeItem(at: file.deletingLastPathComponent()) }.value }
                return .error("SHARE_FAILED", "暂时无法分享文件。", status: 400)
            }
            let sheet = UIActivityViewController(activityItems: [file], applicationActivities: nil)
            sheet.popoverPresentationController?.sourceView = presenter.view
            sheet.popoverPresentationController?.sourceRect = CGRect(x: presenter.view.bounds.midX, y: presenter.view.bounds.midY, width: 1, height: 1)
            sheet.completionWithItemsHandler = { _, _, _, _ in
                Task.detached { try? FileManager.default.removeItem(at: file.deletingLastPathComponent()) }
            }
            presenter.present(sheet, animated: true)
            return .json([:])
        }

        private func presenter() -> UIViewController? {
            var controller = webView?.window?.rootViewController
            while let next = controller?.presentedViewController { controller = next }
            return controller
        }

        private func presentError(_ message: String) {
            let alert = UIAlertController(title: "无法下载", message: message, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "确定", style: .default))
            presenter()?.present(alert, animated: true)
        }

        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            let previous = session!
            session = makeSession()
            connectScheme()
            Task { await previous.stop() }
            webView.reload()
        }
    }
}

@MainActor
private final class ReplyHandler: NSObject, WKScriptMessageHandlerWithReply {
    weak var coordinator: WebAppView.Coordinator?

    init(_ coordinator: WebAppView.Coordinator) { self.coordinator = coordinator }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping @MainActor @Sendable (Any?, String?) -> Void) {
        guard let coordinator else { replyHandler(nil, "操作已取消。"); return }
        coordinator.receive(message, reply: replyHandler)
    }
}
