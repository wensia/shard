# 桌面端默认 VPS

日期：2026-10-31。基于 `codex/ios-shared-web` 当前改动继续实现。

## 目标与边界

- 正常桌面启动仅使用 VPS 数据通道。未登录、凭据失效、退出后都显示账号密码登录页，默认服务器为 `https://shard.askfish.net`。
- 服务器模式可在暂时断网时使用已有远程副本；明确的认证拒绝不能降级成离线成功或旧本地资料库。
- 保留原 `~/Documents/ShardVault` 和原有本地配置，不导入、不删除、不向 VPS 补写这些旧数据。
- 登录页复用现有 Kiln 表单、Noto Sans SC 和共享密码控件，不添加流程解释。
- 完成构建、相关测试、独立原生验收后，备份并替换 `/Applications/Shard.app`。不提交、推送或生产部署。

## 计划

- [x] 前端：启动登录门、默认服务器、成功登录重载、凭据失效立即收起工作台、退出后仍有门禁。
- [x] 原生：后台恢复/校验凭据、阻断已失效副本与旧本地图片回退、异步登录与退出。
- [x] 验证：登录/错误密码/重启/吊销/退出，生产构建对缺失 IPC 关闭工作台，历史组件 fixture 兼容。
- [x] 交付：Apple Silicon DMG、签名与完整性验证、旧版备份、本机安装并实际显示 VPS 登录页。

## 测试边界

- 历史本地组件 fixture 只有在 `DEV` 且显式设置 `VITE_SHARD_LEGACY_UI_TESTS=1`，并明确缺少 `remote_status` IPC 时才可使用本地测试通道。默认开发和生产构建均不启用该例外。
- 真登录测试使用独立 App identifier、独立配置/凭据目录、真实临时 Rust 服务和本地资料库 canary，不对真实账号输入测试密码，不改真实资料库。
- 本机最终验收只检查安装包、进程、启动登录界面及原资料库保持，不代用户输入真实密码。

## 验收记录

- `pnpm build` 和 Apple Silicon Tauri Release 打包通过；完整前端单测 1114 项通过。远程传输专项 24 项、Rust 远程 10 项及图片资源 6 项通过，`cargo check -p shard --locked` 与 `git diff --check` 通过。
- 浏览器 Tauri IPC 替身：DEV 51 项（桌面 18、旧组件 11、浏览器认证 22），生产构建 18 项以及生产缺失/Unsupported IPC 守门 2 项均通过；Kiln 控件计算样式、焦点环与显隐通过。
- 独立 Release macOS Tauri/WKWebView + 真实临时 Rust 服务 9 项检查通过：初始登录、错误密码、真实 VPS 数据、凭据重启恢复、运行期吊销、吊销后冷启、再次登录、退出清除令牌/副本、退出后冷启。所有阶段均未显示旧本地 canary，canary 与真实配置哈希保持不变。报告：`/tmp/shard-desktop-vps-runtime-20261031-194139/report.md`。
- 正式 DMG：`/Users/panyuhang/Downloads/Shard-builds/20261031-195024/Shard_0.1.3_VPS_aarch64.dmg`，SHA-256 为 `622c827e4ec477820694716c4e0ea3f64c0155b3c4ccfd900806278c76bcc222`。已通过 `hdiutil verify` 与包内应用 `codesign --verify --deep --strict`，本地 ad-hoc 签名，未公证。
- 已安装到 `/Applications/Shard.app`，逐文件清单与 DMG 一致，正式 Bundle ID 为 `dev.shard.desktop`。旧应用备份：`/Users/panyuhang/Documents/Shard旧版备份/Shard-before-vps-20261031-195024.app`。
- 真实本机 CUA 验收：启动直接显示「登录」，服务器预填 `https://shard.askfish.net`，邮箱/密码为空，未出现旧资料库工作台。原 `settings.json` SHA 保持不变，`~/Documents/ShardVault` 保留；没有输入真实账号密码。
- 所有临时服务与独立原生测试应用已停止；正式新版保持打开在登录页。未提交、推送或生产部署。
