# Shard

Shard 是一个本地优先的桌面端 Markdown 片段捕捉应用，目前只发布 Apple Silicon macOS 安装包。

它借鉴了 [flomo](https://flomoapp.com/) 的核心心智：先把稍纵即逝的想法记下来，让碎片在时间流里自然沉淀，再在需要时回看、整理和连接。Shard 不是 flomo 的复刻，也与 flomo 没有关联；它把这个灵感收敛到本地优先、Markdown 优先、Git 可追踪的桌面工具里。

![Shard 主界面：片段捕捉、时间线、标签和 Git 状态](docs/design/shard-main-screen-concept.png)

截图内容为示例片段，用于展示真实使用场景，不包含私人 vault 数据。

## 下载与安装

当前发布目标：

- macOS Apple Silicon，M1/M2/M3/M4 芯片
- 不支持 Intel Mac、Windows、Linux

安装方式：

1. 到 [GitHub Releases](https://github.com/wensia/shard/releases/latest) 下载最新的 `Shard_*_aarch64.dmg`。
2. 打开 DMG，把 `Shard.app` 拖到 `Applications`。
3. 首次打开如果 macOS 提示“无法验证开发者”，请右键 `Shard.app` 选择“打开”。当前版本尚未配置 Apple Developer ID 签名和 notarization。

## 适合场景

- 产品判断：先记录一个判断和它的背景，不急着写成完整文档。
- 会议摘记：把早会、复盘、客户沟通里的关键句拆成独立片段。
- 用户反馈：保留原话，再用标签连接到后续产品决策。
- 阅读摘录：记录一句启发、一个反问或一个待验证假设。
- 每日回顾：从近期片段里抽取一组内容，帮助重新看见被遗忘的线索。

## 核心理念

Shard 只优化一个动作：快速捕捉灵感。

1. 写下一段想法、摘录、任务或观察。
2. 按 `Cmd+Enter`、`Ctrl+Enter`，或点击发送按钮保存。
3. Shard 在本地 vault 中生成独立 Markdown 文件。
4. 新内容以灵感卡片的形式进入时间线。
5. Git 在后台为这次记录留下提交痕迹。

`Enter` 或 `Shift+Enter` 用于换行，AI 标签和整理能力只作为后置工作流，不阻塞捕捉。

## 主要功能

- **灵感卡片**：每条片段以卡片形式呈现，按时间倒序或回顾集查看。
- **Markdown 片段落盘**：每条记录都是独立 Markdown 文件，方便迁移、搜索和二次处理。
- **本地优先 vault**：默认写入 `~/Documents/ShardVault`，不依赖云端服务才能保存。
- **Git-backed 记录流**：保存片段后自动初始化/使用 vault 内的 Git 仓库并提交变更。
- **标签捕捉**：正文中的 `#tag` 会被提取到 frontmatter，同时默认保留 `inbox` 标签。
- **轻量导航**：支持收件箱、标签、每日回顾、AI 洞察、随机漫步、归档等入口。
- **本机 AI 回顾**：可调用本机 Codex CLI 只读分析片段，生成洞察或随机漫步连接理由。
- **桌面应用体验**：基于 Tauri，目标是保持快速、安静、低打扰。

## 功能状态

| 模块 | 状态 |
| --- | --- |
| 快速捕捉 Markdown 片段 | 已实现 |
| 灵感卡片时间线 | 已实现 |
| 标签提取与标签浮层 | 已实现 |
| 本地 vault 与 Git commit | 已实现 |
| Git pull / push 同步入口 | 已实现，需要用户配置 vault remote |
| 每日回顾 | 已实现 |
| AI 洞察与随机漫步 | 已实现，需要本机 Codex CLI |
| 归档与深度编辑 | 已实现 |

## Stack

- Tauri 2
- React 19
- TypeScript
- Tailwind CSS 4
- shadcn/ui with Base UI primitives
- Rust filesystem and Git commands

## Development

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

Frontend-only development:

```bash
pnpm dev
```

## Vault

Shard stores fragments in:

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

## Design

Shard uses [Kiln](vendor/kiln) as its frontend design system. Kiln owns the
shared tokens, component rules, layouts, and migration checks; Shard-specific
editor and timeline geometry lives in `src/styles/frontend-rules.css` as a
product extension rather than a second design system.

## License

License is not selected yet. Public repository visibility does not imply an open-source license grant.
