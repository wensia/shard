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

## Main Layout / Scroll Rules

- Shard 主界面顶部 composer 是固定交互区；搜索结果打开片段、标签切换、定位卡片等行为只能滚动 composer 下方的时间线 viewport，不得让页面、内容列或 `document/window` 参与滚动定位。
- 不要在 composer / `CaptureBox` 内添加 document 级 `wheel`、`scroll`、`touchmove` 监听来推断折叠状态；折叠只能由明确的时间线用户滚动事件触发。程序化滚动必须在时间线组件内标记并跳过折叠回调。
- 不要用全局 `element.scrollIntoView()` 修复时间线定位问题；应获取 `ScrollArea` viewport，基于目标卡片相对 viewport 的位置计算 `scrollTop`，保证输入框不被顶出或截断。

## Dependency Watch

- `@astryxdesign/core` / `@astryxdesign/theme-neutral`（前端设计系统，当前 ^0.1.8）和 `libsql`（Rust 侧 Turso 数据库客户端，当前 0.9，来自 tursodatabase 组织）都是刚起步不久、API 仍在快速演进的库，不能当成稳定依赖装完就不再理会。
- 涉及这两个库的任务开始前，主动查一下是否有新版本、CHANGELOG 或 breaking changes；发现上游已经补上了本项目之前绕过/手写的缺口（例如 astryx 缺失的 Sheet/Drawer、ScrollArea 等组件），评估是否值得替换掉本地的临时方案。
- 升级前先确认改动范围（新增 API、废弃 API、语义变化），再决定是否需要连带调整 Shard 自己的适配代码。
