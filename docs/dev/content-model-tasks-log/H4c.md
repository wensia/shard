# H4c：图模型移入 shard-core 与 CLI 图读写

## 改动文件与要点

- `crates/shard-core/src/graph_model.rs`、`crates/shard-core/src/lib.rs`
  - 将导图与流程图的公开数据模型、结构校验、链接校验、规范化序列化、搜索文本投影和 `find_fragment_path` 的纯文件系统逻辑集中到 `shard-core`；保留原 serde 字段名、`deny_unknown_fields`、校验顺序和既有错误文案。
  - 图链接校验继续覆盖密匣片段 id 与 `MarkdownPath` 路径检查；`find_fragment_path` 继续按公开碎片、回收站碎片和资料库 Markdown 查找。
  - 增加内容 SHA-256 与 RFC 3339 当前时间的小型公共辅助函数，供桌面端和 CLI 共用。
  - 增加核心层测试，覆盖导图/流程图合法与非法结构、受保护链接、未知字段拒绝、碎片查找，以及 `0.1 + 0.2` 坐标经解析、规范化、再解析后的浮点逐位一致。
- `crates/shard-core/Cargo.toml`
  - 为现有 `serde_json` 依赖显式开启 `float_roundtrip`，保证单独编译 CLI 时也与桌面端画布坐标语义一致；没有新增依赖。
- `src-tauri/src/lib.rs`、`src-tauri/src/canvas_commands.rs`、`src-tauri/src/search_sources.rs`
  - 删除桌面端重复的图类型和纯逻辑实现，改用 `shard-core`；为减少调用面变化，保留原函数名的薄包装。
  - 图碎片、独立图文档、拆分、搜索、升级和导入仍走原调用链，现有错误文案和数据语义不变。
  - 增加兼容性测试：使用核心层规范化结果模拟外部图写入，再由桌面端 `read_graph_fragment_in_vault` 读取，确认 CLI/核心层产物可被桌面端接受。
- `crates/shard-cli/src/graph.rs`、`crates/shard-cli/src/main.rs`
  - 新增 `--graph-read`、`--graph-outline`、`--graph-write`、`--graph-set-text`、`--graph-add-child`、`--graph-remove` 六个互斥命令，并接入现有手写参数解析与 `shard: <消息>` 错误约定。
  - 读命令不取锁；写命令只接受公开 `fragments/`，必须携带 `--expect`，取得 `VaultProcessLock` 后重新读取并比较完整文件 SHA，过期时拒绝且不写盘。
  - 写入会核对碎片 type、图 kind 和图 id，复用核心层校验，更新图 revision/updatedAt 与 frontmatter `updated_at`，只替换受管区域并原子写入；未知 frontmatter 与区域外正文保持原字节。
  - `--graph-outline` 使用两空格缩进和 `- ` 标记；新增子节点使用现有唯一后缀生成不冲突 id，并放在父节点末尾；删除根节点明确拒绝。
- `crates/shard-cli/tests/graph.rs`
  - 覆盖六个命令成功路径，以及过期 SHA 零写入、类型不符、图 id 不符、删除根节点、持锁超时、持锁期间只读、归档碎片拒绝写入、frontmatter/正文保真和浮点往返。
- `README.md`
  - 同步 CLI 图命令用法与并发写入说明。
- `tests/ui/content-types.spec.ts`
  - 将 201/401 节点用例改为测试侧一次性注入完整会话树，保留原业务断言；没有改业务代码、样式或视觉合同。
- `docs/dev/content-model-tasks-log/H4c.md`
  - 记录本批实现、基线、验收、偏差与遗留问题。

本批没有新增依赖、CSS、视觉 token 或通用控件；没有实施 H5 或其它后续批次。

## 开工前 UI 基线

1. 开工前完整读取 `AGENTS.md`、§1、§11 与 `vendor/kiln/SKILL.md`，确认沿用未跟踪的 `playwright.worktree.config.ts`；其 Vite 服务、健康检查和 `baseURL` 均为 `http://127.0.0.1:1422`，全程没有连接 1420。
2. 在任何代码改动前运行 §11.4 指定的 4 个 UI spec，共 73 项，73 项全部通过，耗时约 1.6 分钟。
3. 开工前以单 worker 定向运行 201 节点与 401 节点两个慢用例，2/2 通过，实际耗时 70.15 秒；由此确认性能问题只在测试构造路径，不是业务断言失败。
4. 基线及最终 UI 运行改写了 4 个 `tests/evidence` PNG；最终验收完成后已全部恢复。

## 验收结果

| 命令 | 结果 |
| --- | --- |
| `cargo test -p shard-core -p shard -p shard-cli` | 通过。`shard` 230 通过、4 忽略；`shard-cli` 25 通过；`shard-core` 67 通过；文档测试 0 项。合计 322 通过、4 忽略、0 失败。桌面端既有断言无需修改。 |
| `cargo build --release -p shard-cli` | 通过。CLI 可脱离 `src-tauri` 单独完成 release 构建，`float_roundtrip` 不依赖桌面 crate 的特性传播。 |
| `pnpm test:unit` | 符合 §11.4 已知失败边界：串行全套 646 通过、1 失败，共 647 项。唯一失败仍是 `roundtrip.test.ts` 的 golden 目录检查，当前只发现 1 组而断言至少 22 组；`quick-open-perf.test.ts` 2/2 通过，冷启动为 57.90 ms。首次与 Rust 测试并行运行时该性能项曾测得 295 ms，随后单独复跑为 38.33 ms，串行全套复跑也通过，确认是验证并发造成的瞬时 CPU 争用。 |
| `pnpm build` | 通过。Markdown 构建、215 个 token 契约、104 个 UI 控件静态契约、TypeScript 与 Vite 2922 个模块构建全部通过；49 项既有设计债没有新增。输出仅含既有 Rollup 注释、动态/静态导入和大 chunk 警告。 |
| `pnpm build:markdown && pnpm exec playwright test -c playwright.worktree.config.ts tests/ui/content-types.spec.ts tests/ui/rich-surfaces.spec.ts tests/ui/mind-map-workspace.spec.ts tests/ui/canvas-workspace.spec.ts` | 通过。最终 73/73 项通过，耗时 43.4 秒；相对开工前基线没有新增失败。 |
| 401 节点用例单独计时 | 使用 `--workers=1` 定向运行「超过 400 节点时拦截提交、提示并保留完整草稿」，1/1 通过，Playwright 报告 4.3 秒，进程实际耗时 4.81 秒，低于 10 秒门槛；同文件 201 节点用例也已改用同一批量构造路径并在全套中通过。 |
| `rustfmt --edition 2021 --check crates/shard-core/src/graph_model.rs crates/shard-cli/src/graph.rs crates/shard-cli/tests/graph.rs` | 通过。 |
| `git diff --check` | 通过。 |

Playwright 改写的 4 个 `tests/evidence` 文件已恢复；`playwright.worktree.config.ts` 保持开工前的未跟踪状态，没有纳入交付改动。

## 偏差及原因

1. 施工令把图模型现状概括为集中在 `src-tauri`，源码中同时存在沿用旧调用名的内部函数和多处搜索投影入口。为保证桌面调用面、行为和错误文案不变，本批在删除模型副本后保留了少量同名薄包装，而不是批量改写所有调用点；实际校验、规范化和搜索逻辑均只有 `shard-core` 一份。
2. CLI crate 当前没有直接依赖时间、随机数或哈希库，且施工令禁止加依赖。为保持最小范围，SHA-256 和当前 RFC 3339 时间复用/下沉到 `shard-core`，新增节点 id 复用 CLI 已有的 `unique_suffix`，没有引入新的依赖或抽象层。
3. §11.3 要求验证「写后桌面端的 `read_graph_fragment_in_vault` 可读」，但该函数是桌面二进制 crate 的私有函数，CLI 集成测试不能直接链接调用。最小适配是在桌面端同模块测试中用核心层规范化文本模拟外部写入并直接调用该私有读取函数，同时由 CLI 集成测试覆盖真实命令写入、再读取和类型解析；两侧共同覆盖该兼容合同。
4. §11.0 要求不改业务代码。当前测试没有正式的批量大纲测试桥，因此用测试运行时中已有的 React Fiber 找到 `CaptureBox` 的 `file/onChange`，一次性提交与真实会话树同构的数据；业务提交、限制提示和草稿保留断言未变，也没有把测试辅助能力带入生产包。
5. `docs/dev/content-model-tasks-log/H4c.md` 受仓库现有 `docs/dev/*` 忽略规则影响，不会出现在普通 `git status` 中；仍按施工令创建并直接读取核对，没有 stage、commit 或修改 `.gitignore`。

## 遗留问题

- `pnpm test:unit` 仍有 1 项既有、稳定失败：Markdown golden 夹具当前只发现 1 组，断言要求至少 22 组；本批未扩大为夹具补录或测试规则修改。
- 测试侧的 React Fiber 注入依赖当前 React 测试运行时内部结构；它只用于这两个性能用例。若未来组件运行时或测试框架升级，应优先换成届时已有的正式测试桥或等价的一次性输入手段。
- 未执行 Git commit、push、合并、部署或 worktree 外写入。
