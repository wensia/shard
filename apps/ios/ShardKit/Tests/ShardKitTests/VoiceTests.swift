import Foundation
import Testing
@testable import ShardKit

@Suite struct VoiceTests {
    private func settings(_ mode: VoiceMode = .mimo, _ base: String = "https://api.example.com/v1") -> VoiceSettings {
        VoiceSettings(mode: mode, baseUrl: base, transcriptionModel: "asr", speechModel: "tts", voice: "冰糖")
    }

    private func json<T>(_ request: URLRequest, as _: T.Type = T.self) throws -> T? {
        guard let body = request.httpBody else { return nil }
        return try JSONSerialization.jsonObject(with: body) as? T
    }

    private func failure(_ body: () throws -> Void) -> String? {
        do { try body(); return nil } catch { return (error as? VoiceFailure)?.message ?? "\(error)" }
    }

    private func wav(rate: Int = 16_000, channels: Int = 1, samples: Int = 16_000, extraChunk: Bool = false) -> Data {
        var data = Data()
        func u32(_ value: Int) { withUnsafeBytes(of: UInt32(value).littleEndian) { data.append(contentsOf: $0) } }
        func u16(_ value: Int) { withUnsafeBytes(of: UInt16(value).littleEndian) { data.append(contentsOf: $0) } }
        let payload = samples * 2 * channels
        data.append(contentsOf: Array("RIFF".utf8)); u32(0); data.append(contentsOf: Array("WAVE".utf8))
        data.append(contentsOf: Array("fmt ".utf8)); u32(16); u16(1); u16(channels); u32(rate); u32(rate * 2 * channels); u16(2 * channels); u16(16)
        if extraChunk {
            // Core Audio pads with an FLLR chunk before the samples.
            data.append(contentsOf: Array("FLLR".utf8)); u32(5); data.append(contentsOf: [0, 0, 0, 0, 0, 0])
        }
        data.append(contentsOf: Array("data".utf8)); u32(payload)
        data.append(Data((0..<payload).map { UInt8($0 % 251) }))
        return data
    }

    @Test func settingsNormalizeLikeTheDesktop() throws {
        let normalized = try VoiceContract.normalize(settings(.mimo, "  HTTPS://API.Example.com:443/v1/  "))
        #expect(normalized.baseUrl == "https://api.example.com/v1")
        #expect(try VoiceContract.normalize(settings(.mimo, "http://127.0.0.1:8080/v1")).baseUrl == "http://127.0.0.1:8080/v1")
        #expect(failure { _ = try VoiceContract.normalize(settings(.mimo, "http://api.example.com/v1")) } == "API 地址需使用 HTTPS；本机服务可使用 HTTP。")
        #expect(failure { _ = try VoiceContract.normalize(settings(.mimo, "https://user:pw@api.example.com/v1")) } != nil)
        #expect(failure { _ = try VoiceContract.normalize(settings(.mimo, "https://api.example.com/v1?key=x")) } != nil)
        #expect(failure { _ = try VoiceContract.normalize(settings(.mimo, "https://api.example.com/v1/chat/completions")) }?.contains("基础地址") == true)
        var blank = settings()
        blank.voice = "  "
        #expect(failure { _ = try VoiceContract.normalize(blank) } == "请填写有效的语音模型和音色。")
    }

    @Test func previewVoiceNamesFollowTheSettingsRules() throws {
        #expect(try VoiceContract.name("  茉莉 ") == "茉莉")
        for invalid in ["", "   ", "a\nb", String(repeating: "x", count: 257)] {
            #expect(failure { _ = try VoiceContract.name(invalid) } == "请填写有效的语音模型和音色。")
        }
    }

    @Test func keysAreScopedPerEndpointAndHeaderSafe() throws {
        let a = VoiceContract.keyAccount(for: settings(.mimo, "https://a.example.com/v1"))
        #expect(a.hasPrefix("endpoint-") && a.count == "endpoint-".count + 64)
        #expect(a != VoiceContract.keyAccount(for: settings(.mimo, "https://b.example.com/v1")))
        #expect(try VoiceContract.validateKey("  sk-123  ") == "sk-123")
        #expect(try VoiceContract.validateKey("   ") == nil)
        #expect(failure { _ = try VoiceContract.validateKey("sk-\n123") } == "API Key 格式无效。")
        #expect(failure { _ = try VoiceContract.validateKey("密钥") } == "API Key 格式无效。")
    }

    @Test func sessionsAndSpeechTextAreBounded() throws {
        try VoiceContract.validateSessionID("0b6c1f3e-9a7d-4a8e-b2a1-1c2d3e4f5a6b")
        #expect(failure { try VoiceContract.validateSessionID("../x") } == "语音会话无效。")
        #expect(failure { try VoiceContract.validateSessionID("") } == "语音会话无效。")
        #expect(try VoiceContract.speechText("  你好  ") == "你好")
        #expect(failure { _ = try VoiceContract.speechText(String(repeating: "字", count: 1501)) } == "每段朗读内容应为 1–1500 字。")
        #expect(try VoiceContract.speechText(String(repeating: "字", count: 1500)).count == 1500)
    }

    @Test func mimoRequestsUseInputAudioAndAssistantSpeech() throws {
        let audio = wav()
        let asr = try VoiceContract.transcriptionRequest(settings: settings(), key: "sk-1", wav: audio)
        #expect(asr.url?.absoluteString == "https://api.example.com/v1/chat/completions")
        #expect(asr.value(forHTTPHeaderField: "Authorization") == "Bearer sk-1")
        let body = try #require(try json(asr, as: [String: Any].self))
        #expect(body["model"] as? String == "asr")
        #expect((body["asr_options"] as? [String: String])?["language"] == "auto")
        let content = try #require(((body["messages"] as? [[String: Any]])?.first?["content"]) as? [[String: Any]])
        let data = try #require((content.first?["input_audio"] as? [String: String])?["data"])
        #expect(data == "data:audio/wav;base64," + audio.base64EncodedString())

        let tts = try VoiceContract.speechRequest(settings: settings(), key: "sk-1", text: "朗读")
        let speech = try #require(try json(tts, as: [String: Any].self))
        #expect((speech["messages"] as? [[String: String]])?.first == ["role": "assistant", "content": "朗读"])
        #expect(speech["audio"] as? [String: String] == ["format": "wav", "voice": "冰糖"])
    }

    @Test func openAIRequestsUseMultipartAndSpeechEndpoint() throws {
        let asr = try VoiceContract.transcriptionRequest(settings: settings(.openai), key: "sk-2", wav: wav(samples: 4000))
        #expect(asr.url?.path == "/v1/audio/transcriptions")
        #expect(asr.value(forHTTPHeaderField: "Content-Type")?.hasPrefix("multipart/form-data; boundary=") == true)
        let multipart = try #require(asr.httpBody)
        let text = String(decoding: multipart, as: UTF8.self)
        #expect(text.contains("name=\"model\"\r\n\r\nasr\r\n"))
        #expect(text.contains("name=\"response_format\"\r\n\r\njson\r\n"))
        #expect(text.contains("filename=\"recording.wav\"\r\nContent-Type: audio/wav"))

        let tts = try VoiceContract.speechRequest(settings: settings(.openai), key: "sk-2", text: "朗读")
        #expect(tts.url?.path == "/v1/audio/speech")
        let body = try #require(try json(tts, as: [String: String].self))
        #expect(body == ["model": "tts", "input": "朗读", "voice": "冰糖", "response_format": "wav"])
    }

    @Test func httpErrorsNeverEchoUpstreamBodies() {
        let leaked = Data(#"{"error":{"code":"invalid_api_key","message":"key sk-secret is wrong for 正文"}}"#.utf8)
        let message = VoiceContract.httpFailure(status: 401, body: leaked).message
        #expect(message == "语音服务返回 HTTP 401（invalid_api_key）。请检查 API Key 和模型权限。")
        let unknown = Data(#"{"error":{"code":"sk-secret"}}"#.utf8)
        #expect(VoiceContract.httpFailure(status: 500, body: unknown).message == "语音服务返回 HTTP 500。请稍后重试。")
    }

    @Test func responsesAreParsedAndValidated() throws {
        let mimo = Data(#"{"choices":[{"message":{"content":"  识别文字 "}}]}"#.utf8)
        #expect(try VoiceContract.transcriptionText(mode: .mimo, body: mimo) == "识别文字")
        #expect(try VoiceContract.transcriptionText(mode: .openai, body: Data(#"{"text":"hello"}"#.utf8)) == "hello")
        #expect(failure { _ = try VoiceContract.transcriptionText(mode: .openai, body: Data(#"{"text":" "}"#.utf8)) } == "没有识别到文字，可以重试或重新录音。")

        let audio = wav(samples: 100)
        let encoded = Data(#"{"choices":[{"message":{"audio":{"data":"\#(audio.base64EncodedString())"}}}]}"#.utf8)
        #expect(try VoiceContract.speechAudio(mode: .mimo, body: encoded) == audio)
        #expect(try VoiceContract.speechAudio(mode: .openai, body: audio) == audio)
        #expect(failure { _ = try VoiceContract.speechAudio(mode: .openai, body: Data(#"{"error":"x"}"#.utf8)) } == "语音服务没有返回有效的 WAV 音频。")
        #expect(failure { _ = try VoiceContract.speechAudio(mode: .mimo, body: Data(#"{"choices":[]}"#.utf8)) } == "语音服务没有返回音频。")
    }

    @Test func recorderFilesBecomeCanonicalMonoPCM() throws {
        let canonical = try VoiceContract.canonicalWAV(wav(samples: 8000, extraChunk: true))
        #expect(canonical.count == 44 + 16_000)
        #expect(canonical.prefix(4).elementsEqual("RIFF".utf8))
        #expect(canonical.dropFirst(36).prefix(4).elementsEqual("data".utf8))
        #expect(canonical.dropFirst(44) == wav(samples: 8000).dropFirst(44))
        #expect(failure { _ = try VoiceContract.canonicalWAV(wav(samples: 1000)) } == "录音太短，请重新录音。")
        #expect(failure { _ = try VoiceContract.canonicalWAV(wav(channels: 2)) } == "录音格式不受支持。")
        #expect(failure { _ = try VoiceContract.canonicalWAV(Data("nope".utf8)) } == "无法读取录音。")
    }
}
