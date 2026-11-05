import Foundation
import CryptoKit
import ShardKit

struct WebBridgeMessage: Codable, Sendable {
    var type: String
    var id: String?
    var path: String?
    var method: String?
    var headers: [String: String]?
    var bodyBase64: String?
    var fileName: String?

    init(type: String, id: String? = nil, path: String? = nil, method: String? = nil,
         headers: [String: String]? = nil, bodyBase64: String? = nil, fileName: String? = nil) {
        self.type = type
        self.id = id
        self.path = path
        self.method = method
        self.headers = headers
        self.bodyBase64 = bodyBase64
        self.fileName = fileName
    }
}

struct WebBridgeResponse: Sendable {
    var status: Int
    var headers: [String: String]
    var body: Data

    static func json(_ value: Any, status: Int = 200) -> Self {
        Self(status: status, headers: ["content-type": "application/json"],
             body: (try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])) ?? Data("{}".utf8))
    }

    static func error(_ code: String, _ message: String, status: Int) -> Self {
        .json(["code": code, "message": message], status: status)
    }
}

struct WebBridgeEvent: Codable, Sendable {
    var type: String
    var id: String?
    var chunk: String?
    var done: Bool?
    var error: String?

    init(type: String, id: String? = nil, chunk: String? = nil, done: Bool? = nil, error: String? = nil) {
        self.type = type
        self.id = id
        self.chunk = chunk
        self.done = done
        self.error = error
    }
}

actor WebBridgeSession {
    private let model: AppModel
    private let onEvent: @MainActor @Sendable (WebBridgeEvent) -> Void
    private var network = WebBridgeSession.makeNetwork()
    private var scope: UUID?
    private var caches: [String: WebBridgeCache] = [:]
    private var cookieReady = false
    private var cookiePaths = Set<String>()
    private var offline = false
    private var stopped = false
    private var streams: [String: Task<Void, Never>] = [:]
    private var streamRequests: [String: URLSessionTask] = [:]
    private var requests: [String: Task<WebBridgeResponse, Never>] = [:]
    private var dataRevision = 0
    private var erasingPublic = false
    private static let defaultServer = "https://shard.askfish.net"
    private static let maximumBody = 64 * 1024 * 1024

    init(model: AppModel, onEvent: @escaping @MainActor @Sendable (WebBridgeEvent) -> Void) {
        self.model = model
        self.onEvent = onEvent
    }

    func handle(_ message: WebBridgeMessage) async -> WebBridgeResponse {
        guard !stopped else { return .error("CANCELLED", "请求已取消。", status: 499) }
        let context = await model.webBridgeContext()
        if erasingPublic, message.type != "cancel" && message.type != "bootstrap" {
            return .error("CACHE_UPDATING", "正在更新，请稍后重试。", status: 503)
        }
        if !erasingPublic { configure(context) }
        switch message.type {
        case "bootstrap": return await bootstrap(context)
        case "cancel":
            if let id = message.id {
                requests.removeValue(forKey: id)?.cancel()
                streams.removeValue(forKey: id)?.cancel()
                streamRequests.removeValue(forKey: id)?.cancel()
            }
            return .json(["ok": true])
        case "sync":
            await model.sync()
            guard await model.webBridgeAccepts(context) else { return changedAccount() }
            await changed()
            return await bootstrap(await model.webBridgeContext())
        case "request", "stream":
            guard let path = message.path else { return invalidRequest() }
            let method = (message.method ?? "GET").uppercased()
            guard WebBridgePolicy.validPath(path, method: method),
                  (message.bodyBase64?.utf8.count ?? 0) <= Self.maximumBody * 4 / 3 + 8,
                  let body = message.bodyBase64.map({ Data(base64Encoded: $0) }) ?? Data()
            else { return invalidRequest() }
            if message.type == "stream", method != "GET" || path != "/api/events" || message.id == nil { return invalidRequest() }
            let id = message.id ?? UUID().uuidString
            if let existing = requests[id] { return await existing.value }
            let operation = Task {
                if message.type == "stream" { return await self.openStream(id: id, context: context, headers: message.headers ?? [:]) }
                return await self.request(path: path, method: method, headers: message.headers ?? [:], body: body, context: context, requestID: id)
            }
            requests[id] = operation
            let response = await withTaskCancellationHandler {
                await operation.value
            } onCancel: { operation.cancel() }
            requests.removeValue(forKey: id)
            return operation.isCancelled ? cancelled() : response
        default: return invalidRequest()
        }
    }

    func stop() async {
        stopped = true
        streams.values.forEach { $0.cancel() }
        streams.removeAll()
        streamRequests.values.forEach { $0.cancel() }
        streamRequests.removeAll()
        requests.values.forEach { $0.cancel() }
        requests.removeAll()
        network.invalidateAndCancel()
    }

    private static func makeNetwork() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 30
        configuration.timeoutIntervalForResource = 3600
        configuration.httpShouldSetCookies = true
        configuration.httpCookieAcceptPolicy = .always
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: configuration)
    }

    private func configure(_ context: WebBridgeContext, preservingRequest: String? = nil, preservingCookies: Bool = false) {
        guard scope != context.revision else { return }
        let cookies = preservingCookies ? network.configuration.httpCookieStorage?.cookies ?? [] : []
        let hadBrowserSession = cookieReady
        for id in streams.keys {
            Task { await onEvent(WebBridgeEvent(type: "stream", id: id, done: true, error: "连接已更新。")) }
        }
        streams.values.forEach { $0.cancel() }
        streams.removeAll()
        streamRequests.values.forEach { $0.cancel() }
        streamRequests.removeAll()
        for (id, request) in requests where id != preservingRequest { request.cancel() }
        requests = requests.filter { $0.key == preservingRequest }
        network.invalidateAndCancel()
        network = Self.makeNetwork()
        for cookie in cookies { network.configuration.httpCookieStorage?.setCookie(cookie) }
        scope = context.revision
        cookieReady = preservingCookies && hadBrowserSession
        if !preservingCookies { cookiePaths.removeAll() }
        offline = false
    }

    private func bootstrap(_ context: WebBridgeContext) async -> WebBridgeResponse {
        .json([
            "serverURL": selectedServer(context),
            "email": context.account?.email as Any? ?? NSNull(),
            "authenticated": context.authenticated,
            "sync": ["state": offline ? "offline" : context.syncState, "pending": context.pendingCount],
            "legacyAvailable": true,
            "legacyOffline": await model.webRequiresLegacyOffline,
            "storageEmail": context.account?.storageEmail as Any? ?? NSNull(),
        ])
    }

    private func request(path: String, method: String, headers: [String: String], body: Data,
                         context: WebBridgeContext, requestID: String) async -> WebBridgeResponse {
        guard !Task.isCancelled else { return cancelled() }
        if path == "/api/auth/login", method == "POST" { return await login(body, context: context, requestID: requestID) }
        if path == "/api/auth/logout", method == "POST" {
            if context.authenticated, cookieReady {
                _ = try? await perform(path, method: method, headers: [:], body: body, context: context, cookies: true)
            }
            await model.signOutServer()
            configure(await model.webBridgeContext(), preservingRequest: requestID)
            await onEvent(WebBridgeEvent(type: "state-changed"))
            return .json(["ok": true])
        }
        guard context.authenticated else {
            if path == "/api/auth/state" { return authState(context, authenticated: false) }
            return .error("UNAUTHENTICATED", "请先登录。", status: 401)
        }
        do { try await context.store?.recoverPublicErasure() }
        catch { return .error("CACHE_UNAVAILABLE", "本机缓存暂不可用，请重试。", status: 503) }
        if path == "/api/auth/stepup", method == "POST" { return await stepUp(body, context: context) }
        if path == "/api/auth/state" { return await currentAuthState(context, requestID: requestID) }
        let usesCookie = needsBrowserSession(path) || cookiePaths.contains(path)
        if usesCookie, !cookieReady {
            return .error("SESSION_REQUIRED", "请确认登录密码。", status: 403)
        }
        if usesCookie, let failure = await verifyDevice(context) { return failure }
        if path == "/api/rpc/create_fragment", method == "POST" {
            return await capture(body: body, headers: headers, context: context)
        }
        if method == "GET", header("range", in: headers) == nil, path.hasPrefix("/api/files/"), let store = context.store {
            let filePath = String(path.dropFirst("/api/files/".count)).removingPercentEncoding ?? ""
            if VaultPaths.isSyncedDocument(filePath), let saved = try? await store.cachedFile(filePath) {
                guard !Task.isCancelled, await model.webBridgeAccepts(context) else { return changedAccount() }
                return WebBridgeResponse(status: 200, headers: ["content-type": "text/markdown; charset=utf-8"], body: saved.data)
            }
            if VaultPaths.isAsset(filePath), let saved = try? await store.cachedFile(filePath) {
                guard !Task.isCancelled, await model.webBridgeAccepts(context) else { return changedAccount() }
                return WebBridgeResponse(status: 200, headers: ["content-type": mimeType(filePath)], body: saved.data)
            }
        }
        do {
            var trashTree: Data?
            if path == "/api/rpc/purge_from_trash" || path == "/api/rpc/empty_trash" {
                // Resolve the actual trash leaves before deleting them. A trash folder's
                // path can also contain unrelated active files and queued captures.
                let tree = try await perform("/api/rpc/list_library_tree", method: "POST", headers: ["content-type": "application/json"],
                                             body: Data("{}".utf8), context: context, cookies: false)
                guard !Task.isCancelled, await accepts(context) else { return cancelled() }
                guard (200..<300).contains(tree.status) else {
                    if tree.status == 401 { await model.webBridgeExpire(context) }
                    return tree
                }
                trashTree = tree.body
            }
            let erasure = await erasureTargets(path: path, args: body, context: context, trashTree: trashTree)
            let readRevision = dataRevision
            var response = try await perform(path, method: method, headers: headers, body: body, context: context, cookies: usesCookie)
            guard !Task.isCancelled else { return cancelled() }
            guard await model.webBridgeAccepts(context), !stopped else { return changedAccount() }
            if response.status == 401, usesCookie {
                cookieReady = false
                return .error("SESSION_REQUIRED", "请确认登录密码。", status: 403)
            }
            guard await model.webBridgeAccepts(context), !stopped else { return changedAccount() }
            if response.status == 401 {
                await model.webBridgeExpire(context)
                return response
            }
            if response.status == 403,
               let error = (try? JSONSerialization.jsonObject(with: response.body)) as? [String: Any],
               error["code"] as? String == "SESSION_REQUIRED" { cookiePaths.insert(path) }
            if [502, 503, 504].contains(response.status), header("range", in: headers) == nil,
               let cached = await offlineResponse(path: path, method: method, body: body, context: context) { return cached }
            if (200..<300).contains(response.status) {
                await setOffline(false)
                var persisted = false
                if header("range", in: headers) == nil, readRevision == dataRevision {
                    do {
                        try await contextCache(context)?.save(WebCachedResponse(status: response.status, headers: response.headers, body: response.body),
                                                             path: path, method: method, body: body)
                        persisted = context.account != nil
                    } catch {}
                }
                if path == "/api/rpc/list_fragments" {
                    if persisted { await observeSnapshot(response, context: context) }
                    await model.webBridgeLegacyOffline(false)
                    response = await overlayPending(response, context: context)
                }
                if path == "/api/auth/account", method == "POST",
                   let fields = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any],
                   let requestedEmail = fields["email"] as? String {
                    // Prefer the server's normalized current owner identity after the write.
                    let state = try? await perform("/api/auth/state", method: "GET", headers: [:], body: Data(), context: context, cookies: true)
                    let stateJSON = state.flatMap { try? JSONSerialization.jsonObject(with: $0.body) as? [String: Any] }
                    let email = stateJSON?["email"] as? String ?? requestedEmail
                    let next = try await model.webBridgeAccountEmail(email, context: context)
                    configure(next, preservingRequest: requestID, preservingCookies: true)
                    await changed()
                    return response
                }
                if isWrite(path, method: method) {
                    dataRevision += 1
                    if let targets = erasure {
                        return await erasePublicAfterWrite(response, ids: targets.ids, paths: targets.paths,
                                                          context: context, requestID: requestID)
                    }
                    do { try await cacheMutation(response, args: body, context: context) }
                    catch { return .error("CACHE_WRITE_FAILED", "已保存到服务器，本机离线缓存保存失败。", status: 507) }
                    Task { await self.refreshModel(context) }
                }
            }
            guard !Task.isCancelled, await model.webBridgeAccepts(context) else { return changedAccount() }
            return response
        } catch {
            guard !Task.isCancelled else { return cancelled() }
            guard await model.webBridgeAccepts(context), !stopped else { return changedAccount() }
            if header("range", in: headers) == nil,
               let cached = await offlineResponse(path: path, method: method, body: body, context: context) { return cached }
            return .error("NETWORK", "连不上服务器，请检查网络后重试。", status: 503)
        }
    }

    private func login(_ body: Data, context: WebBridgeContext, requestID: String) async -> WebBridgeResponse {
        guard let fields = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any],
              let email = fields["email"] as? String, let password = fields["password"] as? String else { return invalidRequest() }
        let server = fields["server"] as? String ?? selectedServer(context)
        do {
            try await model.login(server: server, email: email, password: password, name: "Shard · iPhone")
            configure(await model.webBridgeContext(), preservingRequest: requestID)
            await model.webBridgeLegacyOffline(false)
            await changed()
            return .json(["ok": true])
        } catch ServerError.wrongCredentials {
            return .error("INVALID_CREDENTIALS", "邮箱或密码不正确。", status: 401)
        } catch {
            return .error("LOGIN_FAILED", await AppModel.describe(error), status: 400)
        }
    }

    private func stepUp(_ body: Data, context: WebBridgeContext) async -> WebBridgeResponse {
        guard let fields = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any],
              let password = fields["password"] as? String, let email = context.account?.email else { return invalidRequest() }
        do {
            if let failure = await verifyDevice(context) { return failure }
            if !cookieReady {
                let loginBody = try JSONSerialization.data(withJSONObject: ["email": email, "password": password])
                let reply = try await perform("/api/auth/login", method: "POST", headers: ["content-type": "application/json"], body: loginBody, context: context, cookies: true)
                guard await model.webBridgeAccepts(context), !stopped else { return changedAccount() }
                guard (200..<300).contains(reply.status) else { return reply }
                cookieReady = true
            }
            let reply = try await perform("/api/auth/stepup", method: "POST", headers: ["content-type": "application/json"], body: body, context: context, cookies: true)
            guard await model.webBridgeAccepts(context), !stopped else { return changedAccount() }
            if reply.status == 401 { cookieReady = false }
            return reply
        } catch { return .error("NETWORK", "连不上服务器，请稍后重试。", status: 503) }
    }

    private func capture(body: Data, headers: [String: String], context: WebBridgeContext) async -> WebBridgeResponse {
        guard let fields = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any],
              let content = fields["content"] as? String,
              let key = header("idempotency-key", in: headers), !key.isEmpty, key.utf8.count <= 256 else { return invalidRequest() }
        let tags = fields["tags"] as? [String]
        do {
            let document = try await model.webBridgeCapture(content: content, tags: tags, requestKey: key)
            guard await model.webBridgeAccepts(context), !stopped else { return changedAccount() }
            dataRevision += 1
            await changed()
            return .json(fragmentDTO(document))
        } catch RemoteError.conflict(_) {
            return .error("IDEMPOTENCY_CONFLICT", "请求内容与首次提交不一致。", status: 409)
        } catch VaultStore.StoreError.erasedCapture {
            return .error("IDEMPOTENCY_RETIRED", "此请求已完成，请重新操作。", status: 409)
        } catch {
            return .error("CREATE_FAILED", await AppModel.describe(error), status: 400)
        }
    }

    private func perform(_ path: String, method: String, headers: [String: String], body: Data,
                         context: WebBridgeContext, cookies: Bool) async throws -> WebBridgeResponse {
        let request = try makeRequest(path, method: method, headers: headers, body: body, context: context, cookies: cookies)
        let (data, result) = try await network.data(for: request, delegate: WebBridgeRejectRedirects())
        guard let result = result as? HTTPURLResponse else { throw ServerError.invalidResponse }
        return WebBridgeResponse(status: result.statusCode, headers: responseHeaders(result), body: data)
    }

    private func makeRequest(_ path: String, method: String, headers: [String: String], body: Data,
                             context: WebBridgeContext, cookies: Bool) throws -> URLRequest {
        guard WebBridgePolicy.validPath(path, method: method), let server = context.account?.serverURL,
              let incoming = URLComponents(string: path), var address = URLComponents(url: server, resolvingAgainstBaseURL: false)
        else { throw ServerError.invalidServer }
        address.percentEncodedPath = incoming.percentEncodedPath
        address.percentEncodedQuery = incoming.percentEncodedQuery
        guard let url = address.url else { throw ServerError.invalidServer }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.httpBody = body.isEmpty ? nil : body
        request.httpShouldHandleCookies = cookies
        request.setValue("1", forHTTPHeaderField: "x-shard-request")
        request.setValue(server.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")), forHTTPHeaderField: "Origin")
        request.setValue("same-origin", forHTTPHeaderField: "Sec-Fetch-Site")
        request.setValue("shard-ios-web/0.1", forHTTPHeaderField: "User-Agent")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue(String(TimeZone.current.secondsFromGMT() / 60), forHTTPHeaderField: "x-shard-utc-offset")
        if !cookies, let token = context.token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        for key in ["content-type", "accept", "idempotency-key", "last-event-id", "range", "x-shard-utc-offset"] {
            if let value = header(key, in: headers), !value.contains("\r"), !value.contains("\n") {
                request.setValue(value, forHTTPHeaderField: key)
            }
        }
        return request
    }

    private func openStream(id: String, context: WebBridgeContext, headers: [String: String]) async -> WebBridgeResponse {
        guard context.authenticated else { return .error("UNAUTHENTICATED", "请先登录。", status: 401) }
        streams.removeValue(forKey: id)?.cancel()
        streamRequests.removeValue(forKey: id)?.cancel()
        do {
            let request = try makeRequest("/api/events", method: "GET", headers: headers, body: Data(), context: context, cookies: false)
            let (bytes, result) = try await network.bytes(for: request, delegate: WebBridgeRejectRedirects())
            guard await model.webBridgeAccepts(context), !stopped, !Task.isCancelled else {
                bytes.task.cancel()
                return changedAccount()
            }
            guard let response = result as? HTTPURLResponse else { throw ServerError.invalidResponse }
            guard response.statusCode == 200 else {
                bytes.task.cancel()
                if response.statusCode == 401 { await model.webBridgeExpire(context) }
                await setOffline([502, 503, 504].contains(response.statusCode))
                return .error("STREAM_UNAVAILABLE", "实时连接暂时不可用。", status: response.statusCode)
            }
            await setOffline(false)
            streamRequests[id] = bytes.task
            streams[id] = Task {
                do {
                    var framer = WebSSEFramer()
                    for try await byte in bytes {
                        try Task.checkCancellation()
                        if let line = try framer.push(byte) {
                            guard await self.accepts(context) else { return }
                            await self.onEvent(WebBridgeEvent(type: "stream", id: id, chunk: line))
                        }
                    }
                    if let final = framer.finish(), await self.accepts(context) {
                        await self.onEvent(WebBridgeEvent(type: "stream", id: id, chunk: final))
                    }
                    await self.endStream(id, context: context, error: nil)
                } catch {
                    guard !Task.isCancelled else { return }
                    await self.endStream(id, context: context, error: "实时连接已断开。")
                }
            }
            Task { await self.refreshModel(context) }
            return WebBridgeResponse(status: 200, headers: ["content-type": "text/event-stream"], body: Data())
        } catch {
            guard !Task.isCancelled, await accepts(context) else { return cancelled() }
            await setOffline(true)
            return .error("NETWORK", "实时连接暂时不可用。", status: 503)
        }
    }

    private func endStream(_ id: String, context: WebBridgeContext, error: String?) async {
        guard await accepts(context) else { return }
        streams.removeValue(forKey: id)
        streamRequests.removeValue(forKey: id)?.cancel()
        await onEvent(WebBridgeEvent(type: "stream", id: id, done: true, error: error))
    }

    private func accepts(_ context: WebBridgeContext) async -> Bool {
        let current = await model.webBridgeAccepts(context)
        return !stopped && scope == context.revision && current
    }

    private func offlineResponse(path: String, method: String, body: Data, context: WebBridgeContext) async -> WebBridgeResponse? {
        guard !Task.isCancelled, await accepts(context) else { return cancelled() }
        await setOffline(true)
        if path == "/api/auth/state" {
            var response = authState(context, authenticated: context.authenticated)
            response.headers["x-shard-offline"] = "1"
            return response
        }
        if let files = await offlineFiles(path: path, method: method, body: body, context: context) { return files }
        if let saved = await contextCache(context)?.read(path: path, method: method, body: body) {
            var response = WebBridgeResponse(status: saved.status, headers: saved.headers, body: saved.body)
            response.headers["x-shard-offline"] = "1"
            if path == "/api/rpc/list_fragments" { response = await overlayPending(response, context: context) }
            guard !Task.isCancelled, await accepts(context) else { return cancelled() }
            return response
        }
        if path == "/api/rpc/list_fragments" || path == "/api/rpc/list_library_tree", let store = context.store,
           !(await store.loadDocuments()).isEmpty {
            await model.webBridgeLegacyOffline(true)
            await onEvent(WebBridgeEvent(type: "state-changed"))
            return .error("OFFLINE_LEGACY_AVAILABLE", "联网完成界面升级，离线内容仍保存在本机。", status: 503)
        }
        return nil
    }

    /// Use the original verified bytes, including frontmatter and Markdown hard breaks.
    /// Unknown files stay unavailable; absence from a local mirror is not a server 404.
    private func offlineFiles(path: String, method: String, body: Data, context: WebBridgeContext) async -> WebBridgeResponse? {
        guard let store = context.store else { return nil }
        if path == "/api/sync/fetch", method == "POST",
           let value = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any],
           let paths = value["paths"] as? [String], paths.count <= 500 {
            var items: [[String: Any]] = []
            var size = 0
            for file in paths {
                guard !Task.isCancelled, await accepts(context),
                      VaultPaths.isSyncedDocument(file) || VaultPaths.isAsset(file),
                      let cached = try? await store.cachedFile(file) else { return nil }
                size += cached.data.count
                guard size <= Self.maximumBody else { return nil }
                items.append(["path": file, "sha": cached.sha, "data": cached.data.base64EncodedString()])
            }
            guard !Task.isCancelled, await accepts(context) else { return cancelled() }
            var response = WebBridgeResponse.json(["items": items])
            response.headers["x-shard-offline"] = "1"
            return response
        }
        if (method == "GET" || method == "HEAD"), path.hasPrefix("/api/blobs/"),
           let data = try? await store.cachedBlob(String(path.dropFirst("/api/blobs/".count))) {
            guard !Task.isCancelled, await accepts(context) else { return cancelled() }
            return WebBridgeResponse(status: 200, headers: ["content-type": "application/octet-stream", "x-shard-offline": "1"],
                                     body: method == "HEAD" ? Data() : data)
        }
        return nil
    }

    private func erasureTargets(path: String, args: Data, context: WebBridgeContext, trashTree: Data?) async -> (ids: Set<String>, paths: [String])? {
        let fields = (try? JSONSerialization.jsonObject(with: args)) as? [String: Any] ?? [:]
        let tree = trashTree.flatMap { (try? JSONSerialization.jsonObject(with: $0)) as? [String: Any] } ?? [:]
        func leaves(_ entries: [[String: Any]]) -> [String] {
            entries.flatMap { entry -> [String] in
                if let children = entry["children"] as? [[String: Any]] { return leaves(children) }
                if entry["kind"] as? String == "dir" || entry["kind"] as? String == "directory" { return [] }
                return (entry["path"] as? String).map { [$0] } ?? []
            }
        }
        let libraryTrash = leaves(tree["trashEntries"] as? [[String: Any]] ?? [])
        let fragmentTrash = leaves(tree["fragmentTrashEntries"] as? [[String: Any]] ?? [])
        switch path {
        case "/api/rpc/seal_fragment_into_lockbox":
            guard let id = fields["fragmentId"] as? String else { return nil }
            return ([id], [])
        case "/api/rpc/delete_library_entry":
            guard let file = fields["path"] as? String else { return nil }
            return ([], [file])
        case "/api/rpc/purge_from_trash":
            guard let file = fields["path"] as? String else { return nil }
            return ([], (libraryTrash + fragmentTrash).filter { $0 == file || $0.hasPrefix(file + "/") })
        case "/api/rpc/empty_trash":
            let scope = fields["scope"] as? String ?? "library"
            var paths: [String] = []
            var ids = Set<String>()
            if scope == "all" || scope == "library" { paths += libraryTrash }
            if scope == "all" || scope == "fragments" { paths += fragmentTrash }
            if scope == "all" || scope == "fragments" { ids = await context.store?.retiredWebCaptureIDs() ?? [] }
            return (ids, paths)
        default: return nil
        }
    }

    private func erasePublicAfterWrite(_ response: WebBridgeResponse, ids: Set<String>, paths: [String],
                                       context: WebBridgeContext, requestID: String) async -> WebBridgeResponse {
        erasingPublic = true
        defer { erasingPublic = false }
        let cache = contextCache(context)
        // Cancel other readers now. AppModel also cancels and awaits the native sync,
        // changing its revision before disk erasure so no old callback can restore text.
        for (id, request) in requests where id != requestID { request.cancel() }
        let list = await cache?.read(path: "/api/rpc/list_fragments", method: "POST", body: Data("{}".utf8))
        let encrypted = await cache?.read(path: "/api/rpc/lockbox_snapshot", method: "POST", body: Data("{}".utf8))
        do {
            let next = try await model.webBridgeErasePublic(ids: ids, paths: paths, context: context)
            // Actor barrier after the revision change: old successful reads already queued
            // here finish before removeAll, and cannot leave a late plaintext response.
            try await cache?.removeAll()
            configure(next, preservingRequest: requestID, preservingCookies: true)
            if let list, var state = (try? JSONSerialization.jsonObject(with: list.body)) as? [String: Any],
               let fragments = state["fragments"] as? [[String: Any]] {
                let publicPaths = paths.map { $0.hasPrefix(".trash/") ? String($0.dropFirst(7)) : $0 }
                state["fragments"] = fragments.filter { fragment in
                    if let id = fragment["id"] as? String, ids.contains(id) { return false }
                    if let path = fragment["path"] as? String,
                       publicPaths.contains(where: { path == $0 || path.hasPrefix($0 + "/") }) { return false }
                    return true
                }
                try await cache?.save(WebCachedResponse(status: 200, headers: list.headers,
                    body: JSONSerialization.data(withJSONObject: state, options: [.sortedKeys])),
                    path: "/api/rpc/list_fragments", method: "POST", body: Data("{}".utf8))
            }
            if let encrypted { try await cache?.save(encrypted, path: "/api/rpc/lockbox_snapshot", method: "POST", body: Data("{}".utf8)) }
            await changed()
            Task { await self.refreshModel(next) }
            return response
        } catch {
            // A durable erasure journal keeps partially removed public copies hidden on
            // restart. Do not return success while local removal is incomplete.
            configure(await model.webBridgeContext(), preservingRequest: requestID, preservingCookies: true)
            return .error("CACHE_ERASURE_FAILED", "本机缓存清理失败，请重试。", status: 507)
        }
    }

    private func overlayPending(_ response: WebBridgeResponse, context: WebBridgeContext) async -> WebBridgeResponse {
        guard let store = context.store,
              var value = (try? JSONSerialization.jsonObject(with: response.body)) as? [String: Any],
              var fragments = value["fragments"] as? [[String: Any]] else { return response }
        let ids = Set(fragments.compactMap { $0["id"] as? String })
        let pending = await store.pending
        for item in pending where !ids.contains(item.id) {
            fragments.insert(fragmentDTO(VaultDocument.parse(path: item.path, text: item.text, isPending: true)), at: 0)
        }
        for document in await store.uncachedWebCaptures(cachedIDs: Set(fragments.compactMap { $0["id"] as? String })) {
            fragments.insert(fragmentDTO(document), at: 0)
        }
        value["fragments"] = fragments
        var result = WebBridgeResponse.json(value, status: response.status)
        result.headers = response.headers
        result.headers.removeValue(forKey: "content-length")
        return result
    }

    private func authState(_ context: WebBridgeContext, authenticated: Bool) -> WebBridgeResponse {
        .json(["authenticated": authenticated, "setupRequired": false, "stepUpValid": false,
               "email": authenticated ? context.account?.email as Any? ?? NSNull() : NSNull(), "vaultId": context.vaultID ?? ""])
    }

    private func supplementAuthState(_ response: WebBridgeResponse, context: WebBridgeContext) -> WebBridgeResponse {
        guard var value = (try? JSONSerialization.jsonObject(with: response.body)) as? [String: Any] else { return response }
        if value["authenticated"] as? Bool == true, !(value["email"] is String) {
            value["email"] = context.account?.email as Any? ?? NSNull()
        }
        return .json(value, status: response.status)
    }

    private func fragmentDTO(_ document: VaultDocument) -> [String: Any] {
        ["id": document.fragmentID ?? document.path, "path": document.path, "content": document.body,
         "tags": document.tags, "createdAt": document.createdAt ?? "", "updatedAt": document.updatedAt ?? document.createdAt ?? "",
         "pinned": document.pinned, "category": NSNull(), "archived": false, "lockbox": false,
         "gitStatus": document.isPending ? "sync_pending" : "saved", "error": NSNull(), "aiStatus": "none",
         "related": [], "properties": []]
    }

    private func refreshModel(_ context: WebBridgeContext) async {
        guard await accepts(context) else { return }
        await model.sync()
        guard await accepts(context) else { return }
        // Commit acknowledgement can precede the next UI refresh. Persist authoritative
        // public snapshots before announcing that the durable outbox has drained.
        await refreshReadCaches(context)
        guard await accepts(context) else { return }
        await changed()
    }

    private func observeSnapshot(_ response: WebBridgeResponse, context: WebBridgeContext) async {
        guard let state = (try? JSONSerialization.jsonObject(with: response.body)) as? [String: Any],
              let fragments = state["fragments"] as? [[String: Any]] else { return }
        try? await context.store?.markWebObserved(ids: Set(fragments.compactMap { $0["id"] as? String }))
    }

    private func refreshReadCaches(_ context: WebBridgeContext) async {
        for command in ["list_fragments", "list_library_tree", "lockbox_snapshot"] {
            guard await accepts(context) else { return }
            let path = "/api/rpc/" + command
            let body = Data("{}".utf8)
            guard let reply = try? await perform(path, method: "POST", headers: ["content-type": "application/json"],
                                                 body: body, context: context, cookies: false),
                  (200..<300).contains(reply.status), await accepts(context) else { continue }
            do {
                try await contextCache(context)?.save(WebCachedResponse(status: reply.status, headers: reply.headers, body: reply.body),
                                                     path: path, method: "POST", body: body)
                if command == "list_fragments" { await observeSnapshot(reply, context: context) }
            } catch { return }
        }
    }

    private func cacheMutation(_ response: WebBridgeResponse, args: Data, context: WebBridgeContext) async throws {
        guard let cache = contextCache(context), let value = (try? JSONSerialization.jsonObject(with: response.body)) as? [String: Any] else { return }
        let parameters = (try? JSONSerialization.jsonObject(with: args)) as? [String: Any] ?? [:]
        let fragment = value["fragment"] as? [String: Any] ?? (value["content"] is String && value["id"] is String ? value : nil)
        var observed = Set<String>()
        if let id = parameters["id"] as? String { observed.insert(id) }
        if let id = fragment?["id"] as? String { observed.insert(id) }
        try await context.store?.markWebObserved(ids: observed, paths: (parameters["path"] as? String).map { [$0] } ?? [])
        let body = Data("{}".utf8)
        if value["fragments"] is [[String: Any]] {
            try await cache.save(WebCachedResponse(status: 200, headers: ["content-type": "application/json"], body: response.body),
                                 path: "/api/rpc/list_fragments", method: "POST", body: body)
            await observeSnapshot(response, context: context)
        } else if let fragment, let id = fragment["id"] as? String,
                  let old = await cache.read(path: "/api/rpc/list_fragments", method: "POST", body: body),
                  var state = (try? JSONSerialization.jsonObject(with: old.body)) as? [String: Any],
                  var fragments = state["fragments"] as? [[String: Any]] {
            if let index = fragments.firstIndex(where: { $0["id"] as? String == id }) { fragments[index] = fragment }
            else { fragments.insert(fragment, at: 0) }
            state["fragments"] = fragments
            let data = try JSONSerialization.data(withJSONObject: state, options: [.sortedKeys])
            try await cache.save(WebCachedResponse(status: 200, headers: old.headers, body: data),
                                 path: "/api/rpc/list_fragments", method: "POST", body: body)
        }
        if let tree = value["tree"] as? [String: Any] {
            let data = try JSONSerialization.data(withJSONObject: tree, options: [.sortedKeys])
            try await cache.save(WebCachedResponse(status: 200, headers: ["content-type": "application/json"], body: data),
                                 path: "/api/rpc/list_library_tree", method: "POST", body: body)
        }
    }

    /// Browser sessions cannot keep a revoked native device authenticated.
    private func verifyDevice(_ context: WebBridgeContext) async -> WebBridgeResponse? {
        do {
            let reply = try await perform("/api/auth/state", method: "GET", headers: [:], body: Data(), context: context, cookies: false)
            guard !Task.isCancelled, await accepts(context) else { return cancelled() }
            let state = (try? JSONSerialization.jsonObject(with: reply.body)) as? [String: Any]
            if reply.status == 401 || ((200..<300).contains(reply.status) && state?["authenticated"] as? Bool == false) {
                await model.webBridgeExpire(context)
                cookieReady = false
                await onEvent(WebBridgeEvent(type: "state-changed"))
                return .error("UNAUTHENTICATED", "登录已失效，请重新登录。", status: 401)
            }
            guard (200..<300).contains(reply.status), state?["authenticated"] as? Bool == true else { return reply }
            return nil
        } catch {
            if Task.isCancelled { return cancelled() }
            return .error("NETWORK", "连不上服务器，请稍后重试。", status: 503)
        }
    }

    private func currentAuthState(_ context: WebBridgeContext, requestID: String) async -> WebBridgeResponse {
        if let failure = await verifyDevice(context) {
            if failure.status == 401 { return authState(context, authenticated: false) }
            if [502, 503, 504].contains(failure.status) {
                await setOffline(true)
                var state = authState(context, authenticated: true)
                state.headers["x-shard-offline"] = "1"
                return state
            }
            return failure
        }
        guard cookieReady else { return authState(context, authenticated: true) }
        do {
            let reply = try await perform("/api/auth/state", method: "GET", headers: [:], body: Data(), context: context, cookies: true)
            guard await accepts(context) else { return changedAccount() }
            guard let state = (try? JSONSerialization.jsonObject(with: reply.body)) as? [String: Any],
                  state["authenticated"] as? Bool == true else {
                cookieReady = false
                return authState(context, authenticated: true)
            }
            if let email = state["email"] as? String, email != context.account?.email {
                let next = try await model.webBridgeAccountEmail(email, context: context)
                // Any existing reader must reconnect against the new context. The view's
                // account storage identity remains stable for this same-owner change.
                configure(next, preservingRequest: requestID, preservingCookies: true)
                await changed()
                return supplementAuthState(reply, context: next)
            }
            return supplementAuthState(reply, context: context)
        } catch { return authState(context, authenticated: true) }
    }

    private func setOffline(_ value: Bool) async {
        guard offline != value else { return }
        offline = value
        await onEvent(WebBridgeEvent(type: "state-changed"))
    }

    private func changed() async {
        await onEvent(WebBridgeEvent(type: "vault-changed"))
        await onEvent(WebBridgeEvent(type: "state-changed"))
    }

    private func needsBrowserSession(_ path: String) -> Bool {
        path.hasPrefix("/api/devices") || ["/api/auth/account", "/api/auth/audit"].contains(path) || path.hasPrefix("/api/auth/sessions")
    }

    private func isWrite(_ path: String, method: String) -> Bool {
        method != "GET" && method != "HEAD" && !WebBridgePolicy.canCache(path: path, method: method) && path.hasPrefix("/api/rpc/")
    }

    private func responseHeaders(_ response: HTTPURLResponse) -> [String: String] {
        var headers: [String: String] = [:]
        for key in ["content-type", "content-disposition", "content-range", "accept-ranges", "retry-after"] {
            if let value = response.value(forHTTPHeaderField: key) { headers[key] = value }
        }
        return headers
    }

    private func header(_ key: String, in headers: [String: String]) -> String? {
        headers.first { $0.key.caseInsensitiveCompare(key) == .orderedSame }?.value
    }

    private func selectedServer(_ context: WebBridgeContext) -> String {
        if let account = context.account { return account.serverURL.absoluteString }
        #if DEBUG
        if let candidate = UserDefaults.standard.string(forKey: "debugServer"),
           let server = try? ServerRemote.normalizeServer(candidate) { return server.absoluteString }
        #endif
        return Self.defaultServer
    }

    private func contextCache(_ context: WebBridgeContext) -> WebBridgeCache? {
        guard let account = context.account else { return nil }
        let root = VaultStore.defaultRoot(for: account)
        if let cache = caches[root.path] { return cache }
        let created = WebBridgeCache(accountRoot: root)
        caches[root.path] = created
        return created
    }

    private func mimeType(_ path: String) -> String {
        switch (path as NSString).pathExtension.lowercased() {
        case "png": "image/png"
        case "jpg", "jpeg": "image/jpeg"
        case "gif": "image/gif"
        case "svg": "image/svg+xml"
        case "webp": "image/webp"
        case "avif": "image/avif"
        case "heic", "heif": "image/heic"
        default: "application/octet-stream"
        }
    }

    private func invalidRequest() -> WebBridgeResponse { .error("INVALID_REQUEST", "请求无效。", status: 400) }
    private func changedAccount() -> WebBridgeResponse { .error("CANCELLED", "连接已切换。", status: 409) }
    private func cancelled() -> WebBridgeResponse { .error("CANCELLED", "请求已取消。", status: 499) }
}

private final class WebBridgeRejectRedirects: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}
