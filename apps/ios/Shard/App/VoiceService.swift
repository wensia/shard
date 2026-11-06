import AVFoundation
import Foundation
import Security
import ShardKit
import UIKit

/// Native side of the page's `voice_*` commands. Command names and payloads match the desktop
/// Tauri commands (`src-tauri/src/voice.rs`), so the shared React UI runs unchanged. The API key,
/// microphone and speech-service requests stay here; the page only sees settings without the key,
/// recognised text, and validated WAV bytes.
actor VoiceService {
    static let shared = VoiceService()

    typealias Emit = @MainActor @Sendable (WebBridgeEvent) -> Void

    private struct Credentials: Sendable {
        let settings: VoiceSettings
        let key: String
    }

    private enum Recording {
        case starting
        case recording(VoiceRecorder)
        case ready(Data)
        case failed(String)
    }

    private final class Session {
        let owner: UUID
        let credentials: Credentials
        let emit: Emit?
        var recording: Recording?
        var busy = false
        var cancelled = false
        var lastUsed = Date()
        var inflight: Task<VoiceTransfer.Outcome, Never>?
        var limit: Task<Void, Never>?

        init(owner: UUID, credentials: Credentials, recording: Recording?, emit: Emit?) {
            self.owner = owner
            self.credentials = credentials
            self.recording = recording
            self.emit = emit
        }
    }

    /// Longer than a full recording plus retries and one playback segment.
    private static let sessionIdle: TimeInterval = 10 * 60
    private static let maximumArguments = 256 * 1024
    private var sessions: [String: Session] = [:]
    private var tombstones: [String] = []
    /// Pages that reloaded or went away. A command they queued before that, but which only
    /// arrives now, must not open the microphone for a page that can no longer stop it.
    private var retiredOwners: [UUID] = []
    private let network: URLSession

    private init() {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 60
        configuration.timeoutIntervalForResource = 90
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        network = URLSession(configuration: configuration, delegate: VoiceRejectRedirects(), delegateQueue: nil)
        VoiceRecorder.purgeLeftovers()
    }

    // MARK: Bridge entry points

    func handle(command: String, bodyBase64: String?, owner: UUID, emit: @escaping Emit) async -> WebBridgeResponse {
        if retiredOwners.contains(owner), command != "voice_cancel" {
            return .error("VOICE_FAILED", VoiceFailure.cancelled.message, status: 400)
        }
        do {
            guard (bodyBase64?.utf8.count ?? 0) <= Self.maximumArguments,
                  let body = bodyBase64.map({ Data(base64Encoded: $0) }) ?? Data()
            else { throw VoiceFailure("语音请求无效。") }
            let args = body.isEmpty ? [:] : ((try? JSONSerialization.jsonObject(with: body)) as? [String: Any] ?? [:])
            switch command {
            case "voice_get_settings":
                return .json(try settingsView())
            case "voice_save_settings":
                return .json(try save(args))
            case "voice_start_recording":
                try await startRecording(try sessionID(args), owner: owner, emit: emit)
                return .json([:])
            case "voice_transcribe":
                return .json(["text": try await transcribe(try sessionID(args))])
            case "voice_synthesize":
                guard let text = args["text"] as? String else { throw VoiceFailure("每段朗读内容应为 1–1500 字。") }
                // Settings previews an unsaved voice; the override lives only in this session.
                var voice: String?
                if let raw = args["voice"] as? String { voice = try VoiceContract.name(raw) }
                let audio = try await synthesize(try sessionID(args), text: text, voice: voice, owner: owner)
                return WebBridgeResponse(status: 200, headers: ["content-type": "audio/wav"], body: audio)
            case "voice_cancel":
                cancel(try sessionID(args))
                return .json([:])
            default:
                throw VoiceFailure("语音请求无效。")
            }
        } catch let failure as VoiceFailure {
            return .error("VOICE_FAILED", failure.message, status: 400)
        } catch {
            return .error("VOICE_FAILED", "语音操作失败，请重试。", status: 400)
        }
    }

    /// The page that owned these sessions is reloading or gone; it can no longer stop them.
    func cancelOwner(_ owner: UUID) {
        if !retiredOwners.contains(owner) { retiredOwners.append(owner) }
        if retiredOwners.count > 64 { retiredOwners.removeFirst(retiredOwners.count - 64) }
        for (id, session) in sessions where session.owner == owner {
            sessions.removeValue(forKey: id)
            shutDown(session)
            tombstone(id)
        }
    }

    // MARK: Settings

    private func sessionID(_ args: [String: Any]) throws(VoiceFailure) -> String {
        guard let id = args["sessionId"] as? String else { throw VoiceFailure("语音会话无效。") }
        try VoiceContract.validateSessionID(id)
        return id
    }

    private static var settingsFile: URL {
        get throws(VoiceFailure) {
            guard let support = try? FileManager.default.url(
                for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true
            ) else { throw VoiceFailure("无法打开本机设置目录。") }
            let folder = support.appending(path: "Voice", directoryHint: .isDirectory)
            try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            return folder.appending(path: "voice-settings.json")
        }
    }

    private func readSettings() throws(VoiceFailure) -> VoiceSettings {
        let file = try Self.settingsFile
        guard FileManager.default.fileExists(atPath: file.path) else { return .defaults }
        guard let data = try? Data(contentsOf: file),
              let settings = try? JSONDecoder().decode(VoiceSettings.self, from: data)
        else { throw VoiceFailure("语音设置无法读取，请重新配置。") }
        return try VoiceContract.normalize(settings)
    }

    private func view(_ settings: VoiceSettings, hasKey: Bool) -> [String: Any] {
        [
            "mode": settings.mode.rawValue, "baseUrl": settings.baseUrl,
            "transcriptionModel": settings.transcriptionModel, "speechModel": settings.speechModel,
            "voice": settings.voice, "hasKey": hasKey,
        ]
    }

    private func settingsView() throws(VoiceFailure) -> [String: Any] {
        let settings = try readSettings()
        return view(settings, hasKey: try VoiceKeychain.read(VoiceContract.keyAccount(for: settings)) != nil)
    }

    private func credentials() throws(VoiceFailure) -> Credentials {
        let settings = try readSettings()
        guard let key = try VoiceKeychain.read(VoiceContract.keyAccount(for: settings)) else {
            throw VoiceFailure("请先配置语音 API Key。")
        }
        return Credentials(settings: settings, key: key)
    }

    private func save(_ args: [String: Any]) throws(VoiceFailure) -> [String: Any] {
        guard let raw = args["settings"],
              let data = try? JSONSerialization.data(withJSONObject: raw),
              let decoded = try? JSONDecoder().decode(VoiceSettings.self, from: data)
        else { throw VoiceFailure("语音设置无效。") }
        let settings = try VoiceContract.normalize(decoded)
        let account = VoiceContract.keyAccount(for: settings)
        let previous = try VoiceKeychain.read(account)
        // `nil` keeps the stored key; an empty string deletes it.
        var updated: String?? = nil
        if let key = args["apiKey"] as? String { updated = .some(try VoiceContract.validateKey(key)) }
        let file = try Self.settingsFile
        let staged = file.deletingPathExtension().appendingPathExtension("pending.json")
        guard let bytes = try? JSONEncoder().encode(settings),
              (try? bytes.write(to: staged, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])) != nil
        else { throw VoiceFailure("无法写入语音设置。") }
        if let updated {
            do throws(VoiceFailure) { try VoiceKeychain.write(account, updated) } catch {
                try? FileManager.default.removeItem(at: staged)
                throw error
            }
        }
        // Stage the file before changing the key; if replacing it fails, restore the previous key.
        if rename(staged.path, file.path) != 0 {
            try? FileManager.default.removeItem(at: staged)
            if updated != nil, (try? VoiceKeychain.write(account, previous)) == nil {
                throw VoiceFailure("设置文件保存失败，API Key 回滚也失败；请重新设置 API Key。")
            }
            throw VoiceFailure("语音设置保存失败，原设置已保留。")
        }
        let hasKey = updated.map { $0 != nil } ?? (previous != nil)
        return view(settings, hasKey: hasKey)
    }

    // MARK: Sessions

    private func insert(_ id: String, _ session: Session) throws(VoiceFailure) {
        if tombstones.contains(id) { throw VoiceFailure.cancelled }
        if sessions[id] != nil { throw VoiceFailure("语音会话已存在。") }
        let now = Date()
        // Sessions untouched for a while belong to a page that went away without cancelling.
        for (key, value) in sessions where !value.busy && now.timeIntervalSince(value.lastUsed) >= Self.sessionIdle {
            sessions.removeValue(forKey: key)
            shutDown(value)
        }
        if sessions.count >= 8 { throw VoiceFailure("请先结束当前语音操作。") }
        sessions[id] = session
    }

    private func get(_ id: String) throws(VoiceFailure) -> Session? {
        if tombstones.contains(id) { throw VoiceFailure.cancelled }
        let session = sessions[id]
        session?.lastUsed = Date()
        return session
    }

    private func tombstone(_ id: String) {
        if !tombstones.contains(id) { tombstones.append(id) }
        if tombstones.count > 128 { tombstones.removeFirst(tombstones.count - 128) }
    }

    private func cancel(_ id: String) {
        if let session = sessions.removeValue(forKey: id) { shutDown(session) }
        tombstone(id)
    }

    private func shutDown(_ session: Session) {
        session.cancelled = true
        session.inflight?.cancel()
        session.limit?.cancel()
        if case .recording(let recorder) = session.recording { recorder.cancel() }
        session.recording = nil
    }

    private func acquire(_ session: Session) throws(VoiceFailure) {
        guard !session.busy else { throw VoiceFailure("此语音操作正在处理中。") }
        session.busy = true
    }

    // MARK: Recording

    private var recordingActive: Bool {
        sessions.values.contains { session in
            switch session.recording {
            case .starting, .recording: true
            default: false
            }
        }
    }

    private func startRecording(_ id: String, owner: UUID, emit: @escaping Emit) async throws(VoiceFailure) {
        let credentials = try credentials()
        guard !recordingActive else { throw VoiceFailure("另一个录音尚未结束。") }
        let session = Session(owner: owner, credentials: credentials, recording: .starting, emit: emit)
        try insert(id, session)
        do throws(VoiceFailure) {
            try await Self.microphonePermission()
            guard !session.cancelled, sessions[id] === session else { throw VoiceFailure.cancelled }
            let recorder = try VoiceRecorder.start { [weak self] message in
                Task { await self?.recorderStopped(id, message: message) }
            }
            session.recording = .recording(recorder)
            let token = ObjectIdentifier(recorder)
            session.limit = Task { [weak self] in
                try? await Task.sleep(for: .seconds(VoiceContract.maxRecordingSeconds))
                guard !Task.isCancelled else { return }
                await self?.limitReached(id, token: token)
            }
        } catch {
            if sessions[id] === session { sessions.removeValue(forKey: id) }
            session.recording = nil
            throw error
        }
    }

    private static func microphonePermission() async throws(VoiceFailure) {
        let denied = VoiceFailure("麦克风权限未开启，请在「设置 → Shard」中允许使用麦克风。")
        switch AVAudioApplication.shared.recordPermission {
        case .granted: return
        case .denied: throw denied
        default:
            if await AVAudioApplication.requestRecordPermission() { return }
            throw denied
        }
    }

    private func limitReached(_ id: String, token: ObjectIdentifier) async {
        guard let session = sessions[id], case .recording(let recorder) = session.recording,
              ObjectIdentifier(recorder) == token else { return }
        let outcome = collect(recorder)
        guard sessions[id] === session, !session.cancelled else { return }
        session.recording = outcome
        let event: WebBridgeEvent = switch outcome {
        case .failed(let message): WebBridgeEvent(type: "voice-recording-stopped", id: id, error: message, reason: "error")
        default: WebBridgeEvent(type: "voice-recording-stopped", id: id, reason: "limit")
        }
        await session.emit?(event)
    }

    private func recorderStopped(_ id: String, message: String) async {
        guard let session = sessions[id], case .recording(let recorder) = session.recording else { return }
        session.limit?.cancel()
        session.recording = .failed(message)
        recorder.cancel()
        await session.emit?(WebBridgeEvent(type: "voice-recording-stopped", id: id, error: message, reason: "error"))
    }

    private func collect(_ recorder: VoiceRecorder) -> Recording {
        guard let file = recorder.finish() else { return .failed("无法读取录音。") }
        defer { try? FileManager.default.removeItem(at: file) }
        guard let data = try? Data(contentsOf: file) else { return .failed("无法读取录音。") }
        do throws(VoiceFailure) { return .ready(try VoiceContract.canonicalWAV(data)) } catch { return .failed(error.message) }
    }

    private func stoppedAudio(_ session: Session) async throws(VoiceFailure) -> Data {
        if case .recording(let recorder) = session.recording {
            session.limit?.cancel()
            let outcome = collect(recorder)
            guard !session.cancelled else { throw VoiceFailure.cancelled }
            session.recording = outcome
        }
        switch session.recording {
        case .ready(let audio): return audio
        case .failed(let message): throw VoiceFailure(message)
        case .starting, .recording: throw VoiceFailure("录音尚未开始。")
        case nil: throw VoiceFailure("没有可识别的录音。")
        }
    }

    // MARK: Speech service

    private func transcribe(_ id: String) async throws(VoiceFailure) -> String {
        guard let session = try get(id) else { throw VoiceFailure("录音已结束，请重新录音。") }
        try acquire(session)
        defer { session.busy = false }
        let audio = try await stoppedAudio(session)
        let credentials = session.credentials
        let request = try VoiceContract.transcriptionRequest(settings: credentials.settings, key: credentials.key, wav: audio)
        let body = try await perform(request, session)
        let text = try VoiceContract.transcriptionText(mode: credentials.settings.mode, body: body)
        // A completed transcription frees its recording at once; failures keep it for retry.
        if sessions[id] === session { sessions.removeValue(forKey: id) }
        session.recording = nil
        return text
    }

    private func synthesize(_ id: String, text: String, voice: String?, owner: UUID) async throws(VoiceFailure) -> Data {
        let text = try VoiceContract.speechText(text)
        let session: Session
        if let existing = try get(id) {
            session = existing
        } else {
            var credentials = try credentials()
            if let voice {
                var settings = credentials.settings
                settings.voice = voice
                credentials = Credentials(settings: settings, key: credentials.key)
            }
            session = Session(owner: owner, credentials: credentials, recording: nil, emit: nil)
            try insert(id, session)
        }
        try acquire(session)
        defer { session.busy = false }
        let credentials = session.credentials
        let request = try VoiceContract.speechRequest(settings: credentials.settings, key: credentials.key, text: text)
        let body = try await perform(request, session)
        return try VoiceContract.speechAudio(mode: credentials.settings.mode, body: body)
    }

    private func perform(_ request: URLRequest, _ session: Session) async throws(VoiceFailure) -> Data {
        guard !session.cancelled else { throw VoiceFailure.cancelled }
        let network = network
        let task = Task { await VoiceTransfer.run(request, on: network) }
        session.inflight = task
        defer { session.inflight = nil }
        let outcome = await task.value
        guard !session.cancelled else { throw VoiceFailure.cancelled }
        switch outcome {
        case .tooLarge:
            throw VoiceFailure("语音响应过大，请缩短文本后重试。")
        case .failed(let code):
            switch code {
            case .cancelled: throw VoiceFailure.cancelled
            case .timedOut: throw VoiceFailure("语音请求超时，请重试。")
            case .cannotFindHost, .cannotConnectToHost, .dnsLookupFailed, .notConnectedToInternet,
                 .secureConnectionFailed, .serverCertificateUntrusted, .serverCertificateHasBadDate,
                 .serverCertificateNotYetValid, .serverCertificateHasUnknownRoot:
                throw VoiceFailure("无法连接语音服务，请检查 API 地址和网络。")
            default: throw VoiceFailure("语音请求失败，请检查网络后重试。")
            }
        case .body(let status, let data):
            guard status != 0 else { throw VoiceFailure("语音服务返回了无效响应。") }
            guard (200..<300).contains(status) else { throw VoiceContract.httpFailure(status: status, body: data) }
            return data
        }
    }
}

/// One Keychain item per endpoint, never synced off this device, readable only while unlocked.
private enum VoiceKeychain {
    private static let service = "dev.shard.mobile.voice"

    private static func query(_ account: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
    }

    static func read(_ account: String) throws(VoiceFailure) -> String? {
        var query = query(account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        switch SecItemCopyMatching(query as CFDictionary, &item) {
        case errSecSuccess:
            guard let data = item as? Data, let key = String(data: data, encoding: .utf8), !key.isEmpty else { return nil }
            return key
        case errSecItemNotFound: return nil
        default: throw VoiceFailure("无法读取钥匙串，请解锁设备后重试。")
        }
    }

    static func write(_ account: String, _ key: String?) throws(VoiceFailure) {
        guard let key else {
            let status = SecItemDelete(query(account) as CFDictionary)
            guard status == errSecSuccess || status == errSecItemNotFound else {
                throw VoiceFailure("无法删除钥匙串中的 API Key。")
            }
            return
        }
        let update: [String: Any] = [
            kSecValueData as String: Data(key.utf8),
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
        ]
        var status = SecItemUpdate(query(account) as CFDictionary, update as CFDictionary)
        if status == errSecItemNotFound {
            status = SecItemAdd(query(account).merging(update) { $1 } as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw VoiceFailure("无法保存 API Key 到钥匙串。") }
    }
}

private final class VoiceRejectRedirects: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest) async -> URLRequest? { nil }
}

/// One request whose byte limits hold while it downloads: a successful body stops at the response
/// cap, an error body at 8 KiB (only a known machine code is ever read from it, as on the desktop).
private final class VoiceTransfer: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    enum Outcome: Sendable {
        case body(Int, Data)
        case tooLarge
        case failed(URLError.Code?)
    }

    private static let errorBodyLimit = 8192
    private let lock = NSLock()
    private var status = 0
    private var data = Data()
    private var tooLarge = false
    private var errorBodyTruncated = false
    private var continuation: CheckedContinuation<Outcome, Never>?

    static func run(_ request: URLRequest, on network: URLSession) async -> Outcome {
        let transfer = VoiceTransfer()
        let task = network.dataTask(with: request)
        task.delegate = transfer
        return await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in
                transfer.lock.withLock { transfer.continuation = continuation }
                task.resume()
            }
        } onCancel: {
            task.cancel()
        }
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse) async -> URLSession.ResponseDisposition {
        let http = response as? HTTPURLResponse
        let status = http?.statusCode ?? 0
        let oversized = (200..<300).contains(status) && (http?.expectedContentLength ?? -1) > Int64(VoiceContract.maxResponseBytes)
        lock.withLock {
            self.status = status
            if oversized { tooLarge = true }
        }
        return oversized ? .cancel : .allow
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive chunk: Data) {
        let stop = lock.withLock { () -> Bool in
            let success = (200..<300).contains(status)
            guard data.count + chunk.count <= (success ? VoiceContract.maxResponseBytes : Self.errorBodyLimit) else {
                if success { tooLarge = true } else { errorBodyTruncated = true }
                return true
            }
            data.append(chunk)
            return false
        }
        if stop { dataTask.cancel() }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest) async -> URLRequest? { nil }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        let (outcome, continuation) = lock.withLock { () -> (Outcome, CheckedContinuation<Outcome, Never>?) in
            let outcome: Outcome = if tooLarge {
                .tooLarge
            } else if errorBodyTruncated {
                // Too long to be a plain error object: report the status without a code.
                .body(status, Data())
            } else if let error {
                .failed((error as? URLError)?.code)
            } else {
                .body(status, data)
            }
            defer { self.continuation = nil }
            return (outcome, self.continuation)
        }
        continuation?.resume(returning: outcome)
    }
}

/// Records 16 kHz mono PCM16 WAV with the app's audio session switched to record only while
/// a dictation is running; the previous category is restored afterwards so playback resumes.
/// Owned and driven by `VoiceService`: activating an audio session blocks, so none of this runs
/// on the main thread, and the page stays responsive while the system sets up the microphone.
final class VoiceRecorder {
    private static var folder: URL { FileManager.default.temporaryDirectory.appending(path: "shard-voice", directoryHint: .isDirectory) }
    private let recorder: AVAudioRecorder
    private let file: URL
    private let previous: (AVAudioSession.Category, AVAudioSession.Mode, AVAudioSession.CategoryOptions)
    private var observers: [NSObjectProtocol] = []
    private var closed = false

    static func purgeLeftovers() {
        try? FileManager.default.removeItem(at: folder)
    }

    static func start(onStopped: @escaping @Sendable (String) -> Void) throws(VoiceFailure) -> VoiceRecorder {
        let audio = AVAudioSession.sharedInstance()
        let previous = (audio.category, audio.mode, audio.categoryOptions)
        do {
            try audio.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetoothHFP])
            try audio.setActive(true)
        } catch {
            try? audio.setCategory(previous.0, mode: previous.1, options: previous.2)
            throw VoiceFailure("无法开始录音，请检查麦克风是否被其他应用占用。")
        }
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let file = folder.appending(path: UUID().uuidString + ".wav")
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: 16_000, AVNumberOfChannelsKey: 1,
            AVLinearPCMBitDepthKey: 16, AVLinearPCMIsFloatKey: false, AVLinearPCMIsBigEndianKey: false,
        ]
        guard let recorder = try? AVAudioRecorder(url: file, settings: settings), recorder.record() else {
            try? FileManager.default.removeItem(at: file)
            try? audio.setActive(false, options: .notifyOthersOnDeactivation)
            try? audio.setCategory(previous.0, mode: previous.1, options: previous.2)
            throw VoiceFailure("无法开始录音，请检查麦克风是否被其他应用占用。")
        }
        return VoiceRecorder(recorder: recorder, file: file, previous: previous, onStopped: onStopped)
    }

    private init(recorder: AVAudioRecorder, file: URL,
                 previous: (AVAudioSession.Category, AVAudioSession.Mode, AVAudioSession.CategoryOptions),
                 onStopped: @escaping @Sendable (String) -> Void) {
        self.recorder = recorder
        self.file = file
        self.previous = previous
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: nil) { note in
            let type = (note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt).flatMap(AVAudioSession.InterruptionType.init)
            if type == .began { onStopped("录音被系统中断，请重新录音。") }
        })
        observers.append(center.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: nil) { note in
            let reason = (note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt).flatMap(AVAudioSession.RouteChangeReason.init)
            if reason == .oldDeviceUnavailable { onStopped("麦克风连接中断，请重新录音。") }
        })
        observers.append(center.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: nil, queue: nil) { _ in
            onStopped("麦克风连接中断，请重新录音。")
        })
        // Without background audio the system stops the microphone once the app leaves the foreground.
        observers.append(center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: nil) { _ in
            onStopped("切到后台后录音已停止，请重新录音。")
        })
    }

    /// Stops and returns the finished file; the caller reads and deletes it off the main thread.
    func finish() -> URL? {
        guard !closed else { return nil }
        recorder.stop()
        close()
        return file
    }

    func cancel() {
        guard !closed else { return }
        recorder.stop()
        recorder.deleteRecording()
        close()
    }

    private func close() {
        closed = true
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
        observers.removeAll()
        let audio = AVAudioSession.sharedInstance()
        try? audio.setActive(false, options: .notifyOthersOnDeactivation)
        try? audio.setCategory(previous.0, mode: previous.1, options: previous.2)
    }
}
