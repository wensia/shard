# 可编辑思维导图与文档关联方案

Status: revised after second multi-agent audit
Date: 2026-06-29
Owner: pending

## 背景

Shard 当前主线是本地优先的 Markdown fragment 捕获工具：启动后聚焦极简输入，保存后生成独立 Markdown 文件并进入时间线。思维导图不替代这个主线，也不把首屏变成 graph workspace。

本方案只讨论一个显式入口后的新能力：

- 用户在新建入口选择“思维导图”后进入导图编辑面。
- 默认 Inbox / CaptureBox / 时间线保持原样。
- 导图可以关联已有公开 fragment、vault 内公开 Markdown 文件或其他导图。
- 导图自身使用独立数据文件保存，不强行塞进现有 Markdown fragment。
- 文档关联能力作为导图节点能力先落地，不在 v1 抽全局 relations 索引。

## 审计后裁决

多方审计结论是批准推进，但必须按以下硬约束修订后再进入实现：

1. 主格式固定为 `maps/**/*.shardmap.json`，不把 OPML、FreeMind `.mm` 或 XMind 作为主格式。
2. 第一可交付编辑器采用键盘优先递归大纲；React Flow / XYFlow 保留为 Phase 2 renderer，不并行做 Mind Elixir 完整 PoC。
3. v1 只做节点级 links，不做全局 `relations/` 索引。
4. 禁止导图进入默认首屏、Inbox 主时间线、默认左侧主导航或常驻右侧 inspector。
5. 导图使用独立 Structures / Maps 分区或显式入口，不参与 tag、lockbox、archive、review 和默认搜索。
6. `list_mind_maps` 只返回轻量 summary；链接解析和 fragment 定位必须 lazy。
7. `MindMapSummary` 必须由后端预计算 `nodeCount`，且只返回 metadata，不返回节点文本或节点摘要。
8. `sortKey` 使用稀疏字典序 / fractional-indexing，不使用裸时间戳。
9. 保存策略采用显式 Save + dirty guard；autosave 延后为可选能力。
10. 冲突 UI 至少提供“保留我的版本/保留磁盘版本”二元恢复，并保留 conflict 副本路径。
11. 动手前必须确认 `revision`、`lastSavedHash`、`updatedAt` 是后端独立持久化业务字段，而不是文件系统 mtime 推导值。
12. 密匣元数据泄露是 Phase 1 阻断项：明文 `.shardmap.json` 不得持久化密匣 path、label、title 或正文摘录。
13. 写入必须有原子写、确定性 JSON、revision/hash 校验、冲突另存和 last-good 备份。
14. v1 砍掉导入/导出 Phase；若未来需要逃生口，最多先做 Markdown outline 单向导出。

## 目标

1. 支持创建、打开、编辑和保存一份本地思维导图。
2. 支持节点增删改、添加子节点、添加同级节点、折叠、重排。
3. 支持节点关联到公开 fragment、公开 Markdown 路径或其他导图。
4. 保持 capture-first 主体验不变：应用启动、收件箱、保存快捷键、时间线不受影响。
5. 文件格式稳定、可 Git diff、可迁移、可被脚本读取。
6. 所有 vault 扫描、导图读写、Markdown/链接解析都走异步路径，避免卡住 Tauri/WKWebView UI 线程。

## 非目标

- 不做 Obsidian Graph View 式全库自由图谱。
- 不做无限画布白板、复杂绘图、手写批注、多人协作。
- 不把所有 fragment 自动变成导图节点。
- 不要求导图反向改写 Markdown 正文结构。
- 不在 v1 做 OPML、FreeMind、XMind 导入导出。
- 不在 v1 支持普通明文导图链接密匣 fragment。

## 产品入口

入口必须低侵入：

1. 在支持菜单或新建菜单里放“新建思维导图”。
2. 在公开 fragment 卡片更多菜单里提供“用这条片段创建导图”。
3. 在搜索结果或标签视图中提供“关联到导图节点”，但必须是显式动作。
4. 在 Structures / Maps 这类显式分区展示导图列表；该分区不是默认首屏，也不让导图插入 Inbox 主时间线。

禁止第一版新增首屏常驻导图面板、默认左侧一级导图导航或永久右侧 inspector。导图编辑面可以使用独立 view、fullscreen-like Dialog/Sheet，或单独 route 状态，但返回后应恢复原来的 fragment 流。

## 数据文件

新增 vault 子目录：

```text
maps/
  2026/
    06/
      2026-06-29-153000-abcd.shardmap.json
```

使用 JSON 作为主格式，而不是 Markdown：

- 易被前端直接渲染。
- 易表达节点、布局、折叠、链接和视口状态。
- Git diff 可读性比二进制格式强。
- 不把导图编辑需求强行混入 fragment Markdown frontmatter。

## Schema v1

导图第一版是树，不是通用 graph；每个节点最多一个 `parentId`。节点结构使用扁平 `Record<string, ShardMapNode>`，避免深层嵌套树在 Git merge 时产生大面积冲突。

```ts
interface ShardMapFile {
  kind: "shard.map"
  schemaVersion: 1
  id: string
  title: string
  createdAt: string
  updatedAt: string
  savedWithAppVersion: string
  revision: number
  rootId: string
  hasProtectedLinks: false
  nodes: Record<string, ShardMapNode>
  viewport?: {
    x: number
    y: number
    zoom: number
  }
}

interface ShardMapNode {
  id: string
  parentId: string | null
  sortKey: string
  text: string
  note?: string
  collapsed?: boolean
  createdAt: string
  updatedAt: string
  links?: ShardDocumentLink[]
  style?: {
    tone?: "default" | "accent" | "success" | "warning"
  }
}

type ShardDocumentLink =
  | ShardFragmentLink
  | ShardMarkdownPathLink
  | ShardMapLink

interface ShardFragmentLink {
  id: string
  targetType: "fragment"
  targetId: string
}

interface ShardMarkdownPathLink {
  id: string
  targetType: "markdownPath"
  path: string
}

interface ShardMapLink {
  id: string
  targetType: "map"
  targetId: string
}
```

Schema 约束：

- `schemaVersion` 预留迁移路径；不得继续使用泛化的 `version`。
- `kind: "shard.map"` 用于文件类型校验，避免误读普通 JSON。
- `revision` 每次成功保存递增；写入 command 必须校验调用方的 `expectedRevision`。
- `sortKey` 使用稀疏、可排序字符串，避免插入或重排导致兄弟节点全部改号。
- `nodes` 输出时按 key 排序，节点内部字段顺序稳定，JSON 使用确定性 pretty format。
- `hasProtectedLinks` 在 v1 必须为 `false`。一旦未来支持 protected links，需要单独 schema version 或加密 sidecar 设计。
- `ShardDocumentLink` 不保存 fragment title、label、path snapshot、正文摘录或密匣路径。
- `markdownPath` 只允许 vault 内公开 Markdown 相对路径；不得指向 `lockbox/`、绝对路径或 vault 外路径。

## 文档关联模型

当前 Shard 的“文档”主要是独立 fragment Markdown 文件，还没有通用文档关系层。因此 v1 只做最小可用关联：

- 节点可以链接到公开 fragment id。
- 节点可以链接到 vault 内公开 Markdown 相对路径。
- 节点可以链接到其他 `.shardmap.json` 的 map id。
- 打开链接时复用现有搜索/定位逻辑：能在当前可见集合里定位就滚动；不可见时提示需要切换归档/标签视图。
- v1 禁止普通明文导图链接密匣 fragment；写入层必须拦截 lockbox fragment id 和 `lockbox/` 路径。

不在 v1 引入：

```text
relations/
  links.json
```

全局 relations 会增加索引、反链、权限和迁移复杂度。先把导图节点链接做好，更容易审计和回滚。

## 渲染与库选型

### Phase 1 主路径：递归大纲编辑器

第一可交付编辑器采用键盘优先的递归大纲，而不是直接进入 React Flow / XYFlow。

理由：

- 任意层级大纲已经能覆盖真正的思维导图编辑需求，避免“一级编辑器”成为废弃实现。
- 树操作可以写成对 schema 的纯函数：新增同级、添加子节点、缩进、反缩进、删除、移动、编辑文本。
- 大纲更容易做好中文输入法、键盘流、显式保存、冲突恢复和无障碍焦点管理。
- 后续 React Flow / XYFlow 只替换 renderer，schema、排序、保存和冲突逻辑可以复用。

### Phase 2 画布 renderer：React Flow / XYFlow

React Flow / XYFlow 仍是后续画布编辑和可视化的首选 renderer。

保留原因：

- 和当前 React、Tailwind、shadcn 技术栈贴近。
- 能把 Shard 的 quiet paper 视觉系统压进节点、连接线和工具栏。
- 数据流、键盘事件、布局缓存和 lazy loading 更可控。

进入条件：

- 递归大纲编辑、保存、冲突恢复和 Structures / Maps 分区已经稳定。
- 在真实 Tauri/WKWebView 中验证触控板缩放、拖拽、中文输入法和 20-30 节点性能。
- 验证按需 split chunk：不打开导图时不加载导图渲染代码。

### 非主路径

- Mind Elixir：不做完整并行 PoC。只有当 React Flow 在 WKWebView 或 IME 上失败时，才作为隔离验证备选。
- Markmap：适合未来从 Markdown outline 生成只读预览，不作为可编辑导图主引擎。
- jsMind：可作为低成本参考，不作为默认推荐。

## 前端结构

建议新增模块边界：

```text
src/lib/mind-map-schema.ts
src/lib/mind-map-tree.ts
src/lib/mind-map-sort-key.ts
src/lib/mind-map-layout.ts
src/lib/mind-map-links.ts
src/components/shard/mind-map-structures-panel.tsx
src/components/shard/mind-map-outline-editor.tsx
src/components/shard/mind-map-workspace.tsx
src/components/shard/mind-map-node.tsx
src/components/shard/mind-map-link-popover.tsx
```

原则：

- schema 与树操作放 `src/lib`，方便单测。
- 渲染组件只消费已解析的 map model，不做文件扫描。
- 导图 workspace 是显式打开的 surface，不进入默认 Inbox timeline 渲染路径。
- 大纲编辑器和未来画布 renderer 共用 `src/lib/mind-map-tree.ts` 的树操作，不重复实现节点命令。
- React Flow 代码必须按需加载，不打开导图时不得污染首屏 bundle 和主 render 路径。
- 节点样式复用 Shard tokens、Button、Popover、Tooltip，不直接接受第三方默认大面积样式。

## Tauri / 文件系统命令

建议新增 command：

- `list_mind_maps() -> Vec<MindMapSummary>`
- `create_mind_map(title, sourceFragmentId?) -> MindMapReadResult`
- `read_mind_map(id) -> MindMapReadResult`
- `write_mind_map(id, file, expectedRevision, lastSavedHash) -> MindMapReadResult`
- `delete_mind_map(id, expectedRevision) -> Vec<MindMapSummary>`

`MindMapSummary` 只包含列表所需轻量信息：

```ts
interface MindMapSummary {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  nodeCount: number
  path: string
}

interface MindMapReadResult {
  file: ShardMapFile
  path: string
  lastSavedHash: string
}
```

所有 command 必须是 `async`。文件读写、目录扫描、JSON 解析、hash 计算都必须进入 `run_blocking` 或等价后台任务。

写入门禁：

- 写入前校验 `kind`、`schemaVersion`、`revision`、`expectedRevision`、`lastSavedHash`。
- 写入前校验 root 的 `parentId === null`、无环、所有节点可达、兄弟 `sortKey` 唯一、节点数和文本长度上限。
- 写入前扫描 links，拒绝 lockbox fragment、`lockbox/` 路径、绝对路径和 vault 外路径。
- 写入使用 temp file + fsync where possible + atomic rename。
- 成功写入后更新 `.last-good/<id>.shardmap.json` 或等价备份。
- 检测到 revision/hash 冲突时，另存 `.conflict-<timestamp>.shardmap.json`，保留前端编辑态，并提示用户处理。

## 保存策略

第一版采用显式 Save + dirty guard，不默认自动保存：

- 编辑标题、节点文本、折叠和重排后进入 dirty 状态，局部展示未保存提示。
- 关闭导图或切换导图前，如果 dirty，提示保存、放弃或取消关闭。
- 保存中显示局部 busy / disabled 状态，不阻塞 Shard 主捕获输入。
- 保存失败时保留前端编辑态，并显示可执行错误状态，不吞错。
- 冲突时至少提供“保留我的版本/保留磁盘版本”二元恢复，并展示 conflict 副本路径。
- Git commit 不阻塞节点编辑；同步仍走现有 Git sync 入口。
- debounce autosave 可列入 future，但不能替代 revision/hash 冲突校验。

## 密匣与权限

v1 的安全边界：

- 不允许导图文件本身放入密匣。
- 不允许普通明文导图链接密匣 fragment。
- 不允许 `.shardmap.json` 持久化密匣 fragment 的标题、路径、label、正文摘录或标签。
- 写入 command 必须以当前 VaultState 或后端 lookup 校验 fragment 是否 lockbox。
- 如果未来必须支持密匣导图或 protected links，需要独立设计加密 sidecar 或加密 map 文件，不和普通 `.shardmap.json` 混放。

## 被低估风险

这些风险必须写入执行 checklist：

- 明文 map 写冲突损坏：必须有原子写和 last-good 备份。
- 默认时间线被导图污染：v1 不把导图插入 Inbox 主时间线，只放 Structures / Maps 显式分区。
- React Flow 在 WKWebView 大节点下性能不确定：Phase 2 前必须实测。
- 中文输入法 composition 与快捷键/autosave 冲突：递归大纲发布前必须实测。
- 缺 undo/redo 会让导图编辑风险高：Phase 2 至少要有本地撤销栈。
- 路径链接在文件重命名后失效：v1 把 fragment id 作为优先链接方式。
- 导图库 bundle 污染首屏：React Flow renderer 必须按需加载。
- 自动保存覆盖跨设备 Git 变更：autosave 仅能作为 future，且必须 revision/hash 校验。
- `MindMapSummary` 携带节点文本导致泄露或性能问题：summary 只能返回 metadata 和后端预计算 `nodeCount`。
- maps 成为搜索、时间线、标签体系之外的孤岛：v1 至少要有 map list 和从 fragment 创建/跳转的闭环。
- schema 演进无迁移路径：必须从 v1 起使用 `schemaVersion`。

## 建议实施阶段

### Phase 0: 后端事实核验与树模型补强

- 固定 schema v1 草案。
- 核验 `revision`、`lastSavedHash`、`updatedAt` 是否为后端独立持久化业务字段。
- 实现 fractional-indexing 排序 key。
- 实现树操作纯函数和单测：新增同级、添加子节点、缩进、反缩进、删除、移动、编辑文本。
- 补强 schema 校验：root parent、无环、可达性、兄弟 sortKey 唯一、节点数和文本长度上限。

### Phase 1: 本地导图文件与安全写入

- 新增 schema、Rust 读写 command、前端 API wrapper。
- 支持新建、打开、保存、删除导图。
- `MindMapSummary` 返回 `nodeCount`、`createdAt`、`updatedAt`、`path` 等 metadata，不返回节点文本。
- 实现原子写、确定性 JSON、revision/hash 校验、conflict 文件和 last-good 备份。
- 实现 lockbox 链接写入拦截。
- 不接入 fragment 链接 UI，只保证导图自身可编辑、可保存、可恢复。

Phase 1 blocker：

- 任何 `.shardmap.json` 可写入 lockbox path、lockbox fragment title/label 或正文摘录，必须阻断发布。
- 任意 JSON 写失败会丢失前端编辑态，必须阻断发布。

### Phase 2: 递归大纲编辑体验

- 支持添加子节点、添加同级节点、删除、折叠、重排、撤销/重做。
- 支持 Enter 建同级、Tab 建子级、方向键树内导航。
- 新建导图默认包含根节点和一个空分支，创建后自动打开编辑器并聚焦空分支。
- 导图在 Structures / Maps 显式分区可见，不进入 Inbox 主时间线。
- 显式 Save、dirty guard、保存失败和冲突二元恢复必须可用。
- 接入 Shard 视觉系统，避免第三方默认样式压过 app。
- 做空状态、错误态、保存中状态和冲突提示。

### Phase 3: 画布 renderer 验证

- 用 React Flow / XYFlow 验证画布 renderer，不替换底层树操作。
- 用 20-30 个节点验证编辑、拖拽、折叠、缩放、树布局和性能。
- 在真实 Tauri/WKWebView 中验证触控板缩放、拖拽、中文输入法和全键盘编辑。
- 验证按需 split chunk：不打开导图时不加载导图渲染代码。

### Phase 4: 文档关联

- 节点链接公开 fragment id / 公开 Markdown path / map id。
- 从公开 fragment 卡片创建导图或关联节点。
- 搜索和打开链接时复用现有 fragment 定位逻辑。
- 链接解析 lazy，不在 React render 路径扫 vault 或 parse Markdown。
- lockbox 链接继续禁止，直到加密方案单独审计通过。

### Future: 导入导出

v1 不做导入导出。若后续需要逃生口，优先考虑 `.shardmap.json` 到 Markdown outline 的单向导出；不优先做 OPML、FreeMind `.mm` 或 XMind。

## 验收标准

- 应用启动后仍默认聚焦 capture 输入。
- 不打开导图时，不加载或执行导图布局逻辑。
- 新建导图后自动打开导图编辑器并聚焦第一个空分支。
- 导图出现在 Structures / Maps 显式分区，不插入默认 Inbox 主时间线。
- 新建导图能保存为 `.shardmap.json`，重启后可恢复。
- `.shardmap.json` 通过 schema 校验，使用 `kind`、`schemaVersion`、`revision`、`sortKey`。
- `MindMapSummary` 包含后端预计算 `nodeCount`，不包含节点文本、节点摘要或密匣元数据。
- 20-30 节点递归大纲编辑、折叠、重排不卡 UI。
- 中文输入法编辑节点不丢字、不误触发保存快捷键。
- Enter / Tab / 方向键树内编辑体验可用。
- 节点链接公开 fragment 后可跳转定位。
- 写入层拒绝 lockbox fragment、`lockbox/` 路径、绝对路径和 vault 外路径。
- 保存冲突会生成 `.conflict-<timestamp>.shardmap.json`，并保留 last-good 备份。
- `pnpm build`、`cargo check`、`git diff --check` 通过。
- 保存冲突提供“保留我的版本/保留磁盘版本”，且不丢失当前编辑态。
- 浏览器预览和真实 Tauri/WKWebView 至少各做一次 smoke。

## 参考资料

- React Flow / XYFlow: https://reactflow.dev/
- React Flow GitHub: https://github.com/xyflow/xyflow
- Mind Elixir GitHub: https://github.com/ssshooter/mind-elixir-core
- Markmap: https://markmap.js.org/
- jsMind GitHub: https://github.com/hizzgdev/jsmind
- OPML 2.0 spec: https://opml.org/spec2.opml

## 审计记录

- 2026-06-29 · council-20260628-165436 · 选手:codex,antigravity,grok（opencode 因目录权限被拒缺席）· 主席claude裁决 HIGH:「批准推进；定 .shardmap.json 为主格式、第一版直接选 React Flow、节点级 links 不做全局 relations、密匣明文落盘泄露列为 Phase1 阻断项（schema 立改）、补原子写/恢复策略、砍 Phase 4 导入导出」· 报告 /Users/panyuhang/.council/shard/council-20260628-165436/viewer.html
- 2026-06-29 · council-20260628-184106 · 选手:codex,antigravity,grok,opencode · 主席claude裁决 HIGH:「approve with changes — 否决一级大纲与 Inbox updatedAt 混排，改键盘优先递归大纲(命令层纯函数,未来 React Flow 只换 renderer)+导图独立 Structures 分区(不污染 capture-first);nodeCount 后端预算且 summary 不带节点文本,sortKey 用 fractional-indexing,冲突给二元恢复,显式保存」· 报告 /Users/panyuhang/.council/shard/council-20260628-184106/viewer.html
