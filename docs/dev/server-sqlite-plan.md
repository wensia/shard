# Shard：服务端 SQLite 为唯一真相源 + 网页版

> 状态：2026-10-26 用户拍板，分支 `feat/server-sqlite` 实施中。S11 正式切换前，主线桌面应用仍以
> vault 目录里的 Markdown + Git 为真相源；本文描述切换后的目标架构与迁移路径。
> 取代 `server-and-sync-plan.md`（2026-07 的同方向方案，08-09 在 894405d 撤回，原因未记录）。

## 0. 决定

| 决定 | 选择 |
|---|---|
| 真相源 | VPS 上一份 SQLite，只有服务器写库。桌面与网页都是客户端；桌面留本地副本，离线能看、能记，联网补交，冲突按条目另存副本 |
| 文件与 Git | 彻底不用。备份是 age 加密的数据库快照；版本历史是库里的修订表 |
| 网页访问 | 公网域名 + 通行密钥（WebAuthn），Caddy 终止 TLS，服务只监听 127.0.0.1 |
| 网页上的密匣 | 允许解锁（端到端加密，口令只在浏览器内用），设置里可关 |
| 彻底删除 | 历史版本再留 30 天；另有「立即抹除」 |
| iOS | 暂不做；切换时停用现有读 GitHub 的 iOS App |

上一轮（2026-07）撤回原因不明。防御做法：上一轮没做完的三项——真实 VPS 部署、恢复演练、密匣密钥——这次是硬性验收；
上一轮按字段拆列建模，带来「文件 ↔ 本地库 ↔ 服务端」三方对账，这次改为存原文（§2）。

## 1. 拓扑

```
               浏览器（手机 / 平板 / 任何电脑）         桌面 App（Tauri）              shard CLI / AI 助手
                         │ HTTPS + 通行密钥 Cookie            │ HTTPS + 设备令牌（钥匙串）       │ HTTPS + 设备令牌
                         ▼                                    ▼                                ▼
   Caddy（TLS、HTTP/2、HSTS） ──► shard-server（axum，127.0.0.1）──► shard.db / blobs.db / auth.db
                                         │                               │
                                         └─ 静态托管网页                  └─ 每小时快照，每日 age 加密异地；恢复演练
   桌面 App 内：replica.db（已确认层）+ overlay + outbox；SSE 保持新鲜；离线读写允许的子集
```

## 2. 数据模型：库里存原文，列只做派生

SQLite 当作带事务的虚拟文件系统：每个 vault 相对路径一行，存原文件的完整字节（frontmatter + 正文原文、CSV
原始字节、导图 / 画布 JSON 原文、图片字节）。id、标签、标题、链接是同事务内从原文重算的派生投影，可整表重建。

理由：
- frontmatter 保真合同（G-P0；`shard-core/frontmatter.rs` 的 `apply_frontmatter`、`set_custom_property`
  在原文 YAML 上局部改写）与 CSV 原格式保留（`dataset.rs` 的 `serialize_csv_with`）原样有效。
- `fileSha` = sha256(整份原文) 的口径不变：前端 STALE_BASE、`vault-changes.ts` 刷新判定、CLI `--expect`、
  导图 `last_saved_hash`、数据集 `expected_sha` 不用改。
- 导出 = 把行原样写回文件，与原 vault 逐字节一致，旧版 App 可直接打开：既是回滚通道，也是逃生通道。
- 抽 `Vfs` trait（`FsVfs` 与 `SqliteVfs`），lib.rs 现有文件操作机械迁移；现有测试在两种实现上各跑一遍证明等价。
- 改名、移动连带的引用改写（wikilink、Markdown 图片、CSV 单元格）进同一事务，取代现在的多文件尽力回滚。

「vault 相对路径」保留为用户可见命名空间（`fragments/…`、`notes/…`、`assets/…`、`datasets/…`、`.trash/…`），
前端的路径标识与正文里的引用全部不变。

### 2.1 shard.db（内容）

`journal_mode=WAL`、`synchronous=FULL`、`foreign_keys=ON`；`user_version` 管迁移，只增不改。

```sql
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
-- vault_id, epoch（每次从备份恢复都轮换）, markdown_dialect=2, changes_floor_seq, import_report

-- 公开命名空间：真相 = inline / blob 字节；其余列同事务维护
CREATE TABLE nodes (
  node_id     INTEGER PRIMARY KEY,           -- 内部身份，改名、进回收站都不变
  path        TEXT,                          -- vault 相对路径，含 '.trash/' 前缀；彻底删除后 NULL
  path_key    TEXT,                          -- shard_path_key(path) = NFC 后转小写（Rust 注册的 SQL 函数）
  kind        TEXT NOT NULL CHECK (kind IN ('dir','file')),
  inline      BLOB,                          -- ≤ 1 MiB 文件的原始字节（GBK CSV 也原样）
  blob_sha    TEXT,                          -- 图片或 > 1 MiB：blobs.db 内容寻址
  size        INTEGER NOT NULL DEFAULT 0,
  sha         TEXT,                          -- sha256(原始字节)，即现在的 fileSha
  created_at  TEXT NOT NULL,
  modified_at TEXT NOT NULL,                 -- 取代文件 mtime（树与碎片排序、缩略图版本号依赖它）
  revision    INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  seq         INTEGER NOT NULL,              -- 最后一次变化的全局 seq
  purged_at   TEXT,
  CHECK ((path IS NULL) = (purged_at IS NOT NULL)),
  CHECK ((path IS NULL) = (path_key IS NULL)),
  CHECK (purged_at IS NOT NULL
         OR (kind='dir'  AND inline IS NULL AND blob_sha IS NULL AND sha IS NULL)
         OR (kind='file' AND (inline IS NULL) <> (blob_sha IS NULL) AND sha IS NOT NULL)),
  CHECK (path IS NULL OR (substr(path,1,1) <> '/' AND instr(path,'//') = 0
                          AND substr(path,1,8) <> 'lockbox/'))      -- 密匣永不进 nodes
);
CREATE UNIQUE INDEX nodes_path_key ON nodes(path_key) WHERE path_key IS NOT NULL;
CREATE INDEX nodes_seq  ON nodes(seq);
CREATE INDEX nodes_blob ON nodes(blob_sha) WHERE blob_sha IS NOT NULL;

-- 派生投影（只由 shard-store 写，可整表重建）
CREATE TABLE doc_index (
  node_id      INTEGER PRIMARY KEY REFERENCES nodes(node_id) ON DELETE CASCADE,
  doc_ns       TEXT NOT NULL CHECK (doc_ns IN ('fragment','map','flow','canvas','dataset','legacy')),
  doc_id       TEXT NOT NULL,
  lookup_scope INTEGER NOT NULL CHECK (lookup_scope IN (0,1)),  -- 1 = 落在现有按 id 查找的扫描范围内
  type_tag TEXT, title TEXT, pinned INTEGER, created_at TEXT, updated_at TEXT, conflict_of TEXT
);
CREATE UNIQUE INDEX doc_unique_in_scope ON doc_index(doc_ns, doc_id) WHERE lookup_scope = 1;
CREATE INDEX doc_by_id ON doc_index(doc_id);
CREATE TABLE doc_tags (node_id INTEGER NOT NULL REFERENCES nodes ON DELETE CASCADE,
                       tag TEXT NOT NULL, PRIMARY KEY (node_id, tag)) WITHOUT ROWID;
CREATE INDEX doc_tags_tag ON doc_tags(tag);
CREATE TABLE doc_links (node_id INTEGER NOT NULL REFERENCES nodes ON DELETE CASCADE,
  link_kind TEXT NOT NULL CHECK (link_kind IN
    ('wikilink','image','csv','related','map_fragment','map_path','map_map','map_flow')),
  target TEXT NOT NULL, PRIMARY KEY (node_id, link_kind, target)) WITHOUT ROWID;
CREATE INDEX doc_links_target ON doc_links(link_kind, target);   -- 改名规划、image_references、blob GC

-- 事务 / 幂等 / 审计
CREATE TABLE txns (
  txn_id INTEGER PRIMARY KEY, op_id TEXT UNIQUE, command TEXT NOT NULL,
  actor TEXT NOT NULL,                        -- session:<8位> | device:<id> | admin
  request_sha TEXT, response BLOB,            -- 只存成功提交的响应；30 天后置 NULL
  first_seq INTEGER, last_seq INTEGER, created_at TEXT NOT NULL
);

-- 全局变化日志：SSE 与增量拉取共用。AUTOINCREMENT + SQLite 单写者 ⇒ 提交顺序 = seq 顺序
CREATE TABLE changes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  txn_id INTEGER NOT NULL REFERENCES txns(txn_id),
  scope TEXT NOT NULL CHECK (scope IN ('public','lockbox','lockbox_manifest')),
  key TEXT NOT NULL,           -- public = 路径（改名写旧路径 exists=0 与新路径 exists=1 两条）；lockbox = item_id
  node_id INTEGER, exists_ INTEGER NOT NULL CHECK (exists_ IN (0,1)), sha TEXT, kind TEXT
);
CREATE INDEX changes_key ON changes(scope, key, seq);
-- 压缩：90 天前同 key 只留最新一行，推进 meta.changes_floor_seq

-- 版本历史（存写后的状态；最新一条 = 当前 = last-good）
CREATE TABLE revisions (
  rev_id INTEGER PRIMARY KEY,
  node_id INTEGER NOT NULL REFERENCES nodes(node_id),
  path_at TEXT NOT NULL, sha TEXT, inline BLOB, blob_sha TEXT,
  reason TEXT NOT NULL CHECK (reason IN ('import','create','edit','rename','move','trash',
                                         'restore','purge','conflict','revert','migrate')),
  txn_id INTEGER NOT NULL REFERENCES txns(txn_id),
  device TEXT, created_at TEXT NOT NULL,
  sealed INTEGER NOT NULL DEFAULT 0     -- 0 = 合并窗口内，可被同设备同条目的下次编辑原地覆盖
);
CREATE INDEX revisions_node ON revisions(node_id, rev_id DESC);
CREATE INDEX revisions_blob ON revisions(blob_sha) WHERE blob_sha IS NOT NULL;

-- 密匣：服务器只存密文
CREATE TABLE lockbox_manifest (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  body TEXT NOT NULL, sha TEXT NOT NULL,      -- 现 .shard/lockbox.json 原文（+ KDF 参数）
  revision INTEGER NOT NULL, seq INTEGER NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE lockbox_items (
  item_id TEXT PRIMARY KEY,                   -- 信封明文 id（公开图链接校验需要）
  envelope TEXT, envelope_version INTEGER NOT NULL,
  legacy_path TEXT,                           -- v1 导入路径（lockbox/notes 含明文标题），升级到 v2 后清空
  sha TEXT, size INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 1, seq INTEGER NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT,
  CHECK ((deleted_at IS NULL) = (envelope IS NOT NULL))
);
CREATE TABLE lockbox_revisions (rev_id INTEGER PRIMARY KEY, item_id TEXT NOT NULL,
  envelope TEXT NOT NULL, sha TEXT NOT NULL, txn_id INTEGER NOT NULL, created_at TEXT NOT NULL);
```

**path 唯一性（含回收站）**
1. 进回收站 = 路径改成 `.trash/<原路径>`，与现在的语义一致（`lib.rs` 的 `move_to_trash`），所以一个唯一索引
   同时覆盖正常条目与回收站。
2. 撞名沿用 `timestamped_collision_path` 的加后缀规则，`exists` 改为按 `path_key` 查。
3. 彻底删除：`path` 置 NULL，行作墓碑保留（同步与修订要用）；部分唯一索引自动忽略。
4. 目录改名 / 移动：对后代做前缀替换
   `WHERE path = :old OR substr(path, 1, length(:old) + 1) = :old || '/'`，**不能用 LIKE**（路径里可能有 `%` `_`），
   `path_key` 用 SQL 函数重算。
5. 路径分段合法性仍由 Rust 校验（`safe_vault_relative_path`）；父目录行必须存在，几个根目录建库时预建。
6. `path_key` 统一 NFC + 小写：APFS 不区分大小写与规范化方式，现有 `exists()`、重名判断、`![](Notes/x.png)`
   都依赖这一点；导入报告列出「只有忽略大小写或规范化才对得上的引用」。

**修订**：同设备、同条目 5 分钟内的编辑合并成一条（`sealed=0` 原地覆盖）；结构操作单独一条。
最新一条就是 last-good，`maps/.last-good`、`.shard/canvas/last-good` 不再需要。
保留策略：全部保留 90 天，之后每个条目每天留当天最后一条（密匣密文修订同样处理）；未引用的 blob 标记满 35 天（大于备份保留期）才删；彻底删除的条目历史再留 30 天（服务启动后每 6 小时清理到期的），「立即抹除」删修订、只被它们引用的 blob 与幂等响应里的副本，再截断 WAL（S9 已实现）。

### 2.2 blobs.db（图片与 > 1 MiB 的文件）

`auto_vacuum=INCREMENTAL`，只追加。

```sql
CREATE TABLE blobs (
  id INTEGER PRIMARY KEY,                     -- 大 BLOB 用 rowid 表 + 增量 blob I/O
  sha TEXT NOT NULL UNIQUE, size INTEGER NOT NULL, mime TEXT NOT NULL,
  data BLOB NOT NULL, created_at TEXT NOT NULL,
  unreferenced_since TEXT                     -- GC：nodes 与 revisions 都不引用且超过宽限期才删
);
```

顺序固定为「先提交 blob，再提交引用」（WAL 模式下跨 ATTACH 库的事务不原子）。GC 宽限期 > 备份保留期。

### 2.3 auth.db（认证，不随内容回滚）

```sql
CREATE TABLE owner (id INTEGER PRIMARY KEY CHECK (id = 1), user_handle BLOB NOT NULL,
  auth_epoch TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE passkeys (cred_id BLOB PRIMARY KEY, passkey_json TEXT NOT NULL, label TEXT,
  created_at TEXT NOT NULL, last_used_at TEXT, revoked_at TEXT);
CREATE TABLE sessions (id_hash BLOB PRIMARY KEY, created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
  idle_expires_at TEXT NOT NULL, absolute_expires_at TEXT NOT NULL, step_up_at TEXT,
  user_agent TEXT, ip TEXT, revoked_at TEXT) WITHOUT ROWID;
CREATE TABLE devices (device_id TEXT PRIMARY KEY, name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('desktop','cli')), token_hash BLOB NOT NULL UNIQUE,
  scopes TEXT NOT NULL, created_at TEXT NOT NULL, last_seen_at TEXT, last_ip TEXT, revoked_at TEXT);
CREATE TABLE pairing_requests (device_code_hash BLOB PRIMARY KEY, user_code TEXT NOT NULL UNIQUE,
  client_name TEXT, kind TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, approved_at TEXT, consumed_at TEXT);
CREATE TABLE setup_tokens (token_hash BLOB PRIMARY KEY,
  purpose TEXT NOT NULL CHECK (purpose IN ('first_passkey','recover')),
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT);
CREATE TABLE audit_log (id INTEGER PRIMARY KEY, at TEXT NOT NULL, actor TEXT NOT NULL,
  event TEXT NOT NULL, ip TEXT, user_agent TEXT, detail TEXT);
```

### 2.4 一致性规则

- 每个写命令是**一个** `BEGIN IMMEDIATE` 事务：改 `nodes` → 重算投影 → 写 `revisions` → 分配 `changes.seq` →
  写 `txns`。seq 只能在写事务内分配，否则并发写会产生乱序 seq，增量拉取永久漏数据。
- 不用时间戳做同步游标（时钟偏移会静默漏数据）。
- 进程内只有一个写连接（单写者），读走连接池。
- 所有写请求带 `Idempotency-Key`（op_id）。同 op_id 且同 `request_sha` 的重试直接返回记录的响应；
  同 op_id 不同载荷返回 422。`write_canvas` 现有的「同一次保存的重试判为成功」推广到所有写命令。

## 3. 服务端 API（`crates/shard-server`）

| 端点 | 说明 |
|---|---|
| `POST /api/rpc/{命令名}` | 命令名与 DTO 与现有 Tauri 命令一一对应；参数结构体 `rename_all = "camelCase"`（与 Tauri 的参数映射一致）。错误体 `{code, message}`，`STALE_BASE` → 409，`NOT_FOUND` → 404，校验失败 → 422 |
| `GET /api/events` | SSE。`id` = seq，`data` = `{vault, changes:[{path,exists,sha}]}`，与 `vault_watch.rs` 的 `vault-changed` 同形；支持 `Last-Event-ID`，低于 floor 时推 `resync`；20 秒心跳 |
| `GET /api/files/<路径>` | Cookie 鉴权；ETag = sha；内容寻址路径 `immutable`；SVG 照搬 `vault_asset_protocol.rs` 的 sandbox CSP；`nosniff`、`CORP: same-origin` |
| `GET /api/sync/changes?since=&limit=` | `{vaultId, epoch, floorSeq, headSeq, changes, more}`；`since < floorSeq` 或 epoch 不符 → 410 `RESYNC_REQUIRED` |
| `GET /api/sync/manifest` | NDJSON，全部在用 key 与 sha |
| `POST /api/sync/fetch` | 按 key 批量取内容（gzip） |
| `HEAD/GET/PUT /api/blobs/<sha>` | PUT 时服务端重算 sha256，不一致 422；已存在直接 200 |
| `/api/auth/*`、`/api/device/*` | 见 §7 |
| `GET /healthz` | 存活探针 |
| 其余 GET | 静态托管网页 |

请求头：`Idempotency-Key`（写）、`X-Shard-UTC-Offset`（写，客户端时区偏移，碎片 id 与 `fragments/YYYY/MM`
按它计算——VPS 跑 UTC，否则北京时间早上新建的碎片会归错月份）、`X-Shard-Request: 1`（非 GET，CSRF）。

搜索继续用内存快照 + `shard_core::search` 精确扫描（中文 1–2 字查询 FTS 命中不了）。
wikilink 解析从 `src/lib/wikilink.ts` 移植到 `shard-core/wikilink.rs`，保存时同事务派生 `origin = wikilink`
的关系（取代前端逐条 link/unlink 的非原子做法），TS 与 Rust 共用 fixture 做一致性测试。

## 4. 92 个命令的去向

| 组 | 命令 | 说明 |
|---|---|---|
| A 服务端 RPC，名字与参数不变（48） | 碎片：list_fragments、create_fragment、update_fragment、update_fragment_tags、set_fragment_archived、set_fragment_pinned、set/remove_fragment_property、read_property_registry、register_property_type、link/unlink_fragments、create/read/write_graph_fragment、import_graph_file_to_timeline、convert_note_to_fragment、convert_fragment_to_note；资料库：list_library_tree、list_mind_maps、list_csv_files、create_library_note/dataset/directory、rename/move/delete_library_entry、restore_from_trash、purge_from_trash、empty_trash、image_references、existing_vault_images；导图 / 画布：create/read/write/delete_mind_map、create/read/write_canvas、list_diagram_documents、split_canvas；数据集：read_dataset、apply_dataset_ops、create_dataset、normalize_csv_file、read_csv_file；搜索：search_vault、read_search_target | create_fragment 增加可选 `id`、`operationId`、`utcOffset`、`conflictOf`；碎片 7 个写命令的密匣分支在客户端分流；list_fragments 只返回公开条目与信封列表，git 字段替换；搜索只搜公开内容，客户端合并密匣结果；read_csv_file 返回字节；画布去掉二进制 IPC |
| B 改语义（12） | watch_vault（→ SSE / 桌面同步引擎发同形事件）、save_fragment_image（原始字节上传）、save_image_attachment_from_path、import_library_files（桌面读路径后上传，网页用 File）、read_import_csv_file（网页本地解析）、read_import_xlsx_file 与 convert_table_document_to_markdown（无状态转换端点，限 25 MB）、read_fragment_image（→ /api/files）、fragment_image_file_path 与 open_vault_image（桌面把 blob 落到缓存文件再打开，网页开新标签）、open_csv_file（导出副本，提示改动不回流）、move_fragment_to_lockbox（客户端加密后调原子的 `replace_with_envelope`，同事务删明文修订） | |
| B' 密匣改为客户端执行（7） | setup_lockbox、unlock_lockbox、lock_lockbox、change_lockbox_password、reset_lockbox_password、list/apply_lockbox_dialect_migration | 服务端只提供 manifest 与信封的读取、CAS 写入 |
| C 仅桌面（12） | set_window_controls_hidden、set_canvas_grab_cursor、set_reminder_schedule、cli_install_status、install_cli、uninstall_cli、set_cli_install_declined、reveal_fragment_image_in_dir、write_export_file、save_exported_image、save_recovery_key、copy_exported_image | 网页：导出改浏览器下载，复制图片用 ClipboardItem，恢复密钥下载为 .txt |
| D 删除（13） | set_vault_path、initialize_vault_git、set_vault_remote、github_cli_status、create_github_vault_repo、sync_vault、checkpoint_vault、migrate_legacy_notes、preflight_outline_upgrade、run_outline_upgrade、list/apply_markdown_dialect_migration、organize_fragments | 一次性迁移改为导入器前置检查；退出前 checkpoint 改为「清空 outbox」 |
| 新增 | append_fragment、append_dataset_records（CLI）；put_lockbox_item、replace_with_envelope、get/put_lockbox_manifest；修订 list/read/restore；export zip；同步与认证端点 | `--graph-*` 由 CLI 本地完成「读 → 改 → CAS 写」 |

## 5. 桌面客户端模式与同步引擎

**分两步交付**（2026-10-27 定）：

- **S8a 在线客户端**：桌面「连接服务器」后，前端走与网页同一套命令（`invoke(命令, 参数)`），由 Rust 带设备令牌
  （钥匙串，服务名与命令行分开，可单独吊销）转发到 `/api/rpc`；图片经 `shard-asset` 协议代理 `/api/files`；
  Rust 订阅 SSE 并转成现有的 `vault-changed` / `lockbox-changed` 事件。界面与网页完全一致，密匣走 S7 的 wasm 客户端。
  配对、令牌存取、带幂等键与重试的 RPC 客户端从命令行抽成共享的 `crates/shard-remote`，桌面与命令行同一份。
  这一步之后桌面就能在切换后照常用（要联网）。
- **S8b 离线**：下面的副本 + overlay + outbox，在 S8a 的转发层底下接入：在线照旧直发，离线落 overlay 与 outbox，
  联网后先拉后推。

`replica.db` 与服务器同一套 shard-store schema，作为「已确认层」，只在拉取时写入；另有乐观层 `overlay`
与 `outbox`。读 = 「已确认层 ∪ overlay」上跑同一套读函数（离线浏览、搜索可用）。在线写直接转发服务器；
离线写在 overlay 上跑同一套命令实现，并把 RPC 调用原样记进 outbox。

```sql
CREATE TABLE sync_state (id INTEGER PRIMARY KEY CHECK (id = 1), server_url TEXT NOT NULL,
  vault_id TEXT NOT NULL, epoch TEXT NOT NULL, cursor_seq INTEGER NOT NULL DEFAULT 0,
  device_id TEXT NOT NULL, last_pull_at TEXT, last_push_at TEXT);
CREATE TABLE outbox (
  op_seq INTEGER PRIMARY KEY AUTOINCREMENT, op_id TEXT NOT NULL UNIQUE,   -- UUIDv7 = 幂等键
  command TEXT NOT NULL, args_json TEXT NOT NULL,     -- 已含客户端 id / createdAt / utcOffset
  target TEXT NOT NULL,                               -- fragment:<id> | lockbox:<id>
  base_sha TEXT, blob_deps TEXT,                      -- 先传完 blob 才能发
  state TEXT NOT NULL CHECK (state IN ('pending','inflight','acked','conflicted','failed')),
  attempts INTEGER NOT NULL DEFAULT 0, next_try_at TEXT, last_error TEXT,
  created_at TEXT NOT NULL, result_json TEXT);
CREATE TABLE overlay (scope TEXT NOT NULL, key TEXT NOT NULL, exists_ INTEGER NOT NULL,
  inline BLOB, blob_sha TEXT, sha TEXT, op_seq_max INTEGER NOT NULL, PRIMARY KEY (scope, key));
CREATE TABLE pending_blobs (sha TEXT PRIMARY KEY, mime TEXT, size INTEGER, uploaded INTEGER NOT NULL DEFAULT 0);
```

**outbox 合并**（同一目标）：连续 update 合并成一条，保留第一条的 base_sha 与最后一条的内容；create 后的
update 折进 create；pinned、properties、仅改标签按字段后写覆盖先写。

**离线允许**：create_fragment（客户端生成 id 与时间）、update_fragment（CAS）、update_fragment_tags、
set_fragment_pinned、set/remove_fragment_property、save_fragment_image（内容寻址幂等）、手动 link/unlink
（wikilink 关系由服务端派生，不进 outbox）、密匣条目正文与标签（本地加密后 `put_lockbox_item`，带 base revision）。

**离线禁止**（界面明确提示「需要联网」）：资料库新建、改名、移动、删除、回收站、转换、导入；导图、流程图、
数据集写入；密匣 setup 与改口令；属性注册表。

**一轮同步**（单飞）：
1. 拉：changes 按 key 合并，批量取内容，本地事务写入，提交后才推进游标。410 或 epoch 变化 → manifest 全量对账；
   副本里「服务器没有、且 seq 大于服务器 head」的条目作为冲突安全的新建排进待推（恢复备份后找回 T 之后的数据）。
2. 推：按 op_seq 重放，同一 op_id。2xx 确认；有 blob 依赖先 PUT。409 STALE_BASE → 用本地内容
   `create_fragment{conflictOf, operationId: op_id + ":conflict"}`（冲突副本 id 由 op_id 确定性派生，重试不重复），
   原操作标 conflicted；404（服务器已删除）同样走冲突副本，**绝不复活**；其他 4xx 标 failed 并显示；
   5xx 或网络错误指数退避（1–60 秒，带抖动），op_id 不变。
3. 再拉一次；某 key 的操作全部确认后丢掉它的 overlay；向前端发同形 `vault-changed` 与 `sync-status`。

**重连**：SSE 用 fetch 流（能读到 401），1–60 秒退避；macOS 唤醒与网络变化主动同步一次。

**网页**：第一版只做 IndexedDB 草稿（断网不丢字）+ 断线横幅；只读离线缓存与「添加到主屏幕」放 S12；
网页离线写至少等桌面引擎真实跑过几周再考虑。

## 6. 密匣端到端加密

服务器永不解密。三层：

| 层 | 位置 | 内容 |
|---|---|---|
| 加密格式 | `crates/shard-lockbox`（已完成 S7a） | Argon2id 口令派生、主密钥两份包裹、免密写入 RSA 密钥对、信封加解密；格式与报错文案与旧桌面一字不改。固定向量 `tests/fixtures/lockbox-v1.json` 与旧桌面真实生成的 `lockbox-desktop-v1.json` |
| 密匣领域逻辑 | `shard-lockbox::domain`（S7b） | 载荷（frontmatter 原文 + 正文）的读改写、标签规整、置顶 / 归档 / 属性、密匣笔记、公开内容移入密匣、内存搜索。运行在抽象的「密匣条目存储」上：桌面本地模式背后是 `lockbox/` 下的文件，网页与将来的桌面客户端模式背后是与服务器同步的内存副本 |
| 浏览器 | `crates/shard-lockbox-wasm` → `src/lib/lockbox-client/`（S7c） | 同一份 Rust 编成 wasm（wasm-bindgen）；主密钥只在 wasm 内存里，TS 只拿不透明句柄。传输层把密匣相关命令（解锁、列表合并、碎片写命令的密匣分支）在客户端执行，再用下面的服务端接口带 CAS 写回 |

选 wasm 而不是在 TS 里重写：难点不是加密（WebCrypto 都有），而是 frontmatter 保真写回（G-P0）等约 1000 行领域逻辑，
两份实现必然漂移。加密也一并走 wasm，避免第二套实现；浏览器只负责网络与租约计时。

**服务端接口（S7b）**：`lockbox_snapshot`（manifest 原文 + 全部信封 + 游标）；`lockbox_apply`（一批 put / delete，
每条带 `expectedSha`，manifest 可选带 CAS，整批一个事务）；`seal_fragment_into_lockbox`（公开碎片移入密匣：同一事务里
彻底删除公开文件、删它的全部明文修订与幂等响应里的副本，并写入客户端加密好的信封）。SSE 增加 `lockbox` 范围的变化。
服务端校验信封能解析、信封 id 与条目 id 一致，不校验内容。

- **v2 信封**：AAD = `"shard-lockbox-v2|" + id`，解密后核对载荷内 id 与信封 id 一致（防服务器调换密文）；
  路径、标题、所在分区（fragments / archive / notes）挪进载荷，服务端的 `legacy_path` 清空（修掉 `lockbox/notes`
  明文文件名泄露标题）。信封 id 保持明文（随机，泄露有限；公开图「不能链接密匣碎片」的校验需要它）。
  v1 照常可读，写回时升级。代价：v2 信封旧版 App 读不了，导出 zip 回退旧版 App 时密匣需要新版。
- **KDF**：现 Argon2id m=19 MiB、t=2。manifest 增加可选的派生参数字段，缺省即现参数；在 iPhone Safari 上实测
  wasm 耗时后提到约 1 秒，口令那份在解锁时重包，恢复密钥那份（192 bit 熵）只在重新生成时升级。
- 会话与租约全在客户端：每设备、每标签页各自 15 分钟，主密钥只在内存。服务器没有「已解锁」状态；会话过期或
  注销时清掉密钥。改口令只重包 manifest（CAS），其他设备内存里的主密钥不受影响。
- 密匣搜索只在客户端内存，与服务端公开搜索结果合并显示。
- 公开内容移入密匣：同事务删除它的明文修订（连接开 `secure_delete`，抹除后截断 WAL）；界面提示已有备份与旧
  GitHub 历史里的旧版本不会消失。
- 设置开关「允许在网页解锁密匣」，默认开，存服务器（所有浏览器一致）；关掉后服务器拒绝向浏览器会话下发信封。
  它防的是被盗的浏览器会话与误操作，**防不了被篡改的网页**（篡改的网页可以无视开关）——那种情况唯一的防线
  是不在网页输入密匣口令，威胁模型如实写明。

## 7. 认证与安全

- **通行密钥**：webauthn-rs；RP ID = 域名，origin 精确匹配，要求 UV；单用户，allowCredentials 列出全部凭据；
  签名计数与备份标志每次登录后更新。第一把用 `shard-server setup` 打印的一次性链接注册（15 分钟、一次性）。
  换域名会让全部通行密钥失效，需 SSH 重跑 setup。
- **会话**：Cookie `__Host-shard`，`HttpOnly; Secure; SameSite=Strict; Path=/`；32 字节随机，库里只存 sha256；
  闲置 14 天、绝对 90 天；登录时轮换（登录本身算一次验证）。敏感操作要求 10 分钟内重新验证通行密钥：增删通行密钥、
  批准设备配对、导出全部、「立即抹除」删除历史、注销其他会话（RPC 里标 `Access::Sensitive`，成功后记审计）。
  彻底删除与清空回收站**不**要求：有 30 天找回期，可逆；要求的话桌面客户端用设备令牌就清不了回收站。
- **CSRF**：SameSite=Strict；非 GET 必须带 `X-Shard-Request: 1`，`Origin` 等于配置地址，`Sec-Fetch-Site` 为
  `same-origin`；只接受 JSON 或指定字节类型；不开 CORS；GET 无副作用。
- **CSP**：`default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline';
  img-src 'self' blob: data:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none';
  frame-ancestors 'none'; form-action 'self'`。`index.html` 的内联首帧主题脚本移到 `/theme-init.js`；
  `style-src 'unsafe-inline'` 是否可去掉，逐个核对 xyflow、glide、sonner。另加 HSTS（一年）、
  `Referrer-Policy: no-referrer`、COOP / CORP same-origin、Permissions-Policy。
- **限流**：发起登录每 IP 每分钟 10 次，输入配对码每分钟 5 次；全局连续失败指数退避。
- **设备配对**（RFC 8628 式）：客户端 `POST /api/device/start` 得 `device_code` 与 8 位 `user_code`（10 分钟、
  最多 5 次尝试）；在已登录浏览器 `/pair` 输入并重新验证通行密钥后批准；客户端轮询 `POST /api/device/token`
  得 `shd_dev_` 开头的 256 bit 令牌。库里只存 sha256，带作用域，可单独吊销。桌面存 macOS 钥匙串且只在 Rust 层，
  网页 JS 拿不到；CLI 单独配对，Linux 退回 0600 文件。
- **审计**：登录成败、通行密钥增删、会话签发与吊销、配对与吊销、setup / recover 链接签发与使用、导出、
  彻底删除、清空回收站、manifest 替换、导入、恢复、epoch 轮换。不记请求体。
- **恢复路径**：通行密钥全丢 → SSH 执行 `shard-server admin recover`；手机丢失 → 桌面吊销其会话；
  服务器被入侵 → 轮换 auth_epoch、吊销全部令牌、从备份恢复内容并轮换 epoch。
- **运维**：systemd 非 root、`ProtectSystem=strict`、`NoNewPrivileges`、`Restart=always`；CI 跑
  `cargo deny` / `cargo audit`；tracing 日志脱敏；只信任 Caddy 传来的 X-Forwarded-For。

## 8. 备份与恢复

- 每小时 `VACUUM INTO`（或 backup API）生成本地快照，**不能直接 cp**；每天把 shard.db 与 blobs.db 打包，
  用 age **公钥**加密后传到异地（目标在 S3 时确认）。VPS 上只有公钥，私钥由用户离线保管。
- Litestream 作持续复制补充；0.5 版起改用 LTX 格式，是否仍支持 age 加密实施时核实，不支持就以每日加密快照为主。
- 恢复 = 停服 → 换库 → 轮换 `meta.epoch` → 启动；auth.db 不回滚，恢复手册里另有「轮换 auth_epoch」一步。
- 恢复演练是交付项：S3 用测试数据演练一次；S10 起每周自动恢复最新快照到临时目录，跑 `integrity_check` 与
  verify，失败告警。
- 逃生通道：设置里「导出全部为 zip」，结构即原 vault 目录，旧版 App 可直接打开。

## 9. 导入、导出与正式切换

- `shard-server import --vault <路径>` 只读导入，按原字节入库，保留修改时间与创建时间。
- **前置检查**（不满足就拒绝，先用旧版 App 跑完迁移）：`.shard/format.json` 的 markdownDialect = 2；没有
  `archive/` 目录；fragments 里没有带 note 标签的条目；没有未升级的旧大纲。
- **特殊文件逐项处理，不认识的不许静默丢弃**：`.shardtable.json`、`.shardcanvas.json` 原样入库；无扩展名旧图
  （`assets/2026/06/<时间戳>-png`）原样入库；`maps/.last-good` 与 `.shard/canvas/*` 丢弃（主文件损坏时改用
  last-good 并写进报告）；上一轮残留的 `.shard/notes.sqlite3` 丢弃并报告；空目录（如 `debts/`）报告后按目录入库；
  `.gitattributes`、`.gitignore`、`.DS_Store` 丢弃。
- **校验**：真实库**副本**上跑「导入 → 导出 → `diff -r`」逐字节一致，只允许事先列明的丢弃清单不同；
  按类别核对数量与哈希；重复导入幂等。
- **正式切换**（S11，用户确认后执行）：先替换 CLI 二进制 → 最后一次 Git 同步 → 导入 → 对旧 vault
  `chflags -R uchg`（旧 CLI 发现目录不见会静默重建，设成不可改让残留写入明确报错）→ 桌面切到客户端模式。
  旧 vault 与 GitHub 仓库保留只读；回滚 = 导出后用旧版 App 打开。同时停用 iOS App。

## 10. 前端改造

- 传输层 `src/lib/transport/{index,tauri,http,capabilities}.ts`；所有直接 invoke 的地方改走它
  （`src/lib/api.ts`、`src/features/datasets/api.ts`、`src/features/canvas/api.ts`、`src/lib/export-file.ts`、
  `src/workspace/use-vault-watch.ts`、`src/lib/use-table-document-drop.ts`）。
- 桌面专属能力由 capability 开关隔离，不再用 `isTauri()`：对话框、原生拖放、红绿灯、Dock、CLI 安装。
  网页：`<input type=file>`、DOM 拖放、浏览器下载。`vaultImageUrl` 生成 `/api/files` 地址。
- 身份：`vaultPath` 字段名保留，值为 `shard://<域名>/<vault_id>`；`gitStatus` → saved / sync_pending / sync_failed；
  状态栏显示连接与同步状态。
- `vault-guide.tsx` 的选库改为「连接服务器 / 设备配对」；新增登录页、设置页（通行密钥、设备、会话、网页解锁密匣开关）。
- 移动端：`viewport-fit=cover` 与 safe-area；网页去掉 80px 红绿灯避让；输入框字号 ≥ 16px；长按菜单用 pointer
  事件；不能拖放的地方提供「移动到…」；悬停按钮在触屏可达；`dvh`；VisualViewport 处理键盘；表格在手机上只看
  并能单格编辑。

## 11. 阶段与验收

| 阶段 | 内容 | 验收 |
|---|---|---|
| S0 | 本文档；修订与新方向冲突的文档与 AGENTS.md | 文档评审 |
| S1 | `crates/shard-store`：Vfs（Fs / Sqlite）、nodes、投影、changes、txns、revisions、blobs；shard-core 时区参数化；wikilink 移植 | 现有测试在两种 Vfs 上通过；随机操作序列在两种实现上得到相同路径树与 sha；seq 同事务分配的并发测试；wikilink TS/Rust 一致性测试 |
| S2 | import / export / verify | 真实库副本「导入 → 导出 → diff -r」逐字节一致；前置检查拒绝路径有测试；旧版 App 能打开导出结果 |
| S3 | shard-server（RPC、SSE、files、blobs、认证、限流、安全头）+ 部署到 VPS（Caddy、systemd、备份） | Mac Safari 与 iPhone 在真实域名用通行密钥登录；测试数据完成第一次恢复演练 |
| S4 | CLI 改调服务器 RPC（设备令牌）；更新 guide.rs | CLI 集成测试在临时服务器上通过；`--expect`、错误码、JSON 输出不变 |
| S5 | 前端传输层 + 网页版 | 现有 Playwright 在 Tauri mock 下全绿；新增 `tests/e2e/` 真服务器用例 |
| S6 | 移动端布局 | WebKit iPhone 视口端到端用例；真机人工清单 |
| S7 | 密匣端到端（S7a 加密格式 crate ✅；S7b 领域逻辑 + 服务端接口；S7c wasm + 网页客户端；v2 信封、KDF 升级、网页解锁开关） | 固定测试向量互解；写入金丝雀明文后 shard.db / blobs.db / WAL grep 命中 0 |
| S8 | 桌面客户端模式：S8a 在线客户端（共享 shard-remote、Rust 转发 RPC、资源代理、SSE 桥）；S8b 离线（副本、outbox、离线子集） | 双客户端断网脚本覆盖 server-and-sync-plan §十一 的 9 条 + 恢复后 epoch 对账找回数据 |
| S9 | 版本历史界面 + 导出 zip | 恢复任意修订后 sha 与当时一致 |
| S10 | 生产加固 + 真实数据副本恢复演练 + 监控 | 每周自动恢复演练通过；healthz 监控 |
| S11 | 正式切换 | 用户确认；切换后各类数量与哈希一致 |
| S12+ | 网页只读离线、添加到主屏幕、提醒推送 | 另行规划 |

真服务器端到端：`playwright.e2e.config.ts` 同时起 `shard-server --data-dir <临时目录>` 与 Vite（同源代理
`/api`）；种子数据从 `tests/fixtures/vault-golden` 导入，每 worker 独立库；Chromium 用 CDP
`WebAuthn.addVirtualAuthenticator` 走真实通行密钥，WebKit 用 `test-auth` feature 的测试端点（发行版不编译）。

## 12. 数据丢失风险表

| 风险 | 场景 | 规避 |
|---|---|---|
| 迁移丢数据 | 导入漏掉文件或改写字节 | 只读导入；副本上逐字节往返校验；不认识的文件拒绝而不是丢弃；旧 vault 与 GitHub 保留只读 |
| 同步漏数据 | seq 乱序、时间戳游标 | seq 同事务分配；不用时间做游标；并发测试 |
| 冲突丢数据 | 两端同时改同一条 | CAS；冲突永远另存副本，不覆盖 |
| 已删除内容复活 | A 删、B 离线编辑后上线 | 墓碑；404 走冲突副本，不 update 复活 |
| 重试产生重复或误判冲突 | 响应丢失后重试 | Idempotency-Key + txns；冲突副本 id 由 op_id 确定性派生 |
| 恢复备份丢掉之后的写入 | 恢复到时间 T | epoch 轮换 → 客户端全量对账，副本里 T 之后的条目推回 |
| 恢复备份让吊销令牌复活 | auth 随内容回滚 | auth.db 独立，不回滚；恢复手册轮换 auth_epoch |
| 网页断网丢字 | 编辑中途断网 | IndexedDB 草稿（第一版就有） |
| 单 VPS 损坏 | 磁盘、误操作、被入侵 | 每小时快照 + 每日 age 加密异地；每周自动恢复演练；桌面副本本身是完整离线备份 |
| 切换窗口期旁路写入 | 旧 CLI / AI 写旧 vault | 先换 CLI；旧 vault `uchg` 不可改 |
| 大文件拖垮库 | 50 MiB 图片进 WAL | blob 独立库、增量 I/O、先 blob 后引用；单张上限 50 MiB |

## 13. 威胁模型

| 攻击者 | 能拿到 | 防护 |
|---|---|---|
| 网络窃听 | 流量 | TLS（Caddy）、HSTS |
| 互联网扫描、撞库 | 登录端点 | 只有通行密钥，没有密码；限流；审计 |
| 跨站请求 | 用户已登录的浏览器 | SameSite=Strict + 自定义头 + Origin / Sec-Fetch-Site 校验；无 CORS |
| 上传内容里的脚本（SVG） | 同源执行 | SVG sandbox CSP、nosniff、CORP；全站严格 CSP |
| VPS 服务商、磁盘或备份泄露 | 库文件、快照 | 公开内容：无保护（单用户自用，接受）；密匣：只有密文（AES-GCM + AAD）；备份 age 加密 |
| 服务器被攻破（运行时） | 内存、下发的网页 | 公开内容全部暴露；密匣：桌面端安全，**网页端可被篡改网页窃取口令**——设置里可关网页解锁 |
| 设备丢失 | 已登录的会话或令牌 | 会话与设备令牌可单独吊销；桌面令牌在钥匙串 |
| 离线爆破密匣 | 拖库后拿到 manifest | Argon2 参数升级到约 1 秒；恢复密钥 192 bit |
