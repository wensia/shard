# 片段关系层与回看浮现（Fragment Relations）实施计划

状态：待实施
创建：2026-08-18
裁决依据：council-20260818-070701（codex / antigravity / grok / kimi，4/4 高置信）

## 背景与裁决

回看侧真正的缺口不是「片段摆在哪」，而是「这条片段还连着什么」。

多方审计一致否决「自由坐标空间画布」（新建 `.shardcanvas.json`、节点带 x/y、拖拽改坐标语义），三条理由同向：

1. **心智**：自由摆放向用户征收「整理税」，与「只优化捕捉」的产品根基冲突。
2. **架构**：x/y 是视觉状态而非业务数据。持久化后 git diff 全是 `x: 341→358` 的无语义噪音，且 merge 冲突（两个分支移动同一个框）在语义上无法判对错，与 local-first + 可读可 diff 的 vault 约束互斥。
3. **成本**：单人维护下，双层 hit-testing、z-index、框选碰撞、画布内文本编辑与 IME、大图性能会持续吃预算。

`docs/dev/editable-mind-map-and-document-links-plan.md` 第 49-50 行已把「不做 Obsidian Graph View 式全库自由图谱」「不做无限画布白板」写入非目标。本计划与该裁决一致，不推翻它。

现有导图 `parentId + sortKey` 入库、坐标由 `layoutMindMap()` 每次派生的做法是正确架构，本计划沿用同一原则：**存关系，不存像素**。

## 目标

1. 片段之间的「边」成为可持久化、可 diff、可被 git 追踪的一等数据。
2. 回看时关联自动浮现到用户面前，而不是等用户主动去翻。
3. 把随机漫步 / AI 洞察当前「算完即扔」的关联沉淀下来。
4. 捕捉链路零改动：composer、Cmd+Enter、时间线渲染路径不受影响。

## 非目标

- 不做自由坐标画布、不新增 `.shardcanvas.json`、不引入图形库（React Flow 等）。
- 不做全库自动图谱可视化。
- 不让导图节点渲染成片段卡片（防止树导图滑向白板）。
- 不做自动建边：AI 只能「建议」，落盘必须经用户确认。
- 不改写片段正文，边只进 frontmatter。

---

## Phase 0：先还债（0.5 天）

`fragment-timeline.tsx:72` 的 `buildTimelineItems(fragments, mindMaps)` 把导图卡片混进了 Inbox 主时间线（348 行渲染 `MindMapTimelineCard`），违反 `editable-mind-map-and-document-links-plan.md` 第 26 条「禁止导图进入默认首屏、Inbox 主时间线」。

关系层会往时间线卡片上追加「相关片段」区域，动手前先把这笔债还掉，否则时间线的内容边界会越来越糊。

- 从 `buildTimelineItems` 移除 `mindMaps` 参数，导图只保留侧栏 Structures/Maps 分区入口
- `FragmentTimelineProps` 移除 `mindMaps` / `onOpenMindMap`
- `MindMapTimelineCard` 若无其他消费者则删除

若判断该越界是刻意的产品决定，则改为在原计划文档里显式修订第 26 条并记录理由，不要让代码和文档继续互相矛盾。

---

## Phase 1：边的数据层（2-3 天）

### 存储位置：片段 frontmatter

边写进片段自己的 frontmatter，不建全局 `relations/` 索引。

理由：
- 边随片段走。片段删除、归档、进密匣时，边自然跟随，无需维护外部索引一致性。
- git diff 落在片段文件上，语义清晰（「这条片段新增了一条指向 X 的关联」），不产生集中式索引文件的写冲突热点。
- `FragmentFrontmatter`（`src-tauri/src/lib.rs:338`）**没有** `deny_unknown_fields`，新增字段对旧版本向后兼容；新字段加 `#[serde(default, skip_serializing_if = "Vec::is_empty")]`，未使用该功能的片段文件零变化。

单向存储：只在发起侧写一条边，反向关系由内存索引推导，避免一次操作写两个文件、以及两侧不一致的修复逻辑。

### Rust 侧改动（`src-tauri/src/lib.rs`）

```rust
// FragmentFrontmatter 新增
#[serde(default, skip_serializing_if = "Vec::is_empty")]
related: Vec<FragmentRelation>,

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct FragmentRelation {
    target_id: String,
    /// manual | walk | insight | tag
    origin: String,
    created_at: String,
    /// 建边理由，来自 AI 时保存其原句，人工建边可为空
    #[serde(default, skip_serializing_if = "Option::is_none")]
    note: Option<String>,
}
```

新增两个 command（挂进 `invoke_handler`）：

- `link_fragments(source_id, target_id, origin, note) -> Fragment`
- `unlink_fragments(source_id, target_id) -> Fragment`

实现约束：
- 两端都要过 `ensure_public_fragment_id`（已存在，见 `create_mind_map_in_vault` 的用法）。**密匣片段不参与关系层**，明文 frontmatter 不得出现密匣片段 id——这与原计划第 12 条「密匣元数据泄露是阻断项」一致。
- 自环（source == target）拒绝；重复边幂等返回。
- 复用 `write_fragment_file` 的原子写；沿用现有 `commit_path` 提交，commit message 形如 `link fragment <short-id> -> <short-id>`。
- 按 AGENTS.md Runtime Rules，command 用 `async fn` + `run_blocking` 包裹文件读写。

### 前端类型（`src/types.ts`）

```ts
export interface FragmentRelation {
  targetId: string
  origin: "manual" | "walk" | "insight" | "tag"
  createdAt: string
  note?: string
}
// Fragment 新增：related?: FragmentRelation[]
```

`src/lib/api.ts` 补 `linkFragments` / `unlinkFragments` 两个 wrapper。

### 验证

- `cargo check`
- Rust 单测：建边 / 幂等 / 自环拒绝 / 密匣拒绝 / 旧格式文件读入后 `related` 为空且回写不产生 diff（**这条必测**，它保证向后兼容）

---

## Phase 2：相关片段浮现（3-4 天）

### 计算层：`src/lib/relations.ts`（新建）

```ts
export interface RelatedFragment {
  fragment: Fragment
  reason: "linked" | "tag" | "suggested"
  score: number
  note?: string
}

export function computeRelated(
  target: Fragment,
  all: Fragment[],
  options?: { limit?: number }
): RelatedFragment[]
```

三个来源合并后按 score 排序、去重：

1. **已确认的边**（`related` 字段，双向：自己指向的 + 指向自己的）——最高权重，永远排前
2. **同标签共现**——排除 `inbox` 这类泛标签，稀有标签权重更高（`idf = log(总数 / 含该标签数)`），两条片段的共同标签 idf 之和为分数
3. **AI 建议**（Phase 3 落地前留空数组）

### 性能：放进 Worker

全量共现计算是 O(n×m)，几千条片段时不能进 UI 线程（AGENTS.md Runtime Rules 明确禁止）。

复用 `src/workers/fragment-search.worker.ts` 的既有模式，新建 `src/workers/fragment-relations.worker.ts`，或在现有 worker 里扩一个 `type: "relations"` 请求分支。反向边索引（targetId → sources）在 worker 内构建一次并缓存，片段列表变更时失效重建。

### UI：卡片底部「相关片段」

`fragment-card.tsx` 的 `FragmentCardProps` 新增：

```ts
related?: RelatedFragment[]
onOpenRelated?: (fragment: Fragment) => void
onUnlink?: (source: Fragment, targetId: string) => void
```

交互约束：
- **默认折叠**，显示为一行「3 条相关」，点击展开。捕捉与浏览的默认视觉密度不能被改变。
- 展开后每条显示：首行摘要（复用现有 markdown 行解析）、来源徽标（关联 / 同标签 / AI 建议）、`note`
- 点击跳到该片段——**复用时间线现有的定位逻辑**，滚动 ScrollArea viewport 计算 scrollTop，禁止 `scrollIntoView()`（见 CLAUDE.md / AGENTS.md 主布局滚动规则）
- 只在展开时请求计算，不在时间线渲染时批量算

### 建边入口

- 片段卡片更多菜单 →「关联到片段…」→ 复用 `fragment-search-workspace` 做选择器
- 搜索结果多选 →「互相关联」（原计划文档第 62 条早已规划「关联到导图节点」的显式动作，同一心智）

### 验证

- `pnpm build`、`pnpm test:ui`
- 手工：500+ 片段的 vault 展开相关片段，观察是否掉帧

---

## Phase 3：把随机漫步的边留下来（2-3 天）

### 现状

`randomWalkFragments`（`src/lib/review-workflows.ts:81`）只做 `stablePick` 随机抽取，不计算关联。真正的连接由 Codex CLI 生成，输出是 Markdown（`## 漫步路径` / `## 意外连接`，见 `src-tauri/src/lib.rs:3767`），引用格式 `[笔记 N]`——N 是本次 prompt 内的临时序号，与 fragment id 无映射，结果落成一条带 `ai/insight` 标签的普通片段后，连接信息就此沉没。

### 改造

1. **prompt 追加结构化尾块**。在 walk 任务的输出要求后追加：

```
- 最后输出一个 ```json 代码块，格式为：
  {"edges":[{"from":1,"to":3,"reason":"一句话理由"}]}
  from / to 使用来源笔记编号。这个块用于程序解析，不要添加额外说明。
```

洞察任务（`CodexInsightLens`）同样可加，Phase 3 先只做 walk。

2. **解析与映射**。前端拿到结果后提取尾部 json 块，用本次 `codexReviewFragments` 的入参顺序把 `笔记 N` 映射回 fragment id。解析失败静默降级为「无建议」，不影响 Markdown 正文展示——**不能因为解析失败就丢掉整个洞察结果**。

3. **确认才落盘**。`review-workspace.tsx` 在结果下方列出建议边，每条一个「保留」按钮，点击才调 `linkFragments(..., origin: "walk", note: reason)`。不做「全部保留」的一键批量，避免低质量边污染关系层。

### 验证

- `cargo check`（prompt 改在 Rust 侧）、`pnpm build`
- 手工跑一次随机漫步，确认：json 块被正确解析、编号映射正确、拒绝保留时 vault 无写入

---

## Phase 4（可选，暂不排期）：只读聚类投影

若「空间感」的需求在 Phase 1-3 落地后依然存在，只做：算法派生、只读、用完即弃的聚类视图——按已确认的边 + 标签共现 + 时间邻近排布 8-20 张卡片，位置每次由布局算法生成、只存在于内存，点击仍回到时间线。

不落盘坐标、不新增文件格式、不引图形库。可复用 `mind-map-canvas-editor.tsx` 里最有价值的那部分资产：手写的 viewport 手势（wheel 缩放锚点换算、ctrlKey 捏合、Safari gesture 事件、marquee 框选、缩放钳制，约 319-435 行）。

---

## 顺带收尾：导图链接通电（1 天，独立于主线）

`createMindMap(title, sourceFragmentId?)`（`src/lib/api.ts:56`）的第二个参数从未被传过，Rust 侧 `create_mind_map_in_vault` 的实现、`ShardDocumentLink` enum、lockbox 校验都已就位——这是原计划文档第 61 条「在公开 fragment 卡片更多菜单里提供『用这条片段创建导图』」的欠账。

- 片段卡片更多菜单加「用这条片段创建导图」，传 `sourceFragmentId`
- 导图节点渲染链接角标，点击跳回片段

**硬约束**：节点仍然只是短文本。禁止把节点渲染成片段卡片、禁止在节点内展示片段正文摘录——这是树导图滑向白板的唯一入口，必须封死。

---

## 排期与优先级

| 阶段 | 内容 | 预估 | 优先级 |
|---|---|---|---|
| Phase 0 | 导图退出主时间线 | 0.5 天 | 先做 |
| Phase 1 | 边的数据层 | 2-3 天 | 主线 |
| Phase 2 | 相关片段浮现 | 3-4 天 | 主线（价值兑现点） |
| Phase 3 | 随机漫步边沉淀 | 2-3 天 | 主线 |
| 收尾 | 导图链接通电 | 1 天 | 可随时插入 |
| Phase 4 | 只读聚类投影 | — | 暂不排期 |

主线合计约 8-11 天。Phase 1 单独上线用户无感知，**价值在 Phase 2 才兑现**，两者应连续排。

## 成功判据

- 边能建、能删、能在 git 历史里看懂改了什么
- 旧片段文件读入回写后 `git diff` 为空
- 500+ 片段 vault 展开相关片段无可感卡顿
- 随机漫步的连接理由能沉淀成边，且拒绝保留时 vault 零写入
- 捕捉链路（composer、Cmd+Enter、时间线首屏）无任何行为变化

## 已知限制（不阻塞交付）

`link_fragments_in_vault` 的调用链里，`ensure_public_fragment_id`（两端各一次）和 `find_fragment_path` 都会**全量读取并解析 vault 里的每个片段文件**来按 id 定位，单次建边最多触发 5 轮全量扫描。

`find_fragment_path` 是既有函数，这个模式在仓库里早已存在，不是关系层引入的。当前 vault 规模（约 33 条片段）下延迟不可感知，因此本次不做优化，避免范围扩张。

**触发重构的阈值**：片段数达到千级，或用户报告建边有可感延迟。届时的正确做法是建一次内存 id→path 映射并在单次 command 内复用，而不是把它做成常驻索引（那会引入缓存失效问题，与 local-first 的文件真相源冲突）。

## 审计记录

- 2026-08-18 · council-20260818-070701 · 选手:codex,antigravity,grok,kimi · 主席claude裁决 HIGH:「否决自由坐标画布，主投资转向片段之间的边与回看侧自动浮现」· 报告 ~/.council/shard/council-20260818-070701/viewer.html
