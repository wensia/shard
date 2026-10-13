import SwiftUI
import WebKit

/// What the renderer page shows: a fragment (`MarkdownContent`) or a document
/// (`MarkdownDocument`). Mirrors `RenderPayload` in apps/ios/renderer/src/main.tsx.
struct RenderPayload: Encodable, Equatable {
    enum Kind: String, Encodable {
        case fragment
        case document
    }

    var kind: Kind
    var content: String
}

/// Renders Markdown with the desktop's `@shard/markdown` components inside WKWebView.
struct MarkdownWebView: UIViewRepresentable {
    var payload: RenderPayload
    var loadVaultFile: (@MainActor (String) async throws -> Data)?

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeUIView(context: Context) -> WKWebView {
        let coordinator = context.coordinator
        coordinator.schemeHandler.loadVaultFile = loadVaultFile

        let configuration = WKWebViewConfiguration()
        configuration.setURLSchemeHandler(coordinator.schemeHandler, forURLScheme: ShardSchemeHandler.scheme)
        configuration.userContentController.add(WeakMessageHandler(coordinator), name: Coordinator.messageName)

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.backgroundColor = .clear
        webView.navigationDelegate = coordinator
        #if DEBUG
        webView.isInspectable = true
        #endif

        coordinator.webView = webView
        coordinator.render(payload)
        webView.load(URLRequest(url: ShardSchemeHandler.rendererIndexURL))
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        context.coordinator.schemeHandler.loadVaultFile = loadVaultFile
        context.coordinator.render(payload)
    }

    static func dismantleUIView(_ webView: WKWebView, coordinator: Coordinator) {
        webView.configuration.userContentController.removeScriptMessageHandler(forName: Coordinator.messageName)
    }

    @MainActor
    final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
        static let messageName = "shard"

        let schemeHandler = ShardSchemeHandler()
        weak var webView: WKWebView?
        private var pending: RenderPayload?
        private var shown: RenderPayload?
        private var isReady = false

        func render(_ payload: RenderPayload) {
            pending = payload
            flush()
        }

        private func flush() {
            guard isReady, let webView, let payload = pending, payload != shown,
                  let data = try? JSONEncoder().encode(payload),
                  let json = String(data: data, encoding: .utf8)
            else { return }
            shown = payload
            webView.evaluateJavaScript("window.shardRender(\(json))")
        }

        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
            switch type {
            case "ready":
                // A reload (e.g. after the web process was reclaimed) starts empty again.
                isReady = true
                shown = nil
                flush()
            case "error":
                print("renderer error:", body["message"] ?? "")
            default:
                break
            }
        }

        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
            guard let url = action.request.url else { return .cancel }
            if url.scheme == ShardSchemeHandler.scheme { return .allow }
            if action.navigationType == .linkActivated,
               let scheme = url.scheme?.lowercased(), ["http", "https", "mailto"].contains(scheme) {
                await UIApplication.shared.open(url)
            }
            return .cancel
        }

        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            isReady = false
            webView.reload()
        }
    }
}

/// WKUserContentController retains its handlers; this breaks the cycle with the coordinator.
@MainActor
private final class WeakMessageHandler: NSObject, WKScriptMessageHandler {
    weak var target: (any WKScriptMessageHandler)?

    init(_ target: any WKScriptMessageHandler) {
        self.target = target
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(controller, didReceive: message)
    }
}
