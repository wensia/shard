# 思维导图禅模式与真实渲染 Blocker

Status: implemented-code-smoke-passed
Date: 2026-06-29
Audit: `council-20260628-200300`
Related:

- `docs/dev/editable-mind-map-and-document-links-plan.md`
- `docs/dev/mind-map-editing-and-timeline-audit-input-20260629.md`

## 背景

当前思维导图实现仍只是雏形，不能算“可用”：

1. 编辑面仍主要像列表/弹窗，不是完整思维导图工作台。
2. 首页卡片只是 metadata preview，不是思维导图样式预览。
3. 没有全屏、纯白、低干扰的禅模式编辑体验。
4. 没有在“思维导图”和“大纲”两种编辑形态之间切换。
5. 首页卡片没有根据节点数量自动布局和缩放，无法保证所有节点可见。

因此，当前版本不满足“保证思维导图正常渲染、流畅使用”的要求。后续实现不能继续把需求降级为“能创建、能列出、能保存 JSON”。

## 硬性目标

### 1. 编辑入口进入禅模式

点击思维导图文件、首页导图 card、或导图列表项后，应进入完整编辑工作面，而不是只打开一个小 Dialog。

禅模式要求：

1. 全屏或接近全屏，占据主内容区域，隐藏默认捕获输入和普通 timeline 干扰。
2. 背景为纯白或接近纯白，不使用深色背景、渐变、玻璃效果或装饰性背景。
3. 顶部只保留最少 chrome：返回、标题、保存状态、视图切换、必要工具按钮。
4. 编辑区是主视觉，不能被侧栏、弹窗边框、嵌套卡片或多余说明文字压缩。
5. 保存中、未保存、冲突、错误状态必须在局部显示，不能用 toast 代替核心状态。

### 2. 支持“思维导图 / 大纲”双视图编辑

同一份 `.shardmap.json` 必须支持两种编辑形态：

1. 思维导图视图：节点以树状思维导图形式渲染，有连接线、层级、左右/纵向布局和自动缩放。
2. 大纲视图：节点以递归大纲形式编辑，支持键盘优先操作。
3. 两种视图必须共享同一份 schema 和同一套树操作，不允许各自维护一套状态导致不一致。
4. 在任一视图编辑后切换视图，另一视图必须立即反映最新结果。
5. 视图切换应是明确控件，例如 segmented control：`思维导图 | 大纲`。

大纲视图至少支持：

1. Enter 新建同级节点。
2. Tab / Shift+Tab 缩进和反缩进。
3. Cmd/Ctrl+S 保存。
4. 删除空节点。
5. 上下移动节点。
6. 中文输入法 composition 期间不误触发快捷键。

思维导图视图至少支持：

1. 所有节点可见。
2. 自动布局。
3. 自动适配缩放。
4. 点击节点可编辑文本。
5. 添加子节点和同级节点。
6. 节点移动或重排不会造成布局跳动到不可用状态。

### 3. 首页 card 必须真实渲染导图预览

首页内容 card 区域出现思维导图时，不能只显示标题、路径和节点数。必须渲染导图样式预览。

导图 card 要求：

1. 使用和笔记 card 一致的 quiet paper 视觉：白底、少 chrome、清晰边距、不过度装饰。
2. card 内包含一个真实导图 preview canvas/SVG 区域。
3. preview 必须显示节点和连接线，而不是 metadata 列表。
4. 自动根据节点数量和布局 bounding box 计算缩放比例，保证所有节点都在 preview 区域内。
5. 小导图显示节点文本；节点很多时可以降低字号或做文本截断，但节点框和连接关系必须完整可见。
6. preview 不允许出现横向/纵向内部滚动条。
7. preview 不允许裁切根节点、末端节点或连接线。
8. 点击 card 或 preview 进入禅模式编辑。

排序边界：

1. 导图在首页 Inbox 可见。
2. 默认按 `createdAt` 进入时间线位置。
3. `updatedAt` 只显示为 edited 状态，不因编辑后浮顶。
4. 不进入 tag、lockbox、archive、review 视图。

## 推荐实现路线

### Phase A: 抽出渲染模型

新增纯函数层，把 `ShardMapFile` 转换为可渲染 tree layout：

```text
src/lib/mind-map-layout.ts
```

职责：

1. 输入 `ShardMapFile`。
2. 输出节点坐标、边、bounding box、推荐 scale。
3. 支持 card preview 和禅模式共享。
4. 不依赖 DOM，不读文件，不触发 Tauri command。
5. 有单元测试覆盖小导图、中等导图、深层导图、宽导图、空文本节点。

### Phase B: 首页导图 preview card

新增或重写：

```text
src/components/shard/mind-map-timeline-card.tsx
src/components/shard/mind-map-preview.tsx
```

要求：

1. `MindMapTimelineCard` 不只展示 metadata。
2. `MindMapPreview` 使用 SVG 或 canvas 渲染节点与连接线。
3. 根据 layout bounding box 和 preview 容器尺寸自动 fit-to-view。
4. 至少验证 1、5、20、50 个节点。
5. card 高度可以随节点数适度变化，但不能撑破 timeline，也不能产生内部滚动。

### Phase C: 禅模式工作台

新增独立编辑 surface：

```text
src/components/shard/mind-map-workspace.tsx
src/components/shard/mind-map-outline-editor.tsx
src/components/shard/mind-map-canvas-editor.tsx
```

要求：

1. 不再把核心编辑体验塞进小 Dialog。
2. 工作台进入后主背景为白色。
3. 顶部工具条克制，只保留返回、保存、视图切换、状态。
4. 默认打开思维导图视图；用户可切换到大纲。
5. 如果从首页 card 点击进入，必须直接打开对应导图。
6. 如果新建导图，创建后自动进入禅模式并聚焦第一个空节点。

### Phase D: 性能与流畅性

必须避免以下问题：

1. 每次输入都全量读取文件或调用 Tauri command。
2. 每次 keypress 都重新测量 DOM。
3. 大导图输入时明显卡顿。
4. 缩放计算导致无限 layout loop。
5. 保存时阻塞主线程或冻结 UI。

建议：

1. 编辑态在前端内存维护。
2. layout 计算只基于当前 draft tree。
3. 对昂贵 layout 做 memoization。
4. 保存仍使用显式 Save + dirty guard。
5. 20-50 节点输入和切换视图必须流畅。

## 验收标准

实现后必须逐项通过：

1. 首页 Inbox 中，思维导图以真实导图 preview card 出现。
2. preview card 显示节点和连接线，不只是标题、路径、节点数。
3. preview 自动缩放，1、5、20、50 节点均能完整显示所有节点。
4. 点击 preview card 进入全屏/近全屏禅模式。
5. 禅模式背景为纯白或接近纯白，无深色、渐变或装饰背景。
6. 禅模式可在“思维导图 / 大纲”之间切换。
7. 在大纲视图新增、缩进、删除节点后，切到思维导图视图能立即看到变化。
8. 在思维导图视图新增或编辑节点后，切到大纲视图能立即看到变化。
9. 新建导图后自动进入禅模式，并聚焦第一个空节点。
10. 保存后关闭再打开，布局和节点内容仍正确。
11. 保存冲突不丢失当前编辑态，并提供可执行恢复选择。
12. `pnpm build` 或等价 `tsc --noEmit` + `vite build` 通过。
13. `cargo check` 和 `cargo test` 通过。
14. Browser smoke 覆盖首页 preview card 和禅模式两种视图。
15. 真实 Tauri/WKWebView smoke 覆盖创建、编辑、保存、重开和 card preview。

## 不接受的替代方案

以下实现不能算完成：

1. 只在首页 card 显示标题、路径、节点数。
2. 只做递归大纲，没有思维导图视图。
3. 只做 Dialog 内编辑，没有全屏/近全屏禅模式。
4. preview 需要滚动才能看到全部节点。
5. preview 裁切部分节点或连接线。
6. 大节点数时直接显示“节点过多无法预览”。
7. 用 toast 替代保存/冲突/错误状态。
8. 编辑体验依赖频繁读写文件，导致输入卡顿。

## 给其他 AI 审计的问题

请重点审计：

1. `mind-map-layout.ts` 是否应该自研 SVG tree layout，还是引入 React Flow / XYFlow。
2. 首页 preview card 的最佳自适应算法：如何在 card 尺寸有限时保证所有节点可见且尽量可读。
3. 禅模式应该作为 Dialog、Sheet、route-like workspace，还是 App 内状态切换。
4. 思维导图视图和大纲视图共享状态时，如何避免切换时丢编辑内容。
5. 50 节点以内的流畅性如何验证，是否需要 Playwright 录入/交互 smoke。
6. 如何在不破坏 Shard capture-first 首页的前提下，让导图功能真正可用。

## 当前结论

已按审计吸收后的 MVP 口径完成实现：自研 SVG tree layout、首页真实 preview card、App 顶层禅模式 workspace、思维导图/大纲双视图共享 draft、显式保存与冲突恢复。

已通过代码级与运行级 smoke：

1. `src/lib/mind-map-layout.ts` 输出节点矩形、连接线、bounds 与 fit-to-view viewBox。
2. `MindMapTimelineCard` 在 Inbox 按 `createdAt` 混入时间线，并懒加载完整 `.shardmap` 渲染 preview。
3. `MindMapWorkspace` 以顶层纯白 workspace 打开，不再把核心编辑塞进 Dialog。
4. `MindMapCanvasEditor` 支持点击节点、编辑文本、添加子节点、添加同级节点、删除非 root 节点。
5. `MindMapOutlineEditor` 支持 Enter、Tab、Shift+Tab、Cmd/Ctrl+S、空节点删除、上下移动。
6. 新建导图后会从列表 Dialog 自动进入 workspace，并聚焦首个可编辑节点。
7. 保存使用单一 draft + revision/hash，冲突时保留当前编辑态并提供“保留我的版本 / 保留磁盘版本”。

验证记录：

1. `./node_modules/.bin/tsc --noEmit` 通过。
2. `./node_modules/.bin/vite build` 通过，仅有现有 chunk size warning。
3. `cargo check` 通过。
4. `cargo test` 通过，12 个 Rust 测试全通过。
5. `git diff --check` 通过。
6. Vite SSR layout fixture 通过：41 nodes / 40 edges，bounds `680 x 1876`，320 x 180 preview fit scale `0.08315565031982942`，compact text 启用。
7. Browser smoke 通过：`http://127.0.0.1:1420/` 桌面与窄视口加载非空白，Playwright console warning/error 为 0。
8. Live dev 条件核验通过：`http://127.0.0.1:1420/` 返回 200，存在当前仓库 `src-tauri` cwd 的 `target/debug/shard` 进程。

剩余发布前人工核验：

1. 在真实 Tauri/WKWebView 中手动创建一张导图，确认进入 workspace、编辑、保存、关闭重开、首页 preview card 回显。
2. 使用 1、5、20、50 节点样例做视觉验收，确认 preview 不裁切节点和连线。
3. 当前未为了该功能新增 Playwright 依赖，符合审计收敛口径；若后续建立桌面 UI 自动化，可把上述人工核验固化为 e2e。

## 审计记录

- 2026-06-29 · council-20260628-200300 · 选手:codex,antigravity,grok（opencode 外部目录权限失败、gemini 停用）· 主席claude 裁决 HIGH:「批准但收敛 MVP——自研纯函数 SVG tree layout（非 React Flow）+ 单一 draft 双视图 + App 状态切换禅模式；先插 Phase 0 裁定 Inbox/Structures 产品边界，暂不引入 Playwright」· 报告 /Users/panyuhang/.council/RuiMF-next/council-20260628-200300/viewer.html

## 审计吸收后的执行口径

本轮审计结论是批准 blocker 方向，但必须收敛 MVP 后再执行。核心裁决如下：

1. 布局路线：采用自研纯函数 SVG tree layout，不引入 React Flow / XYFlow 作为 Phase A/B 基础。
2. 共享模型：`ShardMapFile` draft 是唯一事实来源；大纲 rows 和导图 SVG layout 都是 derived projection。
3. 禅模式形态：采用 App 顶层状态切换或 route-like workspace，不使用 Dialog / Sheet 承载核心编辑体验。
4. 首页 preview：用户已明确要求首页内容 card 区域展示思维导图，因此 Phase 0 裁定为 Inbox 首页显示真实导图 preview card；但导图仍不进入 tag、lockbox、archive、review 视图，且按 `createdAt` 锚定，不按 `updatedAt` 浮顶。
5. MVP 范围：第一版画布只要求真实渲染、自动 fit-to-view、点击节点编辑文本、添加子节点/同级节点；拖拽重排、自由摆放、多选、复杂连线编辑后置。
6. 验证策略：不为了该功能单独引入 Playwright；保留 `tsc --noEmit`、`vite build`、`cargo check`、`cargo test`、layout fixture 单测、真实 Tauri/WKWebView smoke 为硬门槛。若项目已有 Playwright，可加浏览器 smoke，但不能替代 WKWebView。

## MVP 实施顺序

### Phase 0: 产品边界与数据读取裁定

1. 首页 Inbox 显示导图 preview card，但只作为 quiet paper card 的一种内容项。
2. `MindMapSummary` 保持 metadata-only，不返回节点文本。
3. preview 所需完整 map 数据必须懒加载：只读取可见或即将可见的导图，不在启动时批量读取所有 `.shardmap.json` 节点文本。
4. `updatedAt` 仅显示 edited 状态，不改变 card 排序位置。

### Phase 1: 自研 layout 与 preview

1. 新增 `src/lib/mind-map-layout.ts`。
2. 输入 `ShardMapFile`，输出节点矩形、边、bounding box 和 fit-to-view 参数。
3. 新增 `src/components/shard/mind-map-preview.tsx`，使用 SVG 渲染节点和连接线。
4. 首页 card 使用同一 preview 组件；不得再只显示标题、路径、节点数。

### Phase 2: App 内禅模式 workspace

1. 新增 `mind-map-workspace.tsx`，由 App 顶层状态打开。
2. workspace 背景纯白或接近纯白，隐藏 capture/timeline 干扰。
3. 顶部只保留返回、标题、保存状态、视图切换和必要操作。
4. 点击首页 preview card 或导图列表项直接进入对应 workspace。

### Phase 3: 双视图同步编辑

1. 大纲视图继续使用 `mind-map-tree.ts` 纯函数命令。
2. 导图视图使用同一 draft + layout projection。
3. 任一视图编辑后切换视图，另一视图必须立即反映。
4. 显式 Save + dirty guard + 冲突恢复继续保留。

### Phase 4: 后置增强

以下能力不进 MVP：

1. 节点拖拽自由摆放。
2. 多选、框选、复杂连线编辑。
3. React Flow / XYFlow。
4. 全局 relations / 反链。
5. 200+ 节点重型白板能力。
