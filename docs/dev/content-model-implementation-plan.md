# 内容模型实施方案

日期：2026-09-28。依据：[产品框架](product-framework.md) §2、§8（2026-09-28 修订）与 [内容模型架构评审](content-model-architecture-review.md)。

执行方式：每批交 Codex（`gpt-5.6-sol`，`model_reasoning_effort=high`）在独立 worktree 分支上实施；Claude 负责规划与验收（对照源码审 diff、重跑验收命令），通过后提交。一批验收通过再细化并派发下一批。执行者只按本文当批施工令做事，不顺手重构。

## 1. 已定决策（执行者不得改动）

- 每条内容一篇 md，四种 type：碎片（缺省）、大纲 `outline`、流程图 `flowchart`、文档 `document`（另有历史 `note`）。
- 大纲与流程图的正文是唯一一段受管 JSON（```` ```shardmap ```` / ```` ```shardflow ````），大纲与导图是同一份 JSON 的两个视图。
- **密匣只加密 md 文档**（碎片、文档、历史笔记）。大纲、流程图、CSV、附件都不进密匣，不做加密适配。
- 自定义属性写在 frontmatter 顶层；Shard 改文件时未涉及的键逐字节保留。

## 2. 批次总览

| 批次 | 内容 | 依赖 | 状态 |
| --- | --- | --- | --- |
| **P0** | frontmatter 保真读写：修改既有 md 时只局部改写系统键；密匣载荷保存原始 frontmatter | 无 | 已完成（`ba55dc5`），施工令见 §3 |
| **P1** | 共用前置合同：保存基线覆盖完整文件（前端拿到文件级哈希）；type 合同（新增 `flowchart`，多个 type 标签的冲突规则在后端与 CLI 统一执行）；大纲、流程图拒绝进密匣 | P0 | 执行中，施工令见 §4 |
| **H1** | 受管 JSON 区域编解码（Rust + TS）与后端读写命令：幂等创建（稳定操作 ID）、读取、只替换区域的原子写、完整文件基线 | P1 | 执行中，施工令见 §5 |
| H2 | `/大纲` 提交改为创建 JSON 大纲（正式导入器，上限 400 节点，超限报错不截断）；打开大纲进入现有导图编辑器（大纲/导图两视图）；`/流程图` 创建与打开；大纲与流程图不进 Tiptap | H1 | 待细化 |
| H3 | 时间线卡片（缩略 + 标题）、type 筛选、搜索图内容投影（不索引 JSON 键名、坐标、ID） | H1 | 待细化 |
| H4 | 旧 md 大纲批量升级（预检报告、正式导入器、确认成功的备份）；资料库时代 `notes/` 下 `.shardmap.json`/`.shardflow.json` 显式加入时间线；CLI 原生 JSON 读写与节点级修改 | H2 | 待细化 |
| G1–G3 | 属性面板与 `.shard/properties.json`；SQLite 属性表与筛选；标签主题页表格视图 | P1 | 待细化 |

## 3. P0 施工令：frontmatter 保真读写

### 3.1 目标与非目标

**目标**：Shard 修改一篇已有 md（碎片、笔记、文档）时，frontmatter 里本次操作没有涉及的内容——未知键、注释、空行、键序、引号与流式写法——逐字节保留，只局部改写值发生变化的系统键；无法安全局部改写时返回错误，文件保持原样。进出密匣同样保真。对 Shard 自己写出、没有未知键的文件，新写法的输出与现在的 `write_fragment_file` **逐字节一致**，用户库不产生无意义的 diff。

**非目标**（本批不做）：
- 不换 YAML 库，继续用 `serde_yaml 0.9` 解析与生成单个键的文本。
- 不改前端，不改 Tauri 命令签名；`expected_sha` 仍只覆盖正文（P1 处理）。
- 不改新建文件的写法：`create_public_fragment_in_vault`、`write_organized_note`、`create_library_note_in_vault`、`canvas_commands/split.rs` 的 `index_bytes` 保持原样。
- 不接受 CRLF 或 BOM 文件：维持现状（解析报错、不写）。
- 不加属性 UI，不加新依赖。

### 3.2 新模块 `crates/shard-core/src/frontmatter.rs`

在 `shard-core` 新增 `pub mod frontmatter`，提供：

1. `SYSTEM_KEYS`：`FragmentFrontmatter` 的 10 个字段名，按结构体字段顺序：`id, created_at, updated_at, tags, category, ai_status, pinned, source, conflict_of, related`。
2. `parse_fragment(text) -> Result<ParsedFragment, String>`，`ParsedFragment { raw: String, frontmatter: FragmentFrontmatter, body: String }`。边界规则与现有 `src-tauri/src/lib.rs` 的 `parse_fragment_text` **完全一致**（`strip_prefix("---\n")`，第一个 `"\n---"` 为界）；`raw` 是两道 fence 之间的原文（不含首尾 `---`，末尾不带换行）；`body` 与现有函数返回的正文字节相同；错误文案保持不变。
3. `apply_frontmatter(raw, next: &FragmentFrontmatter) -> Result<String, String>`，返回新的 raw。算法：
   - 把 raw 按行切成片段：第 0 列非空、非空白、非 `#` 开头的行开始一个**顶层条目**，后续缩进行、空行之前的行都属于它；第 0 列的 `#` 注释行和空行是独立的**杂项**，原位保留，不附着在任何条目上。条目的键只按 `^[A-Za-z_][A-Za-z0-9_]*\s*:(\s|$)` 识别；识别不出的顶层行（引号键、`?`、`{`、`[` 等）当作不透明条目，永不改动。
   - 用 `serde_yaml` 把旧 raw 解析成 `Mapping`（记为 `old`），把 `next` 用 `serde_yaml::to_value` 变成 `Mapping`（记为 `want`；这自动沿用结构体上的 `skip_serializing_if` 规则）。
   - 对每个系统键 `k`：`old.get(k) == want.get(k)` 时**不动文本**；`want` 有值时，用 `serde_yaml::to_string` 生成只含 `k` 的单键映射文本（去掉可能的 `---\n` 前缀），替换原条目的全部行；原来没有这个条目时，插在规范位置：按 `SYSTEM_KEYS` 顺序，放在 raw 中存在的下一个系统键条目之前，找不到就放在前一个系统键条目之后，都没有就放在末尾；`want` 没有值时删除该条目的全部行。
   - **校验**：把新 raw 解析成 `Mapping`（记为 `new`）：非系统键的键集合与每个值必须与 `old` 相等；每个系统键必须等于 `want`；新 raw 必须能反序列化为 `FragmentFrontmatter`，且与 `next` 等价。任何一项不满足、或任一步解析失败，返回错误，不产生部分结果。这一步兜住别名/锚点、引号写的系统键、重复键等情况。
4. `render_fragment(raw, body) -> String`：`format!("---\n{raw}\n---\n\n{}\n", body.trim_end())`，与现有 `write_fragment_file` 的输出形状一致。
5. `write_fragment_update(path, raw, next, body) -> Result<(), String>`：`apply_frontmatter` → `render_fragment` → `write_text_atomically`。
6. `raw_from_frontmatter(fm) -> Result<String, String>`：旧 writer 会生成的 raw（`serde_yaml::to_string` 去掉可能的 `---\n` 前缀和末尾换行），供旧密匣载荷补 raw 使用；`src-tauri` 不再直接调用 `serde_yaml::to_string`。

`write_fragment_file` 与 `FragmentFrontmatter` 保持现状，供新建文件使用。

### 3.3 改造既有文件的写路径（`src-tauri/src/lib.rs`）

以下函数全部改为「`parse_fragment` 拿到 raw → 修改结构体投影 → `write_fragment_update` 或 `apply_frontmatter` + `render_fragment`」，业务语义（标签规范化、`inbox` 补齐、`updated_at` 更新、正文 trim 规则、提交策略）不变：

| 函数 | 现在的写法 |
| --- | --- |
| `update_fragment_tags` | `parse_fragment_text` + `write_fragment_file` |
| `update_fragment` | 同上 |
| `link_fragments_in_vault`、`unlink_fragments_in_vault` | 同上 |
| `set_public_fragment_pinned_in_vault` | 同上 |
| `convert_public_fragment_file_with_writer`（被 `convert_fragment_to_note_in_vault`、`convert_note_to_fragment_in_vault` 调用） | 自己 `serde_yaml::to_string(frontmatter)` 拼文件；改为 `apply_frontmatter` + `render_fragment` 后再交给现有 `rewrite` 闭包，回滚逻辑不变 |

`parse_fragment_text` 保留原签名供只读调用方使用，内部可委托 `shard_core::frontmatter::parse_fragment`。

### 3.4 密匣载荷保真

- `LockboxFragmentPayload` 增加 `#[serde(default, skip_serializing_if = "Option::is_none")] frontmatter_raw: Option<String>`。新写入的载荷**总是**带 raw，它是权威；`frontmatter` 字段继续写入并与 raw 的投影一致（旧版本应用降级读取时仍可用）。读取时有 raw 就从 raw 解析投影，没有 raw（旧载荷）就用结构体。
- 改动密匣条目（`update_lockbox_fragment_in_vault`、`update_lockbox_fragment_tags_in_vault`、`set_lockbox_fragment_pinned_in_vault`）：修改投影后用 `apply_frontmatter` 更新 raw；旧载荷没有 raw 时，先用 `raw_from_frontmatter` 从结构体生成 raw 再应用。
- 转入密匣（`move_public_fragment_to_lockbox_in_vault`、`move_public_fragment_content_to_lockbox_in_vault` → `move_public_fragment_payload_to_lockbox_in_vault` → `write_lockbox_fragment_file`）：把公开文件的 raw 带进载荷。**保留现有语义**：`related` 清空（通过 `apply_frontmatter` 删除该键）、标签按现规则处理。
- 新建密匣条目（`create_lockbox_fragment_in_vault`）：raw 由新结构体生成。
- `read_lockbox_fragment` 从投影构造 `Fragment`，对外行为不变。

### 3.5 必须新增的测试

`crates/shard-core/src/frontmatter.rs` 单元测试：

1. **字节一致**：构造覆盖各种组合的 Shard 自写文件（`pinned` 真/假、`related` 0/1/2 条且带或不带 `note`、`conflict_of` 有/无、`category`/`ai_status` 为 null 或有值），对每种文件依次做改标签、改 `updated_at`、切换置顶、增删关联，输出与「修改结构体后用旧 `write_fragment_file` 整体重写」逐字节相同。
2. **未知键保真**：文件含 `author: 张三`、`rating: 5`、`isbn: '00123'`、列表、嵌套映射、`|` 块标量、第 0 列注释、行尾注释、空行，且未知键分别出现在系统键之前、之间、之后；改标签、切置顶、增删关联后，所有未知部分逐字节不变。
3. **只动变化的键**：`tags: [a, b]` 流式写法在标签不变时原样保留；标签变化时只重写 `tags` 条目。
4. **规范插入位置**：原文件没有 `pinned`、`related`、`conflict_of` 时新增，位置与旧 writer 一致。
5. **拒绝写入**：系统键被别处别名引用、系统键用引号写（`"tags": [...]`）、重复键时返回错误。
6. 边界与现有 `parse_fragment_text` 一致：用现有测试夹具核对 `body` 相同。

`src-tauri/src/lib.rs` 测试模块中的集成测试（临时 vault）：

7. 一篇带未知键和注释的公开碎片，依次经过 `update_fragment`、`update_fragment_tags`、`link_fragments_in_vault`、`unlink_fragments_in_vault`、`set_public_fragment_pinned_in_vault`、转为笔记再转回碎片，每一步之后未知键与注释都原样存在，系统字段符合各操作的现有语义。
8. 同样的碎片转入密匣 → 改标签 → 切置顶 → 读取：解密后的载荷里 `frontmatter_raw` 含未知键与注释，`related` 已清空，读取结果与现有行为一致。
9. 一个不带 `frontmatter_raw` 的旧版载荷（按现有写法生成）仍能读取和修改，修改后补上 raw。
10. 故意制造 `apply_frontmatter` 失败的文件（别名引用系统键），调用 `update_fragment` 返回错误且文件字节不变。

### 3.6 验收命令

全部在仓库根目录执行并通过：

| 命令 | 要求 |
| --- | --- |
| `cargo test -p shard-core -p shard` | 全部通过，列出新增测试数 |
| `rustfmt --edition 2021 --check crates/shard-core/src/frontmatter.rs` | 通过 |
| `git diff --check` | 通过 |
| `command grep -n "serde_yaml::to_string" src-tauri/src/lib.rs` | 生产代码（测试模块之前）不再出现 |
| `command grep -n "write_fragment_file(" src-tauri/src/lib.rs` | 生产代码只剩 `write_organized_note`、`create_library_note_in_vault` 两处 |

### 3.7 交付

- 不提交 Git，改动留在 worktree，由 Claude 验收后提交。
- 写报告 `docs/dev/content-model-tasks-log/P0.md`：改动文件与要点、验收命令与结果表（含测试数）、与本施工令的偏差及原因、遗留问题。

## 4. P1 施工令：文件级保存基线、type 合同、密匣边界

前置：P0 已合入本分支（`ba55dc5`）。现状调研要点：只有资料库编辑器（`src/workspace/library-shell.tsx`）会传 `expectedSha`，而且是对正文算的 SHA-256；行内编辑、禅模式、密匣编辑都不带基线。后端只有 `update_fragment` 接收 `expected_sha`，三个分支（公开保存、公开转入密匣、密匣保存）都用 `ensure_expected_content_sha` 对正文比对。Rust 侧没有任何 type 标签识别（`normalize_tags` 只做规范化与排序去重）；CLI 不过滤 type 标签。进密匣的入口都不区分内容类型。

### 4.1 A：文件级保存基线

- Rust `Fragment` DTO（`src-tauri/src/lib.rs`）增加 `file_sha: String`（前端字段名 `fileSha`）：公开条目是磁盘文件完整文本的 SHA-256（小写 hex，用现有 `content_sha256_hex` 对整份文件文本计算）；密匣条目是加密文件完整文本的 SHA-256。构造 `Fragment` 的三处都要填：`read_fragment`、`lockbox_fragment_from_parts`、`search_sources.rs` 的 `markdown_document`。
- `update_fragment` 命令把参数 `expected_sha` 换成 `expected_file_sha: Option<String>`：有值时在拿到 vault 门之后、任何写入之前，与目标文件（公开文件或密匣文件）当前完整文本的哈希比对，不一致返回现有 `STALE_BASE_ERROR`（文案不变）。三个分支都适用。删除对正文哈希的比对（`ensure_expected_content_sha` 若不再有调用方就删掉）。
- 前端 `src/lib/api.ts` 的 `updateFragment` 第 4 个参数改为 `expectedFileSha`；TS `Fragment` 增加 `fileSha?: string`（可选：旧测试 mock 可能没有，缺省时视为没有基线）。
- `library-shell.tsx`：基线直接取 `fileSha`——切换文档取 `selectedNote.fileSha`，保存成功取返回值的 `fileSha`，载入磁盘版后取新 note 的 `fileSha`；删除异步 `sha256Hex` 计算。STALE_BASE 冲突流程（覆盖 / 载入磁盘版）不变。
- **不做**：行内编辑、禅模式、密匣编辑（`FragmentEditor`）接入基线，留到 H2。

### 4.2 B：type 合同

- `crates/shard-core/src/lib.rs` 增加：`TYPE_TAGS = ["note", "outline", "flowchart", "document"]`（顺序即判定优先级，与前端 `deriveKind` 一致）、`PROTECTED_TYPE_TAGS = ["outline", "flowchart"]`、`derive_type(tags) -> Option<&str>`、`normalize_type_tags(tags) -> Vec<String>`（只保留优先级最高的一个 type 标签，其余 type 标签删除，非 type 标签不动）。
- 后端写入规则（`src-tauri/src/lib.rs`）：
  1. `create_fragment`（公开与密匣）：对传入标签做 `normalize_type_tags`；允许 `outline`、`flowchart`（显式创建，如 `/大纲`）。
  2. `update_fragment`、`update_fragment_tags`（公开与密匣）：先 `normalize_type_tags`，再按磁盘上当前文件的 type 执行**受保护规则**——磁盘 type 是 `outline` 或 `flowchart` 时，结果必须保留该 type（缺了补回，其它 type 标签去掉）；磁盘 type 不是这两者时，从传入标签里去掉 `outline`、`flowchart`。`note`、`document` 与缺省碎片之间的现有行为不变。
  3. `crates/shard-cli`：标签含 `outline` 或 `flowchart` 时报错「终端不支持直接创建大纲或流程图。」（与现有密匣拦截同一位置、同一风格）；其余标签经 `normalize_type_tags`。
- 前端 `src/lib/content-kind.ts`：`TYPE_TAGS` 按上面的顺序加入 `flowchart`，显示名「流程图」；新增 `stripProtectedTypeTags(tags, currentKind)`，与后端受保护规则一致。
  - 速记框普通提交（`capture-box.tsx`）与 `FragmentEditor` 保存（`fragment-editor.tsx`）：当前内容不是大纲或流程图时，用它去掉正文 `#outline`、`#flowchart` 提取出的标签。
  - `flowchart` 在 H2 之前没有专属卡片和编辑器：卡片显示「流程图」徽标，正文按普通碎片渲染和编辑；多选、转换菜单等沿用现有 `kind === "fragment"` 判断，自然排除。按 TypeScript 编译错误补齐 `Record<ContentKind, …>` 等穷举位置，不做额外 UI。
  - 搜索的 `markdown_kind` 与搜索契约不改（H3 处理）。

### 4.3 C：密匣边界（只加密 md 文档）

- 后端统一拒绝，错误文案「大纲与流程图不能放入密匣。」：
  1. `create_fragment` 带密匣标签且 type 为 `outline` 或 `flowchart`；
  2. `update_fragment`、`update_fragment_tags` 对磁盘 type 为 `outline` 或 `flowchart` 的公开文件带密匣标签；
  3. `move_fragment_to_lockbox` 目标的 type 为 `outline` 或 `flowchart`。
  拒绝时文件与 Git 状态都不变。已经在密匣里的旧大纲照常可读可改，不迁移。
- 前端：
  - `fragment-card.tsx` 的「移入密匣」菜单项对 `outline`、`flowchart` 不显示；
  - 速记框大纲态提交时，若大纲文字提取出密匣标签，不提交，用现有 toast 提示「大纲不能放入密匣」，草稿保留；
  - `FragmentEditor` 的「将移入密匣 / 将保存到密匣」徽标对 `outline`、`flowchart` 不显示。

### 4.4 必须新增或更新的测试

- Rust：
  - `update_fragment`：只改 frontmatter（例如外部加一个未知键）后用旧 `fileSha` 保存返回 STALE_BASE 且文件不变；用新 `fileSha` 保存成功；密匣分支同样校验；不带基线照常保存。
  - `normalize_type_tags` 与受保护规则：多 type 取最高优先级；普通碎片正文带 `#outline` 保存后仍是普通碎片；大纲保存时丢了 `outline` 会被补回。
  - 三条密匣拒绝路径，拒绝后文件字节与位置不变。
  - `shard-cli` 解析测试：`#outline`、`#flowchart` 报错；`#document #note` 只保留 `note`。
- TS 单元测试：`content-kind.test.ts` 覆盖新的 `TYPE_TAGS` 顺序、`deriveKind` 的流程图、`stripProtectedTypeTags`。
- UI（Playwright）：
  - `tests/ui/library-workspace.spec.ts` 里 STALE_BASE 相关用例改为 `expectedFileSha`、mock 数据带 `fileSha`，覆盖与载入磁盘版两个分支都要通过；
  - 新增：大纲卡片菜单里没有「移入密匣」；速记框大纲态含 `#密匣` 时不提交并提示。

### 4.5 验收命令

先在 worktree 执行 `pnpm install --frozen-lockfile --prefer-offline`。

**Playwright 不能用默认配置**：1420 端口被用户主工作区的 vite 占用，`reuseExistingServer: true` 会让测试跑到主工作区的代码上。复制 `playwright.config.ts` 为 `playwright.worktree.config.ts`（不提交），把 `baseURL`、`webServer.url` 改为 `http://127.0.0.1:1422`，`webServer.command` 改为 `node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 1422 --strictPort`，`reuseExistingServer: false`。

**开工前**先在未改动的代码上跑一遍下面的 UI 用例，把已有失败记为基线；完工后不得新增失败。

| 命令 | 要求 |
| --- | --- |
| `cargo test -p shard-core -p shard -p shard-cli` | 全部通过 |
| `pnpm test:unit` | 全部通过 |
| `pnpm build` | 通过 |
| `pnpm build:markdown && pnpm exec playwright test -c playwright.worktree.config.ts tests/ui/library-workspace.spec.ts tests/ui/content-types.spec.ts tests/ui/lockbox-space.spec.ts tests/ui/rich-composer.spec.ts tests/ui/slash-commands.spec.ts tests/ui/mind-map-outline.spec.ts tests/ui/mind-map-mubu-outline.spec.ts tests/ui/rich-surfaces.spec.ts tests/ui/search-fragment-reveal.spec.ts tests/ui/search-integration.spec.ts` | 相对开工前基线没有新增失败；新增用例全部通过 |
| `rustfmt --edition 2021 --check crates/shard-core/src/frontmatter.rs` 及本批新建的 Rust 文件 | 通过 |
| `git diff --check` | 通过 |

### 4.6 交付

- 不提交 Git；`playwright.worktree.config.ts` 不纳入改动。
- 报告写 `docs/dev/content-model-tasks-log/P1.md`：改动文件与要点、开工前 UI 基线、验收命令与结果（含测试数）、偏差及原因、遗留问题。

## 5. H1 施工令：受管 JSON 区域与后端读写命令

前置：P0、P1 已在本分支。本批只做存储层与后端命令，**不改任何 UI**（打开、编辑、卡片、搜索分别在 H2、H3）。现有可复用：导图 `ShardMapFile`、`validate_mind_map_file`、`canonical_mind_map_text`（`src-tauri/src/lib.rs`）；流程图 `CanvasFile`（`kind = "shard.flow"`）、`validate_file`、`canonical`（`src-tauri/src/canvas_commands.rs`）；frontmatter 保真函数（`crates/shard-core/src/frontmatter.rs`）；P1 的 `fileSha` 与 `STALE_BASE_ERROR`。

### 5.1 区域编解码（Rust：`crates/shard-core/src/graph_region.rs`；TS：`src/lib/graph-region.ts`）

- 两种围栏：大纲 ```` ```shardmap ````，流程图 ```` ```shardflow ````。开围栏行恰好是三个反引号加围栏名（行尾空白可忽略），闭围栏行恰好是三个反引号；两行都在第 0 列。区域内容是 JSON 文本。
- `find_region(body, kind)`：返回区域在 body 中的字节范围与 JSON 文本。没有区域、有多个同名区域、开围栏未闭合，分别返回不同的错误（中文文案，区分三种情况）。同一 body 里同时出现两种围栏也算错误。
- `render_region(kind, json_text)`：生成 ```` ```shardmap\n{json}\n``` ````（JSON 末尾不重复换行）。
- `replace_region(body, kind, json_text)`：只替换区域，区域前后的字节原样保留。
- TS 版提供同样的 `findGraphRegion` / `replaceGraphRegion`，供 H2/H3 使用，规则与 Rust 完全一致；本批只加单元测试，不接 UI。

### 5.2 后端命令（`src-tauri/src/lib.rs`，按现有惯例注册、`async` + 后台线程、拿到 vault 后立刻 `lock_vault_gate`；内容写入只落盘，不内嵌 Git 提交）

1. `create_graph_fragment(kind, operation_id, graph, tags)`：`kind` 为 `outline` 或 `flowchart`。
   - 在 `fragments/YYYY/MM/<id>.md` 新建一篇 md（路径与 id 规则同 `create_public_fragment_in_vault`，需要时在 shard-core 增加可指定 id 的最小变体）；标签经现有规范化并带上对应 type 标签；密匣标签按 P1 规则拒绝。
   - 大纲：`graph` 必填，是 `ShardMapFile` JSON；后端把 `id` 设为碎片 id，补齐 `kind`、`schemaVersion`、`savedWithAppVersion`、`revision`、时间戳，按 `validate_mind_map_file` 校验（节点上限 400，超限报错，不截断），用 `canonical_mind_map_text` 的格式写入区域。
   - 流程图：`graph` 可空；为空时生成空流程图（字段与现有新建流程图一致，`nodes`、`edges` 为空，标题「未命名流程图」），非空时同样设置 id 并按 `validate_file` 校验。
   - **幂等**：`operation_id` 必填。进程内记录「操作 ID → 碎片 id」（有界，例如最近 256 条）；同一操作 ID 重试时返回已创建的条目，不重复建文件；同一操作 ID 但 `kind` 不同则报错。
   - 返回 `{ fragment, graph }`，`fragment` 带 P1 的 `fileSha`。
2. `read_graph_fragment(id)`：读取公开碎片，要求 type 是 `outline` 或 `flowchart` 且正文恰好有一个对应区域；解析并校验 JSON 后返回 `{ fragment, graph }`。区域缺失、多个或无法解析时返回明确错误，不生成空图。
3. `write_graph_fragment(id, graph, expected_file_sha)`：
   - 拿门后读当前完整文件，`expected_file_sha` 有值且不一致返回 `STALE_BASE_ERROR`，文件不变。
   - 校验 `graph` 的 id 与碎片 id 一致、类型与碎片 type 一致，再按对应校验函数校验；导图 `revision` 在写入时加 1，`updatedAt` 更新。
   - 只替换区域：区域外的正文字节、frontmatter 中未涉及的内容都保持不变；frontmatter 只通过 `apply_frontmatter` 更新 `updated_at`。
   - 原子写入，返回 `{ fragment, graph }`（新的 `fileSha`）。
4. **保护区域不被文本保存覆盖**：`update_fragment` 对正文含受管区域（`find_region` 找到任一种区域，或报「多个」「未闭合」）的公开碎片直接返回错误「大纲与流程图请在专用编辑器中保存。」，文件不变。`update_fragment_tags`、置顶、关联这类只改 frontmatter 的操作照常可用。现有纯缩进列表的旧大纲不含区域，行为不变。
5. 前端 `src/lib/api.ts` 增加三个命令的类型化封装（`createGraphFragment`、`readGraphFragment`、`writeGraphFragment`），本批没有 UI 调用方。

### 5.3 必须新增的测试

- Rust `graph_region`：两种围栏的查找与替换；区域前后有额外正文时逐字节保留；无区域、多个区域、两种围栏并存、未闭合分别报对应错误；闭围栏必须在第 0 列。
- Rust 集成测试（临时 vault）：
  1. 创建大纲：文件位置、frontmatter 带 `outline` 与 `inbox`、正文恰好一个区域、JSON 的 id 等于碎片 id、`read_graph_fragment` 读回一致。
  2. 创建空流程图，读回后通过 `validate_file`。
  3. 同一 `operation_id` 连续创建两次只产生一个文件、返回同一 id。
  4. 在 frontmatter 加未知键并在区域前后加额外正文后，用正确 `fileSha` 调 `write_graph_fragment`：只有区域和 `updated_at` 变化，其余字节不变；返回新 `fileSha`。
  5. 用旧 `fileSha` 写入返回 STALE_BASE，文件字节不变。
  6. 超过 400 节点的大纲创建与写入都报错且不产生或改动文件。
  7. `update_fragment` 对含区域的碎片报错且文件不变；对旧式缩进列表大纲照常保存。
  8. 创建时带密匣标签被拒绝。
- TS 单元测试：`src/lib/graph-region.test.ts` 覆盖与 Rust 相同的查找、替换与错误情形。

### 5.4 验收命令

| 命令 | 要求 |
| --- | --- |
| `cargo test -p shard-core -p shard -p shard-cli` | 全部通过 |
| `pnpm test:unit` | 除两项既有失败外全部通过：`roundtrip.test.ts` 的 golden 目录检查（`.gitignore` 全局忽略 `*.md` 导致夹具未入库）、`quick-open-perf.test.ts`（并行负载波动，需单独复跑通过） |
| `pnpm build` | 通过 |
| `rustfmt --edition 2021 --check crates/shard-core/src/frontmatter.rs crates/shard-core/src/graph_region.rs` | 通过 |
| `git diff --check` | 通过 |

本批不改 UI，不需要跑 Playwright。

### 5.5 交付

- 不提交 Git。报告写 `docs/dev/content-model-tasks-log/H1.md`（该目录被 `.gitignore` 的 `docs/dev/*` 覆盖，写文件即可，由验收方 `git add -f`）：改动文件与要点、验收命令与结果、偏差及原因、遗留问题。
