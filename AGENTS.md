# AGENTS.md

- 默认使用中文回复。
- 在有需要的中大型任务时，自动制定计划分配任务给多个 agent 开展工作提升效率。
- 编码、审查、重构任务默认遵循 karpathy-guidelines：
  - 编码前明确关键假设、歧义和取舍；不确定时先澄清。
  - 优先用最少代码解决明确问题，不添加未请求的抽象、灵活性或功能。
  - 精准修改，只触碰完成任务必须修改的代码；不顺手重构或清理无关内容。
  - 对非琐碎任务定义可验证成功标准，并通过测试、构建或等价检查完成验证。

## Runtime Rules

- 不允许在前端渲染、事件处理、Tauri command 主路径或 WKWebView/UI 线程上执行可能卡住界面的重操作。
- Git / GitHub CLI / 文件系统扫描或读写 / 网络请求 / 外部进程 / 大量 Markdown 解析必须异步执行，并在 Tauri 侧使用 `async` command、`tauri::async_runtime::spawn_blocking` 或等价后台任务。
- 前端只能等待异步 Promise，并给受影响的局部组件展示 loading / disabled / `aria-busy` 状态；不得用同步循环、阻塞等待或成功后强制关闭配置界面来掩盖耗时。
- 新增或修改这类能力时，必须全局检查同类阻塞点，并用 `pnpm build`、`cargo check`、`git diff --check` 或等价验证确认不会引入 UI 线程阻塞。
- 提交策略（合并保存）：内容型写入（片段/资料库/密匣正文、标签、置顶、关系、思维导图、附件）只落盘**不得内嵌 git 提交**，提交由 `checkpoint_vault` 聚合；结构型操作（rename/move/delete/restore/purge/convert/移入密匣）保留路径级语义提交并先调 `checkpoint_before_structural_locked`；仅 `.shard/lockbox.json` 密钥元数据即时提交。所有写 vault 的命令必须在拿到 vault 后立刻 `lock_vault_gate`（纯读命令与网络阶段不持门），托管目录清单只能来自 `MANAGED_VAULT_ROOTS`/`managed_pathspecs()`。

## Design System

- 前端设计系统的唯一真相源是 `vendor/kiln/SKILL.md`、`vendor/kiln/references/` 与 `vendor/kiln/tokens/`；所有 UI 设计、实现和审查先读取 Kiln 对应规范。
- Shard 的焦点策略见 `docs/design/frontend.md`：采用 Kiln 的 `managed-navigation`（`src/lib/focus-navigation.ts`）。Tab 归编辑器，F6 / Shift+F6 在 `data-focus-region` 区域间切换；`<html data-focus-mode>` 在 pointer 模式下不画焦点环、keyboard 模式下显示。新增外壳区域要挂 `data-focus-region`，新编辑区要挂 `data-focus-editor`。
- `src/styles/frontend-rules.css` 只保存 Kiln 未覆盖的 Shard 编辑器、时间线、附件与 macOS 壳层几何，不得发展成第二套通用设计系统。
- 可复用的颜色、字体、间距、圆角、阴影和控件规格必须消费 Kiln token；新增 Shard 扩展前先确认不能由 Kiln 语义 token 表达。
- UI 改动至少运行 `pnpm build` 与 `git diff --check`；涉及视觉一致性时还要运行 `pnpm test:ui` 并核对真实计算样式。

## Main Layout / Scroll Rules

- Shard 主界面顶部 composer 是固定交互区；搜索结果打开片段、标签切换、定位卡片等行为只能滚动 composer 下方的时间线 viewport，不得让页面、内容列或 `document/window` 参与滚动定位。
- 不要在 composer / `CaptureBox` 内添加 document 级 `wheel`、`scroll`、`touchmove` 监听来推断折叠状态；折叠只能由明确的时间线用户滚动事件触发。程序化滚动必须在时间线组件内标记并跳过折叠回调。
- 不要用全局 `element.scrollIntoView()` 修复时间线定位问题；应获取 `ScrollArea` viewport，基于目标卡片相对 viewport 的位置计算 `scrollTop`，保证输入框不被顶出或截断。

## Dependency Watch

- `@base-ui/react` 和 shadcn CLI 的 Base UI 组件模板仍在快速演进，升级前先核对当前文档、CHANGELOG 和 breaking changes，再同步更新仓库内拥有的 `src/components/ui/*` 源码。
- `libsql`（Rust 侧 Turso 数据库客户端，当前 0.9，来自 tursodatabase 组织）也处于快速演进阶段；涉及它的任务开始前主动检查新版本与兼容性，不要把当前 API 当成长期稳定接口。
- 升级前先确认改动范围（新增 API、废弃 API、语义变化），再决定是否需要连带调整 Shard 自己的适配代码。
