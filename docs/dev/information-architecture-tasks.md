# 碎片 / 资料库 / 密匣 信息架构重整 · 施工任务清单

依据：`docs/dev/information-architecture-plan.md`
裁决：council-20260831-092606（4/4 判「修订后执行」；阶段顺序由 A→B→C→D 重排为 B-lite→C→A→D）
创建：2026-08-31

## 全局约束（每个任务都适用）

- 遵守 `AGENTS.md` Runtime Rules：文件系统读写、Git、外部进程必须异步，Tauri 侧用 `async fn` + `run_blocking`；前端不得在 UI 线程做重计算。
- 前端设计系统以 `vendor/kiln/` 为唯一真相源，颜色/间距/圆角/字号消费 Kiln token，不新造一套。
- 精准修改：只碰完成任务必须改的代码，不顺手重构无关部分，不添加未要求的抽象。
- **新增或修改 Tauri command，必须同步补齐全部 spec 文件的 mock**（T5 教训：`list_csv_files` 缺 mock 导致 18 条既有用例连锁失败）。
- Playwright 断言用 `exact` 或区域限定，避免子串歧义（"资料库"会撞"同步 Git 资料库"，"密匣"会撞"移入密匣"）。
- 每个任务结束必须跑通对应验收命令，失败不得声称完成。

## 批次划分

| 批次 | 阶段 | 任务 | 状态 |
|---|---|---|---|
| 第一批 | B-lite 笔记进密匣 | T1.1 – T1.4 | **已完成**（Codex gpt-5.6-sol/low 实现；Claude 验收：cargo 52 / unit 63 / ui 98 全绿；已提交 d2adbbc；mock 技术债已在第二批清理） |
| 第二批 | C 密匣传送门 + 一级空间 | T2.1 – T2.5 | **已完成**（Claude 直接实现，2026-08-31；详见下方实施记录） |
| 第三批 | A1 双读 | T3.1 – T3.3 | **已废弃**（归档概念消失；回收站采用 `.trash/` 目录） |
| 第四批 | A2 幂等迁移 | T4.1 – T4.3 | **已废弃**（原 frontmatter 迁移方案由第十六批目录迁移取代） |
| 第五批 | A3 单读 + 计数修正 | T5.1 – T5.3 | **已废弃**（回收站是删除终态，不是正交 frontmatter 状态） |
| 第六批 | D 标签全局化 | T6.1 – T6.2 | 未派发 |
| 第七批 | E 资料库容纳导图 | T7.1 – T7.4 | **已完成**（Codex 实现；Claude 验收：cargo 53 / unit 68 / ui 103 全绿） |
| 第八批 | F 查看器统一 + 禅模式通用化 | T8.1 – T8.7 | **已完成**（Codex high 实现；Claude 验收修正 2 处 UI 回归；cargo 53 / unit 68 / ui 108 全绿；与第七批合并提交 22a5a8f） |
| 第九批 | G 右栏属性面板（导图） | T9.1 – T9.5 | 未派发 |
| 第十批 | H 碎片空间纯捕捉化 + 碎片浏览入资料库 | T10.1 – T10.5 | **已完成**（2026-09-01；施工图 `docs/dev/information-architecture-batch-10.md`；Codex 实现、Claude 验收修正 5 处回归 + 3 处链路缺陷；cargo 53 / unit 68 / ui 110 全绿。验收修正：FragmentTimeline 增 `relationFragments` 分离展示切片与关联候选域（捕捉页 5 条切片曾截断关联对话框候选与反链索引）；搜索分派 note 分支排除归档笔记并不设滚动目标；navigateTo 消费 effect 改为 notes 未含目标时不消费（保住整理/wikilink 的重试语义）；底栏二级导航断言、csv 用例迁资料库碎片流、note-created 编号跟随 mock 修正） |

**A2/A3 涉及存量数据迁移与语义翻转，风险最高，不得与 C 进同一 PR。** 每批派发前由主席（Claude）重新确认前一批验收结果。

### 第一批遗留技术债（已在第二批清理，2026-08-31）

`tests/ui/library-tree.spec.ts` 的**全局** vault mock 被从 `lockbox: { configured: false, unlocked: false }` 改成了 `{ configured: true, unlocked: true }`。当前 98 条用例全绿，但这抹掉了整个 spec 文件里"密匣未配置"的初始态——将来若要验证未配置引导流程，会拿到错误前提。应改为：全局 mock 恢复 `false`，仅在「移入密匣」用例内局部覆盖为已解锁。

---

# 第一批：B-lite —— 放开笔记进密匣

**目标**：`notes/**` 下的笔记可以移入密匣，落到 `lockbox/notes/`。这是当前真实的功能缺口。

**本批显式取舍**：密匣笔记**暂不支持归档**（旧模型下 `lockbox/archive/` 只接受碎片路径映射）。归档能力由第三至五批统一解决，本批不要试图实现。

**本批不做**：不新增"移出密匣"能力（当前架构中密匣单向，只有 `move_fragment_to_lockbox`）；不动 IA 与侧栏结构；不碰 `archive/`。

---

## T1.1 Rust：移入密匣的路径映射支持 notes/

**文件**：`src-tauri/src/lib.rs`

**问题**：`move_public_fragment_payload_to_lockbox_in_vault`（约 `:3955-3995`）的路径映射只认两个前缀：

```rust
let public_rel = public_path
    .strip_prefix(vault.join("fragments"))
    .or_else(|_| public_path.strip_prefix(vault.join("archive")))
    .map_err(|error| error.to_string())?;
let target_root = if relative_path(vault, public_path)?.starts_with("archive/") {
    vault.join("lockbox").join("archive")
} else {
    vault.join("lockbox").join("fragments")
};
```

`notes/` 下的文件 `strip_prefix` 两次都失败，直接报错返回。

**做什么**

1. 把上面这段改成按相对路径前缀三分支判定，`public_rel` 与 `target_root` 必须**同源判定**，不要分两次算：
   - `notes/` 前缀 → `public_rel` = strip `vault/notes`，`target_root` = `vault/lockbox/notes`
   - `archive/` 前缀 → `public_rel` = strip `vault/archive`，`target_root` = `vault/lockbox/archive`
   - `fragments/` 前缀 → `public_rel` = strip `vault/fragments`，`target_root` = `vault/lockbox/fragments`
   - 其他前缀 → 返回 `Err`，错误文案：`"只有 fragments/、notes/、archive/ 中的文档可以移入密匣。"`
2. 后续 `lockbox_path.set_extension("shard")` 与 `write_lockbox_fragment_file` 调用保持不变。
3. 不要修改 `normalize_lockbox_tags` 的行为（它剥掉 `密匣` 与 `inbox`，保留 `note` 标签，密匣笔记的 kind 才仍然是 note——这是对的）。

**注意**：`find_fragment_path`（`:4234-4238`）已经遍历 `notes/`，无需改动；`move_fragment_to_lockbox` command（约 `:1748-1763`）也无需改动。

**验收**：`cargo test` 通过；新增单测见 T1.4

**禁止**：不要顺手给密匣加"移出"能力；不要动 `archive/` 相关逻辑；不要改 `write_lockbox_fragment_file` 的字段白名单（那是第三批的事）

---

## T1.2 Rust：密匣文件收集覆盖 lockbox/notes/

**文件**：`src-tauri/src/lib.rs`

**问题**：两处收集密匣文件的地方都只扫两个目录，`lockbox/notes/` 下的文件永远读不出来——移进去就消失。

**做什么**

1. `list_fragments_in_vault` 约 `:1298-1299`，在两行 `collect_lockbox_files` 后补第三行：
   ```rust
   collect_lockbox_files(&vault.join("lockbox").join("notes"), &mut lockbox_files)?;
   ```
2. `find_lockbox_fragment_path` 约 `:4219-4220`，同样补一行 `collect_lockbox_files(&vault.join("lockbox").join("notes"), &mut files)?;`
3. 用 `command grep -n 'lockbox").join("fragments")' src-tauri/src/lib.rs` 复查是否还有第三处收集点遗漏，有则一并补上；**只补收集点，不要改写入点**。
4. `ensure_vault_dirs`（约 `:2344-2346`）不需要预创建 `lockbox/notes/`——`write_lockbox_fragment_file` 前的 `fs::create_dir_all(parent)` 已经覆盖。

**验收**：`cargo test` 通过；移入一篇笔记后 `list_fragments` 能在解锁态读回它

**禁止**：不要在此任务里改 `collect_lockbox_files` 函数本身的实现

---

## T1.3 前端：资料库树的笔记加"移入密匣"入口

**文件**：`src/workspace/library-shell.tsx`（+ 对应 `.module.css` 如需）

**做什么**

1. 在资料库文件树 markdown 条目的现有操作菜单里（与"重命名""删除"同一菜单，参考 `renameLibraryEntry` / `deleteLibraryEntry` 的接线方式）新增一项「移入密匣」。
2. 仅对 `entry.kind === "markdown"` 显示；目录（`directory`）与 csv 条目不显示。
3. 点击后调用现有的 `move_fragment_to_lockbox` command（前端 API 在 `src/lib/api.ts`，复用现有封装，不要新写一个 command）。需要 fragment id：从该条目对应的 `Fragment` 取；若树条目当前不带 id，用现有的按路径查 fragment 的既有通路取得，**不要为此新增 Tauri command**。
4. 密匣未初始化或未解锁时，走**现有的**密匣对话框流程（`lockbox-dialog`），不要新造提示。
5. 成功后刷新资料库树与碎片列表（复用现有刷新通路），被移走的笔记应从树中消失。

**验收**：`pnpm build` 通过；UI 用例见 T1.4

**禁止**：不要改树的选中态/展开态逻辑；不要动 `#密匣` 标签的既有渲染与目的地徽标；不要在此任务里给树加密匣节点（那是第二批 T2.1）

---

## T1.4 测试：B-lite 的 Rust 单测与 UI 用例

**做什么**

1. **Rust 单测**（`src-tauri/src/lib.rs` 的 `mod tests`）：
   - `notes/` 下的文档移入密匣后，落点为 `lockbox/notes/<同名>.shard`，原文件已删除
   - 子目录笔记（`notes/子目录/x.md`）保留相对结构 → `lockbox/notes/子目录/x.shard`
   - `fragments/` 与 `archive/` 的既有落点行为不变（回归保护）
   - 非上述三个前缀的路径返回 Err
2. **Playwright 用例**（`tests/ui/` 下新建或并入既有密匣 spec）：
   - 解锁密匣 → 资料库树某篇笔记的菜单点「移入密匣」→ 该笔记从资料库树消失
   - 断言用 exact 或区域限定，避免"密匣"撞"移入密匣"
3. **补齐 mock**：本批未新增 command，但若 T1.3 实际引入了任何新 command，必须同步补齐**全部** spec 文件的 mock。

**验收命令**（三条全绿才算完成）：

```bash
cargo test --manifest-path src-tauri/Cargo.toml
pnpm build && pnpm test:unit
pnpm test:ui
```

**禁止**：不要为了让用例通过而放宽既有断言；既有用例数量只能增不能减

---

# 第二批：C —— 密匣传送门 + 一级空间（已完成 2026-08-31）

- **T2.1** ✅ 资料库树新增上锁挂载点（`library-shell.tsx` 碎片流下方，「密匣（上锁空间）」，
  不可展开；点击先 flush 草稿再走 `onOpenLockbox` → `openLockboxGate`）
- **T2.2** ✅ 密匣一级空间：`route.ts` 加 `LockboxRoute`（`space: "lockbox"`）；新建
  `src/workspace/lockbox-shell.tsx`（LockboxHeader 从 workbench-shell 迁入 + 密匣笔记树 +
  碎片流 + 搜索覆盖层）。笔记住树里（点开进禅编辑器）、碎片住碎片流，互斥不混排
- **T2.3** ✅ 安全区改「`space === "lockbox"` ‖ 含密匣洞察」两取值；退出（上锁按钮→资料库）/
  切空间 / 3 分钟空闲（`returnToLibrary`）三条上锁路径保留；洞察豁免原样
- **T2.4** ✅ `FragmentWorkspaceFilter` 移除 `lockbox`；旧 localStorage 值被 `isWorkspaceRoute`
  拒绝、自动回退收件箱；侧栏与底部标签栏移除密匣项（唯一入口=挂载点）
- **T2.5** ✅ 新增 `tests/ui/lockbox-space.spec.ts`（旧路由回退 / 传送门解锁进入 / 笔记树与
  碎片流分工 / 离开即上锁与手动上锁回资料库）；`library-tree.spec` 补挂载点用例；
  `shadcn-migration.spec` 密匣入口前奏改走挂载点
- **遗留债清理** ✅ `library-tree.spec` 全局 mock 恢复「密匣未配置」初始态，
  移入密匣用例改为局部覆盖解锁态

无新增 Tauri command（复用既有 lock/unlock/list 命令），无需补 mock。
搜索在密匣空间内保持空间不跳转（避免离开安全区触发上锁），密匣笔记搜索结果直接进禅编辑器。

---

# 第三批：A1 —— 双读（已废弃）

归档概念已消失。回收站需要容纳任意文件类型，采用 vault 顶层 `.trash/` 目录；本批的 `archived_at` 双读方案不再执行。

- **T3.1** `FragmentFrontmatter`（`:478-492`）加 `archived_at: Option<String>`，须 `#[serde(default, skip_serializing_if = "Option::is_none")]`
- **T3.2** `write_lockbox_fragment_file`（`:4123-4135`）白名单**补 `archived_at`**（漏了会静默丢归档态）
- **T3.3** `archived` 改双读：`archived_at.is_some() || rel_path.starts_with("archive/")`；`set_fragment_archived` 改写字段不搬文件，**且不得 bump `updated_at`**

---

# 第四批：A2 —— 幂等迁移（已废弃）

原 frontmatter 迁移方案不再执行；旧 `archive/` 由第十六批直接幂等迁入 `.trash/fragments/`。

- **T4.1** `archive/**` 回迁 `fragments/`、`lockbox/archive/**` 回迁 `lockbox/fragments/`，写 `archived_at`，走 `checkpoint_before_structural_locked`，清理空目录
- **T4.2** **必须先于 T6 遗留笔记迁移执行**；`migrate_legacy_notes_in_vault`（`:3016`）加排除条件，避免把带 `note` 标签的归档碎片当遗留笔记搬走
- **T4.3** 幂等性用例：连跑两次结果一致；中途崩溃后双读仍能正确判定

---

# 第五批：A3 —— 单读 + 计数修正（已废弃）

回收站是删除终态而非与位置正交的状态，因此继续使用目录派生；本批单读方案不再执行。

- **T5.1** 移除路径派生，`archived` 只读 `archived_at`
- **T5.2** `MANAGED_VAULT_ROOTS`（`:48`）摘掉 `archive`（确认不丢 Git 追踪）；`organize_fragments` 的 `archive/` 前缀兼容一并清理
- **T5.3** `summarize_fragment_stream`（`:2504-2556`）改为读 `archived_at` 计数，否则碎片流数字虚高

---

# 第六批：D —— 标签全局化（未派发）

- **T6.1** 标签入口提为全 vault，覆盖 `fragments/` 与 `notes/`
- **T6.2** 用例：笔记标签出现在标签视图

---

# 第七批：E —— 资料库容纳思维导图（未派发）

**目标**：让资料库真正成为「全 vault 唯一文件管理器」——同时管理 md 文档、csv 数据、思维导图文件，并让导图可被 wikilink 引用。

**缺口现状**（已查证）：

- `LibraryTreeEntryKind`（`src/types.ts:69`）只有 `"directory" | "markdown" | "csv"`，**没有导图**。
- `build_library_tree`（`lib.rs:2450`）的根写死为 `vault.join("notes")`，而导图在 vault 顶层的 `maps/`（`lib.rs:48`），文件名后缀 `.shardmap.json`（`is_mind_map_file`, `lib.rs:3209`）。
- `library-shell.tsx` 里 `maps` **一次都没出现**——导图只有侧栏独立入口，游离在资料库之外。
- `src/lib/wikilink.ts` 里没有任何 `shard.map` 相关代码——导图在双链网络里是孤岛，`[[导图名]]` 无法解析。

这与「资料库是地图」的公理直接冲突：`maps/` 是 vault 顶层目录，却不在地图上。性质与密匣错位相同。

**本批不做（重要）**：

- **不做统一无限画布，不引入 React Flow / Excalidraw / tldraw。** NoteGen 的画布用 `@xyflow/react` 并把 `position: {x, y}` 序列化落盘（`canvas-editor.tsx:285`），这正是 `docs/dev/fragment-relations-plan.md` 里 council 4/4 否决的方案。Shard 维持「存关系不存像素」：`parentId + sortKey`（`types.ts:188-189`）入库，坐标由 `layoutMindMap()`（`src/lib/mind-map-layout.ts:83`）每次派生。
- 不把导图搬进 `notes/`，`maps/` 保持 vault 顶层目录。
- 不让导图参与 `notes/` 的目录操作（移动 / 重命名 / 删除菜单对导图一律不显示）。
- 不支持导图移入密匣（B-lite 的三分支只映射 `fragments/`、`notes/`、`archive/`，导图不在其中）。
- 不引入 mermaid（那是独立议题，需单独决策）。

---

## T7.1 Rust：资料库树快照携带导图

**文件**：`src-tauri/src/lib.rs`

**做什么**

1. `LibraryTreeSnapshot` 新增字段 `mind_maps: Vec<LibraryTreeEntry>`（serde 驼峰序列化后前端读到 `mindMaps`）。
2. `build_library_tree`（`:2449`）填充该字段：用既有的 `collect_mind_map_files(&vault.join("maps"), …)` 收集，逐个走 `read_mind_map_summary` 拿到 `MindMapSummary`，映射为 `LibraryTreeEntry { name: summary.title, path: summary.path, kind: "mindmap", children: None }`。
3. `name` 用**导图标题**而非文件名（`.shardmap.json` 不适合直接示人）。**不需要空标题回退**——`validate_mind_map_file`（`lib.rs:3255-3257`）已经硬性拒绝空白标题，`read_mind_map_summary`（`:3215`）必然先过这道校验，因此 `summary.title` 永远非空。（初版施工图曾要求"标题为空时回退文件名"，经 Codex 指出该分支不可达，已删除；不要绕过 `validate_mind_map_file` 去另开一条解析路径，那会让缺 root 节点、schema 版本不符等真正损坏的文件被误当成"只是标题空"。）
4. 读取失败的单个导图**跳过而非整树报错**（一个坏文件不该让资料库打不开）。空标题文件即属于此类，由本条统一覆盖。
5. **不要改 `collect_library_entries`**——`notes/` 的 entries 语义保持不变，导图走独立字段。这样移动 / 重命名 / 删除等只对 `notes/` 生效的操作天然不会碰到导图。

**验收**：`cargo test` 通过；新增单测见 T7.4

**禁止**：不要把 `maps/` 塞进 `entries`；不要改 `collect_library_entries` 的 kind 匹配；不要动导图文件格式

---

## T7.2 前端：资料库树渲染导图分组

**文件**：`src/types.ts`、`src/workspace/library-shell.tsx`（+ `.module.css` 如需）

**做什么**

1. `src/types.ts:69` 的 `LibraryTreeEntryKind` 增加 `"mindmap"`；`LibraryTreeSnapshot` 类型补 `mindMaps: LibraryTreeEntry[]`。
2. 在资料库树里新增**可展开的「思维导图 N」分组节点**（N 为数量），列出导图条目。参照现有 `fragmentStream` 分组的渲染方式（`library-shell.tsx:705-787`），不要塞进 `notes/` 的树体。

   **插入位置写死**（第二批后的实际结构，`treeViewportInner` 在 `:704`）：
   ```
   treeViewportInner
   ├── fragmentStream      :705   碎片流（跳碎片空间）
   ├── lockboxMount        :788   密匣挂载点（跳密匣空间）
   ├── 思维导图分组         ← 新增插在这里
   └── ul「笔记和数据文件」  :809   notes 树
   ```
   即插在 `styles.lockboxMount` 那个 `div` 结束之后、`<ul aria-label="笔记和数据文件">` 之前。理由：两个「跳到别的空间」的入口（碎片流、密匣）在上，两组「vault 内实际文档」（导图、notes）在下。
3. 导图条目用区别于 markdown / csv 的图标（Kiln token 内选，参考侧栏「思维导图」入口现用图标）。
4. 点击导图条目 → 调用既有的 `openMindMap(summary)` 通路（`workbench-shell.tsx:1270`），通过 prop 传入，**不要新增 Tauri command**。
5. 导图条目**不显示**操作菜单（无重命名 / 移动 / 删除 / 移入密匣）。本批只做「看得见、点得开」。
6. 侧栏原有的「思维导图」独立入口**保留不动**，本批不做入口收敛。

**验收**：`pnpm build` 通过；UI 用例见 T7.4

**禁止**：不要动侧栏结构；不要给导图加任何写操作入口；不要改导图工作区内部实现

---

## T7.3 wikilink 支持导图目标

**文件**：`src/lib/wikilink.ts`、`src/workspace/library-shell.tsx`、`src/components/shard/capture-box.tsx`

**做什么**

1. `WikilinkCandidate.kind`（`wikilink.ts:15`）从 `Fragment["kind"] | "csv"` 扩展为 `Fragment["kind"] | "csv" | "mindmap"`。
2. 新增 `buildMindMapWikilinkCandidates(maps: readonly MindMapSummary[]): WikilinkCandidate[]`，**完全照搬 `buildCsvWikilinkCandidates`（`:69-81`）的结构**：
   ```ts
   maps.map((map) => ({
     kind: "mindmap",
     label: map.title,
     matchKeys: Array.from(
       new Set([map.path, map.title].map(normalizeWikilinkTarget).filter(Boolean))
     ),
     path: map.path,
     target: map.title,
   }))
   ```
   `target` 用 **title**（用户写 `[[我的导图]]` 而不是 `[[maps/xxx.shardmap.json]]`），`matchKeys` 同时收 path 与 title。
3. 两处消费方接入，与 csv 并列：`library-shell.tsx:173` 和 `capture-box.tsx:114` 的 `...buildCsvWikilinkCandidates(csvFiles),` 下方各加一行 `...buildMindMapWikilinkCandidates(mindMaps),`。
4. 点击已解析的导图 wikilink → 走 `openMindMap`。装饰层若按 kind 分色，导图用与 csv 区分的样式。
5. 标题重名时沿用 `buildWikilinkCandidates` 既有的 `preferredCounts` 消歧思路，不要另造一套。

**验收**：`pnpm build && pnpm test:unit` 通过；`wikilink.test.ts` 补用例

**禁止**：不要改 `parseWikilinks` 的语法解析；不要改 `normalizeWikilinkTarget`；不要为导图新增 worker 消息类型

---

## T7.4 测试：第七批的 Rust 单测与 UI 用例

**做什么**

1. **Rust 单测**：
   - `maps/` 下的导图出现在 `build_library_tree` 的 `mind_maps` 字段，`name` 为导图标题
   - 损坏的导图文件被跳过，其余导图与 `notes/` 条目仍正常返回（用**空标题**的文件构造一例，它会被 `validate_mind_map_file` 判为非法而跳过）
   - `notes/` 的 `entries` 不受影响（回归保护）
2. **单元测试**（`src/lib/wikilink.test.ts`）：
   - `buildMindMapWikilinkCandidates` 产出的 `matchKeys` 同时含 path 与 title
   - `[[导图标题]]` 能解析到 mindmap 候选
3. **Playwright 用例**（并入 `tests/ui/library-tree.spec.ts`）：
   - 资料库树出现「思维导图」分组，展开后列出导图
   - 点击导图条目进入导图工作区
   - 导图条目**没有**操作菜单按钮（断言 `toHaveCount(0)`）
   - **补齐全部 spec 文件的 mock**：`read_library_tree` 的返回值新增 `mindMaps` 字段后，所有 mock 该命令的 spec 都要同步补上，否则壳层拿到 `undefined` 会连锁失败（T5 教训）
4. 断言用 exact 或区域限定：「思维导图」会撞侧栏同名入口，必须用 `treePane` 限定。

**验收命令**（三条全绿）：

```bash
cargo test --manifest-path src-tauri/Cargo.toml
pnpm build && pnpm test:unit
pnpm test:ui
```

**禁止**：不要放宽既有断言；既有用例数量只能增不能减

---

# 第八批：F —— 查看器统一 + 禅模式通用化（未派发）

**目标**：消除外壳层的重复与漂移。让「在哪打开」和「能否全屏」不再由内容类型各自决定。

## 诊断（施工前必读）

底层**早已统一**：`ShardEditor`（`src/editor/shard-editor.tsx`）是唯一的 md 编辑器，`variant: "composer" | "inline" | "zen"` 三形态一体，三处消费：`capture-box.tsx:534`（捕捉入口）、`fragment-editor.tsx:703`、`library-shell.tsx:1008`。

问题全在**外壳层没有共同骨架**，导致两类可观测的代价：

**代价一 · 能力重复**——全屏被独立实现两遍，写法都不一样：

| | 全屏定位 | 顶部拖拽避让 | 退出键 |
| --- | --- | --- | --- |
| `fragment-editor.tsx` | `:839` inline style `position:fixed; inset:0; zIndex:50` | `:852` `paddingTop` | `:179` Escape |
| `mind-map-workspace.tsx` | `:374` Tailwind `fixed inset-0 z-50` | `:383` `height` | `:325` Cmd+Enter |

且 `z-index: 50` 与 Kiln 的 Dialog / Tooltip / DropdownMenu 同层（`components/ui/dialog.tsx:34,56`），禅模式下弹 Dialog 靠 DOM 顺序决胜负。

**代价二 · 能力漂移**——资料库第三栏的 `ShardEditor` 只传了 `onSubmit` 与 `variant`，**没有 `onPasteFiles` / `onDropFiles`**：在资料库里往笔记粘贴图片毫无反应，在碎片里粘贴却能上传。这不是设计决策，是写第二遍时漏抄。漂移是无声的，外壳每多一份就多一处。

## 指导原则

用户定调：**碎片本身就是 md 文档，只是有一个快捷输入碎片的入口而已；所有内容都应该可以全屏编辑/禅模式，这不是两种形态。**

推论——外壳层不按「内容是碎片还是笔记」划分（那个分法是伪的），按职责划分：

- **捕捉入口**（`composer`）：碎片唯一真正特殊之处，保留不动
- **内容能力**（图片、标签、wikilink）：统一，任何 md 文档都该有
- **显示容器**（禅模式）：正交能力，任意内容都能进

**明确不做的过度统一**：不强行把 `FragmentEditor`（提交式：写完 Cmd+Enter 提交）与资料库第三栏（自动保存式：边写边存）合并成同一个组件。这两种交互模型是合理的产品差异，硬揉在一起会同时劣化两边。本批统一的是**显示容器**与**内容能力**，不是交互模型。

---

## T8.1 新建 `ZenSurface` 全屏容器

**文件**：新建 `src/components/shard/zen-surface.tsx`（+ `.module.css`）

**做什么**

1. 收敛现被重复实现的三件事：
   - 全屏定位 `position: fixed; inset: 0`
   - Tauri 顶部拖拽区避让（`data-tauri-drag-region` + `var(--shard-top-inset)`）
   - 统一退出契约：`Escape` 触发 `onRequestClose`
2. API：
   ```tsx
   interface ZenSurfaceProps {
     ariaLabel: string
     children: ReactNode
     footer?: ReactNode          // 底部悬浮工具条
     onRequestClose: () => void
   }
   ```
3. **z-index 用新 token**，不要硬编码 50。在 `src/styles/frontend-rules.css` 定义 `--shard-z-zen`，取值**低于** Kiln 的 Dialog/Tooltip 层（它们是 50），例如 40——禅模式里弹确认对话框时，Dialog 必须盖在禅模式之上。
4. 只做容器，不含任何内容语义（不认识 Fragment，也不认识导图）。

**验收**：`pnpm build` 通过

**禁止**：不要在 ZenSurface 里写任何与碎片/笔记/导图相关的逻辑；不要引入新依赖

---

## T8.2 拆出 `MindMapCanvas`

**文件**：`src/components/shard/mind-map-workspace.tsx`（580 行）

**做什么**

1. 把 `:374` 那个 `fixed inset-0 z-50` 外壳、顶部拖拽区、底部工具条**剥离**，剩余的画布/大纲内容导出为可嵌入组件 `MindMapCanvas`。
2. `MindMapCanvas` 必须能在**任意尺寸容器**内正常工作（父容器给多大就多大），不得自带 `fixed` / `100vh` / `100vw`。
3. `MindMapWorkspace` 保留为 `ZenSurface + MindMapCanvas` 的组合，供既有的侧栏全屏入口继续使用，对外 props（`mapId` / `onClose` / `onMapsChange`）**保持不变**。
4. 保存、冲突处理、撤销重做、视图切换（map/outline）等逻辑归属 `MindMapCanvas`，不要留在外壳里——否则第三栏用不到它们。
5. Cmd+Enter「保存并关闭」属于**外壳**语义（关闭），Cmd+S 保存、Cmd+Z 撤销属于**内容**语义，按此归位。

**验收**：`cargo test` 不受影响；`pnpm build` 通过；侧栏全屏入口行为不变

**禁止**：不要改导图文件格式、不要动 `layoutMindMap()`、不要引入画布库

---

## T8.3 资料库第三栏改为多态查看器

**文件**：`src/workspace/library-shell.tsx`

**做什么**

1. 选中态从 `selectedNoteId: string | null`（`:149`）泛化为：
   ```tsx
   type LibrarySelection =
     | { kind: "note"; id: string }
     | { kind: "mindmap"; path: string }
     | null
   ```
2. 第三栏按 kind 分派：`note → ShardEditor`（现有通路不变），`mindmap → MindMapCanvas`。
3. 点击树上的导图条目**不再调用 `openMindMap`**（那是 shell 级全屏），改为设置本地选中态，在第三栏打开。
4. 空态文案按选中类型调整；`selectedNote` 相关的自动保存逻辑只在 `kind === "note"` 时生效，切到导图时必须先 flush 笔记草稿（复用既有 `saveCurrentNote()` 门禁）。
5. 移动端两级导航（`mobilePane`）对导图同样生效。

**验收**：`pnpm build` 通过；UI 用例见 T8.7

**禁止**：不要把导图塞进 `notes/` 的 entries；不要给导图加重命名/移动/删除入口（沿用第七批边界）

---

## T8.4 抽出共享的图片上传能力，补上第三栏缺失

**文件**：`src/components/shard/fragment-editor.tsx`、`src/workspace/library-shell.tsx`，新建 hook

**做什么**

1. 把 `fragment-editor.tsx:574` 的 `uploadPastedImages` 及其依赖的 `uploadImage` 逻辑抽成共享 hook（如 `src/hooks/use-image-upload.ts`），保持行为完全一致。
2. `FragmentEditor` 改用该 hook，**行为不得有任何变化**。
3. 资料库第三栏的 `ShardEditor`（`library-shell.tsx:1008`）补上 `onPasteFiles` / `onDropFiles`，接同一个 hook——这是本批修复的现存 bug。
4. 图片落盘路径、`assets/` 目录约定、密匣拒图（`reject_lockbox_images`）等既有约束不变。

**验收**：`pnpm build && pnpm test:unit` 通过；手工确认资料库里粘贴图片能上传

**禁止**：不要改图片存储格式或路径规则；不要让密匣笔记绕过拒图约束

---

## T8.5 第三栏任意内容可进禅模式

**文件**：`src/workspace/library-shell.tsx`

**做什么**

1. 第三栏顶部加统一的「进入禅模式」按钮，对 **note 与 mindmap 都可用**（这是本批的核心诉求：禅模式是通用能力，不是某类内容的形态）。
2. 进入后用 `ZenSurface` 包裹**当前选中内容的同一个查看器组件**（note → ShardEditor，mindmap → MindMapCanvas），退出回到第三栏且保持选中态。
3. 禅模式下的编辑必须与第三栏共享同一份草稿状态，退出不丢内容、不重复保存。

**验收**：`pnpm build` 通过；UI 用例见 T8.7

**禁止**：不要为 note 和 mindmap 各写一套禅模式；不要新建第二个全屏容器

---

## T8.6 `FragmentEditor` 收编 `ZenSurface`

**文件**：`src/components/shard/fragment-editor.tsx`

**做什么**

1. `:838` 的 zen 分支：`<div style={{position:"fixed", inset:0, zIndex:50, ...}}>` 替换为 `<ZenSurface>`，底部工具条走 `footer` prop。
2. `:852` 自建的顶部拖拽区删除，由 `ZenSurface` 提供。
3. `:179` 的 Escape 处理交给 `ZenSurface` 的 `onRequestClose`；碎片特有的 Cmd+Enter 提交语义**保留在 FragmentEditor**（那是提交不是关闭）。
4. `:738` 的 inline 分支（`<article>`）**完全不动**——它嵌在时间线卡片里，不涉及全屏。
5. **捕捉链路零改动**：`capture-box.tsx` 一行不改，`Cmd+Enter` 提交、composer variant、草稿恢复全部保持原样。

**验收**：`pnpm build && pnpm test:unit` 通过；UI 用例见 T8.7

**禁止**：不要合并 FragmentEditor 与资料库第三栏的交互模型（提交式 vs 自动保存式）；不要动 `ShardEditor` 本身；不要碰捕捉框

---

## T8.7 测试

**做什么**

1. **Playwright**（并入 `tests/ui/library-tree.spec.ts` 或新建 `zen-surface.spec.ts`）：
   - 点击资料库树的导图 → **在第三栏打开**，侧栏与目录树仍可见（这是本批要修的核心问题，必须断言树仍在）
   - 第三栏的 note 可进禅模式、可退出、内容不丢
   - 第三栏的 mindmap 可进禅模式、可退出
   - 碎片的禅编辑器仍能打开与关闭（回归保护）
   - 侧栏「思维导图」全屏入口行为不变（回归保护）
   - 资料库里粘贴图片触发上传（T8.4 的修复）
2. **补齐全部 spec 文件的 mock**：若任何 Tauri command 的签名或返回值发生变化，必须同步所有 spec。
3. 断言用 `exact` 或区域限定。

**验收命令**（三条全绿）：

```bash
cargo test --manifest-path src-tauri/Cargo.toml
pnpm build && pnpm test:unit
pnpm test:ui
```

**禁止**：不要放宽既有断言；既有用例数量只能增不能减

---

# 第九批：G —— 右栏属性面板（导图）（未派发）

**目标**：让资料库第四栏（右侧检查器）在打开导图时不再空白——承载节点样式配置与节点链接汇总，并激活数据模型里两个一直没有 UI 入口的死字段。

## 诊断（施工前必读）

第四栏 `inspectorSlot`（`library-shell.tsx:1152`）目前对笔记渲染 `FragmentBacklinksPanel`，对导图渲染 `null`——因为面板 props 是 `fragment: Fragment` 强绑定，导图不是 Fragment。第八批统一了第三栏（多态查看器），第四栏还没统一，空白就是没统一完的证据。

**数据模型早已预留，缺的只是入口**（`src/types.ts:187-202`）：

```ts
export interface ShardMapNode {
  width?: number                                              // 手动宽度，无 UI
  style?: { tone?: "default" | "accent" | "success" | "warning" }  // 色调，无 UI 且无渲染
  links?: ShardDocumentLink[]                                 // 三种目标，无汇总视图
}
```

全仓库 grep 不到任何设置 `style.tone` / `width` 的代码，也grep 不到消费 `tone` 的渲染代码——**这两个字段目前完全是死的**。原因是全屏工作区里没地方放属性面板，加一个就挤占画布；第八批把导图挪进分栏后，右栏正好是它们的归宿。

`links` 则是另一种浪费：节点链接藏在节点内部，不逐个点开根本看不见，恰恰最需要汇总面板。

## 用户定调

- 右栏未来承载「思维导图更多的样式等等配置」——它的定位从**检查器**（只读观察）扩展为**属性面板**（可编辑配置）。
- **禅模式不配置右栏**：专注模式只看不配，要调样式退回常规工作区。

## 双粒度约束（本批最重要的设计点）

右栏内容源不再只是"打开的文档"，而是**文档 + 文档内选中对象**：

| 上下文 | 右栏内容 |
| --- | --- |
| 打开笔记 | 文档级：现有反链面板（不变） |
| 打开导图，未选中节点 | 文档级：节点链接汇总 |
| 打开导图，选中某节点 | 节点级：色调、宽度、该节点的链接 |

这是 Figma / Sketch 的标准模式（未选中显示画布属性，选中显示对象属性）。

## 非目标

- **不做导图反链**（谁 `[[引用]]` 了这张导图）。查证：正文里的 wikilink **不会**自动落成 `FragmentRelation`——relation 是显式建立的（`link_fragments` command 或 AI 整理 `lib.rs:1227`），`buildRelationsIndex`（`src/lib/relations.ts:49`）的 backlinks 只来自 `fragment.related`。做导图反链需要新增"全库正文 wikilink 扫描索引"能力，成本超出本批，单独立项。
- 不做节点级以外的导图全局设置（主题、布局方向等），本批只激活已有字段。
- 不引入**新的**格式特性（画布坐标、新节点类型等），不动 `layoutMindMap()`、不引入画布库。

  **澄清（2026-09-01，主席裁决）**：「不改导图文件格式」指的是不引入新特性，**不包括修复前后端契约漂移**。派发时 Codex 查出一处必须修的漂移：

  | | 前端 | 后端 `lib.rs:379-395` |
  | --- | --- | --- |
  | `style.tone` | 定义 | ✅ `ShardMapNodeStyle { tone }` 支持 |
  | `width` | 定义 + 注释「用户手动设置的节点宽度」+ `layoutMindMap()` 已消费 | ❌ 缺失，且 `deny_unknown_fields` |

  `write_mind_map` 把前端文件反序列化为 Rust `ShardMapNode`，一旦设置 `width` 就会在入参反序列化阶段失败——**保存、自动保存、冲突检测全部不成立**。这是既有的定时炸弹，现在没炸只因为没有 UI 能设置它。

  **授权**：本批把 Rust `ShardMapNode` 补上 `width: Option<f64>`，必须带 `#[serde(default, skip_serializing_if = "Option::is_none")]`（未设置时一个字节都不写入文件，旧文件读取与 Git diff 均不受影响），补齐节点构造位置，并补宽度读写往返测试。
- **不给禅模式加右栏**（`ZenSurface` 全屏覆盖，右栏自然不可见，这是预期行为）。

---

## T9.1 第四栏改为多态属性面板容器

**文件**：`src/workspace/library-shell.tsx`

**做什么**

1. `inspectorSlot`（第十批后约在 `:1312`，以实际为准）的内容按 `selection.kind` 分派，与第三栏 `renderSelectedViewer` 同构。**注意 `LibrarySelection` 在第十批后已是三支**（`library-shell.tsx:144-148`）：
   - `note` → 现有 `FragmentBacklinksPanel`，**行为完全不变**
   - `mindmap` → 新的 `MindMapInspector`（T9.3/T9.4 实现）
   - `fragments` → **保持空态**。碎片流是列表视图，没有单一「当前文档」可检查；不要在此显示某条碎片的反链，也不要为它造新面板。
   - 无选中 → 保持现有空态
2. 栏位**始终存在**，不按内容类型显隐——否则切换笔记↔导图时编辑区宽度会跳变。
3. `inspectorHeader` 的 `data-tauri-drag-region` 保持不动。

**验收**：`pnpm build` 通过

**禁止**：不要改 `FragmentBacklinksPanel` 的既有契约与行为；不要让第四栏在导图时收起

---

## T9.2 `MindMapCanvas` 暴露选中节点与节点更新能力

**文件**：`src/components/shard/mind-map-workspace.tsx`、`src/components/shard/mind-map-canvas-editor.tsx`

**做什么**

1. `MindMapCanvasProps`（`:48`）新增 `onSelectedNodeChange?: (node: ShardMapNode | null) => void`，在内部 `selectedNodeIds`（`:83`）派生的 `selectedNode`（`:126`）变化时上报。多选时上报 `null`（本批属性面板只处理单选）。
2. `MindMapCanvasHandle`（`:55`）新增 `updateNodeStyle(nodeId: string, patch: { tone?: ...; width?: number }) => void`。
3. **节点更新必须走 Canvas 内部既有的 draft 变更通路**（与节点改名、增删同一条路径），以便：
   - 进入撤销栈（`undoDraft` / `redoDraft` 可回退样式变更）
   - 触发 `isDirty` 与自动保存
   - 参与冲突检测
   **绝对不要**让外部直接改 `draftFile` 或绕过 draft 写文件。
4. 采用「上报 + handle 下达」而非 render prop：右栏与第三栏是并列 DOM，不该嵌套进 Canvas。

**验收**：`pnpm build` 通过；既有导图交互（增删改节点、撤销重做、自动保存、冲突处理）全部不受影响

**禁止**：不要改导图文件格式；不要新增 Tauri command；不要让样式变更绕过撤销栈

---

## T9.3 导图节点属性面板 + 让 `tone` 真正生效

**文件**：新建 `src/components/shard/mind-map-inspector.tsx`（+ `.module.css`）、`src/components/shard/mind-map-canvas-editor.tsx`

**做什么**

1. 新建 `MindMapInspector`，选中节点时显示：
   - **色调**：`default` / `accent` / `success` / `warning` 四选一，消费 Kiln token，不新造颜色
   - **宽度**：手动设置与「恢复自适应」（清空 `width` 回到按文字自适应）
   - 节点自身的 `links` 列表（可点击跳转，复用既有导航通路）
2. **让 `tone` 影响渲染**：`mind-map-canvas-editor.tsx:1280` 的节点元素按 `node.style?.tone` 应用对应样式。当前 `tone` 无任何渲染消费，只加面板不改渲染等于配了没效果。
3. 色调映射到 Kiln 既有语义 token（accent / success / warning），**不要新造色板**。
4. 变更即时生效（走 T9.2 的 handle），无需"应用"按钮；撤销可回退。

**验收**：`pnpm build` 通过；改色调后节点外观立即变化，Cmd+Z 可回退

**禁止**：不要新造颜色变量；不要把样式写进 inline style 硬编码色值；不要让面板直接改文件

---

## T9.4 节点链接汇总（文档级，只读）

**文件**：`src/components/shard/mind-map-inspector.tsx`

**做什么**

1. 未选中节点时，面板显示当前导图的**全部节点链接汇总**：遍历 `draftFile.nodes` 的 `links`，按「节点名 → 链接目标」列出。
2. 三种目标类型（`ShardFragmentLink` / `ShardMarkdownPathLink` / `ShardMapLink`）都要能展示并跳转，复用既有导航通路。
3. 无链接时显示空态文案，不显示空列表框。
4. 这是本批唯一的文档级信息，数据从 T9.2 上报或由 Canvas 另行暴露（只读快照即可，不要让面板持有 draft 引用）。

**验收**：`pnpm build` 通过

**禁止**：不要为此新增 Tauri command；不要做导图反链（见非目标）

---

## T9.5 测试

**做什么**

1. **Playwright**：
   - 打开导图时第四栏可见且非空（未选中节点 → 链接汇总或空态）
   - 选中节点 → 第四栏显示节点属性；改色调后节点外观变化；Cmd+Z 回退
   - 清空宽度回到自适应
   - 打开笔记时第四栏仍是反链面板（回归保护）
   - **进入禅模式后第四栏不可见**（`ZenSurface` 覆盖，确认预期行为）
   - 切换笔记↔导图时编辑区宽度不跳变（第四栏始终在）
2. 若任何 Tauri command 签名或返回值变化，同步补齐**全部** spec mock（本批预期不需要）。
3. 断言用 `exact` 或区域限定：「思维导图」会撞侧栏同名入口与树内分组，必须限定区域。

**验收命令**（三条全绿）：

```bash
cargo test --manifest-path src-tauri/Cargo.toml
pnpm build && pnpm test:unit
pnpm test:ui
```

**禁止**：不要放宽既有断言；既有用例数量只能增不能减
