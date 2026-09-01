# 碎片空间纯捕捉化 + 碎片浏览迁入资料库（IA 重整第十批 H）

## Context

用户定调（截图反馈 + 两问确认）：碎片空间不再展示历史碎片时间线，收敛为**纯捕捉页**（编辑框 + 最近保存的几条确认反馈）；历史碎片的浏览职责全部迁入**资料库空间**——点击资料库树「碎片流」分组/年月/归档，在资料库中列就地展示碎片时间线，不再跳空间。侧栏碎片组的「收件箱/标签/归档」子项全部移除，标签浏览也走资料库（时间线顶部的标签筛选条）。

这是信息架构重整（`docs/dev/information-architecture-plan.md`）的自然延续：碎片流从「跳空间的传送门」变为资料库的「就地内容节点」，资料库进一步成为全 vault 唯一的浏览地图。基线：HEAD 22a5a8f（第七/八批已完成），cargo 53 / unit 68 / ui 108 全绿。**Rust 零改动、无新 Tauri command、无 mock 补齐义务。**

## 关键设计裁决

| # | 裁决 |
|---|---|
| D1 | 捕捉页「最近保存」= 复用 `FragmentTimeline` 渲染最近 5 条（按 `createdAt` 排序后 slice，避免置顶挤占名额）；不传 `onOrganize`（自动无整理工具条）、无标签条。卡片就地编辑/菜单/关系层能力白拿 |
| D2 | `LibrarySelection` 加第三支 `{ kind: "fragments"; month?: string; archived?: boolean }`（archived 时忽略 month），selection 仍是组件 state 不进路由 |
| D3 | 资料库碎片视图顶部复用 `InboxTagBar` 整体（含「全部」chip 与「新建标签」入口），归档 scope 不显示；`TaggedPanel` 组件删除（文件保留，`TagFilterButton`/`TaggedSummary` 仍被引用）。「日程」默认 chip 消失为已接受的行为变化 |
| D4 | 搜索结果分派：公开笔记 → 资料库笔记编辑器（对齐 wikilink 链）；碎片 → 资料库碎片视图（archived→归档 scope）+ 滚动高亮；tagged 分支删除；toast 兜底保留为防线 |
| D5 | 树排序原则修订（推翻 T7.2 旧论据）：**就地内容在上、传送门在下**——碎片流 → 思维导图 → notes 树 → 密匣挂载点殿后 |
| D6 | 侧栏统计三件套 + 热力图保留；inbox/tagged/archive 计数随子项删除，计数职责由资料库树承接（归档计数用前端 `archivedFragments.length`，Rust 不动） |
| D7 | composer 折叠信号保留（捕捉页最近列表继续接 `onScrollDown`） |
| D8 | 资料库默认 selection 保持 `null`，空态文案提及碎片流 |
| D9 | 批次记为**第十批 H**（第九批 G「右栏属性面板」已占用且未派发，不重排） |

## 实施阶段

### 阶段一：library-shell 长出碎片视图（纯增量）

- **新建 `src/lib/fragment-month.ts`**：把 `workbench-shell.tsx` 的 `isFragmentInMonth`（约 :2124）搬出共享（避免 library→workbench 反向 import 成环）。
- **`src/workspace/library-shell.tsx`**：
  - `LibrarySelection`（:124）加 fragments 支；新增 state `fragmentsTag`（标签筛选）与 `consumedNavigationRef`。
  - 新增门禁选择函数 `selectFragmentsView({month?, archived?})`——与 `selectMindMap`（:508）同构：先 `saveCurrentNote()` flush 草稿，成功才 `setSelection`，`setSelectedTreePath("::fragments")` 哨兵清树高亮，`setIsZen(false)`、`setMobilePane("editor")`。
  - 派生 `visibleTimelineFragments`：archived → `archivedFragments`；否则 inbox 碎片按 month（`isFragmentInMonth`）与 `fragmentsTag` 过滤。`fragmentsScrollTargetId` 对照自己的过滤结果 gating。
  - Props 新增：`archivedFragments`、`fragmentsTimeline`（timeline handlers）、`fragmentsTagBar`（summaries + onCreateTag）、`searchContextBar`、`pendingScrollFragmentId`、`navigateTo`（union `{kind:"note"|"fragments", ..., requestId}` 取代 `navigateToNote`）；删除 `onSelectFragmentMonth`。`navigateTo` 消费 effect 用 `consumedNavigationRef` 防 `notes` 刷新重放。
  - 树节点（:845-925）：碎片流分组头点击 = `selectFragmentsView({})` 并展开；月按钮 = `selectFragmentsView({month})`；年月之后追加**归档节点**（ArchiveIcon，`归档（N）`）；三类节点加 `data-selected`。密匣挂载点块下移到 notes 树之后（D5，独立小 commit）。
  - `renderSelectedViewer`（:735）加 fragments 分支：`InboxTagBar`（非归档时）→ `SearchContextBar`（有 session 时）→ `FragmentTimeline`（emptyMessage 按 scope 分派）。`selectedTitle` 显示「碎片流」/「2026年08月」/「归档」；禅按钮对 fragments 视图隐藏。
  - `library-shell.module.css` 加 `.fragmentsViewport`（flex column、min-height:0）。**禁止**照抄 TaggedPanel 的 `padding-top: var(--shard-top-inset)`——中列已有 `editorHeader` 承担顶部避让（风险 R1）。

### 阶段二：workbench-shell 状态重分配与四链路重定向

- `timelineProps`（:1733）拆为 `timelineHandlers`（去 fragments/scrollToFragmentId）；三个消费面组合：捕捉页 `recentCaptureFragments`（最近 5 条）+ 折叠信号；密匣面保持原行为（含搜索定位 gating，风险 R10）；资料库面 `fragmentsTimeline={{...timelineHandlers, onOrganize: handleOrganizeFragments}}`。
- `pendingLibraryNavigation` 扩展为 `pendingLibraryTarget: LibraryNavigationTarget`，helper `requestLibraryTarget(target)`（bump requestId + 跳 library 路由）。
- **`handleOpenSearchResult`**（:1086）重写：lockbox 分支现状保留；公开笔记 → `requestLibraryTarget({kind:"note"})`；含 inbox 标签或 archived → `requestLibraryTarget({kind:"fragments", archived?})` + 公共收尾设 `pendingScrollFragmentId`；toast 兜底保留。上下文条「上一个/下一个」自动继续可用。
- `handleNavigateToFragment`（wikilink）与 `handleOrganizeFragments` 改走 `requestLibraryTarget`；`handleSelectFragmentMonth`、`setFragmentFilter`、`selectedTag`/`selectedInboxTag` state 及清理 effect、`tagSummaries` 删除；`inboxTagSummaries` 保留下传；`handleCreateInboxTag` 签名改为返回 `string | null`。

### 阶段三：碎片空间纯捕捉页

- `fragments-workspace.tsx`：删 `filter`/`inboxTagBar`/`taggedPanel` props 与渲染；`isInboxView = !isMindMapViewActive`；`searchContextBar` 保留。
- `tagged-panel.tsx`：删 `TaggedPanel` 组件本体，保留导出 `TaggedSummary`/`TagFilterButton`。

### 阶段四：路由收敛 + 侧栏/底栏（同一 commit）

- `route.ts`：`FragmentsRoute.params` 收敛为 `Record<string, never>`；`FragmentWorkspaceFilter` 类型与 `FRAGMENT_FILTERS` 删除；`isWorkspaceRoute` 中 fragments 并入空 params 分支。旧 localStorage 值（含 filter/month）一律校验拒绝 → 回退捕捉页，不做映射迁移。
- 全仓 `params: { filter: ... }` 字面量替换为 `params: {}`（workbench :1196/:1273/:1573、sidebar-nav :75、bottom-tabs :66）；workbench 顶部 `filter` 派生变量删除。
- `sidebar-nav.tsx`：删 `FRAGMENT_ITEMS` 与碎片子组 JSX、counts 收窄为 review 三项；热力图与统计三件套不动。
- `bottom-tabs.tsx`：删 `FRAGMENT_TABS` 与碎片二级 tab 块。

### 阶段五：测试改写

| Spec | 改法 |
|---|---|
| `src/lib/workspace-route.test.ts` | 合法集换 `{space:"fragments",params:{}}`；非法集加 `{filter:"inbox"}`、`{filter:"tagged"}`、`{filter:"inbox",month:"2026-08"}` |
| `tests/ui/library-tree.spec.ts:361` | 月按钮点击后断言留在资料库、中列出现 `fragment-august`、localStorage=`{"space":"library","params":{}}`；新增：分组头→全部视图、归档节点→归档碎片（mock 补一条 archived）、fragments 视图无禅按钮 |
| `tests/ui/lockbox-space.spec.ts:166` | 旧路由回退断言改为：composer 可见 + 侧栏无「收件箱」（toHaveCount(0)）+ localStorage=`{"space":"fragments","params":{}}` |
| `tests/ui/shadcn-migration.spec.ts` | `:784` 卡片计数 25→5；`:947` 搜索召回大改（Enter 后断言资料库树可见、目标卡片在资料库中列滚动可见、「返回搜索结果」回捕捉页搜索层且聚焦）；`:1117` 删「标签 N」点击前奏；关系层 beforeEach `toHaveCount(24)`→5、关联跳转断言改资料库查看器 |
| `tests/ui/organize-fragments.spec.ts` | 两条用例前置补「资料库 → 碎片流分组头」导航，其余原样 |
| `tests/ui/wikilink.spec.ts:213` | 断言改为资料库树可见 + 目标卡片在资料库查看器内高亮；document 不滚动断言保留 |
| 新增（并入 library-tree.spec） | 标签 chip 筛选 + 新建标签可用；脏笔记点碎片流先触发 `update_fragment`（门禁回归）；归档 scope 无标签条 |
| `csv-preview`/`editor-table`/`sidebar-collapse`/`library-workspace` | 预期零改动，跑通确认 |

### 阶段六：文档

- `docs/dev/information-architecture-tasks.md`：修正第七/八批章节标题的「未派发」滞后标记；新增**第十批 H** 章节（T10.1 资料库碎片视图 / T10.2 状态重分配与四链路 / T10.3 纯捕捉页 / T10.4 路由收敛+侧栏底栏 / T10.5 测试），显式记录 T7.2 树排序原则修订与「Rust 零改动」。

## 复用清单

- `FragmentTimeline`（`src/components/shard/fragment-timeline.tsx`）：容器无关，三处消费（捕捉页/密匣/资料库）；`scrollToFragmentId`+`onScrollToFragmentComplete` 自足滚动协议
- `InboxTagBar`（`inbox-tag-bar.tsx`）、`TagFilterButton`/`TaggedSummary`（`tagged-panel.tsx`）
- `selectMindMap` 的草稿门禁模式（`library-shell.tsx:508-516`）、`saveCurrentNote`、`pendingLibraryNavigation` 通路、`SearchContextBar`

## 主要风险

- **R1** 新 fragments 查看器不得加 `--shard-top-inset`（editorHeader 已承担顶部避让，加了双重留白）
- **R4** 草稿保存失败中止导航时 `pendingScrollFragmentId` 残留（与既有 note 导航同性质小瑕疵，不新增机制）
- **R5** `navigateTo` effect 因 `notes` 引用变化重放——`consumedNavigationRef` 必须品
- **R6** 树 totalCount（Rust 统计文件数）与前端列表口径的展示性偏差，留给 A3 批次统一修正
- **R10** `filteredFragments` 瘦身时密匣面的搜索定位 gating 必须原样保住（spec 无覆盖，实现后手动验证）

## 验证

每阶段末跑构建；最终三条全绿（基线 cargo 53 / unit 68 / ui 108，既有用例只增不减）：

```bash
cargo test --manifest-path src-tauri/Cargo.toml   # 应零变化
pnpm build && pnpm test:unit
pnpm test:ui
```

手动核对：窄视口移动端两级导航（R9）、密匣搜索定位（R10）、捕捉页顶部无塌陷（R1）。完成后提交（拆 2-3 个 commit：阶段一二 / 阶段三四 / 测试+文档，或按稳定点合并），并更新 auto-memory 中碎片/资料库分工的定调。
