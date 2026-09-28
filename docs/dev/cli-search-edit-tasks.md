# 终端搜索与编辑碎片 `shard -s` / `shard -e` — 任务清单

## 背景

用户要求 CLI 能**搜索碎片，并编辑搜索出来的碎片**。主体代码已由 Claude 写完并通过编译与单元测试，本清单交给执行方完成：审查、集成测试、文档、验收与提交。

分支：`feat/frontmatter-fidelity`（本工作树 `shard-wt-p0`）。

## 已有实现（先读）

| 文件 | 内容 |
| --- | --- |
| `crates/shard-cli/src/find.rs` | 加载 `fragments/**/*.md`（跳过 `.` 开头的文件/目录、解析失败的文件、`outline`/`flowchart` 类型）；复用 `shard_core::search`（`ParsedQuery` → `project_document` → `scan_exact`）做与 App ⌘K 一致的匹配与排序；无关键词时按 `updated_at` 倒序列出；输出 ` 序号  日期  短id  预览`，终端下命中词高亮（`NO_COLOR` 关闭）；`--json` 输出；上次搜索记录在 `$SHARD_CLI_STATE_DIR/last-search.json`，缺省 `app_config_dir()/cli/last-search.json`，按资料库路径区分；`select()` 解析编辑目标 |
| `crates/shard-cli/src/edit.rs` | 正文写入系统临时目录 `shard-<短id>-<随机>.md` → `sh -c '$EDITOR "$@"'` 打开（`$VISUAL` → `$EDITOR` → `vi`）→ 未改动直接退出 → 空正文拒绝 → 按 App 规则重算标签（`edited_tags`）→ 含 `#密匣` 拒绝 → 取 `VaultProcessLock` → 核对全文件 sha256 与打开时一致（不一致退出码 2）→ `write_fragment_update` 保真写入并刷新 `updated_at`。所有保存失败路径都保留临时文件并在错误信息里给出路径 |
| `crates/shard-cli/src/main.rs` | 选项循环里 `-s/--search`、`-e/--edit` 之后的参数交给 `parse_find_args`（`-n/--limit`、`--json` 仅搜索可用；`--vault` 可写在前后；`--` 之后全部是关键词）；`run_find` 分发；HELP 已补「搜索与编辑」一节 |
| `crates/shard-cli/Cargo.toml` | 新增 `chrono` 依赖 |

编辑目标解析规则（`find::select`）：
1. 无参数 → 最近修改（`updated_at` 最大）的一条。
2. 单个纯数字，且上次搜索（同一资料库）有这个序号 → 上次搜索的第 N 条；该条已不存在时报错。
3. 与某条 id 完全相同 → 该条；否则长度 ≥ 4 且只命中一条 id 子串（不区分大小写）→ 该条。
4. 其余按关键词搜索：0 条报错；1 条直接编辑；多条时把列表打到 stderr、记为上次搜索，终端下提示输入序号，非终端返回错误「匹配到 N 条，用 shard -e <序号> 选择其中一条」（退出码 1）。

标签规则（`edit::edited_tags`，与 App 一致）：`inbox` + 正文 `extract_tags`，规范化；原类型存在时移除所有 type 标签再补回原类型（前端 `applyTypeTag`）；再过后端 `normalize_updated_type_tags` 的逻辑（非受保护类型时移除 `outline`/`flowchart`）；结果为空则 `["inbox"]`。

退出码：0 成功（含「没有改动」）；1 一般错误（含搜索无结果）；2 编辑期间文件被改动。

## 约束（必须遵守）

- **不得修改真实用户环境**：所有测试与手工验证只用 `tempfile` / 临时目录，并显式设置 `SHARD_VAULT` 或 `--vault`、`SHARD_LOCK_DIR`、`SHARD_CLI_STATE_DIR`、`TMPDIR`。不得读写 `~/Documents/ShardVault`、`~/Library/Application Support/dev.shard.desktop`、`~/.zshrc`、`~/.local/bin`。
- 行为语义以本清单为准。审查中发现真实缺陷可以修，但要在回报里逐条说明「原行为 / 问题 / 修改」；不要顺手重构、不要改动与本任务无关的文件。
- 只格式化本任务文件：`rustfmt --edition 2021 crates/shard-cli/src/find.rs crates/shard-cli/src/edit.rs crates/shard-cli/src/main.rs crates/shard-cli/tests/search_edit.rs`。**不要** `cargo fmt` 整个 crate（`parse.rs` 等存量未格式化，不属于本任务）。
- 不读 `node_modules/`、`dist/`、`target/`（构建产物检查除外）、`.gstack/`、`.playwright-mcp/`。
- 注释与用户可见文案用简体中文，风格贴合周边代码。

## T1 审查已有实现

逐项核对并在回报中给出结论（没问题也写「已核对」）：
1. `find::render_preview` 截断与高亮在多段、首段为空、连续空白时正确，`…` 只出现一次。
2. `find::select` 规则 2 的序号在「上次搜索属于另一个资料库」「序号越界」时回落到规则 3/4，不误报。
3. `edit::edit_fragment` 每个失败分支（编辑器非零退出、读取临时文件失败、空正文、`#密匣`、锁超时、冲突、写入失败）是否按清单删除或保留临时文件；编辑器非零退出时不写资料库。
4. 非 macOS：`cfg!(windows)` 分支能编译；不要求在 Windows 实测。
5. 搜索无结果时 `--json` 输出 `[]` 且退出码 0（便于脚本），非 JSON 退出码 1——保持现状并在测试里固定。

## T2 集成测试 `crates/shard-cli/tests/search_edit.rs`

参照 `crates/shard-cli/tests/graph.rs` 的夹具写法，用 `env!("CARGO_BIN_EXE_shard-cli")` 起进程。每个用例：临时资料库 + 临时 `SHARD_LOCK_DIR`、`SHARD_CLI_STATE_DIR`、`TMPDIR`，`env_remove("VISUAL")`，`EDITOR` 指向测试生成的 `sh` 脚本（`chmod 755`），脚本用 `$1` 拿到临时文件路径。碎片夹具直接写 `fragments/2026/09/<id>.md`（标准 id 形如 `20260926-061830-81b8ea9d-a2237f`）。

必须覆盖：
1. **搜索命中与排序**：3 条碎片，关键词只在其中 2 条；输出 2 行，含序号、短 id；标题命中的排在只正文命中的前面；`last-search.json` 记下两条 id 且 `vault` 为该资料库。
2. **多关键词 AND、大小写与全角**：`Shard 咖啡` 只命中同时含两词的碎片；`ＳＨＡＲＤ` 与 `shard` 结果相同。
3. **无关键词列出最近**：按 `updated_at` 倒序；`-n 1` 只列 1 条。
4. **排除范围**：`.trash/fragments/` 下的、`outline` 类型的、`.` 开头的临时文件都不出现在结果里。
5. **`--json`**：字段 `index,id,path,title,kind,tags,createdAt,preview`；无结果时输出 `[]`、退出码 0；非 JSON 无结果退出码 1。
6. **按序号编辑 + frontmatter 保真**：夹具 frontmatter 含未知键（`author: 张三`）、第 0 列注释、行尾注释；先 `-s` 再 `-e 2`，编辑脚本把正文改成含 `#新标签` 的内容。断言：正文已替换；`tags` 为 `[inbox, 新标签]`（按规则）；`updated_at` 变化；`id`、`created_at`、未知键与注释逐字节不变；stdout 含 `已保存：fragments/...`；临时文件已删除。
7. **没有改动**：编辑脚本不改文件（或只追加空行）→ 输出「没有改动」、文件字节完全不变。
8. **文档类型保留**：`tags: [document, inbox]` 的碎片，正文加 `#note` → 结果仍是 `[document, inbox]`（加上正文里的其他标签）。
9. **拒绝密匣与空正文**：正文加 `#密匣` → 退出码 1、文件不变、错误信息含临时文件路径且该文件仍在；正文清空 → 退出码 1、文件不变。
10. **冲突**：编辑脚本在改临时文件的同时往碎片文件追加一行（通过环境变量传碎片路径）→ 退出码 2、碎片文件保持「追加后」的内容、临时文件保留且错误信息给出路径。
11. **锁被占用**：测试进程先 `VaultProcessLock::acquire` 同一资料库，`SHARD_LOCK_TIMEOUT_MS=200` → 退出码 1、含「Shard 正在写入资料库，请稍后重试」、文件不变、临时文件保留。
12. **按 id 片段与关键词**：`-e 81b8`（唯一子串）直接编辑；关键词唯一命中直接编辑；关键词多条命中且非终端 → 退出码 1、stderr 列出结果、随后 `-e 1` 能编辑到列表第一条。
13. **拒绝大纲**：`-e <outline 碎片完整 id>` 找不到或报错（outline 不在可编辑集合里，确认错误文案合理），文件不变。
14. **无参数编辑最近一条**：`-e` 不带参数编辑 `updated_at` 最新的那条。
15. **原有速记不受影响**：`shard 今天心情很好` 仍新建碎片；`shard search 银行` 仍按原规则新建内容为「search 银行」的碎片（`-s` 才是搜索）。

## T3 文档

`README.md`「终端快捷创建」一节：代码块补 `shard -s …`、`shard -e …` 示例（与 HELP 一致）；列表补一条说明：匹配规则同 App 搜索、序号引用上次搜索、编辑器取 `$VISUAL`/`$EDITOR` 且图形编辑器需等待参数、保存后重算标签、冲突不覆盖（退出码 2）、大纲流程图用图命令、密匣只在 App 中编辑、双链关系在 App 下次保存该碎片时更新。

## T4 验收（全部执行并在回报中贴结果）

1. `cargo test -p shard-cli -p shard-core` 全绿（贴测试数）。
2. `cargo clippy -p shard-cli --all-targets` 对本任务文件零警告（存量警告可忽略，但要列出）。
3. `rustfmt --edition 2021 --check` 上述四个文件通过。
4. 手工：临时资料库里造 5 条碎片，依次跑 `-s`、`-s 关键词`、`--json`、`-e 1`（`EDITOR` 用脚本），贴终端输出。
5. `git diff --stat` 只包含本任务文件。

## T5 提交

验收全部通过后，在 `feat/frontmatter-fidelity` 上提交**仅本任务文件**（`crates/shard-cli/**`、`Cargo.lock`、`README.md`、本清单）：

```
feat(cli): shard -s 搜索碎片、shard -e 编辑已有碎片
```

不要提交 `playwright.worktree.config.ts`，不要 push。

## 回报

最后一条消息按以下结构：改动文件与要点；T1 逐项结论；T2 用例清单与结果；T4 各命令输出摘要；与本清单的偏差及原因；遗留问题。
