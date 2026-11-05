# 语音输入与朗读

macOS 桌面和 iOS App 在速记、片段编辑器（含禅模式）、片段卡片及资料库 Markdown 提供语音输入和朗读，配置位于设置的「语音」分区；未配置密钥时，录音或朗读入口会直接打开同一份语音设置。两端共用 `src/features/voice/` 的界面，录音、密钥与语音服务请求各由原生侧实现。网页版没有原生录音与钥匙串，不显示语音入口和语音设置。不涉及 PDF/Word 附件与密匣。

## 平台分工

| 端 | 调用通道 | 录音 | 密钥与设置 |
| --- | --- | --- | --- |
| macOS 桌面 | Tauri 本机命令（连接 VPS 时也不经服务器转发） | CPAL 专用线程，转 16 kHz 单声道 PCM WAV | 系统钥匙串 `dev.shard.desktop.voice`；应用配置目录 `voice-settings.json` |
| iOS App | 原生桥 `type: "voice"`（`src/lib/ios-native.ts` → `WebAppView` → `VoiceService`） | `AVAudioRecorder` 直接录 16 kHz 单声道 PCM16，再规整成 44 字节头的标准 WAV | iOS 钥匙串 `dev.shard.mobile.voice`（仅本机、解锁后可读）；Application Support `Voice/voice-settings.json` |

命令名与参数在两端一致：`voice_get_settings`、`voice_save_settings`、`voice_start_recording`、`voice_transcribe`、`voice_synthesize`、`voice_cancel`；录音到达上限或被中断时，桌面发 Tauri 事件、iOS 发 `shard:ios-event`，类型都是 `voice-recording-stopped`。语音配置与服务器账号无关，每台设备各自配置一次密钥，密钥不经过 VPS。

## 使用

- 在语音设置选择 MiMo 或 OpenAI 兼容模式，填写 Base URL、API Key、识别模型、合成模型和音色，保存后可分别测试识别和试听。Base URL 包含版本前缀，不包含具体接口路径。
- MiMo 默认使用 `https://api.xiaomimimo.com/v1`、`mimo-v2.5-asr`、`mimo-v2.5-tts` 和「冰糖」。代理地址可自定义，接口模式不依赖域名识别。
- 点击麦克风开始录音，再点结束并识别；最长两分钟。识别结果替换录音开始时的选区或插入光标位置，可撤销，不额外润色或自动提交记录。资料库及禅模式保留原有自动保存机制。
- 录音期间仅锁定当前编辑区。失败可重试，取消或切换内容会丢弃会话；已被外部更新的文档不会被旧选区覆盖。
- 速记、编辑器和资料库 Markdown 的工具栏有朗读按钮；片段卡片的朗读在「片段操作」菜单里（卡片是内容列与操作列横排，常驻按钮会挤窄每张卡片的正文）。
- 朗读优先使用当前选区，否则使用全文。按正文顺序朗读标题、段落、列表和表格，跳过元数据、代码块及附件地址。播放器支持暂停、继续、停止和倍速。

## 数据与运行边界

非敏感配置在应用配置目录的 `voice-settings.json`；密钥保存在系统钥匙串，并按服务地址隔离。更换地址后需要该地址对应的密钥，旧地址密钥不自动发送到新地址。前端只获得 `hasKey`，不持久化密钥。录音和合成音频仅临时保存在内存，不进入 vault、Git 或日志。

桌面录音由 CPAL 专用线程采集，后台转成单声道 16 kHz PCM WAV；网络请求使用异步 Tauri command。iOS 只在录音期间把音频会话切到录音模式，结束后恢复原类别并通知其他应用恢复播放；来电等系统中断、耳机拔出或切到后台都会结束录音并提示重新录。激活音频会话会阻塞，iOS 的录音器只在 `VoiceService` 的执行器上运行，不占主线程。两端都支持会话取消、超时和响应大小上限，不跟随重定向，不自动重试或跨服务降级。

会话生命周期不依赖前端收尾：识别成功即释放该录音（失败保留，可原样重试）；webview 开始加载页面或窗口关闭时（iOS 为页面导航、网页进程终止或界面卸载），原生侧取消该页面名下的录音与合成并关闭麦克风；闲置 10 分钟且不在请求中的会话，在下次开始语音操作时淘汰，淘汰不留取消记录，长时间暂停后继续朗读会以同一会话号重新建立。

大文档正文提取在 Worker 中执行。合成结果由原生侧校验为 WAV 后返回：桌面经 `tauri::ipc::Response` 以原始字节返回，页面直接拿到 `ArrayBuffer`；iOS 的脚本消息只能传可序列化值，原生桥统一用 base64 承载（编码在后台线程，页面分块解码并让出主线程），解码后同样是 `ArrayBuffer`。iOS 的 WKWebView 允许无手势连续播放，后续分段不需要再次点按。合成不走流式（MiMo 流式返回 24 kHz PCM 分片，直接用 Web Audio 播放时倍速会变调，与现有倍速控制冲突），因此首段不超过 80 个 Unicode 字符以尽快出声，其余每段最多 400 个；在句号、问叹号、分号、省略号、换行及后接空白或引号的英文句点处断句，句末引号随句，小数与网址不拆；过长的句子在后半段最近的逗号、顿号、冒号或空格处断开。播放当前段时只预取下一段。

MiMo 通过 `/chat/completions` 使用 `input_audio` 识别；合成正文放在 assistant 消息中并读取 `message.audio.data`（后端解码校验后以字节返回页面）。通用模式使用 multipart `/audio/transcriptions` 和 `/audio/speech`。两种模式均请求 WAV 合成结果。

## 开源参考

- [Murmur](https://github.com/kurenn/murmur)（MIT）：参考专用录音线程、采样转换和 OpenAI 兼容转录的职责划分。
- [Readest](https://github.com/readest/readest)（AGPL）：仅参考分段朗读、播放控制及 MiMo 适配的行为，未复制其实现。
- [MiMo 语音识别](https://mimo.mi.com/docs/en-US/api/audio/Speech-Recognition)、[MiMo 语音合成](https://mimo.mi.com/docs/en-US/quick-start/usage-guide/audio/speech-synthesis-v2.5)：请求与响应契约。

## 验证

语音正文单元测试位于 `src/lib/voice-text.test.ts`；桌面后台测试位于 `src-tauri/src/voice.rs` 与 `voice_recording.rs`；iOS 的请求/响应契约、设置规范化与 WAV 规整测试位于 `apps/ios/ShardKit/Tests/ShardKitTests/VoiceTests.swift`（`swift test --filter VoiceTests`）。UI 覆盖在 `tests/ui/voice-local.spec.ts`、`voice-playback.spec.ts`、`rich-library.spec.ts`（桌面）、`voice-ios.spec.ts`（页面内假原生桥）和 `web-auth.spec.ts`（网页不显示语音）。

iOS 原生端到端用 `WebWorkspaceUITests.testNativeVoiceReadAloudAndDictationStayInTheHost`：先起 `apps/ios/scripts/web-server-fixture.py`（临时 Rust 服务）和 `apps/ios/scripts/voice-service-fixture.py`（127.0.0.1:18794 的假 MiMo 接口），再 `xcrun simctl privacy <模拟器> grant microphone dev.shard.mobile`，在独立模拟器上运行。HTTP 测试使用本机 fixture，不访问真实模型服务。

发布前还需在打包 App 中手动完成麦克风授权、真实录音与 MiMo 识别/合成、系统钥匙串持久化验证。浏览器 mock 和 HTTP fixture 通过不代表这些实机验证已完成。

2026-11-04 验证：`pnpm test:unit` 868 项、语音 Rust 测试 10 项、上述语音及相关编辑器/焦点 UI 回归 142 项通过；`pnpm build`、`cargo check -p shard`、`git diff --check` 通过。已生成 `target/debug/bundle/macos/Shard.app`，检查麦克风说明，并对测试包进行本地 ad-hoc 签名和 audio-input entitlement 校验；未安装、未发布，也未执行上述真实音频与密钥实测。

2026-11-05 移植到 `feat/voice-mobile`（设备上 VPS 桌面版与 iOS App 所在的线）后的验证：`pnpm build`、前端单测 1120 项、语音 Rust 测试 14 项、ShardKit 61 项（含 VoiceTests 8 项）通过；全量 Playwright 829 项通过，失败项均为该线基线失败或单独重跑通过的偶发；iOS 模拟器真实 WKWebView 全套 6 项 UI 测试通过，其中语音端到端覆盖原生设置保存进钥匙串、朗读无手势自动播放、16 kHz 单声道录音识别插入。Codex 只读审查提出的响应边下载边限额、退役页面拒收迟到命令、启动回复与停止事件竞态、底部导航观察器重绑四项已修复。Mac 包需在打包后以 ad-hoc + hardened runtime 重签并带 `Entitlements.plist`（Tauri 未配置签名身份时只留链接器签名，没有 audio-input 权限）。仍未在真机上用真实 MiMo 密钥验证。
