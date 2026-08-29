# 片段关系层 · 施工任务清单

依据：`docs/dev/fragment-relations-plan.md`
裁决：council-20260818-070701（4/4 高置信否决自由坐标画布，主投资转向片段之间的边）
创建：2026-08-18

## 全局约束（每个任务都适用）

- 遵守 `AGENTS.md` Runtime Rules：文件系统读写、Git、外部进程必须异步，Tauri 侧用 `async fn` + `run_blocking`；前端不得在 UI 线程做重计算。
- 遵守 `AGENTS.md` 主布局滚动规则：定位片段只能计算 ScrollArea viewport 的 `scrollTop`，**禁止 `scrollIntoView()`**。
- 前端设计系统以 `vendor/kiln/` 为唯一真相源，颜色/间距/圆角/字号消费 Kiln token，不新造一套。
- 精准修改：只碰完成任务必须改的代码，不顺手重构无关部分，不添加未要求的抽象。
- 每个任务结束必须跑通对应验收命令，失败不得声称完成。

## 批次划分

| 批次 | 任务 | 状态 |
|---|---|---|
| 第一批 | T0.1, T1.1 – T1.5 | 已完成（Codex） |
| 第二批 | T2.1 – T2.4 | 已完成 |
| 第三批 | T3.1 – T3.3 | 已完成（Codex） |
| 额外修复 | 侧栏补回「随机漫步」入口 | 已完成（主线） |
| 收尾 | T4.1 – T4.2 导图链接通电 | 未派发 |

## 额外修复：随机漫步在 UI 上无入口

验收第三批时发现，`sidebar-nav.tsx` 的 `navItems` 只有 inbox / tagged / insight / archive 四项，**`walk` 和 `dailyReview` 都没有入口**——review-workspace 支持这两种模式、Rust 有 walk prompt、侧栏连计数都算好了（`counts.walk`），但用户点不到。README 明确写了这两个入口应当存在，属于既有回归（推测是 astryx-migration 重构遗留）。

不修的话 T3.3 的建议边 UI 用户永远看不到，因此补回 `{ id: "walk", icon: RouteIcon }`。

`dailyReview` 同样缺失，但不影响本批闭环，未一并处理。

---

# 第一批

## T0.1 导图退出 Inbox 主时间线

**问题**：`src/components/shard/fragment-timeline.tsx:72` 的 `buildTimelineItems(fragments, mindMaps)` 把导图卡片混进主时间线（第 348 行渲染 `MindMapTimelineCard`），违反 `docs/dev/editable-mind-map-and-document-links-plan.md` 第 26 条「禁止导图进入默认首屏、Inbox 主时间线」。

**做什么**
1. `fragment-timeline.tsx`：`buildTimelineItems` 去掉 `mindMaps` 参数，只处理 fragments；移除 `MindMapTimelineCard` 的 import 与渲染分支
2. `FragmentTimelineProps` 移除 `mindMaps`、`onOpenMindMap`
3. `src/App.tsx` 移除向 `FragmentTimeline` 传这两个 prop 的地方
4. `mind-map-timeline-card.tsx` / `.module.css` 若无其他消费者则删除（先 grep 确认）
5. 侧栏 Structures/Maps 入口保持不变，导图工作区功能不受影响

**验收**：`pnpm build` 通过；`grep -rn "MindMapTimelineCard" src/` 无残留；手工确认侧栏仍能打开导图列表和导图工作区

**禁止**：不要顺手改导图工作区内部实现；不要动侧栏导航结构

---

## T1.1 Rust 侧关系数据结构

**文件**：`src-tauri/src/lib.rs`

**做什么**
1. 新增结构体（放在 `FragmentFrontmatter` 附近）：

```rust
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
struct FragmentRelation {
    target_id: String,
    /// manual | walk | insight | tag
    origin: String,
    created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    note: Option<String>,
}
```

2. `FragmentFrontmatter`（当前在第 338 行附近）新增字段：

```rust
#[serde(default, skip_serializing_if = "Vec::is_empty")]
related: Vec<FragmentRelation>,
```

3. 所有构造 `FragmentFrontmatter` 的地方补 `related: Vec::new()`

**关键约束**：`FragmentFrontmatter` 没有 `deny_unknown_fields`，**不要给它加**。`skip_serializing_if` 必须保留——没有关系的片段回写后文件内容必须与改动前**逐字节一致**。

**验收**：`cargo check` 通过

---

## T1.2 关系读写核心函数

**文件**：`src-tauri/src/lib.rs`

**做什么**：实现两个内部函数（不是 command，command 在 T1.3）

```rust
fn link_fragments_in_vault(
    vault: &Path,
    source_id: &str,
    target_id: &str,
    origin: &str,
    note: Option<String>,
) -> Result<Fragment, String>

fn unlink_fragments_in_vault(
    vault: &Path,
    source_id: &str,
    target_id: &str,
) -> Result<Fragment, String>
```

规则：
1. 两端都必须过 `ensure_public_fragment_id`（已存在，见 `create_mind_map_in_vault` 的用法）。**密匣片段一律拒绝**，明文 frontmatter 不得出现密匣片段 id
2. `source_id == target_id` 返回 Err（自环）
3. 重复边幂等：已存在同 `target_id` 的边时直接返回当前 Fragment，不重复追加、不更新 `updated_at`
4. `origin` 只接受 `manual` / `walk` / `insight` / `tag`，其余返回 Err
5. 写入复用 `write_fragment_file`（原子写），更新 `updated_at`
6. 提交复用现有 `commit_path`，message 形如 `link fragment <前8位id> -> <前8位id>` / `unlink fragment ...`
7. `unlink` 时目标边不存在：幂等返回，不报错

**验收**：`cargo check` 通过

---

## T1.3 暴露为 Tauri command

**文件**：`src-tauri/src/lib.rs`

**做什么**
1. 按现有 command 的写法（`async fn` + `run_blocking`）包装 T1.2 的两个函数：

```rust
#[tauri::command]
async fn link_fragments(
    app: tauri::AppHandle,
    source_id: String,
    target_id: String,
    origin: String,
    note: Option<String>,
) -> Result<Fragment, String>

#[tauri::command]
async fn unlink_fragments(
    app: tauri::AppHandle,
    source_id: String,
    target_id: String,
) -> Result<Fragment, String>
```

2. 注册进 `invoke_handler` 的 `generate_handler!` 列表
3. `Fragment` 返回结构体补 `related` 字段（前端类型在 T1.4 对齐）

**验收**：`cargo check` 通过

---

## T1.4 前端类型与 API wrapper

**文件**：`src/types.ts`、`src/lib/api.ts`

**做什么**
1. `src/types.ts` 新增，并给 `Fragment` 加 `related?: FragmentRelation[]`：

```ts
export interface FragmentRelation {
  targetId: string
  origin: "manual" | "walk" | "insight" | "tag"
  createdAt: string
  note?: string
}
```

2. `src/lib/api.ts` 按现有 wrapper 写法补：

```ts
export function linkFragments(
  sourceId: string,
  targetId: string,
  origin: FragmentRelation["origin"],
  note?: string
): Promise<Fragment>

export function unlinkFragments(sourceId: string, targetId: string): Promise<Fragment>
```

参数名要与 Rust command 的 snake_case → camelCase 约定一致（参考现有 `createMindMap` 的写法）。

**验收**：`pnpm build` 通过

---

## T1.5 Rust 单元测试

**文件**：`src-tauri/src/lib.rs` 的 `#[cfg(test)] mod tests`（已存在，参考现有 vault 测试的搭建方式）

**必须覆盖**
1. `test_link_fragments_basic`：建一条边，frontmatter 里出现 `related`，字段值正确
2. `test_link_fragments_idempotent`：同一条边建两次，`related` 长度仍为 1
3. `test_link_fragments_rejects_self`：自环返回 Err
4. `test_link_fragments_rejects_lockbox`：密匣片段作为 source 或 target 都返回 Err
5. `test_link_fragments_rejects_bad_origin`：非法 origin 返回 Err
6. `test_unlink_fragments`：删边后 `related` 为空，且**字段从 frontmatter 中消失**（验证 `skip_serializing_if`）
7. `test_legacy_fragment_roundtrip`（**最重要**）：构造一个不含 `related` 字段的旧片段文件，读入后原样回写，断言文件内容**逐字节不变**

**验收**：`cargo test` 全绿

---

# 第二批

架构沿用仓库既有的搜索模式：**纯逻辑放 `src/lib/`（无 DOM 依赖、可独立推理），worker 只做薄壳**（参考 `src/lib/fragment-search.ts` + `src/workers/fragment-search.worker.ts` 的分工）。

## T2.1 关系计算层

**文件**：`src/lib/relations.ts`（新建）

**做什么**：实现纯函数计算层，不碰 DOM、不 import React。

```ts
export interface RelatedFragment {
  fragment: Fragment
  reason: "linked" | "tag"
  score: number
  note?: string
}

/** 全局标签统计，供 idf 加权；建索引时算一次 */
export interface RelationsIndex {
  byId: Map<string, Fragment>
  /** tag -> 含该标签的片段 id 集合 */
  tagBuckets: Map<string, Set<string>>
  /** targetId -> 指向它的 source id 集合（反向边） */
  backlinks: Map<string, Set<string>>
  total: number
}

export function buildRelationsIndex(fragments: Fragment[]): RelationsIndex

export function computeRelated(
  index: RelationsIndex,
  targetId: string,
  limit?: number
): RelatedFragment[]
```

计算规则：

1. **已确认的边**（`reason: "linked"`）——双向：该片段 `related` 里指向的，加上 `backlinks` 里指向它的。`score` 固定给一个高于任何标签分的常量（例如 1000），保证永远排在前面。带上边的 `note`。
2. **同标签共现**（`reason: "tag"`）——两条片段共同标签的 idf 之和：`idf(tag) = Math.log(total / bucketSize)`。
3. **排除项**：自己、已归档片段、密匣片段（`fragment.lockbox`）、`inbox` 这类泛标签（idf 趋近 0 时天然低权，但 `inbox` 直接硬排除，因为它是默认标签，共现无信息量）。
4. 同一片段同时命中 linked 和 tag 时**只保留 linked**，不重复出现。
5. 按 score 降序，score 相同按 `createdAt` 降序，取 `limit`（默认 8）。

**约束**：不 import 任何 React / Tauri API；`buildRelationsIndex` 只遍历一次片段列表。

**验收**：`pnpm build` 通过；`grep -n "import" src/lib/relations.ts` 只应出现类型 import。

---

## T2.2 关系 worker 与 hook

**文件**：`src/workers/fragment-relations.worker.ts`（新建）、`src/lib/use-fragment-relations.ts`（新建）

**做什么**

1. 在 `src/lib/relations.ts` 里补 worker 消息协议（与 `fragment-search.ts` 的 `FragmentSearchWorkerRequest` / `Response` 同构）：

```ts
export type FragmentRelationsWorkerRequest =
  | { type: "index"; version: number; fragments: Fragment[] }
  | { type: "query"; version: number; requestId: string; targetId: string; limit?: number }

export type FragmentRelationsWorkerResponse =
  | { type: "ready"; version: number }
  | { type: "results"; version: number; requestId: string; related: RelatedFragment[] }
```

2. worker 照抄 `fragment-search.worker.ts` 的结构：模块级持有 index 与 indexVersion，`type: "index"` 时重建并回 `ready`，`query` 时先比对 version 不符则丢弃。

3. hook `useFragmentRelations(fragments: Fragment[])`：
   - 用 `useEffect` 创建一次 worker（`new URL("../workers/fragment-relations.worker.ts", import.meta.url)`, `{ type: "module" }`），卸载时 `terminate()`
   - `fragments` 变化时重新发 `index` 消息并递增 version
   - 返回 `{ isReady: boolean, requestRelated: (targetId: string, limit?: number) => Promise<RelatedFragment[]> }`
   - `requestRelated` 用 requestId 匹配响应；version 失效的响应直接丢弃；组件卸载后不得 setState

**关键约束**：worker **只创建一次**，挂在时间线/App 层级，**禁止每张卡片各建一个 worker**。

**验收**：`pnpm build` 通过；`pnpm test:ui` 17 项仍全绿（本任务不改 UI，测试应无变化）

---

## T2.3 卡片「相关片段」折叠区 —— 已完成

落地方案（与原设想有一处调整，见下）：

- 新建 `src/components/shard/fragment-related.tsx`
- **有已确认边的卡片**才在底部常驻一行「N 条关联」（`fragment.related.length`，零计算）
- **无边的卡片不占任何垂直空间**，从更多菜单「相关片段」显式进入 —— 保证默认时间线密度完全不变
- 展开才请求 worker；`score <= 0` 的候选在 UI 层过滤掉（只共享全库通用标签，无信息量）
- 已确认的边带 `note`，显示为 `title`
- 跳转复用 App 既有的 `setPendingScrollFragmentId`，不新增定位逻辑，不使用 `scrollIntoView()`
- worker 挂在 `fragment-timeline.tsx`，整条时间线共用一个实例
- 顺带把 `markdownToSearchText` 从 `fragment-search.ts` 导出复用为摘要提取

回归：`tests/ui/shadcn-migration.spec.ts` 新增 `片段关系层` describe（2 项）。`installTauriMock` 加了可选 `relations` 参数，默认行为不变，现有 17 项测试零影响。

## T2.4 建边与移除关联入口

**目标**：让用户真的能建边、能移除。这是 Phase 2 形成闭环的最后一步，做完用户才"用得到"。

### 文件

- `src/components/shard/fragment-link-dialog.tsx`（新建）
- `src/components/shard/fragment-card.tsx`（改）
- `src/components/shard/fragment-related.tsx`（改）
- `src/components/shard/fragment-timeline.tsx`、`src/App.tsx`（接线）

### 1. 关联选择对话框

新建 `FragmentLinkDialog`，**不要改 `fragment-search-workspace.tsx`**（那是全屏视图，不适合当选择器）。直接复用 lib 层搜索函数：

```ts
import { buildFragmentSearchIndex, searchFragmentIndex, toFragmentSearchDocument } from "@/lib/fragment-search"
```

```ts
interface FragmentLinkDialogProps {
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  /** 发起关联的片段，要从候选里排除自己 */
  source: Fragment
  fragments: Fragment[]
  onConfirm: (targetId: string) => Promise<void> | void
}
```

要求：
- 用仓库现有的 `@/components/ui/dialog`，样式跟随 `lockbox-dialog.tsx` 的既有写法
- 顶部一个搜索输入（`@/components/ui/input`），下方列出候选，每条显示时间 + 摘要（摘要用 `markdownToSearchText`，已导出）
- 候选排除：自己、已归档、密匣片段、已经关联过的片段
- 空查询时显示最近 20 条；有查询时走 `searchFragmentIndex`
- 索引用 `useMemo` 基于 `fragments` 构建，**不要每次输入都重建**
- 选中一条即调 `onConfirm(targetId)` 并关闭对话框
- 键盘可用：上下键移动高亮、Enter 选中、Esc 关闭

### 2. 卡片菜单入口

`fragment-card.tsx` 的更多菜单里，在「相关片段」下方加一项「关联到片段…」（图标 `Link2Icon`），点击打开 `FragmentLinkDialog`。仅当传入了 `onLinkFragment` 时渲染。

新增 props：

```ts
onLinkFragment?: (sourceId: string, targetId: string) => Promise<void> | void
onUnlinkFragment?: (sourceId: string, targetId: string) => Promise<void> | void
fragments?: Fragment[]   // 供对话框做候选
```

### 3. 移除关联

`fragment-related.tsx` 里，`reason === "linked"` 的行右侧加一个移除按钮（`XIcon`，`size="icon-sm"`、`variant="ghost"`）：

- `aria-label` 为「移除关联」
- 点击**不要**触发整行的跳转（`event.stopPropagation()`）
- 调 `onUnlinkFragment(fragment.id, item.fragment.id)`
- 移除进行中禁用该按钮并显示 `aria-busy`
- 移除成功后本地把该行从列表里去掉，不必等整页刷新

注意：反向边（别人指向我）也显示为 linked。移除时 `source` 必须是**真正持有这条边的那一侧**——`RelatedFragment` 需要能区分方向。在 `src/lib/relations.ts` 的 `RelatedFragment` 上加一个字段：

```ts
/** 该边存放在哪一侧的 frontmatter 里 */
linkOwnerId?: string
```

`computeRelated` 填充它：出边填 `targetId` 所属的当前片段 id，入边填对方 id。移除时用 `linkOwnerId` 作为 source。

### 4. App 接线

`App.tsx` 增加两个 handler，通过 `FragmentTimeline` 透传给卡片：

```ts
async function handleLinkFragment(sourceId: string, targetId: string)
async function handleUnlinkFragment(sourceId: string, targetId: string)
```

- 调 `linkFragments` / `unlinkFragments`
- 成功后用返回的 Fragment 就地更新 `setFragments`（参考 `handlePinFragment` 的写法），**不要整库重新拉取**
- 失败用 `toast.error(getApiErrorMessage(error))`
- 成功后 `toast.success("已关联")` / `toast.success("已移除关联")`

### 验收

- `pnpm build` 通过
- `pnpm test:ui` 现有 19 项仍全绿
- 新增至少 2 项 Playwright 测试放进 `片段关系层` describe：
  1. 从菜单打开关联对话框、搜索、选中后卡片出现「1 条关联」
  2. 展开关联行、点移除按钮后该行消失，且不会触发跳转
- mock 需要处理 `link_fragments` / `unlink_fragments` 两个 command，返回更新后的 fragment

---

# 第三批

## T3.1 漫步 prompt 追加机器可读尾块

**文件**：`src-tauri/src/lib.rs`（`CodexReviewTask::Walk` 分支，约 3767 行）

在现有输出要求的末尾追加：

```
- 最后单独输出一个 json 代码块，格式严格为：
  {"edges":[{"from":1,"to":3,"reason":"一句话理由"}]}
  from / to 使用上面的来源笔记编号，reason 不超过 30 字。
  这个块供程序解析，不要加任何额外说明文字。
```

**约束**：不要改动 `## 漫步路径` / `## 意外连接` 两个标题的要求，也不要改洞察（insight）任务的 prompt。

**验收**：`cargo check` 通过

## T3.2 解析建议边

**文件**：`src/lib/review-workflows.ts`

```ts
export interface SuggestedEdge {
  fromId: string
  toId: string
  reason: string
}

/**
 * 从漫步结果里提取建议边。
 * fragments 必须是本次发给 AI 的同一个有序列表（「笔记 N」按 1 起编号）。
 */
export function parseSuggestedEdges(
  markdown: string,
  fragments: Fragment[]
): SuggestedEdge[]
```

要求：
- 提取 markdown 里最后一个 ```json 代码块并解析
- **解析失败、格式不符、编号越界一律返回空数组，绝不抛异常**——洞察正文比建议边重要得多，不能因为解析失败让用户看不到结果
- 过滤自环、重复边、以及指向归档/密匣片段的边
- `reason` 截断到 40 字

## T3.3 建议边确认 UI

**文件**：`src/components/shard/review-workspace.tsx`

- 漫步结果渲染区（`result={walkText}` 那处）下方增加「建议的关联」区块
- 每条一行：`来源摘要 → 目标摘要`，下面小字显示 `reason`，右侧一个「保留」按钮
- 点「保留」调 `linkFragments(fromId, toId, "walk", reason)`，成功后该行替换为「已保留」的静态文字
- **不要做「全部保留」批量按钮**（会污染关系层）
- 失败 `toast.error`，不影响其他行
- 没有建议边时整个区块不渲染

### 验收

- `cargo check`、`pnpm build` 通过
- `pnpm test:ui` 全绿
- 新增 1 项测试：mock 一个带 json 尾块的漫步结果，验证建议边渲染且点「保留」后调用了 `link_fragments`

# 第三批（未派发）

## T3.1 walk prompt 追加机器可读 json 尾块
## T3.2 前端解析与编号→id 映射（失败静默降级）
## T3.3 建议边的逐条确认 UI

# 收尾（未派发）

## T4.1 `createMindMap` 的 `sourceFragmentId` 通电
## T4.2 导图节点链接角标（**节点仍只是短文本，禁止渲染成片段卡片**）
