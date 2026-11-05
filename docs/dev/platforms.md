# Shard 三端说明

更新：2026-11-01。Shard 提供 **iOS App、Web、macOS 桌面**三种客户端，围绕同一套碎片与笔记产品展开。

本文按 GitHub `main` 的已提交代码说明平台现状。开发分支中的功能须合并并完成对应平台验证后，才能作为该端的已交付能力。

## 平台与入口

| 客户端 | 定位与当前实现 | 代码入口（main） | 开发与获取 |
| --- | --- | --- | --- |
| **iOS App** | iOS 17+ 原生移动客户端；SwiftUI 导航与列表，WKWebView 显示 Markdown 详情 | [`apps/ios/`](https://github.com/wensia/shard/tree/main/apps/ios) | [Xcode 构建、签名与安装](https://github.com/wensia/shard/blob/main/apps/ios/README.md) |
| **Web** | 浏览器中的 React 工作台；登录 Shard 服务器读写资料 | [`src/`](https://github.com/wensia/shard/tree/main/src)、[`crates/shard-server/`](https://github.com/wensia/shard/tree/main/crates/shard-server) | [Web 与服务端部署](https://github.com/wensia/shard/blob/main/deploy/README.md) |
| **macOS 桌面** | Tauri 2 桌面应用；支持本地资料库，也可连接 Shard 服务器 | [`src/`](https://github.com/wensia/shard/tree/main/src)、[`src-tauri/`](https://github.com/wensia/shard/tree/main/src-tauri) | [Apple Silicon DMG](https://github.com/wensia/shard/releases/latest)；开发使用 `pnpm tauri dev` |

`shard-server` 是共用后端，不是第四种客户端；Linux 服务端包也不是 Linux 桌面应用。

## 共享范围与平台差异

- **Web 与 macOS 桌面**共用 `src/` 中的 React 工作台，通过 `src/lib/transport/` 区分浏览器 HTTP、Tauri 本地命令和桌面远程请求。
- **Markdown**公共组件与解析工具位于 `packages/markdown/`；主分支 iOS 的详情渲染复用该包，iOS 导航和列表仍由 SwiftUI 实现。
- **iOS 当前范围**包括时间线、标签、笔记、搜索、详情渲染、离线记录与同步；已有内容编辑、密匣、结构化大纲 / 流程图和图片上传尚未提供。具体范围以 [iOS 文档](https://github.com/wensia/shard/blob/main/apps/ios/README.md) 为准。
- 平台适配、共享渲染和各端功能进度分别记录；同一功能在一端完成，不代表其他两端已完成验收。

## 数据与连接

| 客户端 / 模式 | 数据位置与连接方式 |
| --- | --- |
| Web | 通过服务器账号访问 `shard-server` 管理的资料库 |
| iOS App | 连接同一 Shard 服务器账号；保留本机缓存与离线待发队列，也兼容 GitHub 资料库连接 |
| macOS 服务器模式 | 通过设置连接 Shard 服务器 |
| macOS 本地资料模式 | 本机 Markdown 资料库与 Git；不会因为安装其他客户端而自动上传到服务器 |

跨端访问同一份资料，需要连接同一服务器与账号，或明确配置兼容的资料库连接。本地资料库、服务器资料库及其他云端存储不是自动互通的同一份数据。

## 发布与开发

截至 [v0.1.3](https://github.com/wensia/shard/releases/tag/v0.1.3)，GitHub Release 提供：

| 产物 | 用途 |
| --- | --- |
| `Shard_0.1.3_aarch64.dmg` | macOS Apple Silicon 桌面安装包 |
| `Shard_server_0.1.3_linux_x86_64.tar.gz` | Linux x86_64 服务端与 Web 部署包 |
| `SHA256SUMS.txt` | 下载文件校验值 |

iOS 当前提供源码和构建脚本，Release 不含 IPA，需要自行配置 Apple 签名。桌面暂不提供 Intel Mac、Windows 或 Linux 安装包。

| 目标 | 构建 / 开发入口 |
| --- | --- |
| macOS 桌面 | `pnpm tauri dev`；`pnpm build:mac:apple-silicon` |
| Web | `SHARD_SERVER_URL=http://127.0.0.1:8787 pnpm dev` 连接已启动的本机服务端；`pnpm build` 生成 `dist/` |
| Web + Linux 服务端 | `deploy/docker/release.sh build`；部署步骤见上方服务端文档 |
| iOS App | `apps/ios/scripts/generate-project.sh` 生成 Xcode 工程，再按 iOS 文档配置签名与构建 |

## 开发分支说明

- iOS 嵌入完整 Web 工作台及桌面默认服务器登录的后续迁移，不属于本文所述 `main` / v0.1.3 的已提交实现。
- 新需求、验证记录与发布说明应注明适用端；涉及共享代码时，分别核对受影响客户端。
