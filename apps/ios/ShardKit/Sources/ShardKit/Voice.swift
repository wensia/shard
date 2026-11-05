import CryptoKit
import Foundation

/// Speech input and read-aloud contract shared with the desktop (`src-tauri/src/voice.rs`).
/// Configuration is device-local and account-independent; the API key lives in the Keychain
/// and never reaches the page, the vault, or returned settings.
public enum VoiceMode: String, Codable, Sendable {
    case mimo
    case openai
}

public struct VoiceSettings: Codable, Equatable, Sendable {
    public var mode: VoiceMode
    public var baseUrl: String
    public var transcriptionModel: String
    public var speechModel: String
    public var voice: String

    public init(mode: VoiceMode, baseUrl: String, transcriptionModel: String, speechModel: String, voice: String) {
        self.mode = mode
        self.baseUrl = baseUrl
        self.transcriptionModel = transcriptionModel
        self.speechModel = speechModel
        self.voice = voice
    }

    public static let defaults = VoiceSettings(
        mode: .mimo, baseUrl: "https://api.xiaomimimo.com/v1",
        transcriptionModel: "mimo-v2.5-asr", speechModel: "mimo-v2.5-tts", voice: "冰糖"
    )
}

/// A user-facing failure. Messages never echo upstream bodies, keys, or document text.
public struct VoiceFailure: Error, Equatable, Sendable {
    public let message: String
    public init(_ message: String) { self.message = message }

    public static let cancelled = VoiceFailure("语音操作已取消。")
}

public enum VoiceContract {
    public static let maxRecordingSeconds = 120
    public static let maxResponseBytes = 24 * 1024 * 1024
    public static let maxSpeechCharacters = 1500
    /// 0.2 s of 16 kHz mono PCM16.
    public static let minimumRecordingBytes = 16_000 * 2 / 5

    // MARK: Settings

    public static func normalize(_ input: VoiceSettings) throws(VoiceFailure) -> VoiceSettings {
        var settings = input
        let raw = settings.baseUrl.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let components = URLComponents(string: raw),
              let scheme = components.scheme?.lowercased(),
              let host = components.host?.lowercased(), !host.isEmpty
        else { throw VoiceFailure("API 地址无效。") }
        let loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].contains(host)
        guard scheme == "https" || (scheme == "http" && loopback) else {
            throw VoiceFailure("API 地址需使用 HTTPS；本机服务可使用 HTTP。")
        }
        guard components.user == nil, components.password == nil,
              components.query == nil, components.fragment == nil
        else { throw VoiceFailure("API 地址不能包含账号、密码、查询参数或锚点。") }
        var path = components.percentEncodedPath
        while path.hasSuffix("/") { path.removeLast() }
        if ["/chat/completions", "/audio/speech", "/audio/transcriptions"].contains(where: { path.hasSuffix($0) }) {
            throw VoiceFailure("请填写 API 基础地址，例如 https://api.xiaomimimo.com/v1。")
        }
        var port = ""
        if let value = components.port, !(scheme == "https" && value == 443), !(scheme == "http" && value == 80) {
            port = ":\(value)"
        }
        let hostPart = host.contains(":") && !host.hasPrefix("[") ? "[\(host)]" : host
        settings.baseUrl = "\(scheme)://\(hostPart)\(port)\(path)"
        for keyPath in [\VoiceSettings.transcriptionModel, \VoiceSettings.speechModel, \VoiceSettings.voice] {
            let value = settings[keyPath: keyPath].trimmingCharacters(in: .whitespacesAndNewlines)
            guard !value.isEmpty, value.utf8.count <= 256,
                  !value.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) })
            else { throw VoiceFailure("请填写有效的语音模型和音色。") }
            settings[keyPath: keyPath] = value
        }
        return settings
    }

    /// Mirrors the desktop: one Keychain item per endpoint.
    public static func keyAccount(for settings: VoiceSettings) -> String {
        "endpoint-" + SHA256.hash(data: Data(settings.baseUrl.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    /// Returns the trimmed key, or `nil` to delete it. Header-unsafe keys are rejected.
    public static func validateKey(_ key: String) throws(VoiceFailure) -> String? {
        let trimmed = key.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return nil }
        guard trimmed.utf8.count <= 4096,
              trimmed.unicodeScalars.allSatisfy({ $0.value >= 0x20 && $0.value < 0x7F || $0 == "\t" })
        else { throw VoiceFailure("API Key 格式无效。") }
        return trimmed
    }

    public static func validateSessionID(_ id: String) throws(VoiceFailure) {
        guard !id.isEmpty, id.utf8.count <= 128,
              id.unicodeScalars.allSatisfy({ ($0.isASCII && CharacterSet.alphanumerics.contains($0)) || $0 == "-" || $0 == "_" })
        else { throw VoiceFailure("语音会话无效。") }
    }

    public static func speechText(_ text: String) throws(VoiceFailure) -> String {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.unicodeScalars.count <= maxSpeechCharacters else {
            throw VoiceFailure("每段朗读内容应为 1–1500 字。")
        }
        return trimmed
    }

    // MARK: Requests

    public static func transcriptionRequest(settings: VoiceSettings, key: String, wav: Data) throws(VoiceFailure) -> URLRequest {
        switch settings.mode {
        case .mimo:
            let body: [String: Any] = [
                "model": settings.transcriptionModel,
                "stream": false,
                "messages": [[
                    "role": "user",
                    "content": [["type": "input_audio", "input_audio": ["data": "data:audio/wav;base64," + wav.base64EncodedString()]]],
                ]],
                "asr_options": ["language": "auto"],
            ]
            return try jsonRequest(settings.baseUrl + "/chat/completions", key: key, body: body)
        case .openai:
            let boundary = "shard-" + UUID().uuidString
            var body = Data()
            func field(_ name: String, _ value: String) {
                body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(name)\"\r\n\r\n\(value)\r\n".utf8))
            }
            field("model", settings.transcriptionModel)
            field("response_format", "json")
            body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"recording.wav\"\r\nContent-Type: audio/wav\r\n\r\n".utf8))
            body.append(wav)
            body.append(Data("\r\n--\(boundary)--\r\n".utf8))
            var request = try baseRequest(settings.baseUrl + "/audio/transcriptions", key: key)
            request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
            request.httpBody = body
            return request
        }
    }

    public static func speechRequest(settings: VoiceSettings, key: String, text: String) throws(VoiceFailure) -> URLRequest {
        switch settings.mode {
        case .mimo:
            return try jsonRequest(settings.baseUrl + "/chat/completions", key: key, body: [
                "model": settings.speechModel,
                "stream": false,
                "messages": [["role": "assistant", "content": text]],
                "audio": ["format": "wav", "voice": settings.voice],
            ])
        case .openai:
            return try jsonRequest(settings.baseUrl + "/audio/speech", key: key, body: [
                "model": settings.speechModel, "input": text, "voice": settings.voice, "response_format": "wav",
            ])
        }
    }

    private static func baseRequest(_ address: String, key: String) throws(VoiceFailure) -> URLRequest {
        guard let url = URL(string: address) else { throw VoiceFailure("API 地址无效。") }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("Bearer " + key, forHTTPHeaderField: "Authorization")
        return request
    }

    private static func jsonRequest(_ address: String, key: String, body: [String: Any]) throws(VoiceFailure) -> URLRequest {
        var request = try baseRequest(address, key: key)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        guard let data = try? JSONSerialization.data(withJSONObject: body) else { throw VoiceFailure("无法准备语音请求。") }
        request.httpBody = data
        return request
    }

    // MARK: Responses

    private static let safeCodes: Set<String> = [
        "invalid_api_key", "authentication_error", "invalid_request_error", "model_not_found",
        "insufficient_quota", "rate_limit_exceeded", "permission_denied", "invalid_model",
        "invalid_voice", "invalid_parameter", "content_filter", "server_error",
    ]

    /// Upstream messages are never echoed: some proxies include request bodies, headers,
    /// or document text in error responses. Only known machine codes pass through.
    public static func httpFailure(status: Int, body: Data) -> VoiceFailure {
        let guidance = switch status {
        case 401, 403: "请检查 API Key 和模型权限。"
        case 404: "请检查 API 基础地址和模型名称。"
        case 413: "录音或文本过长，请缩短后重试。"
        case 429: "请求过于频繁或额度不足，请稍后重试。"
        case 400, 422: "请求参数不受支持，请检查接口模式、模型和音色。"
        default: "请稍后重试。"
        }
        var code = ""
        if body.count <= 8192,
           let json = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any],
           let error = json["error"] as? [String: Any],
           let value = (error["code"] as? String) ?? (error["type"] as? String),
           safeCodes.contains(value) {
            code = "（\(value)）"
        }
        return VoiceFailure("语音服务返回 HTTP \(status)\(code)。\(guidance)")
    }

    public static func transcriptionText(mode: VoiceMode, body: Data) throws(VoiceFailure) -> String {
        guard let json = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] else {
            throw VoiceFailure("语音服务返回了无效响应。")
        }
        let value: Any? = switch mode {
        case .mimo: ((json["choices"] as? [[String: Any]])?.first?["message"] as? [String: Any])?["content"]
        case .openai: json["text"]
        }
        let text = (value as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !text.isEmpty else { throw VoiceFailure("没有识别到文字，可以重试或重新录音。") }
        return text
    }

    /// Both modes explicitly request WAV; JSON or arbitrary content is never handed to the player.
    public static func speechAudio(mode: VoiceMode, body: Data) throws(VoiceFailure) -> Data {
        var audio = body
        if mode == .mimo {
            guard let json = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] else {
                throw VoiceFailure("语音合成返回了无效响应。")
            }
            let message = (json["choices"] as? [[String: Any]])?.first?["message"] as? [String: Any]
            guard let encoded = (message?["audio"] as? [String: Any])?["data"] as? String else {
                throw VoiceFailure("语音服务没有返回音频。")
            }
            guard let decoded = Data(base64Encoded: encoded) else { throw VoiceFailure("语音服务返回了无效音频。") }
            audio = decoded
        }
        guard audio.count >= 44,
              audio.prefix(4).elementsEqual("RIFF".utf8),
              audio.dropFirst(8).prefix(4).elementsEqual("WAVE".utf8)
        else { throw VoiceFailure("语音服务没有返回有效的 WAV 音频。") }
        return audio
    }

    // MARK: Recording

    /// Rewrites a recorder's WAV (which may carry `FLLR`/`LIST` chunks or a stale RIFF size)
    /// as a canonical 44-byte-header mono PCM16 file the speech services accept.
    public static func canonicalWAV(_ file: Data) throws(VoiceFailure) -> Data {
        let bytes = [UInt8](file)
        func u32(_ offset: Int) -> Int {
            Int(bytes[offset]) | Int(bytes[offset + 1]) << 8 | Int(bytes[offset + 2]) << 16 | Int(bytes[offset + 3]) << 24
        }
        func u16(_ offset: Int) -> Int { Int(bytes[offset]) | Int(bytes[offset + 1]) << 8 }
        func tag(_ offset: Int) -> String { String(decoding: bytes[offset..<offset + 4], as: UTF8.self) }
        guard bytes.count >= 12, tag(0) == "RIFF", tag(8) == "WAVE" else { throw VoiceFailure("无法读取录音。") }
        var offset = 12
        var format: (channels: Int, rate: Int, bits: Int, encoding: Int)?
        var samples: ArraySlice<UInt8>?
        while offset + 8 <= bytes.count {
            let id = tag(offset)
            let size = u32(offset + 4)
            let start = offset + 8
            let end = min(bytes.count, start + size)
            if id == "fmt ", end - start >= 16 {
                format = (u16(start + 2), u32(start + 4), u16(start + 14), u16(start))
            } else if id == "data" {
                samples = bytes[start..<end]
                break
            }
            offset = start + size + (size % 2)
        }
        guard let format, var samples, format.encoding == 1 || format.encoding == 0xFFFE,
              format.channels == 1, format.bits == 16, format.rate > 0
        else { throw VoiceFailure("录音格式不受支持。") }
        if samples.count % 2 == 1 { samples = samples.dropLast() }
        guard samples.count >= format.rate * 2 / 5 else { throw VoiceFailure("录音太短，请重新录音。") }
        var output = Data(capacity: 44 + samples.count)
        func append32(_ value: Int) { withUnsafeBytes(of: UInt32(value).littleEndian) { output.append(contentsOf: $0) } }
        func append16(_ value: Int) { withUnsafeBytes(of: UInt16(value).littleEndian) { output.append(contentsOf: $0) } }
        output.append(contentsOf: Array("RIFF".utf8)); append32(36 + samples.count); output.append(contentsOf: Array("WAVE".utf8))
        output.append(contentsOf: Array("fmt ".utf8)); append32(16); append16(1); append16(1)
        append32(format.rate); append32(format.rate * 2); append16(2); append16(16)
        output.append(contentsOf: Array("data".utf8)); append32(samples.count)
        output.append(contentsOf: samples)
        return output
    }
}
