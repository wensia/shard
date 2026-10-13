# Shard iOS 首版实施计划

状态：2026-10-13 用户批准，分支 `feat/ios-app`。M0–M3 已完成并验证，M4 待真机安装（见 §6）。本文修订了 [产品框架](./product-framework.md) 与 [碎片版设计](./fragment-only-design.md) 中「不开发独立手机 App」的旧决定：手机端在聊天 Agent 之外，增加一个原生 iOS App，承担浏览与快速记录。

## 1. 范围

| 首版做 | 首版不做 |
| --- | --- |
| 时间线、标签、搜索浏览碎片；浏览 `notes/` 文档 | 编辑已有碎片或笔记 |
| 快速记录新碎片（离线可记，联网推送） | 密匣（不下载、不解密，拦截 `#密匣`） |
| 正文渲染与桌面一致，图片按需加载 | 大纲、流程图、导图、画布、数据集的结构化视图 |
| 暗色模式 | 分享扩展、小组件、App Store 上架 |

## 2. 关键决策

1. **原生 SwiftUI**，iOS 17+。工程用 XcodeGen 从 `apps/ios/project.yml` 生成，`.xcodeproj` 不入库。
2. **同步走 GitHub REST API，不在手机上跑 git。** 读：`git/trees/{branch}?recursive=1` 取路径与 blob SHA，与本地缓存比对后只下载变化的 blob；写：每条新碎片一次 `PUT contents/{path}`，服务端直接生成提交。桌面同步是「fetch → rebase --autostash → push」，手机只新增唯一路径的文件，不产生冲突。同步层是协议 `VaultRemote`，以后可换 Gitee API 或 libgit2。
3. **认证**：GitHub 细粒度令牌，只授权 vault 仓库的 Contents 读写，存 iOS 钥匙串；用户在 App 设置页直接填写。
4. **格式与桌面逐字节对齐。** 碎片 ID、`fragments/YYYY/MM/{id}.md`、frontmatter 序列化、`#标签` 提取与规范化从 `crates/shard-core` 移植到 Swift，`source: ios`。标签规则现在有三处实现（TS 真相源、Rust、Swift），由跨语言对照样例约束：`crates/shard-core/tests/ios_fixtures.rs` 用 Rust 实现校验 `apps/ios/ShardKit/Tests/ShardKitTests/Fixtures/format-fixtures.json`，Swift 测试读同一份文件逐条比对；`SHARD_WRITE_IOS_FIXTURES=1` 时由 Rust 重写该文件。
5. **渲染**：列表原生；详情用 WKWebView 加载 `apps/ios/renderer`（Vite 打包 `@shard/markdown`，碎片用 `MarkdownContent`，笔记用 `MarkdownDocument`）。网页与图片经自定义 scheme `shard://` 提供，保证 ES module 与 Worker 同源可加载。
6. **离线记录**：新碎片先进本地待发队列并立即出现在时间线（状态「待同步」）；推送按路径幂等——若服务端已存在同路径且内容一致，视为成功。
7. **排除**：`lockbox/`、`.shard/`、`.trash/`、`.git*` 永不下载。

## 3. 目录

```
apps/ios/
  project.yml            XcodeGen 工程定义
  scripts/               渲染包构建、工程生成
  ShardKit/              Swift Package：格式、索引、同步（swift test 可在 macOS 跑）
  Shard/                 SwiftUI App
  renderer/              @shard/markdown 网页渲染包（pnpm workspace 成员）
```

## 4. 里程碑

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| M0 | 工程骨架、渲染包、空壳 App | 模拟器启动，渲染一段示例 Markdown |
| M1 | 格式核心与跨语言对照样例 | `swift test` 与 `cargo test -p shard-core` 通过 |
| M2 | GitHub 读取、缓存、时间线/标签/搜索/详情 | 模拟器浏览真实仓库 |
| M3 | 记录、待发队列、推送 | 手机记一条，桌面 Shard 同步后出现 |
| M4 | 真机安装、暗色、打磨；更新产品文档旧决定 | 用户 iPhone 可用 |

## 5. 风险

- 大陆移动网络访问 GitHub 不稳定：首版接受，同步层可替换。
- 令牌安全：细粒度、单仓库、钥匙串存储，不进日志与仓库。
- 格式漂移：对照样例 + 双向测试；改标签规则须三处同改。

## 6. 进度与验证记录

| 阶段 | 验证 |
| --- | --- |
| M0 | 模拟器渲染碎片、文档与 6 万字长文（走解析 Worker），亮暗两套 kiln 配色 |
| M1 | `swift test`：标签提取/规范化、近百个 YAML 标量、时间格式、完整碎片文件与 Rust 逐字节一致；`cargo test -p shard-core` 通过 |
| M2 | `ShardUITests` 经 `scripts/mock-github.py` 浏览真实 vault 克隆；`LiveGitHubTests` 用真实 GitHub API 只读同步 68 个文件，lockbox/.trash/.shard 均未下载 |
| M3 | UI 测试记录并推送；桌面克隆 `fetch` + `rebase --autostash` 无冲突，`shard --read` 读出 `source: ios`；队列测试覆盖响应丢失重试与同路径冲突 |
| M4 | Release 构建签名通过（团队 LN8XZQ6ZX7）；真机安装待手机解锁 |

方言 v2（2026-10-13 合入主线）：碎片源码一行显示一行、空一行显示一行空白，桌面卡片不再用 `compactParagraphs`；iOS 渲染页与列表预览同步去掉空行折叠。手机记录的正文本来就是一行一个换行，与 v2 一致，无需迁移。

已知限制：手机端不编辑已有内容、不支持密匣与图片附件上传；GitHub 在大陆移动网络可能不稳定；搜索不含拼音匹配。
