# 语音输入与朗读

桌面端在速记、片段编辑器（含禅模式）、片段卡片及资料库 Markdown 提供语音输入和朗读，配置位于设置「AI」分区的「语音输入与朗读」分组；未配置密钥时，录音或朗读入口会直接打开设置并定位到 AI 分区。不涉及 PDF/Word 附件、密匣、浏览器或 iOS 正式支持。

## 使用

- 在语音设置选择 MiMo 或 OpenAI 兼容模式，填写 Base URL、API Key、识别模型、合成模型和音色，保存后可分别测试识别和试听。Base URL 包含版本前缀，不包含具体接口路径。
- MiMo 默认使用 `https://api.xiaomimimo.com/v1`、`mimo-v2.5-asr`、`mimo-v2.5-tts` 和「冰糖」。代理地址可自定义，接口模式不依赖域名识别。
- 点击麦克风开始录音，再点结束并识别；最长两分钟。识别结果替换录音开始时的选区或插入光标位置，可撤销，不额外润色或自动提交记录。资料库及禅模式保留原有自动保存机制。
- 录音期间仅锁定当前编辑区。失败可重试，取消或切换内容会丢弃会话；已被外部更新的文档不会被旧选区覆盖。
- 朗读优先使用当前选区，否则使用全文。按正文顺序朗读标题、段落、列表和表格，跳过元数据、代码块及附件地址。播放器支持暂停、继续、停止和倍速。

## 数据与运行边界

非敏感配置在应用配置目录的 `voice-settings.json`；密钥保存在系统钥匙串，并按服务地址隔离。更换地址后需要该地址对应的密钥，旧地址密钥不自动发送到新地址。前端只获得 `hasKey`，不持久化密钥。录音和合成音频仅临时保存在内存，不进入 vault、Git 或日志。

录音由 CPAL 专用线程采集；后台转成单声道 16 kHz PCM WAV。网络请求使用异步 Tauri command，支持会话取消、超时和响应大小上限，不自动重试或跨服务降级。

会话生命周期不依赖前端收尾：识别成功即释放该录音（失败保留，可原样重试）；webview 开始加载页面或窗口关闭时，后端取消该页面名下的录音与合成并关闭麦克风；闲置 10 分钟且不在请求中的会话，在下次开始语音操作时淘汰，淘汰不留取消记录，长时间暂停后继续朗读会以同一会话号重新建立。

大文档正文提取在 Worker 中执行。合成结果由后端校验为 WAV 后经 `tauri::ipc::Response` 以原始字节返回，页面直接拿到 `ArrayBuffer` 交给播放器，不经 base64 与 JSON。合成不走流式（MiMo 流式返回 24 kHz PCM 分片，直接用 Web Audio 播放时倍速会变调，与现有倍速控制冲突），因此首段不超过 80 个 Unicode 字符以尽快出声，其余每段最多 400 个；在句号、问叹号、分号、省略号、换行及后接空白或引号的英文句点处断句，句末引号随句，小数与网址不拆；过长的句子在后半段最近的逗号、顿号、冒号或空格处断开。播放当前段时只预取下一段。

MiMo 通过 `/chat/completions` 使用 `input_audio` 识别；合成正文放在 assistant 消息中并读取 `message.audio.data`（后端解码校验后以字节返回页面）。通用模式使用 multipart `/audio/transcriptions` 和 `/audio/speech`。两种模式均请求 WAV 合成结果。

## 开源参考

- [Murmur](https://github.com/kurenn/murmur)（MIT）：参考专用录音线程、采样转换和 OpenAI 兼容转录的职责划分。
- [Readest](https://github.com/readest/readest)（AGPL）：仅参考分段朗读、播放控制及 MiMo 适配的行为，未复制其实现。
- [MiMo 语音识别](https://mimo.mi.com/docs/en-US/api/audio/Speech-Recognition)、[MiMo 语音合成](https://mimo.mi.com/docs/en-US/quick-start/usage-guide/audio/speech-synthesis-v2.5)：请求与响应契约。

## 验证

语音正文单元测试位于 `src/lib/voice-text.test.ts`；后台测试位于 `src-tauri/src/voice.rs` 与 `voice_recording.rs`；UI 覆盖在 `tests/ui/voice-local.spec.ts`、`voice-playback.spec.ts` 和 `rich-library.spec.ts`。HTTP 测试使用本机 fixture，不访问真实模型服务。

发布前还需在打包 App 中手动完成麦克风授权、真实录音与 MiMo 识别/合成、系统钥匙串持久化验证。浏览器 mock 和 HTTP fixture 通过不代表这些实机验证已完成。

2026-11-04 验证：`pnpm test:unit` 868 项、语音 Rust 测试 10 项、上述语音及相关编辑器/焦点 UI 回归 142 项通过；`pnpm build`、`cargo check -p shard`、`git diff --check` 通过。已生成 `target/debug/bundle/macos/Shard.app`，检查麦克风说明，并对测试包进行本地 ad-hoc 签名和 audio-input entitlement 校验；未安装、未发布，也未执行上述真实音频与密钥实测。
