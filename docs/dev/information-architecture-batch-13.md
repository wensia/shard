# 思维导图迁入文档目录，与 md 平级（IA 重整第十三批 K）

## Context

用户指出：**「思维导图、md 文档，都应该在文件目录，现在只展示了 md 文档，所有文件类型都是同级别才对」**（看资料库根目录的宫格视图时发现只有两个 md）。

这是对的，而且指出了一个我在第七批埋下的架构错误。

## 根因：导图被归到了时间轴

`create_mind_map_in_vault`（`lib.rs:1395-1425`）把导图写到：

```
maps/YYYY/MM/<id>.shardmap.json
```

**按创建时间分目录**，与碎片（`fragments/YYYY/MM/`）同构。于是 `build_library_tree`（`:2483-2489`）只能把它们塞进一个独立的 `mind_maps` 字段，前端渲染成与「碎片流」并列的分组节点——而不是文件树里的普通文件。

这个归类是错的。三轴模型里位置轴分「时间目录 ↔ 用户目录」：

| 内容 | 谁决定它的位置 | 该归哪根轴 |
| --- | --- | --- |
| 碎片 | 系统（捕捉时间） | 时间目录 ✅ 现状正确 |
| 笔记 | 用户（放进哪个主题目录） | 用户目录 ✅ 现状正确 |
| **思维导图** | **用户（主动创建、有标题）** | **用户目录 ❌ 现状错误** |

导图是用户主动创建、有标题、会想放进某个主题目录的**文档**，不是按时间沉淀的流水。第七批我让它上树时，跟着磁盘布局走做成了分组节点，而没有纠正磁盘布局本身。

## 核心裁决

| # | 裁决 |
| --- | --- |
| D1 | 导图从时间轴迁到用户目录：新建落盘到 `notes/`（与笔记同目录规则），既有 `maps/**` 一次性迁移。 |
| D2 | 移除 `LibraryTreeSnapshot.mind_maps` 独立字段与前端的「思维导图」分组节点，导图成为 `entries` 里的普通条目（`kind: "mindmap"`），在树与目录视图里与 md、csv **完全平级**。 |
| D3 | 导图获得与 md 相同的完整文件操作：**重命名、移动到子目录、删除**。这是「同级别」的实质，不只是显示位置。 |
| D4 | 迁移后文件名用**标题**而非 id（`<标题>.shardmap.json`），与 T6「升级即搬移用标题命名」一致——否则树里显示 `map-20260901-...json` 依旧不可读。 |
| D5 | **图片保持 `assets/` 分组不动**。用户本次只提了导图与 md。图片是内容寻址去重的**资源池**（文件名即 hash、无用户可见名称、同内容自动去重），不是用户组织的文档；把它铺进 `notes/` 会破坏去重并制造一堆 hash 文件名。它的网格入口已经能用。 |
| D6 | 侧栏移除「思维导图」独立一级入口，导图按普通文档从资料库浏览、打开。底部「更多操作」保留已有导图管理入口，以保留当前新建与编辑能力；本次不迁移新建流程。（2026-09-06 按用户纠正修订） |

## 风险已核

- **wikilink 不会断**：`buildMindMapWikilinkCandidates`（`src/lib/wikilink.ts:93`）用 `target: map.title`（标题）而非路径，迁移改路径不影响解析。
- **导图内部链接不受影响**：`ShardMapNode.links` 指向的是 fragment id / 笔记路径 / 导图 id，不依赖导图自身位置。

## 非目标

- 不动图片存储与展示（D5）。
- 不改导图文件格式、不动 `layoutMindMap()`、不引入画布库。
- 不做导图内容的搜索索引。
- 不合并 `maps/` 到 `notes/` 之外的任何目录重排。

---

## T13.1 Rust：`notes/` 目录识别导图文件

**文件**：`src-tauri/src/lib.rs`

**做什么**

1. `collect_library_entries`（约 `:2477-2490`）的扩展名匹配增加导图分支。注意 `.shardmap.json` 的 `extension()` 是 `json`，**必须用既有的 `is_mind_map_file(&path)`（`:3206-3211`）按文件名后缀判定**，不要用 extension 匹配。
2. 判定顺序：先 `is_mind_map_file` → `"mindmap"`，再落到既有的 `md` / `csv` 分支，其余 `continue`。
3. `LibraryTreeEntry` 的 `size` / `modified_at`（第十二批加的）对导图同样填充。

**验收**：`cargo test` 通过

**禁止**：不要用 extension 判定导图；不要改 `is_mind_map_file` 本身

---

## T13.2 Rust：导图新建落盘改到 `notes/`

**文件**：`src-tauri/src/lib.rs`

**做什么**

1. `create_mind_map_in_vault`（`:1347`）的落盘目录从 `maps/YYYY/MM/` 改为 `notes/`，文件名用**标题**：`<标题>.shardmap.json`，重名时复用既有的 `unique_note_path` 去重策略。
2. `create_mind_map` command 若能拿到「当前目录」上下文则落在该目录，拿不到就落 `notes/` 根——**本批不新增参数**，先落根目录即可。
3. `collect_mind_map_files`（`:3180`）的扫描根从 `maps/` 改为 `notes/`（递归），保证 `list_mind_maps` 等既有能力不断。
4. `MANAGED_VAULT_ROOTS`（`:48`）暂时**保留** `maps`，供迁移期读取旧数据；T13.3 迁移完成后仍保留（旧 vault 兼容），但新写入不再产生该目录。

**验收**：`cargo test` 通过；新建导图落在 `notes/` 且文件名可读

**禁止**：不要改导图文件内容格式；不要动 `write_mind_map` 的冲突检测

---

## T13.3 Rust：`maps/**` 一次性幂等迁移

**文件**：`src-tauri/src/lib.rs`

**做什么**

1. 新增迁移函数：扫描 `maps/**` 下所有 `.shardmap.json`，逐个搬到 `notes/<标题>.shardmap.json`（`unique_note_path` 去重），保留文件内容不变。
2. **幂等**：连跑两次结果一致；`maps/` 已空或不存在时直接返回。
3. 走 `checkpoint_before_structural_locked`（与第十批归档回迁同规格），迁移后清理空的年月目录。
4. 单个文件读取/校验失败时**跳过并保留原文件**，不中断整体迁移。
5. 触发时机与 T6 遗留笔记迁移一致（首次进入资料库），并确保两个迁移**互不干扰**：本迁移只碰 `maps/`，T6 只碰 `fragments/`，无交集。

**验收**：`cargo test` 通过；幂等性单测见 T13.5

**禁止**：不要在迁移里改写导图内容；不要删除读取失败的文件

---

## T13.4 前端：导图成为普通文件条目

**文件**：`src/types.ts`、`src/workspace/library-shell.tsx`、`src/workspace/workbench-shell.tsx`

**做什么**

1. `LibraryTreeEntryKind` 已含 `"mindmap"`（第七批加的），无需改动。
2. **移除** `LibraryTreeSnapshot.mind_maps` 字段与前端 `mindMaps` prop 链路（`library-shell.tsx:128/176/236/266/306` 等处），导图从 `entries` 里自然出现。
3. **移除**树上的「思维导图（N）」分组节点，导图作为普通文件条目渲染（图标沿用既有的 `GitBranchIcon`）。
4. 导图条目**开放完整操作菜单**：重命名、移动到…、删除（与 md 条目同一套菜单与通路）。这是 D3 的落点，第七批曾禁止，本批解禁。
5. 点击导图仍走既有的第三栏 `MindMapCanvas` 分派（第八批建立），行为不变。
6. `buildMindMapWikilinkCandidates` 的数据源改为从 `entries` 里筛 `kind === "mindmap"` 的条目；需要 title 时用文件名去掉 `.shardmap.json` 后缀。
7. 移除侧栏「思维导图」独立一级入口；底部「更多操作」保留已有导图管理入口（D6）。

**验收**：`pnpm build` 通过；UI 用例见 T13.5

**禁止**：不要移除底部「更多操作」中的导图管理入口；不要改导图工作区内部实现或迁移新建流程

---

## T13.5 测试

**做什么**

1. **Rust 单测**：
   - `notes/` 下的 `.shardmap.json` 出现在 `entries` 且 `kind == "mindmap"`，带 size/modified_at
   - 新建导图落在 `notes/` 且文件名用标题
   - `maps/**` 迁移到 `notes/`，连跑两次幂等
   - 迁移中损坏文件被跳过且原文件保留
2. **Playwright**：
   - 资料库根目录的**列表与宫格里同时出现 md 与导图**（本批的核心诉求，必须断言两者并存）
   - 树上**没有**「思维导图（N）」分组节点了
   - 侧栏**没有**「思维导图」独立一级入口；底部「更多操作」仍可进入导图管理并新建、打开导图
   - 导图可重命名、可移动到子目录（与 md 同一套菜单）
   - 点击导图仍在第三栏打开画布（回归保护）
   - 图片分组**不受影响**（D5 回归保护）
3. **补齐全部 spec mock**：`LibraryTreeSnapshot` 移除 `mindMaps` 字段会波及所有 mock 该命令的 spec（第七批加它时补了 9 个文件、21 处，本批是反向操作，同样规模）。
4. 断言用 `exact` 或区域限定。

**验收命令**（三条全绿）：

```bash
cargo test --manifest-path src-tauri/Cargo.toml
pnpm build && pnpm test:unit
pnpm test:ui
```

**禁止**：不要放宽既有断言

---

## 主要风险

- **R1 · mock 反向扩散**：移除 `mindMaps` 字段波及面与第七批加它时相同（9 个 spec）。
- **R2 · 迁移与 T6 并存**：两个迁移都在首次进资料库时触发，需确认互不干扰（本迁移只碰 `maps/`，T6 只碰 `fragments/`，理论无交集，但要有测试兜底）。
- **R3 · 标题重名**：多张导图同名时靠 `unique_note_path` 加后缀，迁移后树里会出现「架构图.shardmap.json」「架构图 2.shardmap.json」，属预期行为。
- **R4 · 旧 vault 兼容**：迁移后 `maps/` 为空但保留在 `MANAGED_VAULT_ROOTS` 里，旧版本 Shard 读新 vault 会看不到导图——单机应用可接受，但要在 commit 里记录。
