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
| **P0** | frontmatter 保真读写：修改既有 md 时只局部改写系统键；密匣载荷保存原始 frontmatter | 无 | 本批，施工令见 §3 |
| P1 | 共用前置合同：保存基线覆盖完整文件（前端拿到文件级哈希）；type 合同（新增 `flowchart`，多个 type 标签的冲突规则在后端与 CLI 统一执行）；大纲、流程图拒绝进密匣 | P0 | 待细化 |
| H1 | 受管 JSON 区域编解码（Rust + TS）与后端读写命令：幂等创建（稳定操作 ID）、读取、只替换区域的原子写、完整文件基线 | P1 | 待细化 |
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
