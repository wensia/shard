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
| **H1** | 受管 JSON 区域编解码（Rust + TS）与后端读写命令：幂等创建（稳定操作 ID）、读取、只替换区域的原子写、完整文件基线 | P1 | 已完成，施工令见 §5 |
| **H2** | 大纲端到端：`/大纲` 提交创建 JSON 大纲（用编辑会话里的树，上限 400 节点，超限报错不截断）；打开大纲进入禅模式外壳中的现有导图编辑器（大纲/导图两视图）；卡片、搜索标题、快速打开识别 JSON 大纲；`FragmentEditor` 接入文件级基线；修正 H1 保护条件 | H1 | 已完成，施工令见 §6 |
| **H2b** | 流程图端到端：`/流程图` 创建；`CanvasWorkspace` 存储适配后在禅模式外壳中打开；流程图卡片 | H2 | 已完成，施工令见 §7 |
| **H3** | 时间线按类型筛选；后端搜索的图内容投影、标题与 kind 修正（不索引 JSON 键名、坐标、ID） | H2b | 已完成，施工令见 §8 |
| **H4a** | 旧格式 md 大纲批量升级：正式导入器（Rust）、预检报告、必须成功的检查点或独立备份、逐篇原子升级；加固偏重 UI 用例 | H3 | 已完成，施工令见 §9 |
| **H4b** | 资料库独立 `.shardmap.json`/`.shardflow.json` 显式加入时间线（沿用旧图 id 作为碎片 id，原文件移入回收站）；`shard://map|flow/<id>` 与节点引用找不到独立文件时回退到同 id 碎片 | H4a | 已完成，施工令见 §10 |
| H4c | CLI 原生 JSON 读写、缩进列表只读导出、按节点 id 修改（需把图模型与校验移入 shard-core） | H4b | 待细化 |
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

## 6. H2 施工令：大纲端到端

前置：P0、P1、H1 已在本分支。本批只做**大纲**；流程图在 H2b。旧式缩进列表大纲（正文没有 ```` ```shardmap ```` 区域）在 H4 迁移前保持现有全部行为（行内幕布编辑、禅模式只读导图、`update_fragment` 保存），本批不得破坏。下文「JSON 大纲」指 type 为 `outline` 且正文恰好有一个 `shardmap` 区域的碎片。

现状要点（调研结论，行号以当前分支为准）：
- 速记框大纲态的树只存在于 `MindMapFenceWidget` 内部会话，外部只拿到缩进文本；`capture-box.tsx` 提交时再用 `parseMindMapOutline` 解析，超过 200 节点会**静默截断**后提交。
- 可编辑的两视图导图只有 `MindMapCanvas`（`mind-map-workspace.tsx`），按 `mapId` 通过 `readMindMap` / `writeMindMap(expectedRevision, lastSavedHash)` 读写独立 `.shardmap.json`；有排空式保存、1200ms 自动保存、组合输入保护、撤销栈、冲突条（「冲突副本」错误触发）。挂载在 `workbench-shell`（`MindMapWorkspace`）与 `library-shell`。
- 禅模式外壳是通用的 `ZenSurface`；`FragmentEditor` 在其中按 kind 切换编辑面；大纲的禅模式导图视图目前只读。
- 卡片 `OutlineCardBody`、`search-provider.ts`、`quick-open-catalog.ts`、`fragment-editor.tsx` 都按缩进列表解析大纲。
- `FragmentEditor` 保存不带基线，`onSave` 返回值被丢弃，catch 只 toast。

### 6.1 修正 H1 保护条件（后端）

`update_public_fragment_in_vault` 里「正文含受管区域就拒绝」改为：**磁盘 type 为 `outline` 或 `flowchart`，且正文含对应区域（或该区域报多个/未闭合）时**才拒绝。普通碎片正文里即使粘贴了 ```` ```shardmap ```` 行也照常保存。补一条 Rust 测试覆盖后者。

### 6.2 大纲数据辅助（TS）

在 `src/lib/mind-map-outline.ts`（或同目录新文件）提供 `readOutlineContent(content)`：正文有 `shardmap` 区域时解析 JSON 返回 `{ format: "json", file }`；否则按旧逻辑返回 `{ format: "legacy", file, truncated }`；都失败返回 `null`。卡片、`search-provider.ts`、`quick-open-catalog.ts`、`fragment-editor.tsx` 中按缩进列表解析大纲的地方都改用它，JSON 大纲的标题取根节点文字。

### 6.3 速记框 `/大纲` 提交

- `MindMapFenceWidget` 与 `OutlineComposer` 增加可选回调，把会话中的 `ShardMapFile` 同步给宿主（现有文本回调保留，其他使用方不受影响）。
- `capture-box.tsx` 的大纲提交改为：用会话里的 `ShardMapFile`（不再从文本重新解析）；节点数超过 400 时不提交，toast「大纲最多 400 个节点」并保留草稿；标签仍从序列化文本提取并做现有处理，含密匣标签照旧拦截；调用 `createGraphFragment("outline", operationId, file, tags)`。
- `operationId` 用 `crypto.randomUUID()`，同一份草稿的重试沿用同一个 ID，成功或退出大纲态后重置。
- `workbench-shell.tsx` 增加对应的创建处理：把返回的 `fragment` 按现有 `handleCreate` 的方式插入时间线、滚动与动效；失败时 toast 并保留大纲态草稿。大纲提交不再调用 `create_fragment`。

### 6.4 两视图编辑器的存储适配

- `MindMapCanvas` 增加可选 `storage` 适配器（读取、写入、冲突判定、保存后通知），**默认实现就是现有的 `readMindMap` / `writeMindMap` / `listMindMaps` 行为**，资料库与独立导图的现有调用方不改参数、行为不变。
- 增加可选 `initialView`（默认仍为 `"map"`）。
- 碎片适配器：读取用 `readGraphFragment(id)`，基线是返回的 `fragment.fileSha`；写入用 `writeGraphFragment(id, draft, fileSha)`，成功后以返回的 `graph` 与 `fileSha` 更新基线，并把返回的 `fragment` 交给宿主更新时间线；`STALE_BASE` 错误进入现有冲突条——「保留我的版本」先重新读取拿最新 `fileSha` 再写入，「保留磁盘版本」重新载入。碎片模式下不调用 `listMindMaps`。排空保存、自动保存、组合输入保护、撤销栈全部沿用。

### 6.5 打开 JSON 大纲

- `workbench-shell.tsx`：卡片菜单的「编辑」「禅模式」、以及搜索结果打开碎片的路径（`search-target-router.ts` 相关处理），遇到 JSON 大纲时打开图形编辑宿主——`ZenSurface` 里挂 `MindMapCanvas`（碎片适配器，`initialView="outline"`），不进入 `FragmentEditor`。不新建全屏外壳组件，复用 `ZenSurface`。
- 关闭（Esc、关闭按钮、切换空间或打开别的内容前）先排空保存，沿用现有 `saveLibraryDraftBeforeNavigation` 一类的排空入口；保存失败时不关闭并提示。
- 卡片 `OutlineCardBody`：JSON 大纲用 `readOutlineContent` 的结果渲染缩略导图与根节点标题，外观与现有大纲卡片一致。

### 6.6 `FragmentEditor` 文件级基线

- `onSave` 增加第 4 个参数 `expectedFileSha`，调用链 `fragment-editor.tsx` → `fragment-card.tsx` → `fragment-timeline.tsx` → `workbench-shell.tsx`（含全局禅模式、密匣时间线）一并透传；`handleUpdateFragment` 已支持。
- 基线取 `fragment.fileSha`；保存成功后用 `onSave` 返回的 fragment 更新基线；编辑器干净时随刷新更新基线，有未保存草稿时保留旧基线（与 `library-shell.tsx` 的 P1 做法一致）。
- `STALE_BASE` 时沿用 `library-shell.tsx` 的冲突处理方式与文案（覆盖 = 清空基线后重存；载入磁盘版 = 放弃草稿并刷新），期间停止自动保存重试，不重复弹出 toast。
- 卡片任务勾选（`handleToggleFragmentTask`）本批不改。

### 6.7 测试

- Rust：6.1 的普通碎片保存用例。
- TS 单元：`readOutlineContent` 覆盖 JSON、旧式列表、截断标记、非法 JSON。
- UI（mock 中为 `create_graph_fragment`、`read_graph_fragment`、`write_graph_fragment` 增加处理，样本带 `fileSha`；所有会走到新路径的 spec 的 mock 都要补）：
  1. `/大纲` 提交调用 `create_graph_fragment`（带会话树与标签），不再调用 `create_fragment`；新卡片出现在时间线。
  2. 超过 400 节点的大纲不提交、提示并保留草稿；201–400 节点完整提交，不截断。
  3. JSON 大纲卡片显示根节点标题与缩略导图。
  4. 从卡片「编辑」打开 JSON 大纲进入禅模式外壳，默认幕布视图，可切到导图；修改后自动保存调用 `write_graph_fragment` 且带 `expectedFileSha`；Esc 关闭前排空保存。
  5. 图形编辑器收到 STALE_BASE 时出现冲突条，两种选择各自生效。
  6. `FragmentEditor`（禅模式普通碎片）保存带 `expectedFileSha`；STALE_BASE 时按 6.6 处理。
  7. 旧式缩进列表大纲的行内编辑、禅模式行为不变（现有用例全部通过）。
- 现有 `mind-map-workspace.spec.ts`、`mind-map-outline.spec.ts`、`mind-map-mubu-outline.spec.ts` 必须全部通过，证明默认适配器行为不变。

### 6.8 验收命令

沿用 §4.5 的 `playwright.worktree.config.ts`（1422，不提交）。开工前先跑一遍下表的 UI 用例记录基线。

| 命令 | 要求 |
| --- | --- |
| `cargo test -p shard-core -p shard -p shard-cli` | 全部通过 |
| `pnpm test:unit` | 除 golden 夹具那一项既有失败外全部通过（quick-open 性能若在全套中波动须单独复跑通过） |
| `pnpm build` | 通过 |
| `pnpm build:markdown && pnpm exec playwright test -c playwright.worktree.config.ts tests/ui/content-types.spec.ts tests/ui/rich-surfaces.spec.ts tests/ui/rich-composer.spec.ts tests/ui/slash-commands.spec.ts tests/ui/library-workspace.spec.ts tests/ui/lockbox-space.spec.ts tests/ui/mind-map-fence.spec.ts tests/ui/mind-map-workspace.spec.ts tests/ui/mind-map-outline.spec.ts tests/ui/mind-map-mubu-outline.spec.ts tests/ui/search-fragment-reveal.spec.ts tests/ui/search-editor-reveal.spec.ts tests/ui/search-integration.spec.ts` | 相对基线没有新增失败；新增用例全部通过 |
| `rustfmt --edition 2021 --check crates/shard-core/src/frontmatter.rs crates/shard-core/src/graph_region.rs` | 通过 |
| `git diff --check` | 通过 |

UI 改动遵守 AGENTS.md 与 `vendor/kiln`：不新增视觉样式，冲突条、toast、按钮复用现有组件与文案风格。

### 6.9 交付

不提交 Git；测试改写的 `tests/evidence` 图片结束前恢复。报告写 `docs/dev/content-model-tasks-log/H2.md`：改动文件与要点、开工前 UI 基线、验收结果（含测试数）、偏差及原因、遗留问题。

## 7. H2b 施工令：流程图端到端

前置：P0–H2 已在本分支。「JSON 流程图」指 type 为 `flowchart` 且正文恰好有一个 `shardflow` 区域的碎片。本批的做法与 H2 的大纲一一对应，能照搬 H2 的结构就照搬（宿主状态、打开入口、排空保存、搜索打开、时间线回灌、mock 写法）。

现状要点：`CanvasWorkspace`（`src/features/canvas/canvas-workspace.tsx`）按 `path` 读写，加载用 `readCanvas(path)`，保存经 `CanvasSaveQueue`，它通过注入的 transport（`CanvasSaveTransport = (request: { path, file, expectedRevision, lastSavedHash }) => Promise<CanvasReadResult>`）写入，并校验返回的 path、id、createdAt 与 `revision === expected + 1`；保存失败时的恢复入口是「另存流程图副本」（`recoverAsCopy`，会在资料库父目录新建文件）；旧格式有 `splitLegacy`。它只挂在资料库，没有禅模式。

### 7.0 先加固 H2 的偶发用例

`tests/ui/rich-surfaces.spec.ts` 中「JSON 大纲从卡片编辑进入图形禅模式……」在并行负载下偶发失败、重试通过。改为等待可观察条件（例如 mock 里记录到 `write_graph_fragment` 调用、保存状态文字变化），不依赖固定延时；不改业务代码。

### 7.1 `/流程图` 宿主命令

- 在斜杠命令体系中新增内容类型命令「流程图」，与 `/大纲`、`/文档` 同级，只在速记框出现（与现有宿主命令一样按宿主是否提供回调过滤）。需要改的位置：`src/lib/slash-commands.ts`（命令 id、命令表、`isContentTypeSlashCommand`）、`src/editor-rich/commands.ts`（命令 id 集合、`ShardRichHostCommands` 增加回调、分派）、`src/editor-rich/extensions/slash-suggestion.ts`（把现在「是 outline 就看 onEnterOutline，否则看 onMarkDocument」的二选一改为按命令逐一对应回调）、`src/editor-rich/ShardRichEditor.tsx`（props、回调 ref、`hostCommands`）。`content-kind.ts` 补 `FLOWCHART_TYPE_TAG`。
- 速记框行为：选中 `/流程图` 后立即调用 `createGraphFragment("flowchart", operationId, null, tags)` 新建空流程图，标签为 `["inbox"]` 经现有规范化；速记框里已有的草稿文字保留不动（只去掉斜杠命令本身）；创建成功后把新碎片插入时间线，并直接打开流程图编辑宿主（与 `/文档` 提交后直接进禅模式的体验一致）；失败时 toast，不改动草稿。
- 同步更新写死命令数量或顺序的测试：`src/lib/slash-commands.test.ts`、`tests/ui/rich-composer.spec.ts`、`tests/ui/slash-commands.spec.ts`、`tests/ui/content-types.spec.ts`（`/大纲` 候选数）等。

### 7.2 `CanvasWorkspace` 存储适配

- 增加可选的 IO 注入（读取函数与 `CanvasSaveTransport`），**默认就是现有 `readCanvas` / `writeCanvas`**，资料库调用方与现有 canvas 用例行为不变。
- 碎片 IO：读取用 `readGraphFragment(id)`，组装成 `CanvasReadResult` 形状——`path` 用碎片的 `path`（保持稳定，满足保存队列校验），`file` 是区域里的 `CanvasFile`，`lastSavedHash` 用 `fragment.fileSha`。写入 transport 用 `writeGraphFragment(id, request.file, request.lastSavedHash)`，同样组装返回；后端写入会把 revision 加 1、保留 createdAt，保存队列现有校验不改。每次读写返回的 `fragment` 交给宿主回灌时间线。
- 碎片模式下隐藏「另存流程图副本」和旧格式拆分入口。保存返回 `STALE_BASE` 时，用现有按钮组件提供两个选择：「保留我的版本」（重新读取拿最新 `fileSha` 后用当前草稿写入）、「载入磁盘版本」（放弃草稿重新载入）。文案风格与大纲冲突条一致。
- 节点引用（`fragments`、`onOpenLink`）：宿主传入当前碎片列表；打开引用时先排空保存再导航，沿用 H2 大纲宿主的做法。

### 7.3 打开 JSON 流程图与卡片

- `workbench-shell.tsx`：卡片「编辑」「禅模式」、搜索结果打开遇到 JSON 流程图时，打开流程图编辑宿主——`ZenSurface` 包 `CanvasWorkspace`（碎片 IO）。关闭前排空保存，失败不关闭并提示；纳入 `saveLibraryDraftBeforeNavigation` 等排空入口。`FragmentEditor` 不再承载 JSON 流程图。
- 卡片：新增流程图卡片正文——标题取 JSON 的 `title`，下面一行显示节点数与连线数（例如「6 个节点 · 5 条连线」）；复用现有卡片排版与 token，不新增视觉样式。解析失败时退回显示原正文。
- 在 `src/lib/` 增加 `readFlowchartContent(content)`（与 `readOutlineContent` 对应）；`search-provider.ts`、`quick-open-catalog.ts` 中流程图的标题改用 JSON 的 `title`。

### 7.4 测试

- TS 单元：`readFlowchartContent`；斜杠命令表更新后的顺序与过滤。
- UI（mock 补 `flowchart` 分支，样本带 `fileSha`）：
  1. 速记框 `/流程图` 调用 `create_graph_fragment`（kind 为 flowchart、graph 为 null），新卡片出现并直接打开流程图宿主；速记框原草稿保留。
  2. 流程图卡片显示标题与节点/连线计数。
  3. 从卡片「编辑」打开 JSON 流程图进入禅模式宿主；修改后保存调用 `write_graph_fragment` 且带基线；Esc 关闭前排空。
  4. 流程图保存遇到 STALE_BASE 时出现两个选择，各自生效；碎片模式下没有「另存流程图副本」。
  5. 行内编辑与禅模式对普通碎片、文档、大纲的现有行为不变。
- 现有 canvas 用例（`canvas-*.spec.ts`）全部通过，证明默认 IO 行为不变。

### 7.5 验收命令

沿用 `playwright.worktree.config.ts`（1422，不提交），开工前先跑一遍下表 UI 用例记录基线。

| 命令 | 要求 |
| --- | --- |
| `cargo test -p shard-core -p shard -p shard-cli` | 全部通过 |
| `pnpm test:unit` | 除 golden 夹具那一项既有失败外全部通过（quick-open 性能若在全套中波动须单独复跑通过） |
| `pnpm build` | 通过 |
| `pnpm build:markdown && pnpm exec playwright test -c playwright.worktree.config.ts tests/ui/content-types.spec.ts tests/ui/rich-surfaces.spec.ts tests/ui/rich-composer.spec.ts tests/ui/slash-commands.spec.ts tests/ui/canvas-workspace.spec.ts tests/ui/canvas-inspector.spec.ts tests/ui/canvas-keyboard.spec.ts tests/ui/canvas-multidrag.spec.ts tests/ui/canvas-polish.spec.ts tests/ui/canvas-recovery.spec.ts tests/ui/canvas-text-center.spec.ts tests/ui/mind-map-workspace.spec.ts tests/ui/search-fragment-reveal.spec.ts tests/ui/search-editor-reveal.spec.ts tests/ui/search-integration.spec.ts` | 相对基线没有新增失败；新增用例全部通过；对偶发项用 `--workers=1` 单独复跑并在报告中注明 |
| `rustfmt --edition 2021 --check crates/shard-core/src/frontmatter.rs crates/shard-core/src/graph_region.rs` | 通过 |
| `git diff --check` | 通过 |

UI 改动遵守 AGENTS.md 与 `vendor/kiln`，复用现有组件与 token。

### 7.6 交付

不提交 Git；测试改写的 `tests/evidence` 图片结束前恢复。报告写 `docs/dev/content-model-tasks-log/H2b.md`：改动文件与要点、开工前 UI 基线、验收结果（含测试数与偶发项复跑）、偏差及原因、遗留问题。

## 8. H3 施工令：搜索投影与类型筛选

前置：P0–H2b 已在本分支。调研结论（行号以当前分支为准）：

- 后端 `src-tauri/src/search_sources.rs` 的 `markdown_kind`（约 1122 行）只认 note / outline / document，**带 `flowchart` 标签的 md 被判成 `Fragment`**。
- `markdown_title`（约 1134 行）对大纲取首个非空行、其他类型也取首行。JSON 大纲和 JSON 流程图正文的首行是 ```` ```shardmap ```` / ```` ```shardflow ````，**搜索结果的标题就显示成这一行**。
- `markdown_document` 把正文原样交给通用 Markdown 投影（`crates/shard-core/src/search/projection.rs`），围栏内的整段 JSON（`kind`、`id`、`sortKey`、时间戳、坐标）都进入可搜索文本（DocumentOnly 块）。
- 独立 `.shardmap.json` 用 `mind_map_search_text`（只取节点 `text`），`.shardflow.json` 用 `canvas_commands::search_text`（节点文字、内嵌导图标题与节点、连线 `label`）。
- `read_search_document_from_disk`（约 778 行）的白名单只允许 Fragment / Note / Outline / Document。
- SQLite 派生索引（`src-tauri/src/search_index.rs`）缓存了标题与投影块；只改投影代码、文件内容不变时缓存**不会**失效。`INDEX_FORMAT` 变化会触发删库重建。
- 契约 `SearchKind` 在 Rust 与 TS 两侧都已有 `flowchart`，搜索面板已有流程图图标和标签。
- 时间线筛选 `FragmentFilters` 只有 tag / month / pinned，没有类型维度（`src/lib/fragment-space.ts`、`src/components/shard/fragment-workspace-controls.tsx`）。

### 8.0 加固 H2b 的偶发用例

`tests/ui/rich-surfaces.spec.ts` 中「流程图碎片冲突可载入磁盘版本」在高负载并行下失败、串行通过。改为等待可观察条件，不依赖固定延时；不改业务代码。

### 8.1 后端：md 的类型与标题

- `markdown_kind` 改用 `shard_core::derive_type` 判定，优先级与 `TYPE_TAGS` 一致（note > outline > flowchart > document），加入 `Flowchart`。公开与密匣两条 md 路径都用同一函数。
- `markdown_title`：
  - JSON 大纲：根节点文字（`nodes[rootId].text`），为空时「未命名大纲」；
  - JSON 流程图：JSON 的 `title`，为空时「未命名流程图」；
  - 旧式缩进列表大纲与其它类型保持现有规则。
  - 区域用 `crates/shard-core/src/graph_region.rs` 的 `find_region` 识别；区域缺失、多个或 JSON 无法解析时退回现有规则，不报错、不丢结果。

### 8.2 后端：图内容投影

- JSON 大纲与 JSON 流程图的 md 不再把正文交给通用 Markdown 投影，而是生成图内容投影：
  - 大纲：每个节点的 `text` 与 `note`；
  - 流程图：复用 `canvas_commands::search_text` 的抽取规则（节点文字、连线标签、内嵌导图标题与节点）；
  - 不含任何 JSON 键名、id、`sortKey`、时间戳、坐标。
- 投影块用 DocumentOnly（卡片与编辑器都没有可高亮的正文），命中后按现有 `map_hit` 规则给出 `documentOnly`，前端直接打开对应宿主（H2/H2b 已接好）。
- 保留 md 的标签、`objectId`（碎片 id）、`path`、`updatedAt` 等元数据，标签搜索照常可用。
- 区域缺失或无法解析时退回通用 Markdown 投影（与现在一致）。
- `read_search_document_from_disk` 的白名单对 `.md` 路径加入 `Flowchart`；`validate_loaded_identity` 等按 kind 比对的逻辑随之一致。
- 把 `INDEX_FORMAT` 升为 `search-projection-assets-v3`，让已有缓存在升级后重建。同步更新被忽略的 5k 基准里按 kind 计数的断言，使其认得流程图。

### 8.3 前端

- `src/lib/fragment-search.ts` 的旧提供者（`markdownToSearchText`）对 JSON 大纲与流程图改用节点文字（经 `readOutlineContent` / `readFlowchartContent`），不再索引 JSON 原文。
- `tests/ui/search-ipc-mock.ts` 的 `kindOf` 与 `titleOf` 跟后端规则对齐（认得流程图，JSON 标题同 8.1）。
- **时间线按类型筛选**：
  - `FragmentFilters` 增加 `kind`（全部、碎片、大纲、流程图、文档）；`matchesFragmentFilters` 按 `deriveKind` 过滤；筛选对话框增加一组类型选项，复用对话框里现有控件与 Kiln token，不新增视觉样式。
  - 激活的类型筛选与现有筛选一样显示在筛选状态里，可清除。
  - 筛选只影响碎片空间时间线，不改路由。

### 8.4 测试

- Rust（`search_sources.rs` 测试模块）：
  - JSON 大纲 md：kind 为 Outline，标题是根节点文字，节点文字与备注可被搜到，`schemaVersion`、`sortKey`、节点 id 搜不到；
  - JSON 流程图 md：kind 为 Flowchart，标题是 JSON `title`，节点文字与连线标签可被搜到，坐标与 id 搜不到；
  - 旧式缩进列表大纲的 kind、标题、投影与现在一致；
  - 带多个 type 标签的 md 按优先级判定；
  - 区域损坏时退回通用投影且结果不丢。
- TS 单元：`fragment-search.ts` 对两种图碎片的文本；`fragment-space.ts` 的类型筛选。
- UI：时间线按类型筛选（选中「流程图」只剩流程图卡片，清除后恢复）；搜索 mock 下流程图结果显示 JSON 标题并打开流程图宿主。

### 8.5 验收命令

沿用 `playwright.worktree.config.ts`（1422，不提交），开工前先跑一遍下表 UI 用例记录基线。本机负载可能很高，偶发失败一律用 `--workers=1 --retries=0` 单独复跑并在报告中注明。

| 命令 | 要求 |
| --- | --- |
| `cargo test -p shard-core -p shard -p shard-cli` | 全部通过 |
| `pnpm test:unit` | 除 golden 夹具那一项既有失败外全部通过（quick-open 性能若波动须单独复跑，并确认「参考结果对照」那项通过） |
| `pnpm build` | 通过 |
| `pnpm build:markdown && pnpm exec playwright test -c playwright.worktree.config.ts tests/ui/search-editor-reveal.spec.ts tests/ui/search-fragment-reveal.spec.ts tests/ui/search-integration.spec.ts tests/ui/search-ipc.spec.ts tests/ui/search-navigation.spec.ts tests/ui/search-palette.spec.ts tests/ui/search-scope.spec.ts tests/ui/content-types.spec.ts tests/ui/rich-surfaces.spec.ts tests/ui/fragment-masonry.spec.ts tests/ui/fragment-create-motion.spec.ts tests/ui/organize-fragments.spec.ts tests/ui/wikilink.spec.ts` | 相对基线没有新增失败；新增用例全部通过 |
| `rustfmt --edition 2021 --check crates/shard-core/src/frontmatter.rs crates/shard-core/src/graph_region.rs` | 通过 |
| `git diff --check` | 通过 |

### 8.6 交付

不提交 Git；测试改写的 `tests/evidence` 图片结束前恢复。报告写 `docs/dev/content-model-tasks-log/H3.md`：改动文件与要点、开工前 UI 基线、验收结果（含测试数与偶发项复跑）、偏差及原因、遗留问题。

## 9. H4a 施工令：旧格式 md 大纲升级

前置：P0–H3 已在本分支。「旧格式大纲」指 type 为 `outline`、正文没有 `shardmap` 区域的公开碎片（`find_region` 返回「没有区域」）。区域损坏（多个、未闭合、JSON 非法）的不属于本批，保持现状。

现状要点：
- 前端 `parseMindMapOutline`（`src/lib/mind-map-outline.ts`）：认 `- * + 1. 1)` 列表项，Tab 按 4 列；首个非列表行在没有根时当根文本，其余非列表行（段落、引用、续行、围栏行、表格）一律丢弃；不跟踪代码块；每个节点只取标记所在行；已有根之后的顶层项挂到根下；200 节点截断；行内 Markdown 原样作为节点文字。
- 旧格式在行内/禅模式里每次编辑都会整篇重新序列化，上述内容会被丢掉——这是现存的数据丢失路径，本批不改它，但升级后就不再经过它。
- Rust 没有缩进列表解析；`validate_mind_map_file` 要求标题非空、节点 ≤ 400、节点文字 ≤ 2000 字、同父 sortKey 不重复、无环、全可达；前端 `validateCanvasFile` 另要求 sortKey 为 `[0-9A-Za-z]+`、日期符合格式。
- `checkpoint_vault_locked` 返回 `not_git` / `blocked` / `no_changes` / `committed` 或 `Err`；`checkpoint_before_structural_locked` 只打日志。

### 9.1 正式导入器（Rust，`crates/shard-core/src/outline_import.rs`）

- 输入旧大纲正文，输出树（节点 id、父 id、sortKey、文字）与一份**损失报告**。树结构规则与前端 `parseMindMapOutline` 完全一致（同样的列表项识别、缩进折算、根的确定、顶层项挂到根下），但**不做 200 截断**。
- 生成的节点 id 用 `n0`、`n1`… 递增，sortKey 为只含 `[0-9A-Za-z]` 的有序字符串，保证同时通过 Rust 与前端校验。
- 损失报告逐项计数并给出前几条样例：被丢弃的非列表行（首个根行除外）、续行、代码围栏、超过 2000 字的节点文字。没有任何损失时判为「无损」。
- 判为「无法升级」的情形：根文字为空、节点数超过 400、没有任何有效行。
- 单元测试覆盖上述每条规则，并用一组与前端 `mind-map-outline.test.ts` 相同的输入断言树结构一致。

### 9.2 后端命令（`src-tauri/src/lib.rs`，按惯例注册，async + 后台线程）

1. `preflight_outline_upgrade()`：只读，不持写门。扫描 `fragments/`（不含回收站、密匣）中的旧格式大纲，逐篇运行导入器，返回列表：`{ id, path, title, fileSha, nodeCount, status: "lossless" | "lossy" | "blocked", issues }`。
2. `run_outline_upgrade(items: [{ id, fileSha }])`：
   - 拿写门。**先确保可恢复**：Git 库调用检查点，只有 `committed` 或 `no_changes` 才继续，`blocked` 或错误直接返回错误、不改任何文件；非 Git 库先把每篇原文件完整复制到 `.shard/backups/outline-upgrade/<时间戳>/<原相对路径>`，任一复制失败就中止。新增一个「要求成功」的检查点辅助函数，不改 `checkpoint_before_structural_locked` 的现有行为。
   - 逐篇处理，互不影响：重新读取并比对 `fileSha`，不一致跳过并报告「已被修改」；重新运行导入器，`blocked` 跳过；生成 `ShardMapFile`（`id` 等于碎片 id，`createdAt` 取 frontmatter 的 `created_at`，`title` 为根文字，`revision` 1），用 `validate_mind_map_file` 校验；正文整体换成 `render_region(Outline, canonical JSON)`，frontmatter 用 `apply_frontmatter` 只更新 `updated_at`（id、标签、其他属性原样保留）；原子写入。
   - 全部处理完后对成功升级的路径做一次路径级语义提交（「升级旧格式大纲」），沿用现有 `commit_paths_if_git` 一类函数；非 Git 库跳过。
   - 返回每篇结果：`upgraded` / `skipped`（原因）/ `failed`（原因），以及备份位置或检查点结果。
3. 调用方选择的条目必须来自预检结果；`lossy` 只有前端明确勾选「包含有损项」时才会被传入，后端不做额外判断，但返回结果里保留损失摘要。

### 9.3 前端

- **提示**：碎片空间时间线上方的上下文条插槽（`fragments-workspace.tsx` 的 `filterContext`，与筛选状态条同一位置和样式）在当前库存在旧格式大纲时显示一条提示：「有 N 篇旧格式大纲，升级后可用导图编辑」，按钮「查看并升级」「暂不」。旧格式判定直接用已加载碎片的 `readOutlineContent(...).format === "legacy"`，不为此额外扫盘。「暂不」按库记在 localStorage（键带 vault 路径），数量增加时重新出现。筛选状态条与该提示同时存在时两者都要能显示。
- **升级对话框**：复用现有对话框组件与 `ConvertFragmentDialog` 的结构。打开时调用预检；列出三组（可无损升级、有损、无法升级），有损项显示损失摘要，无法升级项显示原因；「包含有损项」复选框默认不勾；主按钮「升级 N 篇」；执行中显示进度与 `aria-busy`；完成后在对话框内显示结果汇总（成功、跳过、失败及原因、备份位置或「已先保存 Git 检查点」），并刷新碎片列表。检查点被阻塞或备份失败时显示错误，不做任何升级。
- **单篇入口**：旧格式大纲的编辑面（`FragmentEditor` 的大纲面，行内与禅模式）顶部加一行提示「旧格式大纲，升级后可用导图编辑」与按钮「升级」，打开同一个对话框并只预选这一篇。旧格式大纲**仍然可以编辑**（不改为只读）。
- 升级完成后，已打开的该篇旧编辑器要关闭或切到新的图形宿主，不能再用旧会话写回。

### 9.4 加固偏重 UI 用例

以下本分支新增的用例在高负载并行下偶发失败、串行通过：`content-types.spec.ts`「超过 400 节点时拦截提交…」、`rich-surfaces.spec.ts` 中 JSON 大纲与流程图禅模式、冲突相关的用例。给它们标 `test.slow()`，并把固定等待换成可观察条件（mock 调用记录、状态文字、元素出现）。不改业务代码。

### 9.5 测试

- Rust：导入器规则单测；`preflight_outline_upgrade` 三种状态；`run_outline_upgrade` 在 Git 库（检查点成功后升级、升级后 frontmatter 未知键与标签保留、正文只剩一个区域、`read_graph_fragment` 可读）、`fileSha` 不一致跳过、`blocked` 跳过、非 Git 库写出备份；检查点 `blocked` 时不改任何文件。
- UI（mock 补两个新命令）：存在旧大纲时出现提示条、「暂不」后隐藏；对话框三组展示与「包含有损项」开关；执行后结果汇总与列表刷新；旧大纲编辑面的「升级」入口。

### 9.6 验收命令

沿用 `playwright.worktree.config.ts`（1422，不提交），开工前先跑一遍下表 UI 用例记录基线；偶发失败用 `--workers=1 --retries=0` 单独复跑并在报告注明。

| 命令 | 要求 |
| --- | --- |
| `cargo test -p shard-core -p shard -p shard-cli` | 全部通过 |
| `pnpm test:unit` | 除 golden 夹具那一项既有失败外全部通过（quick-open 性能若波动须单独复跑，并确认「参考结果对照」通过） |
| `pnpm build` | 通过 |
| `pnpm build:markdown && pnpm exec playwright test -c playwright.worktree.config.ts tests/ui/content-types.spec.ts tests/ui/rich-surfaces.spec.ts tests/ui/fragment-masonry.spec.ts tests/ui/mind-map-fence.spec.ts tests/ui/search-fragment-reveal.spec.ts tests/ui/search-integration.spec.ts` | 相对基线没有新增失败；新增用例全部通过 |
| `rustfmt --edition 2021 --check crates/shard-core/src/frontmatter.rs crates/shard-core/src/graph_region.rs crates/shard-core/src/outline_import.rs` | 通过 |
| `git diff --check` | 通过 |

### 9.7 交付

不提交 Git；测试改写的 `tests/evidence` 图片结束前恢复。报告写 `docs/dev/content-model-tasks-log/H4a.md`：改动文件与要点、开工前 UI 基线、验收结果（含测试数与偶发项复跑）、偏差及原因、遗留问题。

## 10. H4b 施工令：资料库独立图文件加入时间线

前置：P0–H4a 已在本分支。调研要点：
- 资料库条目菜单 `src/components/shard/library-entry-menu.tsx` 对 mindmap / flowchart 条目有「打开、复制文档链接、重命名、移动、删除」；删除走 `delete_library_entry` → `checkpoint_before_structural_locked` → `move_to_trash_in_vault`（`fs::rename` 到 `.trash/<原相对路径>`，重名加时间戳，自带一次 best-effort 提交）。
- 旧图 id 形如 `map-YYYYMMDD-HHMMSS-xxxx`、`map-<uuid>`、`flow-<uuid>` 或 UUID，只含 `[0-9a-z-]`；碎片 id 没有格式校验，`find_fragment_path` 按 frontmatter 的 `id` 匹配，扫描 `fragments/`、`.trash/fragments/`、`notes/`。`create_public_fragment_with_id_in_vault` 只检查同月目录下同名文件。H1 的图命令要求 `graph.id == 碎片 id`。
- 链接 `shard://map/<id>`、`shard://flow/<id>` 由 `src/lib/document-link.ts` 解析；打开走 `library-shell.tsx` 的 `openCanvasLink` 与 `workbench-shell.tsx` 的 `openFlowchartLink`，都按 `listDiagramDocuments`（只扫 `notes/`）查 id，找不到提示「引用的图文档已不存在」。Rust 侧目标缺失的链接仍合法（`canvas_commands::validate_public_link`）。
- 搜索只枚举 `notes/`、`maps/` 下的独立图文件，回收站里的不进搜索。

### 10.0 加固 toast 断言

`tests/ui/content-types.spec.ts` 中「超过 400 节点时拦截提交…」「大纲含密匣标签时保留草稿并提示…」断言的是会自动消失的 toast，高负载下 5 秒内等不到。给这两处以及本分支新增用例里其它断言 toast 的 `expect` 单独放宽超时（如 15 秒），并在 toast 之外同时断言持久状态（草稿仍在、没有创建调用）。不改业务代码。

### 10.1 后端命令 `import_graph_file_to_timeline(path)`

- 只接受资料库 `notes/` 下的 `.shardmap.json`（大纲）与 `.shardflow.json`（流程图）；路径校验沿用现有资料库路径规则。读取并用现有校验函数校验；流程图要求 `kind == "shard.flow"`，旧混合画布（`shard.canvas`）拒绝。
- **碎片 id 沿用旧图 id**。要求 id 只含 `[0-9A-Za-z._-]` 且非空；全库（`fragments/`、`.trash/fragments/`、`notes/` 的 md，以及密匣）不得已有同 id 碎片，否则报错且不改任何文件。**幂等**：已存在同 id、同类型、正文有有效区域的碎片时，视为之前已导入——不重复创建，只在原文件还在时完成「移入回收站」这一步，并返回该碎片。
- 新碎片：`created_at` 取图 JSON 的 `createdAt`（解析失败时用当前时间），目录按它落到 `fragments/YYYY/MM/`；标签 `inbox` 加对应 type；正文为 `render_region` 生成的唯一区域，图 JSON 原样保留（id、节点 id、`createdAt`、`updatedAt`、`revision` 都不改）。
- 顺序：拿写门 → `checkpoint_before_structural_locked` → 写新碎片 → 把原文件移入 `.trash/`（路径规则与 `move_to_trash_in_vault` 相同）→ **一次**路径级语义提交，包含新碎片、原路径与回收站路径。为此最小提取一个不自带提交的移动函数，现有 `move_to_trash_in_vault` 与删除命令的行为不变。移入回收站失败时删除刚写的新碎片并返回错误，原文件不动。
- 返回新碎片（带 `fileSha`）。last-good 副本、冲突副本不处理。

### 10.2 前端

- 资料库条目菜单：mindmap / flowchart 条目（非批量）增加「加入时间线」，图标从现有图标注册表选用。点击后弹确认对话框（复用资料库现有确认对话框结构）：说明会生成一篇同名的大纲或流程图、原文件移入回收站、可从回收站恢复，按钮「加入时间线」「取消」。成功后刷新资料库树与碎片列表，toast「已加入时间线」并提供「打开」动作（打开对应的图形宿主）；失败显示错误，不改变列表。
- **链接回退**：打开 `shard://map/<id>` 或 `shard://flow/<id>`，以及导图检查器、流程图引用节点里的 Map / Flow 引用时，`listDiagramDocuments` 找不到该 id 就在已加载碎片里找同 id、对应类型的 JSON 大纲或流程图，找到则打开 H2/H2b 的图形宿主；都找不到才提示「引用的图文档已不存在」。资料库里触发时通过 workbench 提供的回调打开宿主，不在 library-shell 里复制宿主逻辑。

### 10.3 测试

- Rust：导入大纲与流程图（id 等于旧图 id、`created_at` 与月份目录来自图 JSON、正文恰好一个区域、`read_graph_fragment` 可读、原文件已在 `.trash/`、只有一次提交）；id 冲突、图校验失败、旧混合画布三种拒绝都不改任何文件；重复调用幂等；非 Git 库照常工作。
- UI（mock 补新命令与 `listDiagramDocuments` 缺失场景）：菜单项只对导图和流程图条目出现；确认后调用命令、列表刷新、toast 带「打开」；链接回退打开图形宿主；两处都找不到时仍提示已不存在。
- 现有资料库删除、重命名、移动、打开导图与流程图的用例不回退。

### 10.4 验收命令

沿用 `playwright.worktree.config.ts`（1422，不提交），开工前先跑一遍下表 UI 用例记录基线（`library-tree.spec.ts` 已知有既有失败，以基线为准）；偶发失败用 `--workers=1 --retries=0` 单独复跑并在报告注明。

| 命令 | 要求 |
| --- | --- |
| `cargo test -p shard-core -p shard -p shard-cli` | 全部通过 |
| `pnpm test:unit` | 除 golden 夹具那一项既有失败外全部通过（quick-open 性能若波动须单独复跑，并确认「参考结果对照」通过） |
| `pnpm build` | 通过 |
| `pnpm build:markdown && pnpm exec playwright test -c playwright.worktree.config.ts tests/ui/library-workspace.spec.ts tests/ui/library-tree.spec.ts tests/ui/content-types.spec.ts tests/ui/rich-surfaces.spec.ts tests/ui/mind-map-workspace.spec.ts tests/ui/canvas-workspace.spec.ts tests/ui/wikilink.spec.ts` | 相对基线没有新增失败；新增用例全部通过 |
| `rustfmt --edition 2021 --check crates/shard-core/src/frontmatter.rs crates/shard-core/src/graph_region.rs crates/shard-core/src/outline_import.rs` | 通过 |
| `git diff --check` | 通过 |

### 10.5 交付

不提交 Git；测试改写的 `tests/evidence` 图片结束前恢复。报告写 `docs/dev/content-model-tasks-log/H4b.md`：改动文件与要点、开工前 UI 基线、验收结果（含测试数与偶发项复跑）、偏差及原因、遗留问题。
