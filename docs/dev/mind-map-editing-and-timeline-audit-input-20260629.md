# 思维导图编辑与时间线展示审计输入

Status: audit-reviewed
Date: 2026-06-29
Related: `docs/dev/editable-mind-map-and-document-links-plan.md`
Audit: `council-20260628-184106`

> 说明：本文前半部分保留为提交给其他 AI 的原始审计输入，不能直接作为执行方案。实际执行以文末“吸收后的执行口径”和 `docs/dev/editable-mind-map-and-document-links-plan.md` 的二次审计修订版为准。

## 背景

Shard 的思维导图第一阶段已经完成了底层存储和低侵入创建入口：

- 后端已有 `list_mind_maps`、`create_mind_map`、`read_mind_map`、`write_mind_map`、`delete_mind_map`。
- 导图保存为 `maps/**/*.shardmap.json`，使用 `kind: "shard.map"` 与 `schemaVersion: 1`。
- 写入层已有 revision/hash 冲突检测、原子写、last-good 备份、conflict 副本、密匣链接拦截。
- 前端已有 `MindMapDialog`，能创建、列出、读取导图。
- 侧栏和窄屏底部栏已有可见的思维导图入口。

但当前产品仍有两个明显缺口，需要审计后再进入实现。

## 问题 1：如何编辑思维导图

### 当前状态

当前 `MindMapDialog` 只能做：

1. 输入标题并创建导图。
2. 刷新导图列表。
3. 选择导图后读取并展示标题、路径、revision、根节点和最多 5 个一级子节点。

当前不能做：

1. 修改导图标题。
2. 修改根节点文本。
3. 新增、编辑、删除、重排节点。
4. 保存编辑后的 `.shardmap.json`。
5. 处理保存冲突后的 UI 恢复。

### 候选 v1 实现

建议第一步不要直接引入完整 React Flow 画布，而是先在现有 Dialog 内做一个“可编辑一级大纲”：

1. 标题输入框绑定 `file.title`。
2. 根节点输入框绑定 `file.nodes[file.rootId].text`。
3. 一级子节点以列表展示，每行支持编辑文本、删除。
4. 提供“添加分支”按钮，新增 parentId 指向 root 的节点。
5. 点击“保存”调用 `writeMindMap(id, file, expectedRevision, lastSavedHash)`。
6. 保存成功后更新 `selectedMap`、revision、lastSavedHash 和左侧 summary。
7. 保存失败时保留当前编辑态，并展示后端返回的冲突副本路径。

这个实现不是最终导图编辑器，只是把“可以编辑和保存”打通。后续 React Flow / XYFlow 仍可基于同一 schema 接入。

### 审计问题

请重点审计：

1. 这个“一级大纲编辑器”是否会破坏原方案中“第一版采用 React Flow / XYFlow”的裁决？
2. 是否应该把它定位为 Phase 1.5 的过渡编辑器，还是直接跳到 React Flow？
3. 最小编辑能力应包含哪些操作才算可用：标题、根节点、一级节点是否足够？
4. 节点新增时 `sortKey` 用时间戳/稀疏字符串是否可接受，还是必须先实现严格排序算法？
5. 保存时是否必须支持自动保存，还是显式“保存”足够？
6. 冲突处理是否只提示 conflict 文件路径即可，还是必须提供合并/覆盖 UI？

## 问题 2：新建思维导图应按时间线显示在主面板

### 当前状态

新建导图后，目前只会出现在 `MindMapDialog` 左侧列表，不会进入主面板时间线。

当前主面板时间线只接收 `Fragment[]`：

- `App.tsx` 通过 `listFragments()` 读取 fragment。
- `FragmentTimeline` 渲染 `FragmentCard`。
- 过滤逻辑围绕 `FragmentFilter`、tags、archive、lockbox 展开。

导图现在不是 fragment，也不应该伪装成普通 Markdown fragment，因为导图有独立 schema、独立文件路径和不同操作。

### 候选 v1 实现

建议主面板引入轻量的 timeline item 层，而不是把导图塞进 `Fragment` 类型：

```ts
type TimelineItem =
  | { kind: "fragment"; fragment: Fragment; timestamp: string; pinned: boolean }
  | { kind: "mindMap"; map: MindMapSummary; timestamp: string; pinned: false }
```

Inbox 视图的主时间线可以混排：

1. 普通 fragment 继续按现有规则展示。
2. 思维导图 summary 按 `createdAt` 或 `updatedAt` 插入时间线。
3. 导图卡片使用独立 `MindMapTimelineCard`，展示时间、标题、节点数量未知时可只展示路径。
4. 点击导图卡片打开 `MindMapDialog` 并选中该导图。
5. 新建导图成功后，父级 `App` 刷新或插入 `MindMapSummary`，主面板立刻出现该卡片。

默认建议：

- Inbox 显示导图卡片。
- Tagged / Lockbox / Archive 不显示导图，避免导图参与 tags、密匣和归档语义。
- Review views 不显示导图，避免污染回顾模型。

### 审计问题

请重点审计：

1. 主时间线混排 `Fragment` 与 `MindMapSummary` 是否符合 Shard 的 capture-first 设计？
2. 导图卡片应该按 `createdAt` 还是 `updatedAt` 排序？
3. 是否只在 Inbox 显示导图，还是需要单独筛选入口？
4. 是否需要后端新增 `list_timeline_items` 聚合 command，还是前端并行调用 `listFragments()` 和 `listMindMaps()` 后合并即可？
5. 导图卡片是否需要展示节点数？如果需要，`MindMapSummary` 是否应扩展 `nodeCount`，避免主时间线读取完整 JSON？
6. 点击导图卡片后，是打开现有 Dialog，还是进入独立 workspace/route？
7. 如果导图更新后按 `updatedAt` 浮到时间线顶部，会不会干扰 fragment 捕获流？

## 实现边界建议

建议下一步只做以下最小闭环：

1. `MindMapDialog` 支持标题、根节点、一级分支的编辑与显式保存。
2. `App` 维护 `mindMaps: MindMapSummary[]`，启动和 vault 刷新时读取。
3. `FragmentTimeline` 接收导图 summary，并用独立卡片混排显示。
4. 新建导图成功后回调父级更新 `mindMaps`，主面板立即出现新卡片。
5. 点击主面板导图卡片打开 Dialog 并选中该导图。

暂不做：

1. React Flow 画布。
2. 节点拖拽布局。
3. 多级树完整编辑。
4. 导图参与 tag、lockbox、archive、review。
5. 全局 document relations 或反链。
6. 导入/导出。

## 验收标准

实现后应满足：

1. 在桌面 app 中创建导图后，主面板时间线立即出现对应导图卡片。
2. 点击导图卡片能打开导图编辑弹窗。
3. 修改标题、根节点或一级分支后保存，关闭再打开仍能看到修改。
4. 保存时 revision 增加，`lastSavedHash` 更新。
5. 保存冲突时不丢失当前编辑内容，并能看到冲突提示。
6. `tsc --noEmit`、`vite build`、`cargo check`、`cargo test mind_map` 通过。
7. 浏览器或 Tauri smoke 覆盖：创建、时间线显示、打开、编辑、保存。

## 审计输出期望

请其他 AI 审计时给出：

1. 是否批准上述最小闭环。
2. 必须修改的设计点。
3. 是否存在数据模型、安全、密匣泄露、UI 线程阻塞或 UX 风险。
4. 是否建议先实现 React Flow，而不是过渡大纲编辑器。
5. 是否建议后端新增聚合 timeline command。

## 发散思路要求

除了审计上述方案，请其他 AI 主动提出更优质的产品和技术思路。不要只回答“可行/不可行”，也不要只沿着当前方案小修小补。

请至少覆盖以下方向：

1. 更好的编辑体验：例如大纲编辑、画布编辑、键盘优先编辑、渐进式从大纲切到画布、节点内 Markdown、快速添加兄弟/子节点等。
2. 更好的时间线呈现：例如导图卡片是否应像 fragment、是否应做紧凑预览、是否应显示一级节点摘要、是否应独立成“项目/结构化内容”流。
3. 更好的信息架构：导图到底是 fragment 的补充、文档的一种、项目容器，还是一个单独内容类型。
4. 更好的关联模型：节点链接 fragment、Markdown、其他导图时，如何避免做成重型全局图谱，又能让关联有用。
5. 更好的渐进路线：从“可编辑一级大纲”到 React Flow / XYFlow 的迁移路径，哪些中间实现会被浪费，哪些可以复用。
6. 更好的默认行为：新建导图后是否应该自动出现在 Inbox 顶部、是否应该自动打开编辑、是否应该自动生成根节点和第一个空分支。
7. 更好的风险控制：如何避免导图功能污染 Shard 的 capture-first 主体验，如何防止 UI 变成知识库/白板/项目管理工具。

输出建议格式：

```text
Verdict: approve / approve with changes / reject

Critical fixes:
- ...

Better ideas:
- Idea: ...
  Why better: ...
  Cost/risk: ...
  Reuse with current plan: yes/no

Recommended path:
1. ...
2. ...
3. ...
```

鼓励提出与本文不同的方案，但必须说明：

- 哪些现有代码和 schema 可以复用。
- 哪些现有实现需要推翻。
- 对实现成本、验证成本和用户体验的具体影响。

## 审计记录

- 2026-06-29 · council-20260628-184106 · 选手:codex,antigravity,grok,opencode · 主席claude裁决 HIGH:「approve with changes — 否决一级大纲与 Inbox updatedAt 混排，改键盘优先递归大纲(命令层纯函数,未来 React Flow 只换 renderer)+导图独立 Structures 分区(不污染 capture-first);nodeCount 后端预算且 summary 不带节点文本,sortKey 用 fractional-indexing,冲突给二元恢复,显式保存」· 报告 /Users/panyuhang/.council/shard/council-20260628-184106/viewer.html

## 吸收后的执行口径

二次审计结论为 `approve with changes`。原输入中的两个候选方向不能直接执行：

1. 否决“仅一级大纲编辑器”。最小可用编辑器应是键盘优先的递归大纲，支持任意层级，并把新增同级、添加子节点、缩进、反缩进、删除、移动、编辑文本写成独立纯函数。后续 React Flow / XYFlow 只替换 renderer，命令层和 schema 不重写。
2. 否决“按 updatedAt 把导图混入 Inbox 主时间线”。导图不进入 capture-first 默认时间线，不参与 tag、lockbox、archive、review 和默认搜索；使用独立的 Structures / Maps 分区或显式入口。`createdAt` 只做创建锚点，`updatedAt` 只作为 edited 徽标。

落地前必须补充的硬要求：

1. 先核验 `revision`、`lastSavedHash`、`updatedAt` 是否为后端独立持久化业务字段，而不是依赖文件系统 mtime。
2. `MindMapSummary` 由后端预计算 `nodeCount`，只返回 metadata，禁止返回节点文本、节点摘要、密匣路径、密匣标题或正文摘录。
3. `sortKey` 使用稀疏字典序 / fractional-indexing，不能用裸时间戳。
4. Schema 校验补强：root 的 `parentId === null`、无环、所有节点可达、兄弟 `sortKey` 唯一、节点数和文本长度有上限。
5. 保存策略采用显式 Save + dirty guard；autosave 延后为可选能力。
6. 冲突处理至少提供“保留我的版本/保留磁盘版本”二元恢复，并继续保留 conflict 副本路径；不得丢弃当前编辑态。
7. 新建导图默认生成根节点和一个空分支，创建成功后自动打开编辑器并聚焦空分支。
8. v1 继续使用明文 `.shardmap.json`；密匣导图或加密 map 文件列入 future，需要单独设计。

执行顺序建议：

1. 后端事实核验与 summary/schema 写入门禁。
2. 树操作纯函数与 fractional-indexing 单测。
3. Structures / Maps 显式入口与递归大纲编辑器。
4. 显式保存、dirty guard、冲突二元恢复。
5. 真实 Tauri/WKWebView smoke：创建、打开、编辑、保存、冲突恢复。
