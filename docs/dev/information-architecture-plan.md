# 碎片 / 资料库 / 密匣 信息架构重整计划

> 历史方案（2026-09-15）：本文的多空间产品路线已由 [只围绕碎片的设计](fragment-only-design.md) 取代。保留历史决策与技术背景，本文后续任务不再作为执行队列；新方案尚未实施，也不表示旧数据已迁移或删除。

状态：待实施（已过 council 审计，本文为补订版）
创建：2026-08-31
裁决依据：与用户直接对齐（模型与 IA 归属）+ council-20260831-092606（codex / antigravity / grok / kimi，4/4 判「修订后执行」）
修订：本版按 council 裁决改写了归档决策的论据、密匣 IA 形态、阶段顺序，并补入实施约束清单。原版三处事实性错误见文末审计记录。

## 背景：错位在哪

当前三者在实现上的真实位置：

| | 碎片 | 资料库 | 密匣 |
| --- | --- | --- | --- |
| 磁盘 | `fragments/YYYY/MM/` + `archive/` | `notes/**`（目录、md、csv） | `lockbox/fragments/` + `lockbox/archive/`（`.shard` 加密） |
| 侧栏层级 | 一级空间 | 一级空间 | 碎片空间下的第 3 个 filter |
| 组织轴 | 时间倒序流 | 目录树 | 复用碎片时间流 + 标签筛选 |
| 能装什么 | 碎片 md | 笔记、目录、csv、"碎片流"聚合入口 | 只能装碎片与归档碎片 |

问题不是某个功能缺失，而是**三个正交维度被压进了一维侧栏**：

1. **加工程度**：碎片 ↔ 笔记。同一批 md 的生命周期两端，靠目录 + type 标签区分，"升级即搬移"。
2. **组织方式**：时间流 ↔ 目录树。浏览界面的差异，不是内容的差异。
3. **保密边界**：明文 ↔ 加密。密匣唯一的本质。

碎片与资料库分居维度 1、2 的两端，配对自洽。密匣属于维度 3，与前两者完全正交，却被画成了维度 1 里的一个取值。三个具体症状全部由此派生：

- **笔记进不了密匣。** `src-tauri/src/lib.rs:3970` 的 `move_public_fragment_payload_to_lockbox_in_vault` 只 strip `fragments/` 与 `archive/` 前缀，`notes/` 下的文档无路径可映射。这是当前**真实的功能缺口**。
- **密匣内容只能按时间流看。** 没有目录组织，因为它复用的是碎片视图。
- **安全区绑死路由。** `src/workspace/use-lockbox.ts:76` 判定 `route.space === "fragments" && route.params.filter === "lockbox"`，任何新增密匣视图都要改这条不变量。

归档有同构的问题：它同样是正交状态（活跃 ↔ 已归档），同样被编码成目录（`archive/`、`lockbox/archive/`），同样只对碎片成立。

---

## 目标模型

### 公理

**vault 里只有一种内容：Markdown 文档。** 碎片和笔记不是两种东西，是同一种东西处在不同加工阶段。

在这条公理上，每份文档有三个正交属性：

| 轴 | 取值 | 编码方式 |
| --- | --- | --- |
| 位置 | 时间轴 `fragments/YYYY/MM/` ↔ 用户目录 `notes/**` | 目录 |
| 保密 | 明文 ↔ 加密 `lockbox/` | 目录 |
| 活跃 | 活跃 ↔ 归档 | frontmatter `archived_at` |

### 编码原则

**能用元数据表达的不用物理位置表达；必须物理隔离的才用目录。**

- **保密用目录**：加密是物理事实，`.shard` 与 `.md` 根本不是同一种文件，无法靠字段区分。
- **位置用目录**：它本来就是位置。
- **活跃用字段**：理由见下。

### 归档为什么必须用字段（论据已修订）

> **原版论据作废。** 原文称"归档若用目录编码，每次归档一篇笔记都要联动重写全 vault 指向它的 wikilink"——**这不成立**。wikilink 按 `file_stem` 解析（`apply_vault_wikilink_updates` 的入参就是 old/new stem，`lib.rs:2945`），而 `set_fragment_archived` 的 rename 保留相对路径、stem 不变（`lib.rs:1689-1700`），归档换目录不会断链。T6 的痛点是**改名**（`{id}.md` → `{标题}.md`），与换目录无关。

真正成立的理由有三条：

1. **避免笛卡尔积。** 归档要扩展到 `notes/**`。三轴若全用目录编码，组合是 `notes/`、`archive/notes/`、`lockbox/notes/`、`lockbox/archive/notes/` ……共 8 种目录组合。归档转字段后降为 4 种。
2. **笔记归档不能让资料库树丢节点。** 资料库被定义为全 vault 的地图。若归档笔记被搬进 `archive/notes/`，它在用户建立的目录结构里就消失了——归档一篇笔记不应该改变它在书架上的位置。这是 IA 层面的硬约束，碎片没有这个问题（碎片的位置是时间，不是用户组织的）。
3. **同步冲突面更优**（council 反转结论，应正向记录）：字段方案下"一台设备改归档行、另一台改正文"可以干净三方合并；目录方案下"一台 rename、另一台改内容"是 rename/modify 冲突。

**性能不构成反对理由。** `list_fragments_in_vault`（`lib.rs:1281-1304`）本就全量读取 `fragments/`、`archive/`、`notes/` 三个目录并完整解析每个文件的 frontmatter，`archived` 只是解析后从路径前缀顺手推导（`lib.rs:3651`）；前端搜索与 AI 洞察都在已进内存的 `Fragment` 列表上过滤。改字段后 I/O 量不变，**不需要引入 `.shard/` 索引层**，不要用缓存去补偿一个不存在的回归。

唯一真实的性能相关缺陷是 `summarize_fragment_stream`（`lib.rs:2504-2556`）：它只 `read_dir` 计数 `.md` 文件、不读内容，靠"不走进 `archive/`"排除归档。回迁后计数会虚高——这是必须修的正确性缺陷，不是建索引的理由。

### 三个空间的定义

- **资料库 = 全 vault 的唯一文件管理器。** 所有 md 文档、csv 数据、思维导图都能在这里找到位置。它是**地图**。
  当前只管 `notes/**` 的 md 与 csv（`LibraryTreeEntryKind` = `directory | markdown | csv`，`src/types.ts:69`），`maps/` 下的思维导图游离在外、且无法被 wikilink 引用——与本公理冲突，由第七批（E）补齐。
- **碎片 = 时间轴镜头**，看 `fragments/**` 中未归档的部分。UI 上是镜头，但**磁盘上仍是独立仓库**（`fragments/` 与 `notes/` 保持分立），且**侧栏一级入口必须保留**——产品根基是"只优化一个动作：快速捕捉"。
- **密匣 = 资料库树上的一个上锁挂载点，点击进入的加密一级空间。** 它是**保险柜**。

一句话：**传送带上的东西最终都会在地图上有位置；保险柜在地图上有一个上锁的入口，但推门进去是另一个房间。**

### 密匣形态：传送门，不是模态子树（已修订）

> **原版方案作废。** 原文让密匣作为资料库树的可展开子节点，进入时折叠其余分支形成"模态浏览态"。council 指出：这已经不是在浏览子树，而是在切换空间，只是假装还在树上；节点看起来像文件夹、行为却是保险柜，用户会困惑。

采用的模型：

- 资料库树里放一个**上锁的挂载点节点**（不可展开、不列子文件）。
- 点击 = 解锁 → **进入密匣一级空间**，内含自己的 `notes` 树 + 碎片流。
- 退出密匣、切换空间、3 分钟空闲 = 上锁。
- **安全区继续跟空间走**，不跟选中节点走，也不需要折叠资料库其余分支。

这样既满足"资料库是地图、能看见密匣"，又不把加密世界画成普通子文件夹，还保住了"离开即上锁"的干净不变量。

### 目标磁盘布局

```text
vault/
├── fragments/YYYY/MM/*.md
├── notes/**/*.md
├── assets/
├── maps/
├── lockbox/
│   ├── fragments/YYYY/MM/*.shard
│   └── notes/**/*.shard
└── .shard/
```

`archive/` 与 `lockbox/archive/` 消失，归档态进 frontmatter。`lockbox/notes/` 为新增。

---

## 不变量

1. **安全区跟空间走，且有两个合法取值。** 当前 `use-lockbox.ts:76-101` 存在**两个并存安全区**：密匣视图，以及"含密匣的洞察"（`review/insight` + `insightIncludeLockbox`，有独立的 3 分钟空闲计时与"离开洞察即取消勾选"逻辑）。改造后安全区 = `密匣空间 || 含密匣洞察`，两者都要保留，不得只迁移路由判定而悄悄收紧或留下双标。
2. **归档不搬文件，且只写 `archived_at`。** 禁止顺手 bump `updated_at`——否则归档这个元操作会伪装成内容编辑，污染一切按更新时间排序的地方。
3. **`#密匣` 仍是保存路由指令，不是标签。** 标签过滤面板不展示密匣，编辑器保持琥珀色着色与目的地徽标（沿用 `shard-lockbox-destination` 已定稿部分）。
4. **捕捉流零改动。** 捕捉框保存仍写 `fragments/YYYY/MM/`，`Cmd+Enter` 路径不受本次重整影响；碎片侧栏一级入口保留。
5. **前端 `Fragment` 契约不变。** `archived: boolean` 与 `lockbox: boolean`（`src/types.ts:35-36`）语义与类型均保留，只有来源从路径派生改为字段读取 / 目录判定。
6. **迁移期双读。** `archived = archived_at.is_some() || rel_path.starts_with("archive/")`，保留至少一个发布周期。缺此语义时若迁移中途崩溃，vault 会处于"一半靠路径、一半靠字段"的状态，归档内容会凭空回到时间轴。

## 非目标

- 不做碎片与笔记的存储合并（`fragments/` 与 `notes/` 保持分立目录，时间轴与目录树是两种真实不同的位置语义）。
- **不引入 `.shard/` 索引层或任何缓存。** 见上文性能论证。
- 不改动加密算法、密钥派生与恢复码流程。
- 不引入 tag 命名空间前缀（`#type/xx` 这类），沿用 `shard-type-tag-unified` 决策。
- 不做密匣内容的全文索引或跨密匣搜索。
- 不把碎片收进资料库当子页，不降低碎片的侧栏一级地位。
- **不做统一无限画布，不引入 React Flow / Excalidraw / tldraw。** 查证结论（2026-08-31）：NoteGen 的画布是 `@xyflow/react` 的节点-边编辑器（配 `elkjs` 自动布局），并把 `position: {x, y}` 序列化落盘（`canvas-editor.tsx:285`，还以 `prior.position.x !== node.position.x` 做变更检测）——它不是 Excalidraw 式的自由绘制画布。存坐标正是 `docs/dev/fragment-relations-plan.md` 中 council 4/4 否决的方案（x/y 是视觉状态不是业务数据，git diff 全是无语义噪音，merge 冲突无法判对错）。Shard 维持 `parentId + sortKey` 入库、坐标由 `layoutMindMap()` 派生。
- 不引入 mermaid。若将来要补流程图能力，mermaid 内嵌（文本即图、可 diff、与"存文本不存像素"一致）成本远低于画布，但属独立议题，需单独决策。

---

## 影响面

### Rust（`src-tauri/src/lib.rs`，约 7234 行，`archive` 命中 38 处）

| 位置 | 现状 | 目标 |
| --- | --- | --- |
| `:478-492` `FragmentFrontmatter` | 无归档字段 | 加 `archived_at: Option<String>`，须 `#[serde(default, skip_serializing_if = "Option::is_none")]` |
| `:3651`、`:4096` | `archived` 从 `rel_path.starts_with("archive/")` 派生 | 双读 → 最终只读 `archived_at` |
| `:1661-1700` `set_fragment_archived` | 在 `fragments/` ↔ `archive/` 之间搬文件 | 改写 frontmatter，不动路径，不动 `updated_at` |
| `:4013-4034` `set_lockbox_fragment_archived_in_vault` | 在 `lockbox/fragments/` ↔ `lockbox/archive/` 搬文件 | 解密 → 改字段 → 重加密回原路径 |
| **`:4117-4138` `write_lockbox_fragment_file`** | **白名单逐字段重建 `FragmentFrontmatter`，`related` 已被硬编码为 `Vec::new()` 丢弃** | **必须把 `archived_at` 加进白名单，否则密匣文档首次保存即静默丢失归档态** |
| **`:2504-2556` `summarize_fragment_stream`** | **只 `read_dir` 数 `.md`、不读内容，靠不进 `archive/` 排除归档** | **回迁后须读 `archived_at` 才能正确计数，否则碎片流数字虚高** |
| `:3970-3978` 移入密匣的路径映射 | 只认 `fragments/` 与 `archive/` 前缀 | 增加 `notes/` → `lockbox/notes/` 映射 |
| `:1286-1299`、`:3018` 收集 md | 分别遍历 `fragments/`、`archive/`、`notes/` | 去掉 `archive/`，增加 `lockbox/notes/` |
| `:48` `MANAGED_VAULT_ROOTS` | 含 `archive` | 迁移期保留，单读阶段才移除（移除前不能丢 Git 追踪） |
| `:2344-2346` 初始化 | 创建 `fragments/`、`notes/`、`archive/` | 不再创建 `archive/` |
| `:3016` `migrate_legacy_notes_in_vault`（T6） | 扫 `fragments/` 把带 `note` 标签的搬进 `notes/` | **须加排除条件**：回迁后带 `note` 标签的归档碎片会被误当遗留笔记搬走 |
| `:2994-3001` `convert_fragment_to_note` | 拒绝非 `fragments/` 前缀 | 回迁后归档碎片可被"升级"，须先定义 `archived_at` 是否随升级带走，或禁止升级归档文档 |
| 新增 | — | 一次性幂等迁移：`archive/**` 回迁至 `fragments/` 并写 `archived_at`；`lockbox/archive/**` 同理 |

移入密匣放开 `notes/` 后，`reject_lockbox_images` 与附件引用检查要覆盖笔记可能携带的 `assets/` 引用与 `![[csv]]` 嵌入（公开路径会泄露）。

### 前端

| 模块 | 改动 |
| --- | --- |
| `src/workspace/route.ts` | `FragmentWorkspaceFilter` 移除 `lockbox` 与 `archive`；新增密匣一级空间；`readWorkspaceRoute` 对旧值回退到 `inbox` |
| `src/workspace/use-lockbox.ts:76-101` | 安全区改为"密匣空间 ‖ 含密匣洞察"两个取值，三条上锁路径（退出 / 切空间 / 空闲）保留 |
| `src/workspace/library-shell.tsx` | 树中新增**上锁挂载点节点**（不可展开），点击进入密匣空间 |
| `src/components/shard/sidebar-nav.tsx:86-94` | `FRAGMENT_ITEMS` 收敛为收件箱 + 标签；碎片一级入口保留 |
| `src/workspace/use-fragments.ts` | 归档调用契约不变，仅后端语义变化（**注意：不在 `src/lib/`**） |
| `src/lib/api.ts` | 归档命令签名不变 |
| `src/lib/fragment-search.ts`、`src/lib/review-workflows.ts` | 归档过滤从路径判断改字段判断 |

其余 `archive` 命中文件（`fragment-card.tsx`、`bottom-tabs.tsx`、`fragment-link-dialog.tsx`、`fragment-search-workspace.tsx`、`relations.ts`）消费的是 `Fragment.archived` 布尔值，契约不变则无需改动，验收时确认。

### 标签视图升为全 vault

碎片空间下的"标签"filter 目前只筛碎片。密匣与归档移出后，标签本就是三轴中独立的一根（目录=空间 / 时间=碎片 / 标签=主题，见 T6 决策），笔记同样带标签。标签应提为全局入口，覆盖 `fragments/` 与 `notes/`。

---

## 阶段划分（顺序已按 council 裁决重排）

原版 `A → B → C → D` 的"不可交换"论证不成立：`notes/` → `lockbox/notes/` 是纯加法，不碰 `archive/` 也能做；密匣 IA 迁移不依赖密匣里有没有笔记。风险最高的是归档正交化（一次性搬迁 + 语义翻转）与安全区改造，二者**不得进同一 PR**。

**B-lite：放开笔记进密匣**（风险最低，补当前真实功能缺口）
`notes/` → `lockbox/notes/` 路径映射、密匣文件收集覆盖新目录、移入对笔记成立。密匣笔记**暂不支持归档**（旧模型下无目录可去），这是本阶段的显式取舍。

注：当前只有 `move_fragment_to_lockbox`（`lib.rs:6110`），**没有移出密匣的 command**，密匣是单向的；本阶段不新增移出能力。`find_fragment_path`（`lib.rs:4234-4238`）已覆盖 `notes/`，唯一卡点是路径映射的 `strip_prefix`。

**C：密匣传送门 + 一级空间**
资料库树的上锁挂载点、密匣一级空间（notes 树 + 碎片流）、安全区改为空间维度且保留洞察豁免、`FragmentWorkspaceFilter` 收敛、路由 localStorage 旧值兼容。

**A：归档正交化**（风险最高，独立三段，每段可回滚）
- **A1 双读**：加 `archived_at` 字段，`archived = archived_at.is_some() || path 以 archive/ 开头`，写入路径改字段但不迁移存量。
- **A2 幂等迁移**：`archive/**` 回迁 `fragments/`、`lockbox/archive/**` 回迁 `lockbox/fragments/`，写 `archived_at`；走 `checkpoint_before_structural_locked`，清理空目录残留。**必须先于 T6 迁移执行**，且 T6 须加排除条件。
- **A3 单读**：移除路径派生、从 `MANAGED_VAULT_ROOTS` 摘掉 `archive`、修 `summarize_fragment_stream` 计数。双读至少保留一个发布周期后再做。

**D：标签全局化**
标签入口提为全 vault，覆盖笔记标签。

**E：资料库容纳思维导图**（可与 A 并行，互不依赖）
`LibraryTreeSnapshot` 增 `mind_maps` 字段、资料库树渲染与「碎片流」并列的导图分组、导图成为 wikilink 目标。补齐"资料库是全 vault 地图"的最后一块——`maps/` 是 vault 顶层目录却不在地图上。本批只做「看得见、点得开、可被引用」，不给导图加写操作入口，不碰导图编辑器。

---

## 实施约束（council 补入，逐条必须落地）

1. **双读语义写死**，见不变量 6。
2. **`updated_at` 不被归档 bump**，见不变量 2。这是最容易顺手写错的一条（现有保存路径如 `lib.rs:1648` 都会 bump）。
3. **serde 契约**：`archived_at` 加 `#[serde(default, skip_serializing_if = "Option::is_none")]`，保证未归档文件一个字节都不多写，Git diff 为零。
4. **密匣白名单**：`write_lockbox_fragment_file` 的字段重建列表必须补 `archived_at`（`related` 被丢弃是既有问题，本次不修但不要扩大）。
5. **两个迁移的顺序与互斥**：先归档回迁，再 T6 遗留笔记迁移；T6 加排除条件避免把带 `note` 标签的归档碎片搬走。
6. **密匣重加密硬约束**：只在解锁态运行、明文只在内存、复用 `write_bytes_atomically` 写临时密文再 rename、失败保留原文件、**禁止"先写成 `.md` 再加密"的捷径**。
7. **迁移期兼容清单**：`MANAGED_VAULT_ROOTS` 保留 `archive` 至 A3、`organize_fragments` 仍接受 `archive/` 前缀、回迁走结构型 checkpoint。
8. **`convert_fragment_to_note` 对归档文档的行为先定义**再动工。
9. **归档语义翻转的测试兜底**：从"默认物理不可见"变成"默认可见、靠过滤排除"，任何遗漏 `!archived` 过滤的查询都会把归档内容泄露到 UI，需要用例覆盖。
10. **新增 Tauri command 必须同步补齐全部 spec 文件的 mock**（T5 教训），否则既有用例连锁失败。

## 风险

1. **迁移幂等性**：归档回迁与 T6 迁移同期存在，顺序已在约束 5 中规定，实施时须验证两者各自幂等且顺序稳定。
2. **密匣 Git 噪音**：AES-GCM 每次改字段换 nonce，整份 `.shard` 变成新 blob，Git 认不出 rename，多设备冲突不可合并。对单人低频归档可接受，但须如实记录。
3. **外部工具视图变化**：Obsidian 等会在 `fragments/YYYY/MM` 里重新看见已归档碎片，`archive/` 作为"整夹跳过"的物理提示消失。
4. **选择器歧义**：新增"密匣""归档"文案与既有侧栏项、`同步 Git 资料库` 等易撞子串，Playwright 断言用 exact 或区域限定。

## 审计记录

- 2026-08-31 · council-20260831-092606 · 选手:codex,antigravity,grok,kimi（mimo 失败） · 主席claude裁决 HIGH:「修订后执行——三轴模型保留，但主论据（归档搬目录会断 wikilink）经代码验证不成立，须改写；另发现 write_lockbox_fragment_file 白名单会静默丢弃 archived_at、summarize_fragment_stream 计数将虚高；阶段依赖论证不成立，重排为 B-lite→C→A→D；密匣 IA 由模态子树改为传送门」· 报告 ~/.council/shard/council-20260831-092606/viewer.html
