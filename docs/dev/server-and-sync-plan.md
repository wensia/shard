# Shard：自建服务端与多端同步（历史方案）

> 状态：已于 2026-08-03 暂停并归档。Shard 当前重新以
> Markdown / 加密文件作为唯一真相源，由本地 Git 自动提交并通过 remote
> 执行同步。本文仅保留 SQLite 与自建服务端方案的设计背景；对应客户端数据库、
> `shard-core`、`shard-server` 和部署代码已从当前构建中移除。

## Context

本地侧的反转已经走到第 4 步（附件入库）。下一步是把数据的最终归属搬到自己的服务器上：Tauri 端退化为「壳 + 本地库」，离线照常读写，联网后同步。

**已确定的决策：**

| 决策 | 选择 |
|---|---|
| 服务端形态 | Rust + axum，部署在自己的 VPS，与客户端共享 `shard-core` |
| 服务端数据库 | **VPS 本地 SQLite 文件**（不用 Turso 托管） |
| 用户模型 | **单用户自用**，多设备 |
| 附件二进制 | **VPS 本地磁盘**，内容寻址存放 |
| 本轮范围 | 服务端骨架 + 同步协议，一次做到能同步 |

**为什么服务端数据库不用 Turso 托管。** 同步已经确定要在应用层自建（理由见下条），libSQL 的复制能力用不上，托管只剩「省掉自己做备份」这一项收益，代价是每次查询都走网络、多一个外部依赖与账单。后端与 DB 同机的零延迟更值钱，备份用 Litestream 持续复制到对象存储即可覆盖。

**为什么同步必须自建。** libSQL 的帧同步是物理 WAL 复制，没有行级合并语义，冲突是不可恢复的硬错误（`libsql-0.9.30/src/sync.rs` 的 `sync_offline`）。拿它做多端合并会在双端离线写之后永久分叉。这一点在 `notes/mod.rs` 里已经写死为 `NotesSpec::remote() -> None`，不因为部署方便而回头。

## 一、已经就位的地基

这一轮不需要重新设计存储模型——前几轮已经把同步需要的东西全部预留好了：

| 能力 | 落点 | 状态 |
|---|---|---|
| 乐观并发 | `fragments.revision` + CAS UPDATE | 已有 |
| 墓碑（防幽灵复活） | `fragments.deleted_at`，永不硬删 | 已有 |
| 服务端增量游标 | `fragments.seq`（客户端为 NULL） | 列已建，无人写 |
| 冲突副本标记 | `fragments.conflict_of` | 列已建，无人写 |
| 设备来源 | `fragments.updated_by_device` | 列已建，只有 `soft_delete` 写过 |
| 两端共享逻辑 | `crates/shard-core` | crate 已建，目前只有 FTS 分词 |
| 密文与明文隔离 | 表级 CHECK，密匣明文永不落库 | 已有 |
| 归档可逆 | `archived_at` 打标而非移动目录 | 已有 |

缺的是：服务端本体、`seq` 的分配者、outbox 队列、设备 id 的生成、以及把这些接起来的同步引擎。

## 二、前置：先把本地反转做完

**这一段不能跳。** 当前笔记与密匣的写路径仍然是「写文件 → 影子写入库」，文件还是真相源。此时接同步协议，对账关系会变成「文件 ↔ 本地库 ↔ 服务端」三方——原计划反转本地存储的全部理由就是要避免这个局面。

所以服务端工作开始前，先完成本地反转的剩余两步：

- **第 5 步 写路径反转**：五个写命令（`create_fragment` / `update_fragment` / `update_fragment_tags` / `set_fragment_pinned` / `set_fragment_archived`）改为「写 DB 事务 → 立即返回 → 不碰文件」，`shadow.rs` 退役。密匣写路径拆出 `encrypt_lockbox_fragment` 后直接填 `cipher_*` 列。
- **第 6 步 导出流补全**：`export_vault_markdown` 覆盖笔记 / 密匣 / 导图 / 附件，`verify_export` 同步扩展。

第 6 步不是可选项：`lossless` 为 true 是「库已经是真相源」的证明。没有这个证明就把数据推上服务器，一旦服务端与本地都出问题，手里没有可验证的逃生产物。

新 id 格式也在第 5 步一并换掉：现有 `unique_suffix` 只有 16 bit 熵，多端并发写会碰撞。改为 `<时间戳>-<8位hex随机>-<设备短码>`，旧 id 原样保留。

## 三、Workspace 与 shard-core 上移

根目录建 workspace：

```toml
[workspace]
resolver = "2"
members = ["src-tauri", "crates/shard-core", "crates/shard-server"]
```

上移进 `shard-core` 的东西，判据是「两端都要用且必须保持一致」：

- **schema DDL**：两端用**同一套** `MIGRATIONS`。服务端确实用不到 `import_ledger` / `export_*` / FTS，但让两端 schema 完全一致比省几张表值钱得多——schema 漂移是这类系统最难查的一类 bug。服务端只额外维护一张 `sync_seq` 分配表。
- **数据模型**：`NoteWrite` / `FragmentRow` / `CipherEnvelope` / `MapRow` / `AttachmentRow`。
- **同步 DTO**：推拉两个方向的请求与响应结构，加 serde。
- **内容 hash**：`hash_text` / `hash_bytes`。两端算出的 `content_hash` 必须逐字节一致。

FTS 分词已经在里面了，位置正确——服务端将来若要做服务端搜索，分词口径不能与客户端漂移。

## 四、同步协议

### 形状

单用户，所以全局一个单调序列即可，不必按用户分区。

```
GET  /v1/sync/changes?since=<seq>&limit=<n>   增量拉取，按 seq 升序
POST /v1/sync/push                            批量推送，每条带 base_revision
HEAD /v1/attachments/<hash>                   去重探测
PUT  /v1/attachments/<hash>                   上传字节
GET  /v1/attachments/<hash>                   下载字节
GET  /healthz                                 存活探针
```

### seq 的分配

服务端每次写入成功，在**同一个事务里**取下一个 `seq` 并写进行里：

```sql
UPDATE sync_seq SET value = value + 1 RETURNING value;
```

必须在事务内。分配与写入分开会让并发推送产生乱序的 seq，而增量拉取完全依赖 seq 的单调性——一旦乱序，客户端会永久漏掉中间那批数据。

不用时间戳做游标：时钟偏移会让基于时间的增量静默漏数据。这一点在 schema 注释里已经写明。

### 推送与 CAS

每条推送带 `base_revision`（客户端上次见到的版本）。服务端：

```sql
UPDATE fragments
   SET ..., revision = revision + 1, seq = <新分配>, updated_by_device = ?
 WHERE id = ? AND revision = ?;
-- rows_affected == 0 ⇒ 冲突
```

冲突时**不覆盖**，把服务端当前版本回给客户端。客户端把本地那条另存为冲突副本（新 id，`conflict_of` 指向原 id），然后接受服务端版本。这与导图既有的「另存冲突副本」语义一致——用户永远不会因为同步丢掉自己写的东西。

新建（服务端不存在该 id）用 `INSERT ... ON CONFLICT DO NOTHING` 后检查影响行数，避免把并发新建吞成更新。

### 客户端 outbox

schema v3 追加：

```sql
CREATE TABLE sync_outbox (
    entity_kind   TEXT NOT NULL,   -- fragment | shard_map | attachment | lockbox_manifest
    entity_id     TEXT NOT NULL,
    base_revision INTEGER NOT NULL,
    queued_at     TEXT NOT NULL,
    attempts      INTEGER NOT NULL DEFAULT 0,
    last_error    TEXT,
    PRIMARY KEY (entity_kind, entity_id)
) WITHOUT ROWID;

CREATE TABLE sync_state (
    id              INTEGER PRIMARY KEY CHECK (id = 1),
    last_pulled_seq INTEGER NOT NULL DEFAULT 0,
    last_synced_at  TEXT
);
```

写路径每次成功写库后往 outbox upsert 一行。主键是 `(kind, id)`，同一条实体只保留最新一条待推——离线期间连改十次只需要推最后那一版。

**设备 id** 首次启动生成一次，存 `db_meta`，此后填进 `updated_by_device`。

### 一轮同步的顺序

**先拉后推**。先 pull 拿到服务端最新状态与 seq，再 push 时 `base_revision` 是最新的，能把冲突压到只剩「两端真的同时改了同一条」这一种。

拉取应用规则：
- 本地无该 id → 直接写入
- 本地有，且 outbox 里**没有**它 → 服务端版本覆盖本地
- 本地有，且 outbox 里**有**它 → 真冲突，本地那条另存副本，接受服务端版本，从 outbox 移除

### 密匣

`cipher_*` 列原样同步，服务器全程只见密文，安全模型不变。

`lockbox_manifest` 也是密文，走 CAS 同步（它的 `revision` 列本来就是为并发解锁的覆盖缺陷加的）。

`lockbox_keys.wrapped_private_key` 是**要单独决策的一项**：不同步它，新设备就无法解锁密匣；同步它，服务器被拖库后攻击者可以拿着密文离线爆破主密码。取舍与密码管理器同模型——可接受的前提是 Argon2 参数足够强。本轮的处理：**同步，但作为独立开关暴露给用户**，默认开启，文档写明这个取舍。

### 附件

元数据行走普通同步通道，二进制走三个端点。

上传前先 `HEAD` 探测，服务端已有就跳过——内容寻址让去重变成一次 404/200 判断。`PUT` 时服务端**必须重算 sha256 并校验与 URL 里的 hash 一致**，否则内容寻址的前提就破了。

下载走懒加载：`shard-attachment://` 的协议 handler 在本地缓存缺失时去服务器拉一次再返回。handler 本来就是 async 的，这里天然合适，不会阻塞 UI。

## 五、认证与传输

单用户，认证退化为一个长期 Bearer token：

- 服务端只存 token 的 argon2 hash，比较走常量时间
- Caddy 终止 TLS 并反代到 `127.0.0.1:<port>`，服务本体不监听公网
- 客户端配置 `shard_server_url` + `shard_server_token`，统一放进 `AppConfig`

**已知问题**：`AppConfig` 是明文 JSON，token 会明文落盘。本轮不引入新机制，但记进风险表；换到系统 keychain 是独立的一件事。

## 六、部署

- 数据目录 `/var/lib/shard/`：`notes.sqlite3` + `attachments/<hh>/<hash>`
- systemd unit，`Restart=always`，非 root 专用用户，`ProtectSystem=strict` 只放开数据目录
- Caddy 自动 TLS
- **备份**：Litestream 持续复制 SQLite 到对象存储；附件目录用 restic 定时快照
- **恢复演练是交付项之一**，不是文档里的一句话。没演练过的备份等于没有备份。
- 观测：`tracing` 结构化日志 + `/healthz`

## 七、落地状态

**Phase 0 / A / B 已完成**，但有两项刻意留在后面，理由见「九、未完成」。

| 步骤 | 状态 |
|---|---|
| 0-1 写路径反转，`shadow.rs` 退役 | 已完成 |
| 0-2 导出流补全 + `verify_export` 扩展 | 已完成 |
| A-1 workspace 化，schema/hash/协议上移 `shard-core` | 已完成 |
| A-2 `shard-server` 骨架、认证、迁移 | 已完成 |
| A-3 部署管线（systemd / Caddy / Litestream） | 配置已就绪，**未实际部署与演练** |
| B-1 schema v3 | 已完成（用行上的 `synced_revision` 取代 outbox 表，理由见 schema 注释） |
| B-2 服务端 `seq` 与增量拉取 | 已完成 |
| B-3 服务端 CAS 推送 | 已完成 |
| B-4 客户端同步引擎 | 已完成 |
| B-5 附件端点与懒加载 | 已完成 |
| B-6 密匣 manifest / keys 同步 | **未做**，见下 |
| B-7 前端同步状态与冲突徽章 | 已完成 |

## 八、原落地顺序

每步独立可编译、可测试、可停下。

**Phase 0 — 本地反转收尾**
1. 写路径反转，`shadow.rs` 退役，新 id 格式
2. 导出流补全 + `verify_export` 扩展到导图与附件

**Phase A — 服务端立起来**
3. workspace 化；schema、模型、hash 上移 `shard-core`
4. `crates/shard-server` 骨架：axum、配置、`/healthz`、迁移、Bearer 中间件
5. 部署管线：systemd + Caddy + Litestream + **恢复演练**

**Phase B — 同步**
6. 客户端 schema v3：`sync_outbox` / `sync_state` / 设备 id
7. 服务端 `seq` 分配 + `GET /v1/sync/changes`
8. 服务端 `POST /v1/sync/push`（CAS + 冲突回传）
9. 客户端同步引擎：拉 → 应用 → 推，冲突另存副本
10. 附件三端点 + 客户端懒加载
11. 密匣 manifest / keys 的同步与开关
12. 前端：同步状态、手动触发、冲突徽章（`conflict_of` 已就位）

## 九、未完成

### 密匣密钥同步（B-6）

**现状**：密匣**内容**已经能同步——密文随普通笔记走，服务端全程只见密文。缺的
是密钥：新设备能拿到密匣条目，但解不开。

**为什么留到后面**：这一项有个没写进原计划的前置——`lockbox_manifest` 与
`lockbox_keys` 两张表在 schema v2 里建好了，但**从来没有代码写过它们**。密匣
manifest 至今仍只存在于 `.shard/lockbox.json` 文件里。所以 B-6 实际上要先做一次
「密匣密钥入库」的改造，那是动用户唯一能解密自己数据的东西。

在同步链路还没经过任何真实环境验证的时候叠加这个改动，风险与收益不成比例。它
应该作为独立一轮来做，并且要有真实的多设备验证。

### 部署与恢复演练（A-3）

`deploy/` 下的 systemd unit、Caddyfile、Litestream 配置都已写好，但没有在真实
VPS 上跑过。**恢复演练尤其重要**：没演练过的备份等于没有备份。

## 十、风险与回滚

| 风险 | 缓解 | 回滚 |
|---|---|---|
| **跳过 Phase 0 导致三方对账** | 把它列为硬前置，不并行开工 | —— |
| **seq 分配不在事务内** → 增量永久漏数据 | 分配与写入同事务；并发推送的集成测试 | 重置游标全量拉一次 |
| 冲突处理丢数据 | 冲突永不覆盖，一律另存副本；双端离线写的端到端测试 | 冲突副本仍在库里 |
| 附件 hash 不校验 | `PUT` 时服务端重算 sha256 | —— |
| token 明文落盘 | 本轮保持现状并记录；换 keychain 另立一项 | —— |
| 单 VPS 单点 | Litestream + restic，恢复演练过 | 从备份重建 |
| 密匣密钥上云被离线爆破 | 独立开关；Argon2 参数复核 | 关掉开关，新设备不解锁密匣 |

## 十一、验证

1. `cargo test` 全绿（含服务端 CAS 与 seq 分配的并发测试）
2. `cargo check --all-targets` 零警告，`pnpm build` 通过
3. **收敛**：两个客户端实例离线各写 → 上线 → 两端数据一致
4. **冲突**：同一条笔记两端各改 → 一方成功、一方另存副本，**无数据丢失**
5. **幽灵复活**：A 删除，B 离线期间编辑该条 → B 上线后不复活
6. **密匣**：锁定态写入并同步 → 另一台解锁后能读；服务端库里全程只有密文
7. **附件**：A 粘贴图片 → B 拉取后能正常显示；重复上传只占一份字节
8. **断网重试**：push 中途断网，恢复后重试不产生重复行
9. **恢复演练**：从 Litestream 备份重建服务端，客户端能继续增量同步
