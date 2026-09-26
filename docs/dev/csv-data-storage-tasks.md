# CSV 数据存储层：阶段 0 / 1 任务计划

日期：2026-09-27。方案见 [csv-data-storage-plan.md](csv-data-storage-plan.md)（下称「方案」）。本文件把阶段 0（契约与安全基础）和阶段 1（可编辑 MVP）拆成可独立验收的任务。阶段 2（schema 列类型、DTO v2 `format`/`where`、SQLite 投影、旧表迁移向导）及以后不在本文件范围。

执行：Codex `gpt-6-sol`，reasoning effort `medium`，每次只做一个任务，在 worktree `../shard-csv`（分支 `feat/csv-datasets`）上改动，**不要 commit**，由 Claude 验收后提交。

## 通用约束（每个任务都适用）

- 先读 `AGENTS.md`（Runtime Rules、提交策略、Design System）与本文件对应任务段落；只改任务列出的范围，不顺手重构、不改无关文件。
- 所有写 vault 的 Tauri command：`ensure_vault_dirs` → `let _gate = lock_vault_gate(&vault);` → 执行；内容写入**不内嵌 git 提交**（由 `checkpoint_vault` 聚合）。重操作用 `run_blocking`（`spawn_blocking` 封装）。
- 前端 UI 消费 Kiln token 与 `src/components/ui/*` 共享控件，不写死颜色/尺寸；中文文案。
- 错误文案用中文；冲突错误字符串以 `STALE_BASE:` 开头（与 `lib.rs` 的 `STALE_BASE_ERROR` 同一前缀约定）。
- 每个任务结束时必须跑通该任务「验收命令」，并在最终回复里逐条贴出命令与结果摘要；失败不许谎报。
- 基线：`cargo test --workspace` 与 `pnpm test:unit` 在开工前全绿（golden 用例目录因根 `.gitignore` 的 `*.md` 规则未入库，worktree 已手工拷入，不要改 `.gitignore`）。

## 固定契约

### C1 受管数据集目录

- 新增受管根 `datasets/`。应用新建、导入、提取的数据集写在 `datasets/<文件名>.csv`，旁路 schema 为同目录 `<文件名>.csv.schema.json`。
- 其他位置已有的 `.csv` 仍可读、可编辑（按普通 CSV：无 schema、无主键）；本阶段不在非 `datasets/` 位置创建 schema。
- 私密（lockbox）路径下永远不读写数据集，沿用 `ensure_public_csv_path` 的拒绝规则。

### C2 受管 CSV 写入格式

UTF-8 无 BOM；逗号分隔；双引号、内部双引号双写；仅在字段含 `"`、`,`、`\r`、`\n` 时加引号（csv crate `QuoteStyle::Necessary`）；记录终止符 LF；文件末尾恰好一个 LF；首行是表头。值原样保存为字符串：不 trim、不转数字、不把任何字符串当空值。空单元格即空字符串。

读取：接受开头 UTF-8 BOM（只剥离文件流开头的 U+FEFF，字段内部的不动）；非 UTF-8 → 错误 `CSV_NOT_UTF8`（导入流程在前端解码，见 T1.5）；记录字段数与表头不一致 → `CSV_RAGGED`；表头存在空名或重复名 → 可读但标记 `editable=false` 并给出原因（编辑命令拒绝）；超限 → `LIMIT_EXCEEDED`。

### C3 schema v1（`<name>.csv.schema.json`）

```json
{
  "schemaVersion": 1,
  "datasetId": "ds_<32 位小写 hex>",
  "title": "阅读记录",
  "primaryKey": "id"
}
```

- `primaryKey` 可省略（无主键）。严格解析：未知字段、`schemaVersion != 1`、`datasetId` 格式不符 → 错误 `SCHEMA_INVALID`，编辑命令拒绝（读取仍返回表格数据与错误原因）。
- 序列化：2 空格缩进、键顺序 `schemaVersion, datasetId, title, primaryKey`、末尾一个 LF。不写 revision、时间、hash、行数据。

### C4 主键与行 ID

- 有 `primaryKey` 时：该列必须存在于表头；每行值非空且唯一，否则 `editable=false`（原因 `PRIMARY_KEY_INVALID`）。编辑命令禁止修改主键列的已有值；插入行时调用方必须提供非空且唯一的主键值。
- 新生成的行 ID 格式：`r_` + 12 位小写 hex（前端用 `crypto.getRandomValues`）。

### C5 版本令牌与冲突

- `sha`：CSV 文件实际字节（含 BOM）的 SHA-256 小写 hex。
- `schemaSha`：schema 文件实际字节的 SHA-256；文件不存在时为 `null`，**`null` 也参与比对**（读时不存在、写时已存在 = 基线变化）。
- 所有写命令携带 `expectedSha` 与 `expectedSchemaSha`，在锁内与磁盘比对，不一致返回 `STALE_BASE:数据文件已在别处被修改`。

### C6 编辑操作（按基线快照的行/列下标寻址）

```ts
type DatasetOp =
  | { op: "setCells"; cells: { row: number; column: number; value: string }[] }
  | { op: "insertRows"; at: number; rows: string[][] }        // 每行长度 = 当前列数
  | { op: "deleteRows"; rows: number[] }                       // 去重后按降序删除
  | { op: "insertColumn"; at: number; name: string }            // 已有行在该位置补 ""
  | { op: "renameColumn"; column: number; name: string }
  | { op: "deleteColumn"; column: number }
```

- 下标均 0 起，`row` 不含表头。一个批次内按顺序依次应用，后一个操作的下标以前一个操作之后的状态为准。
- 批次全成或全不成（先在内存算完整结果并校验，再原子写入）。
- 校验：表头非空唯一；不能删除/重命名主键列；不能删最后一列；主键规则（C4）；限制（C7）。
- Rust 与 TS 两端各实现一份「应用操作」的纯函数，行为必须一致（TS 用于前端乐观显示与撤销逆操作计算；Rust 为权威）。

### C7 限制（阶段 1 保守起点）

行 ≤ 10,000；列 ≤ 128；单元格总数 ≤ 300,000；文件 ≤ 64 MiB；单元格 ≤ 16,384 字符；单批操作 ≤ 64 个、显式单元格 ≤ 50,000。超限拒绝并保留原文件。超出可编辑上限的文件只读打开并明示原因，**不得截断读取后允许保存**。

## 阶段 0：契约与安全基础

### T0.1 跨进程 vault 写锁

目标：App 与 `shard-cli` 写 vault 时互斥。现状：`lock_vault_gate`（`src-tauri/src/lib.rs` 约 576 行）只调 `search_runtime::acquire_write_guard`，是进程内 `Mutex+Condvar`；CLI 在 `crates/shard-cli/src/main.rs` 约 97 行直接 `create_public_fragment_in_vault`，不取任何锁。

实现：

1. 把 `normalized_vault_key`（`src-tauri/src/search_runtime.rs` 约 1114–1158 行）**移动**到 `crates/shard-core/src/lib.rs` 并 `pub`，`search_runtime` 改为调用 shard-core 版本（保持行为与测试不变，`search_index.rs` 的调用同步改）。
2. shard-core 新增模块 `vault_lock.rs`：
   - `pub fn vault_lock_path(lock_dir: &Path, vault: &Path) -> PathBuf`：`lock_dir/<sha256(normalized_vault_key(vault) 的 UTF-8 路径字节) 前 16 字节 hex>.lock`。
   - `pub struct VaultProcessLock { file: File }`，`pub fn acquire(lock_dir, vault, timeout: Option<Duration>) -> Result<VaultProcessLock, String>`：`create_dir_all(lock_dir)`；`OpenOptions` 读写+创建打开锁文件（**永不删除锁文件**）；`timeout=None` 时 `file.lock()` 阻塞；`Some(t)` 时循环 `file.try_lock()`，每 50ms 一次，超时返回 `"Shard 正在写入资料库，请稍后重试"`。Drop 时 `file.unlock()`（忽略错误）。使用 std 的 `File::lock/try_lock/unlock`（Rust 1.89+，本机 1.93.1），不引入锁 crate。
   - `pub fn cli_lock_dir() -> Option<PathBuf>`：与 `crates/shard-cli/src/main.rs` 的 `app_settings_path()` 同一目录规则（identifier `dev.shard.desktop`）下的 `locks/` 子目录。把 CLI 的目录计算挪到 shard-core 复用，避免两份规则。
3. App：`setup` 里用 `app.path().app_config_dir()?.join("locks")` 初始化一个 `static VAULT_LOCK_DIR: OnceLock<PathBuf>`。**必须与 `cli_lock_dir()` 在 macOS 上得到同一路径**，写单测断言两者规则一致（至少断言 identifier 与子目录名常量共享）。
4. 改 `lock_vault_gate`：先取进程内门（现有逻辑），再 `VaultProcessLock::acquire(dir, vault, None)`；返回新结构 `VaultGate { process: Option<VaultProcessLock>, inner: search_runtime::VaultWriteGuard }`，**字段声明顺序保证先释放进程锁、再释放进程内门**（Rust 按声明顺序 drop，`process` 在前）。`VAULT_LOCK_DIR` 未初始化（单元测试）时 `process=None`。为 `VaultGate` 实现 `Deref<Target = VaultWriteGuard>`，或把现有接收 `&search_runtime::VaultWriteGuard` 的函数（`move_public_fragment_*_to_lockbox_in_vault` 等，约 4901/4920/4941 行）改为接收 `&VaultGate`——二选一，改动最小者优先。所有现有调用点签名保持可编译，测试不改语义。
5. CLI：`main.rs` 写入前 `VaultProcessLock::acquire(cli_lock_dir, &vault, Some(Duration::from_millis(timeout)))`，timeout 默认 30000ms，可被环境变量 `SHARD_LOCK_TIMEOUT_MS` 覆盖（供测试）。`cli_lock_dir()` 为 `None` 时报错退出，不能无锁写入。
6. 检查点、同步（`checkpoint_vault`、`push_vault` 两段持门）无需额外改动——它们走 `lock_vault_gate`，自动获得进程锁。确认 `push_vault` 的网络阶段仍在门外。

测试：

- shard-core：两个独立 `File` 句柄对同一锁文件，第一个持有时第二个 `acquire(.., Some(100ms))` 超时失败；释放后成功。`vault_lock_path` 对 symlink 父目录与 `..` 形式的同一 vault 给出同一路径。
- CLI 集成测试（`crates/shard-cli/tests/`）：测试进程持有锁，`SHARD_LOCK_TIMEOUT_MS=200` 启动 CLI 二进制写碎片，断言非零退出且 vault 中无新碎片；释放后再跑成功。CLI 测试需要能指定锁目录：新增环境变量 `SHARD_LOCK_DIR` 覆盖 `cli_lock_dir()`（仅供测试与排障，不写进 `--help`）。
- 现有 `cargo test --workspace` 全绿。

验收命令：`cargo test --workspace`、`cargo clippy --workspace --all-targets -- -D warnings`（若基线本身有告警，只要求不新增）、`git diff --check`。

### T0.2 受管根 `datasets/` 与 Git 规则

1. `MANAGED_VAULT_ROOTS` 加入 `"datasets"`（`lib.rs` 约 76 行）。
2. `shard_core::ensure_vault_layout` 与 `lib.rs` 的 `vault_layout_is_complete`（约 2488 行）同步加入 `datasets`；`ensure_vault_layout` 在 `datasets/.gitattributes` 不存在时写入内容 `*.csv merge=binary\n`（存在则不动）。
3. 回收站路径白名单（`trashable_vault_path` 约 3523 行、`restore_from_trash_in_vault` 约 3640 行）加入 `datasets`。
4. `managed_pathspecs()` 增加临时文件排除：`:(exclude,glob)datasets/**/.?*.tmp-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]`（对应 `shard_core::write_bytes_atomically` 的临时名规则；若 T0.3 改了临时名规则，此处同步）。
5. 不改搜索、资料库树等其他硬编码名单（CSV 搜索已覆盖任意位置 `.csv`）。

测试：`managed_pathspecs` 断言含 `datasets` 与排除规则；`ensure_vault_layout` 生成 `.gitattributes` 且不覆盖已有内容；在临时 git vault 里写一个 `datasets/a.csv` 与一个 `.a.csv.tmp-abcd`，跑 `checkpoint_vault_locked`，断言提交包含前者、不含后者（参照现有 checkpoint 测试写法）。

验收命令：同 T0.1。

### T0.3 shard-core 数据集核心（解析、序列化、schema、操作）

新增 `crates/shard-core/src/dataset.rs`（`pub mod dataset`），在 `crates/shard-core/Cargo.toml` 直接声明 `csv = "1.4"`、`sha2`（workspace）、`serde_json`（workspace）、`rand`（已有）。

公开 API（名称可微调，语义不变）：

```rust
pub struct CsvTable { pub header: Vec<String>, pub rows: Vec<Vec<String>> }
pub struct DatasetSchema { pub schema_version: u32, pub dataset_id: String, pub title: String, pub primary_key: Option<String> }
pub struct DatasetSnapshot {
    pub path: String,               // vault 相对路径，'/' 分隔
    pub table: CsvTable,
    pub sha: String,
    pub schema: Option<DatasetSchema>,
    pub schema_sha: Option<String>,
    pub editable: bool,
    pub read_only_reason: Option<String>, // 中文原因，editable=false 时必有
}
pub enum DatasetOp { SetCells{..}, InsertRows{..}, DeleteRows{..}, InsertColumn{..}, RenameColumn{..}, DeleteColumn{..} } // serde tag="op", camelCase，对应 C6
pub struct DatasetLimits { .. } // C7，Default 实现

pub fn parse_csv_bytes(bytes: &[u8], limits: &DatasetLimits) -> Result<CsvTable, DatasetError>;
pub fn serialize_csv(table: &CsvTable) -> Vec<u8>;                       // C2
pub fn parse_schema(bytes: &[u8]) -> Result<DatasetSchema, DatasetError>;  // C3
pub fn serialize_schema(schema: &DatasetSchema) -> Vec<u8>;
pub fn apply_ops(table: &CsvTable, schema: Option<&DatasetSchema>, ops: &[DatasetOp], limits: &DatasetLimits) -> Result<CsvTable, DatasetError>;
pub fn read_dataset(vault: &Path, rel: &str, limits: &DatasetLimits) -> Result<DatasetSnapshot, DatasetError>;
pub fn write_dataset_ops(vault: &Path, rel: &str, expected_sha: &str, expected_schema_sha: Option<&str>, ops: &[DatasetOp], limits: &DatasetLimits) -> Result<DatasetSnapshot, DatasetError>;
pub fn create_dataset(vault: &Path, title: &str, header: Vec<String>, rows: Vec<Vec<String>>, primary_key: Option<String>, limits: &DatasetLimits) -> Result<DatasetSnapshot, DatasetError>;
pub fn new_dataset_id() -> String;   // ds_ + 32 hex
```

要点：

- `DatasetError { code: String, message: String }`，code ∈ `CSV_NOT_UTF8 | CSV_PARSE | CSV_RAGGED | HEADER_INVALID | SCHEMA_INVALID | PRIMARY_KEY_INVALID | LIMIT_EXCEEDED | INVALID_PATH | NOT_FOUND | STALE_BASE | OP_INVALID | IO_ERROR`；`Display` 输出 `"{code}:{message}"`，其中 STALE_BASE 的 message 为 `数据文件已在别处被修改`，保证字符串以 `STALE_BASE:` 开头。
- 解析用 `csv::ReaderBuilder`：`has_headers(false)`、`flexible(true)`（自己检查字段数以给出 `CSV_RAGGED`）、`delimiter(b',')`、`quote(b'"')`、`double_quote(true)`。空文件 → `HEADER_INVALID`。BOM 按 C2 处理。
- 序列化用 `csv::WriterBuilder`：`quote_style(Necessary)`、`terminator(Terminator::Any(b'\n'))`。写单测断言：含换行/引号/逗号/前导空格/`00123`/`=SUM(A1)`/空串的字段往返不变；`serialize(parse(serialize(t))) == serialize(t)`（格式稳定）；修改一格后与原输出逐行 diff 只有 1 条记录不同（多行字段场景也成立）。
- `read_dataset`：路径校验复用 `src-tauri` 的 `ensure_public_csv_path` 规则——把该函数**移动**到 shard-core（`pub fn ensure_public_csv_path(vault, rel) -> Result<PathBuf, String>`），`lib.rs` 改调它，已有测试随迁或保留调用。schema 只在 `datasets/` 下查找旁路文件。
- `write_dataset_ops`：读当前字节 → 比对 `expected_sha`、`expected_schema_sha`（C5）→ 校验 `editable` → `apply_ops` → `serialize_csv` → `write_bytes_atomically`。**不取锁**（调用方负责，文档注释写明「必须在持 vault 写锁时调用」）。
- `create_dataset`：`title` 生成文件名（去除 `/\:*?"<>|` 与控制字符、trim、空则 `数据集`、最长 `LIBRARY_FILENAME_MAX_BYTES` 约束），`datasets/<name>.csv` 已存在则追加 ` 2`、` 3`…；先写 CSV 再写 schema（schema 含新 datasetId、title、primaryKey）；`primary_key=Some(k)` 时 k 必须在 header 中且各行值非空唯一。
- 限制与 C7 一致。

测试：以上各条 + 主键规则（改主键列被拒、插入重复主键被拒、删主键列被拒）、STALE_BASE（sha 不符、schema 由无变有）、`deleteRows` 去重降序、批次失败时文件字节不变。

验收命令：同 T0.1。

### T0.4 Tauri 数据集命令

`src-tauri/src/lib.rs` 新增并注册（`generate_handler!`）：

| command | 参数 | 返回 | 取门 |
| --- | --- | --- | --- |
| `read_dataset` | `path: String` | `DatasetSnapshot`（camelCase） | 否 |
| `apply_dataset_ops` | `path, expectedSha: String, expectedSchemaSha: Option<String>, ops: Vec<DatasetOp>` | `DatasetSnapshot` | 是 |
| `create_dataset` | `title: String, header: Vec<String>, rows: Vec<Vec<String>>, primaryKey: Option<String>` | `DatasetSnapshot` | 是 |

- 全部 `async` + `run_blocking`；写命令 `ensure_vault_dirs` → `lock_vault_gate` → shard-core 函数；不提交 git。
- 错误以 `String` 返回（`DatasetError` 的 `Display`）。
- 大数据：`DatasetSnapshot` 走普通 JSON IPC 即可（C7 上限内），不做分页。
- 测试：Rust 单测直接调命令内部 helper（参照现有 `*_in_vault` 测试风格），覆盖 create → read → apply → 冲突。

验收命令：同 T0.1，外加 `pnpm build`（确保前端类型未受影响）。

## 阶段 1：可编辑 MVP

### T1.1 前端数据集 API 与纯逻辑

新建 `src/features/datasets/`：

- `types.ts`：`DatasetSnapshot`、`DatasetOp`（C6）、`DatasetSchema` 的 TS 类型。
- `api.ts`：`readDataset(path)`、`applyDatasetOps(path, expectedSha, expectedSchemaSha, ops)`、`createDataset(title, header, rows, primaryKey?)`，用 `src/lib/api.ts` 的 `desktopInvoke` 同款封装；`isStaleBaseError(error)` 判断前缀 `STALE_BASE`。
- `ops.ts`（纯函数，无 React/Tauri）：
  - `applyDatasetOps(table, schema, ops): table`——与 Rust `apply_ops` 同语义（C6/C4/C7），失败抛 `DatasetOpError`。
  - `invertDatasetOps(tableBefore, ops): DatasetOp[]`——生成把 `tableAfter` 恢复为 `tableBefore` 的逆操作批次（用于撤销；撤销作为新写入提交）。
  - `newRowId(): string`（C4 格式）。
- 单测 `src/lib/dataset-ops.test.ts`（放 `src/lib/` 以进入现有 `test:unit` glob）：每种操作、批次顺序语义、主键保护、`apply(invert(ops)) ∘ apply(ops) == 原表`（随机化小表 200 轮）、与 Rust 相同的一组固定样例（把样例写成 JSON 夹具 `tests/fixtures/datasets/ops-cases.json`，Rust 测试也读同一文件断言一致）。

验收命令：`pnpm test:unit`、`pnpm build`、`cargo test --workspace`（夹具一致性）、`git diff --check`。

### T1.2 数据集编辑器（Glide）

新建 `src/features/datasets/dataset-editor.tsx`，导出 `DatasetEditor`（`forwardRef`，handle 为 `{ flush(): Promise<boolean>; isDirty(): boolean }`）。

- 复用：`src/features/tables/text-cell-editor.tsx`（`provideTableTextEditor`）与 `src/features/tables/kiln-grid-theme.ts`（`readKilnGridTheme`）；`import "@glideapps/glide-data-grid/dist/index.css"`。**不得 import 旧表格的 model/mutations/save-queue/worker/history/clipboard。**
- 数据：打开时 `readDataset(path)`；显示全部行（C7 上限内），列标题为表头文字；主键列显示锁图标、`readonly`，默认排在原位不移动。
- 编辑能力：
  - 单元格编辑（双击或回车进入，`provideTableTextEditor`），提交产生 `setCells`。
  - 粘贴：`onPaste` 接收 `string[][]`，从选区左上角开始覆盖；超出行数部分转 `insertRows`（有主键时为新行自动生成 `newRowId()`，粘贴内容不写入主键列）；超出列数部分截断并 toast 提示。
  - 删除键清空选中矩形（主键列跳过）。
  - 行：表尾「新增行」（有主键自动填 ID）；行标记多选后工具栏「删除行」。
  - 列：列头菜单（共享 DropdownMenu）「在左侧插入列 / 在右侧插入列 / 重命名 / 删除列」；重命名与新列名用共享输入控件，校验非空唯一。
  - 撤销/重做：Cmd+Z / Shift+Cmd+Z，栈上限 100 批；撤销 = 提交 `invertDatasetOps` 生成的新批次。
- 只读：`snapshot.editable=false` 时整表只读，顶部显示 `readOnlyReason`。
- 中文输入法：组字期间不提交、不触发快捷键（`text-cell-editor` 已处理单元格内；编辑器根节点再加 `onCompositionStartCapture/EndCapture` 标志，快捷键处理检查 `isComposing`）。

保存（自动保存，方案 §5）：

- 每个完成的编辑手势产生一个操作批次，先乐观应用到本地表（`ops.ts`），进入待保存队列。
- 防抖 600ms 合并连续批次（按顺序拼接）；同一编辑器同时只允许一个 `applyDatasetOps` 在途；成功后用返回的 `sha/schemaSha` 作为新基线，继续发送后续批次。
- `STALE_BASE`：暂停保存，保留待保存批次，顶部显示冲突条：「数据文件已在别处被修改」+ 按钮「放弃我的修改并载入磁盘版」「稍后处理」（后者保持暂停、表格可继续看但禁止继续编辑）。不提供覆盖。
- 其他错误：显示错误条与「重试」，不显示已保存。
- 状态显示在编辑器工具栏：保存中 / 已保存 / 未保存 / 冲突 / 出错（`aria-live="polite"`）。
- `Cmd+S` 立即 flush（不触发 git 提交）。`flush()` 等待队列清空，冲突/出错返回 `false`。
- 窗口重新获得焦点时：无待保存批次则重新 `readDataset`，sha 变化即刷新（清空撤销栈）；有待保存批次则先 flush，flush 遇冲突按上面处理。

验收：由 T1.3 的 UI 用例覆盖；本任务单独要求 `pnpm build`、`git diff --check`。

### T1.3 数据集禅模式与入口

- 新建 `src/features/datasets/dataset-zen.tsx`：用 `src/components/shard/zen-surface.tsx` 的 `ZenSurface` 承载 `DatasetEditor`；标题栏显示数据集标题（schema.title 或文件名）与路径；工具栏右侧「用默认程序打开」（先 `flush()`，成功后 `openCsvFile(path)`，并提示「返回 Shard 时会重新载入」）；关闭（Esc / 按钮）前 `flush()`，失败时用共享确认对话框询问「仍有未保存的修改，确定关闭？」。
- 全局打开入口：`src/features/datasets/open-dataset.ts` 导出 `openDatasetEditor(path)`，派发 `window` 自定义事件 `shard:open-dataset`；`src/workspace/workbench-shell.tsx` 监听该事件，维护 `openDatasetPath` state 并渲染 `<DatasetZen>`（同一时刻只有一个；已打开时再次打开同一路径只聚焦，不同路径先 flush 当前再切换）。
- 关窗流程：`workbench-shell.tsx` 约 2390–2430 行的 `onCloseRequested` 在现有 `drafts.flush()` 之前，若数据集编辑器打开则先 `flush()`，失败走现有确认逻辑。
- 保存成功后派发 `shard:dataset-changed`（detail: path）。`DatatableBlock`（CSV 来源）与 `CsvPreview` 监听该事件，路径相同则重新读取。
- 入口：
  1. `src/components/shard/datatable/datatable-block.tsx`：`spec.src` 存在时，工具栏加按钮「编辑数据」→ `openDatasetEditor(spec.src)`（任何 readOnly 状态下都显示，因为编辑的是 CSV 不是 md）；原「来自 x（只读）」文案改为「来自 x」。
  2. `src/editor-rich/schema/csv-embed-view.tsx` 与卡片中的 `CsvPreview`：底部「用默认程序打开」旁加「编辑」按钮 → `openDatasetEditor(path)`。
  3. `src/workspace/search-target-router.ts` 的 `csv` 分支：改为 `openDatasetEditor(target.path)` 并返回与 `externalAccepted` 相同的状态（避免改搜索契约）；⌘O 走同一路由。
  4. 资料库树点击 csv（`library-shell.tsx` 约 1429 行）同样改为 `openDatasetEditor`。
- 私密：以上入口的路径都经过 `ensure_public_csv_path`，lockbox 路径读取即失败并显示错误，不需要额外处理。

测试（Playwright，新文件 `tests/ui/dataset-editor.spec.ts`，mock 写法参照 `tests/ui/rich-blocks.spec.ts` 的 `installRichBlocksMock`；mock 内维护一份内存 CSV 与 sha，实现 `read_dataset`/`apply_dataset_ops`/`create_dataset`/`open_csv_file` 等所需命令）：

1. 从时间线卡片的 datatable（src）点「编辑数据」→ 禅模式打开，显示表头与行。
2. 改一格 → 等待「已保存」→ mock 收到的 ops 正是一次 `setCells`，且 `expectedSha` 为打开时的 sha。
3. 粘贴 2×2（从最后一行开始）→ 产生 `setCells` + `insertRows`；有主键时新行主键为 `r_` 格式。
4. 主键列单元格不可编辑。
5. 撤销 → mock 收到逆操作批次，表格恢复。
6. mock 让下一次写返回 `STALE_BASE:...` → 出现冲突条；点「放弃我的修改并载入磁盘版」→ 重新读取并显示磁盘内容。
7. Esc 关闭时存在待保存批次 → 先 flush；flush 成功后关闭。
8. 保存后卡片里的 datatable 预览刷新为新值。
9. 搜索/⌘O 打开 csv 结果进入禅模式而不是调用 `open_csv_file`。

截图证据放 `tests/evidence/datasets/`（打开态、冲突条、只读原因各一张）。

验收命令：`pnpm test:unit`、`pnpm build`、`pnpm exec playwright test tests/ui/dataset-editor.spec.ts tests/ui/rich-blocks.spec.ts tests/ui/csv-preview.spec.ts`、`git diff --check`。

### T1.4 新建数据集（slash「数据集」）与说明碎片

- 在 `src/editor-rich/blocks/registry-ui.tsx` 附近新增 slash 项 `id: "dataset"`、`label: "数据集"`、`hint: "新建 CSV"`、`keywords: ["数据集","csv","sjj","dataset"]`（不是新的围栏语言，而是一个「动作」slash 项；若现有 slash 体系只支持模板插入，则在 `src/editor-rich/commands.ts` 的 `runRichSlashCommand` 增加动作类型，最小改动）。
- 动作：弹出共享对话框输入标题（默认「数据集」）→ `createDataset(title, ["id","名称"], [], "id")` → 在光标处插入 datatable 围栏 `{"title": <title>, "src": <path>}` → 立即 `openDatasetEditor(path)`。
- 在速记框（capture box）中执行同一 slash 项时，插入围栏后正文即成为「说明碎片」，用户提交即得到一篇含数据表的普通碎片（满足方案 §7「新建数据集同时生成说明碎片」；不自动提交，由用户 Cmd+Enter）。
- 私密上下文禁用：编辑的碎片 `fragment?.lockbox` 为真，或速记框内容/标签 `wantsLockbox(...)` 为真时，该 slash 项不出现（参照 `src/components/shard/fragment-editor.tsx` 约 378/654 行已有判断，通过 `ShardRichEditor` 新增可选 prop `allowDatasetActions?: boolean` 传入，默认 true）。
- 更新 `src/editor-rich/blocks/registry-ui.test.ts` 等断言 slash 列表的测试。

测试：Playwright 用例：在禅模式碎片中 `/数据集` → 输入标题 → mock 收到 `create_dataset` → 正文出现 src 围栏 → 数据集禅模式打开；私密碎片中 `/数据集` 不出现。

验收命令：同 T1.3（加上新增用例）。

### T1.5 导入 CSV 为数据集（拖放）

- 替换 `capture-box.tsx` 约 522 行与 `fragment-editor.tsx` 约 746 行的「请在资料库中导入为多维表格」提示：拖入 `.csv` 文件时提示「松开以导入为数据集」；`.xls/.xlsx` 保持原提示改为「请先另存为 CSV 再导入」。
- 放下 `.csv`：前端读取文件字节 → `src/lib/csv.ts` 的 `parseCsvBytes`（已支持 UTF-8/BOM/UTF-16/GBK 解码与严格解析）→ 弹出共享对话框：显示识别到的编码、前 20 行预览、行列数；表头空名/重复名时显示错误并禁止导入；选项「添加稳定 ID 列（推荐）」（默认勾选；若已有名为 `id` 的列则改为「用 id 列作为主键」且需校验非空唯一，不满足则禁用该选项）→ 确认后 `createDataset(文件名去扩展名, header, rows, primaryKey)`（勾选添加 ID 时在前端为每行生成 `newRowId()` 并把 `id` 插在第一列）→ 在光标处插入 `{"src": path}` 围栏。原文件不动（只读取）。
- 私密上下文（同 T1.4 判断）：拖放 CSV 显示「私密碎片不支持数据集」且不导入。
- 超过 C7 上限：对话框显示超限原因并禁止导入。

测试：Playwright：模拟拖放一个 GBK 编码 CSV（在测试里构造字节）→ 预览显示「GBK」→ 导入 → mock 收到的 header/rows 为正确中文且每行带 `r_` ID；重复表头时导入按钮禁用。

验收命令：同 T1.3（加上新增用例）。

### T1.6 内联小表：精度保护与「提取为 CSV」

1. 精度保护（`src/lib/datatable.ts` 的 `coerceDatatableValue`）：数值列仅当 `String(Number(trimmed)) === trimmed` 时转为 number，否则原样保留文本（覆盖 `00123`、`1.20`、`9007199254740993`、`1e3`、`Infinity` 等）；布尔列逻辑不变。更新 `datatable.test.ts`。不批量改写已有 JSON。
2. 软阈值提示：内联表（无 src）行数 > 200 或单元格 > 5,000 时，datatable 工具栏显示提示「数据较多，建议提取为 CSV」（不阻止编辑）。
3. 「提取为 CSV」：内联表可编辑时，工具栏更多菜单项「提取为 CSV」（私密上下文不显示，判断同 T1.4，经 `ShardBlockEditorProps` 传入所需上下文；若 NodeView 拿不到上下文，则通过编辑器 storage 传递，最小改动）：
   - 表头：用列 `label`；label 有重复或为空时改用 `key`；仍冲突则禁止并提示。
   - 值：string 原样；number/boolean 用 `String(value)`；`null`/缺失为 `""`；数组或对象 → 列出位置并中止。
   - 预览确认对话框（显示将创建的文件名、行列数）→ `createDataset(title || "数据集", header, rows, null)`（不强加 ID）→ 用 onChange 把围栏替换为 `{"title"?, "src": path, "view"?}`：不写 `columns` 与 `rows`；`view.sort.key` / `view.group` 从原列 key 映射到 CSV 列 key `c<序号>`（与 `datatableColumnsFromCsv` 的 key 规则一致）；`view.filter` 原样保留。
   - 成功后内联 rows 不再存在于围栏中（不得双写）。
4. 单测：`coerceDatatableValue` 新规则；提取的 header/rows/view 映射纯函数（放 `src/lib/datatable.ts`，如 `datatableToDatasetExtraction(spec)`）。
5. Playwright：内联表「提取为 CSV」→ mock 收到 `create_dataset`（`00123` 仍是字符串）→ 围栏变为 src 形式并通过 CSV 渲染。

验收命令：同 T1.3（加上新增用例）。

### T1.7 CLI：追加记录

`shard-cli` 新增用法：`shard-cli --append-dataset <vault 相对路径>`，从 stdin 读取 JSON：

```json
{ "expectedHeader": ["id", "名称"], "records": [ { "id": "r_…", "名称": "…" } ] }
```

- 解析参数时，`--append-dataset` 与普通碎片内容互斥；`--help` 说明新用法。
- 取 T0.1 的进程锁后：`read_dataset` → 表头必须与 `expectedHeader` 完全一致，否则退出码 2、stderr `表头已变化`；数据集必须有主键；每条记录必须提供主键且只含表头中的列（缺失列补 `""`）；已存在相同主键且整行相同 → 视为已存在（跳过，计入 `skipped`）；已存在相同主键但内容不同 → 整批失败退出码 3（`主键冲突`）；否则构造 `insertRows { at: 行数 }` 批次，以当前 sha 为 expected 调 `write_dataset_ops`。
- stdout 输出 JSON `{ "appended": n, "skipped": m, "sha": "…" }`。
- 不做 git 提交（由 App 检查点聚合）。

测试（`crates/shard-cli/tests/`）：追加成功；重复追加同一 ID 被跳过（幂等）；同 ID 不同内容失败且文件字节不变；表头不符失败；持锁时超时失败（沿用 T0.1 的 `SHARD_LOCK_DIR`/`SHARD_LOCK_TIMEOUT_MS`）。

验收命令：`cargo test --workspace`、`cargo clippy --workspace --all-targets -- -D warnings`（不新增告警）、`git diff --check`。

## 真机验证（Claude 在全部任务完成后执行 / 交用户）

以下项自动化测不出，必须在真实 Tauri（WKWebView）中验证：Glide 单元格中文拼音连续输入、候选确认、Enter/Tab/Esc、快速切格；禅模式滚动与大表（1 万行）打开/滚动/改一格耗时；「用默认程序打开」后 Excel 修改保存、返回 Shard 后的重新载入与冲突；App 与 CLI 同时写入的真实并发。
