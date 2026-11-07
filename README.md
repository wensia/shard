# Shard

Shard 是用于记录与整理 Markdown 碎片和笔记的应用，提供 **iOS App、Web 和 macOS 桌面**三种客户端。

| 客户端 | 使用方式 | 入口 |
| --- | --- | --- |
| **iOS App** | iOS 17+ 的 iPhone 原生应用，连接 Shard 服务器，也保留 GitHub 资料库连接 | [iOS 构建与安装](apps/ios/README.md) |
| **Web** | 浏览器访问部署好的 Shard 站点，使用服务器账号登录 | [Web 与服务端部署](deploy/README.md) |
| **macOS 桌面** | Apple Silicon Mac 安装应用，使用本地资料库或连接 Shard 服务器 | [下载 DMG](https://github.com/wensia/shard/releases/latest) |

Web 与 macOS 共用 React 工作台，iOS 提供原生移动客户端。各端能力、代码入口和发布状态见 [三端说明](docs/dev/platforms.md)。

> 产品方向（2026-09-15）：正在设计只围绕碎片的版本，移除资料库、思维导图、画布与内置多维表格等独立模块（大纲成为碎片内容类型之一，导图是其视图，见 docs/dev/product-framework.md），加入可组合的 Git / 飞书 / 夸克存储目标和 Hermes / OpenClaw 接入。详见 [设计方案](docs/dev/fragment-only-design.md) 与 [实施文档入口](docs/dev/README.md)。目前仅完成方案整理，相关代码移除、数据迁移及新同步能力尚未实施；下文仍描述现有版本。

它借鉴了 [flomo](https://flomoapp.com/) 的核心心智：先把稍纵即逝的想法记下来，让碎片在时间流里自然沉淀，再在需要时回看、整理和连接。Shard 不是 flomo 的复刻，也与 flomo 没有关联。

![Shard 主界面：片段捕捉、时间线、标签和 Git 状态](docs/design/shard-main-screen-concept.png)

截图内容为示例片段，用于展示真实使用场景，不包含私人 vault 数据。

## 下载与安装

### iOS App

当前提供 iOS 17+ 源码，需要使用 Xcode 和自己的 Apple 签名配置构建安装，步骤见 [iOS 文档](apps/ios/README.md)。当前 GitHub Release 不含 IPA。

### Web

访问已部署的 Shard 站点即可使用。自建站点请按 [部署文档](deploy/README.md) 配置服务端和 Web 静态资源；GitHub Releases 提供 Linux x86_64 服务端包。

### macOS 桌面

当前桌面安装包支持：

- macOS Apple Silicon，M1/M2/M3/M4 芯片
- 暂不提供 Intel Mac、Windows、Linux 桌面安装包；Linux 服务端与桌面客户端是不同的发布产物。

安装方式：

1. 到 [GitHub Releases](https://github.com/wensia/shard/releases/latest) 下载最新的 `Shard_*_aarch64.dmg`。
2. 打开 DMG，把 `Shard.app` 拖到 `Applications`。
3. 首次打开如果 macOS 提示“无法验证开发者”，请右键 `Shard.app` 选择“打开”。当前版本尚未配置 Apple Developer ID 签名和 notarization。

## 适合场景

- 产品判断：先记录一个判断和它的背景，不急着写成完整文档。
- 会议摘记：把早会、复盘、客户沟通里的关键句拆成独立片段。
- 用户反馈：保留原话，再用标签连接到后续产品决策。
- 阅读摘录：记录一句启发、一个反问或一个待验证假设。

## 核心理念

Shard 只优化一个动作：快速捕捉灵感。

以下保存流程与功能表描述 **macOS 桌面的本地资料模式**；Web 与 iOS 的存储及功能范围见 [三端说明](docs/dev/platforms.md)。

1. 写下一段想法、摘录、任务或观察。
2. 按 `Cmd+Enter`、`Ctrl+Enter`，或点击发送按钮保存。
3. Shard 在本地 vault 中生成独立 Markdown 文件。
4. 新内容以灵感卡片的形式进入时间线。
5. Git 在后台为这次记录留下提交痕迹。

`Enter` 或 `Shift+Enter` 用于换行，AI 标签和整理能力只作为后置工作流，不阻塞捕捉。

## 主要功能

服务器模式支持[后台自动标签](docs/dev/server-auto-tagging.md)：为未分类的公开内容补充多标签，优先复用现有标签。Web、iOS 和 macOS 服务器模式共用服务端实现；在「设置 → AI」里配置模型并开启（⌘, 打开设置）。分类 [Prompt](docs/dev/auto-tagging-prompt.md) 随代码维护。

- **灵感卡片**：每条片段以卡片形式呈现，按时间倒序查看。
- **Markdown 片段落盘**：每条记录都是独立 Markdown 文件，方便迁移、搜索和二次处理。
- **本地优先 vault**：默认写入 `~/Documents/ShardVault`，不依赖云端服务才能保存。
- **Git-backed 记录流**：保存片段后自动初始化/使用 vault 内的 Git 仓库并提交变更。
- **标签捕捉**：正文中的 `#tag` 会被提取到 frontmatter，同时默认保留 `inbox` 标签。
- **轻量导航**：支持碎片、标签筛选和回收站等入口。
- **桌面应用体验**：基于 Tauri，目标是保持快速、安静、低打扰。

## 功能状态

| 模块 | 状态 |
| --- | --- |
| 快速捕捉 Markdown 片段 | 已实现 |
| 灵感卡片时间线 | 已实现 |
| 标签提取与标签浮层 | 已实现 |
| 本地 vault 与 Git commit | 已实现 |
| Git pull / push 同步入口 | 已实现，需要用户配置 vault remote |
| 回收站软删除与深度编辑 | 已实现 |

## Stack

- Tauri 2
- React 19
- TypeScript
- Tailwind CSS 4
- shadcn/ui with Base UI primitives
- Rust filesystem and Git commands
- SwiftUI / Swift（iOS App）
- Rust / axum / SQLite（Web 与多端共用的服务端）

## Development

### macOS 桌面

```bash
pnpm install
pnpm tauri dev
```

Build:

```bash
pnpm build
pnpm tauri build
```

Build Apple Silicon macOS DMG:

```bash
pnpm build:mac:apple-silicon
```

### Web

安装根目录依赖后，连接本机已启动的 `shard-server` 开发前端：

```bash
SHARD_SERVER_URL=http://127.0.0.1:8787 pnpm dev
```

`pnpm build` 生成 `dist/`，由服务端托管。服务器配置和完整部署见 [部署文档](deploy/README.md)。

### iOS App

在 macOS 上安装根目录依赖后：

```bash
apps/ios/scripts/generate-project.sh
open apps/ios/Shard.xcodeproj
```

XcodeGen、签名配置和测试步骤见 [iOS 文档](apps/ios/README.md)。

### 共享 Markdown 包

Markdown 渲染与纯解析工具位于独立 workspace 包 [`@shard/markdown`](packages/markdown/README.md)。
主项目开发、构建和测试会先构建该包；运行 `pnpm pack:markdown` 可生成供其他产品安装的 `.tgz`。
跨产品 React、样式、业务 adapter 和 Vite Worker 的接入方式见包内文档。

## Vault

In macOS local-vault mode, Shard stores fragments in:

```text
~/Documents/ShardVault
```

Each fragment is an independent Markdown file under:

```text
fragments/YYYY/MM/
```

Shard initializes Git inside the vault on first commit. If Git commit fails, the Markdown file still remains on disk and the app marks the card with a failed status.

Example fragment:

```markdown
---
id: 20260803-050116-e71fe4dc-c91185
created_at: 2026-06-05T00:12:00+08:00
updated_at: 2026-06-05T00:12:00+08:00
tags:
  - inbox
  - product
category: null
ai_status: none
source: desktop
---

一个突然出现的产品想法 #product
```

## 终端快捷创建

此入口面向 macOS 桌面的本地资料库。

安装 Shard.app 并首次启动后，App 会自动安装 `shard` 终端命令。仅当需要向 shell 配置加入 PATH 时，App 才会先征求确认；也可以在设置的「终端命令」中查看状态或卸载。

```bash
shard 今天心情很好
shard #备忘 /任务列表 买咖啡   # 前导 #标签 与 /块命令，其余是正文
pbpaste | shard #摘录          # 没有内容参数时读标准输入
shard -s 银行 房贷             # 搜碎片与资料库笔记，关键词须同时命中；不带关键词列出最近修改
shard -i 银行 房贷             # 在交互界面搜索、预览和编辑；不带关键词显示最近修改
shard -e 2                   # 在终端内编辑上次搜索结果的第 2 条，也可用 id 或关键词
shard -e --external 2        # 强制用外部编辑器
shard --graph-read <碎片id>    # 读取受管图 JSON 与完整文件 fileSha
shard --graph-outline <碎片id> # 将大纲只读导出为两空格缩进列表
```

- 块命令与编辑器 `/` 菜单同名（含拼音缩写）：`/任务列表` `/待办` `/备忘` → `- [ ]`，`/列表` → `-`，`/编号` → `1.`，`/引用` → `>`；多行内容每行一项。
- 资料库依次取 `--vault`、`SHARD_VAULT`、App 设置里的资料库、`~/Documents/ShardVault`。
- 只写文件（`source: cli`），提交交给 App 的检查点。App 运行中会监听资料库，终端、AI 助手或其他编辑器写入后碎片流、资料库树和打开中的数据集实时刷新；App 自己的保存按文件 sha 过滤，不会重复刷新。
- `-s` 的匹配与排序规则同 App 搜索，结果序号可供 `-e` 引用。`-i` 须在终端中运行；`-e` 在标准输入和标准输出均为终端时打开内置编辑器，关键词命中多条时进入搜索页供选择。内置编辑器用 Ctrl+S 保存、Esc 返回、Ctrl+Z 撤销、Ctrl+Y 重做、Ctrl+Q 退出；未保存时返回或退出会询问如何处理。
- `-e --external` 或标准输入、标准输出不全是终端时使用 `$VISUAL`、`$EDITOR`（终端里默认 `vi`；非交互环境未设置编辑器时直接报错，提示改用 `--update`）；图形编辑器须带等待参数，如 `EDITOR='code -w'`。鼠标捕获期间，用 Option（iTerm2）或 Fn（Terminal）拖动可原生选择复制。保存后按正文重算标签；编辑期间文件被改动时不覆盖，退出码为 2。大纲与流程图请使用图命令，密匣只能在 App 中编辑；双链关系会在 App 下次保存该碎片时更新。
- bash 等把 `#` 当注释的 shell 里给标签加引号，或用全角 `＃备忘`。`#密匣` 只能在 App 中保存。
- 图命令直接读写公开的大纲/流程图片段：`--graph-write <碎片id> --expect <fileSha>` 从标准输入读取完整图 JSON，`--graph-set-text <碎片id> <节点id> <文字> --expect <fileSha>` 修改节点文字，`--graph-add-child <碎片id> <父节点id> <文字> --expect <fileSha>` 添加大纲子节点，`--graph-remove <碎片id> <节点id> --expect <fileSha>` 删除大纲子树。
- 所有图写命令都必须使用最近一次 `--graph-read` 返回的 `fileSha`；文件已被其他进程修改时会拒绝写入。图写入只落盘，提交仍由 App 检查点聚合。

### 给 AI 助手使用

Claude Code、Codex 等能执行命令的助手直接用 `shard` 读写资料库，不需要 MCP：

```bash
shard --install-skill            # 把使用说明装成 skill（~/.claude、~/.codex 存在时各装一份）
shard --agent-guide              # 打印完整说明：格式规则、全部命令、JSON 结构、退出码
```

- 读写命令：`--read <目标>`、`--update <目标> --expect <sha>`（正文从标准输入读）、`--append <目标> [内容]`、`--note <标题> [--folder 文件夹]`、`--tags`、`--ls [文件夹]`、`--read-dataset`、`--create-dataset`。目标是 id、vault 相对路径、上次搜索序号或唯一的 id 片段，不做关键词猜测。
- 任何命令加 `--json`：成功时 stdout 只有一个 JSON 值，失败时 stderr 输出 `{"error":{"code","message"}}`；退出码 2 表示内容已被改过（`CONFLICT`），需重新读取后再改。
- `--source <名称>`（或 `SHARD_SOURCE`）写入 frontmatter 的 `source`，标明内容出自哪个助手。
- 正文带 YAML frontmatter 会被拒绝；标签直接写在正文里。CLI 不提供删除。
- skill 内容随 CLI 版本走，升级 Shard 后重新运行 `shard --install-skill` 即可更新；目录里已有非 shard 生成的同名 skill 时不覆盖（`--force` 强制）。

开发者可以运行 `pnpm install:cli` 在本地构建并安装 CLI；该脚本仅用于开发，默认安装到 `~/.local/bin/shard`，也可以通过 `PREFIX` 覆盖安装目录。

## Design

Shard uses [Kiln](vendor/kiln) as its frontend design system. Kiln owns the
shared tokens, component rules, layouts, and migration checks; Shard-specific
editor and timeline geometry lives in `src/styles/frontend-rules.css` as a
product extension rather than a second design system.

## License

License is not selected yet. Public repository visibility does not imply an open-source license grant.
