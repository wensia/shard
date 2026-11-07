# 服务端自动标签

自动分类由 `shard-server` 统一执行。Web、macOS 服务器模式和 iOS 服务器模式提交的内容使用同一套规则；客户端不调用模型。

## 行为

- 开启后，后台分批处理已有和新增的未分类公开碎片与笔记。`inbox`、`note`、`document`、`outline`、`flowchart` 是系统标记，不计作主题标签。
- 每条内容可有多个标签，通常 1–3 个、最多 5 个；优先复用资料库已有标签，仅在没有合适主题时新建。
- 已有主题标签、密匣、回收站、隐藏内容及空正文不参与分类。附件二进制不发送，模型不访问正文链接。
- 只修改标签，保留原正文、内容类型及其他元数据。请求期间用户改了内容、手动加了标签或移走内容，则放弃过期结果。
- 正常编辑正文时保留只存在于标签字段中的标签；专用标签修改仍可删除它们。同一正文已经处理过时，手动删除自动标签不会立即触发重打。
- 模型返回空标签会记录为已处理；失败有限重试。处理状态持久化在内容数据库中，重启后继续。
- 保存内容不等待模型。结果通过现有版本历史与同步通道传播；Web/macOS 经 SSE 更新，iOS 在后续同步时取得标签。

每轮最多检查 32 条新版本、处理 1 条内容，轮询间隔 5 秒。单文件上限 128 KiB。词表从最近修改的最多 512 篇已有标签的候选文档中筛出公开内容，每篇只读最多 16 KiB 的元数据头，再按使用次数选取最多 200 个主题标签、合计最多 8,000 字符。超过文件上限的内容保持原样；较旧或低频标签可能不在本次 Prompt 的词表中。

临时错误最多尝试 3 次，两次重试分别等待 30、60 秒；失败或空结果不会阻挡其他条目。正文发生变化后可以重新分类，仅修改标签或时间不会反复分类。

## 配置

默认关闭。启用会将待分类的公开内容和现有主题标签发送给配置的模型服务，并产生该服务的调用费用。

### 在 App 里配置（推荐）

网页版、macOS（连接服务器）和 iOS 都在「设置 → AI → 自动标签」里配置：开关、接口地址、模型名称、API Key，可先「测试连接」。保存后立即生效，不用重启服务。

- 配置保存在服务器数据目录的 `ai-settings.json`（权限 600），不进内容库、导出包和同步。API Key 只写不读：界面只显示「已保存」，留空表示保留原值。
- App 里只能填公网 HTTPS 地址；本机或内网的模型服务（如 `http://127.0.0.1:11434/v1`）只能用下面的环境变量配置，避免一个登录会话就能让服务器访问内网。
- 设置页显示后台状态（运行中 / 已暂停 / 已关闭）、最近一次成功或失败，以及已处理、排队、跳过的条数。

### 用环境变量配置（运维托管）

`SHARD_AUTO_TAG_ENABLED=true` 时以环境变量为准，App 设置里只读显示；为 `false` 或不设置时使用 App 里保存的配置。

| 环境变量 | 用途 |
| --- | --- |
| `SHARD_AUTO_TAG_ENABLED` | `true` 开启，默认 `false` |
| `SHARD_AUTO_TAG_API_BASE` | Chat Completions API 基础地址，默认 `https://api.openai.com/v1`；不含 `/chat/completions` |
| `SHARD_AUTO_TAG_MODEL` | 模型名称，开启时必填 |
| `SHARD_AUTO_TAG_API_KEY` | 模型密钥，开启时必填，仅服务端读取 |

接口需要支持 `messages`、`response_format: {"type":"json_object"}`、`max_completion_tokens` 和 `store: false`。接入格式参考 [Chat Completions 官方接口](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)。JSON 模式仍须由程序校验结果；它不代替 ID、标签和写入版本检查。

Docker 部署将变量填写到 `/opt/shard/.env`；systemd 部署填写到 `/etc/shard/server.env`。填写密钥后文件权限设为 `600`，重建容器或重启对应服务使配置生效。不要将密钥放进资料库、前端配置或 Git。

HTTP 401/403/404 或重定向视为配置错误，暂停后台分类；在 App 里修改配置后自动恢复（环境变量托管的需改好后重启服务）。HTTP 400/422 先用固定示例再请求一次：示例能通过，说明只是这一篇被拒（超出上下文、触发内容过滤），只跳过这一篇；示例也被拒才按配置错误暂停。内容保存与读取始终不受影响。临时网络错误、超时、HTTP 408/429/5xx 使用有限重试。日志只记录状态与计数，不记录正文、模型原始响应或密钥。

内容没有变化时 worker 不重复扫描候选；候选扫描在只读快照里进行，不占用写连接。正文改动后，旧正文尚在排队的任务直接作废。

## Prompt 与实现入口

- [Prompt 与输入输出示例](auto-tagging-prompt.md)
- [`shard-core::auto_tagging`](../../crates/shard-core/src/auto_tagging.rs)：固定 Prompt、输入与结果校验。
- [`shard-vault::auto_tagging`](../../crates/shard-vault/src/auto_tagging.rs)：公开内容资格检查、版本校验与保真写标签。
- [`shard-store` 任务状态](../../crates/shard-store/src/store/auto_tagging.rs)：分批发现、去重、恢复和重试记录。
- [`shard-server` worker](../../crates/shard-server/src/auto_tagging.rs)：后台调度与同步通知。
- [`模型接口`](../../crates/shard-server/src/tagging_model.rs)：异步 HTTP、超时和响应限制。

这项功能需要部署包含上述实现的服务端并显式启用；本地资料库和金山文档工作区不经过该服务器，因此不属于此自动分类范围。
