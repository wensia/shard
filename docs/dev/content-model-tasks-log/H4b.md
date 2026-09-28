# H4b：资料库独立图文件加入时间线

## 改动文件与要点

- `src-tauri/src/lib.rs`
  - 新增异步后台命令 `import_graph_file_to_timeline(path)` 并注册到 Tauri；命令进入阻塞线程后获取 vault，立即拿写门，再执行导入。
  - 仅接受 `notes/` 下的 `.shardmap.json` 与 `.shardflow.json`；复用现有资料库路径、导图、流程图校验，明确拒绝旧 `shard.canvas` 混合画布，并校验旧图 id 仅含 `[0-9A-Za-z._-]`。
  - 全库检查公开碎片、回收站、资料库 Markdown 与密匣 id 冲突；同 id、同类型且受管区域有效的公开图碎片被视为中断恢复，只补做原图移入回收站，不重复生成碎片。
  - 新碎片沿用旧图 id，以图 JSON 的 `createdAt` 决定 frontmatter 与 `fragments/YYYY/MM/`，添加 `inbox` 与 `outline` / `flowchart` 标签，并用 `render_region` 写入唯一受管区域，不改图内 id、节点、时间或 revision。
  - 从现有 `move_to_trash_in_vault` 最小提取不自带提交的移动函数；原删除行为保持原有 best-effort 提交，导入则在检查点后写碎片、移动原图，最后只做一次包含新路径、原路径与回收站路径的语义提交。移动失败会删除刚写入的碎片。
  - 新增 4 项 Rust 测试，覆盖非 Git 大纲导入、Git 流程图单次语义提交、id 冲突/图校验失败/旧混合画布零写入，以及已写碎片但原图尚在时的幂等恢复。
- `src/lib/api.ts`
  - 增加 `importGraphFileToTimeline` 前端命令封装，复用现有 Fragment 返回合同。
- `src/components/shard/library-entry-menu.tsx`、`src/components/shard/directory-view.tsx`
  - 仅为非批量 mindmap / flowchart 条目增加「加入时间线」菜单项，复用现有图标、菜单与关闭后执行机制；普通文件、旧画布与批量菜单不显示该入口。
- `src/workspace/library-shell.tsx`
  - 复用资料库现有确认对话框，按大纲/流程图显示对应说明；导入按钮使用普通主按钮语义，删除、彻底删除与清空回收站仍保持 destructive。
  - 成功后刷新资料库树与碎片列表，显示「已加入时间线」并提供「打开」动作；命令失败保留对话框与现有列表。若命令已经成功而刷新失败，则关闭确认框并明确提示「已加入时间线，但列表刷新失败」，避免把已完成写入误报成可重试失败。
  - 独立图文档不存在时，从已加载碎片中按相同 id、相同 JSON 图类型回退，并通过 workbench 回调打开 H2/H2b 图形宿主。
- `src/components/shard/mind-map-workspace.tsx`、`src/workspace/workbench-shell.tsx`
  - 为独立导图工作区补充既有 `fragments` 与 `onOpenLink` 透传，使导图检查器里的 Map / Flow 引用也走统一回退。
  - workbench 的图链接处理先查独立图文档，缺失时再查已加载公开 JSON 大纲/流程图片段；资料库回调只负责更新碎片状态并打开既有宿主，没有在 library-shell 内复制宿主实现。
- `tests/ui/content-types.spec.ts`
  - 按 §10.0 将两处自动消失 toast 的等待单独放宽为 15 秒；密匣大纲用例改为检查真实的 `create_graph_fragment` 调用记录，同时继续断言草稿持久存在。
- `tests/ui/library-tree.spec.ts`
  - 增加导入命令、刷新后树/碎片状态和独立图缺失的 mock。
  - 新增 3 项 UI 测试，覆盖菜单与批量边界、确认/取消/失败持久状态、刷新与 toast 打开动作，以及 Map / Flow 回退和全部缺失提示。
- `docs/dev/content-model-tasks-log/H4b.md`
  - 记录本批实现、基线、验收、偏差与遗留问题。

本批没有新增依赖、CSS、视觉 token 或通用控件；Kiln 只影响控件复用和语义选择，没有改变资料库独立导图/流程图原有的打开、编辑、删除、重命名或移动路径。

## 开工前 UI 基线

1. 开工前完整读取 §1 与 §10，并确认沿用未跟踪的 `playwright.worktree.config.ts`；其 Vite 服务、健康检查与 `baseURL` 均使用 `http://127.0.0.1:1422`，全程没有连接 1420。
2. 在任何代码改动前运行 §10.4 指定的 7 个 UI spec，共 150 项；146 项通过、4 项失败，耗时约 2.2 分钟。
3. 4 项基线失败均位于 `library-tree.spec.ts`：
   - 「思维导图标题支持确认、失焦与取消改名，保留扩展名和根主题」；
   - 「文件名编辑外点关闭，拖动标题栏也能提交且返回操作等待改名完成」；
   - 「思维导图标题改名前等待草稿落盘，改名后继续编辑并按新路径重开」；
   - 「碎片确认标题目录后转为文档并聚焦正文，转回时保留最新正文与唯一归属」。
4. 基线及最终 UI 运行改写了 10 个 `tests/evidence` PNG；最终验收完成后已全部恢复。

## 验收结果

| 命令 | 结果 |
| --- | --- |
| `cargo test -p shard-core -p shard -p shard-cli` | 通过。`shard` 224 通过、4 忽略；`shard-cli` 10 通过；`shard-core` 49 通过；文档测试 0 项。合计 283 通过、4 忽略、0 失败；H4b 新增 Rust 测试 4 项。 |
| `pnpm test:unit` | 符合 §10.4 已知失败边界：全套 630 通过、1 失败，共 631 项。唯一失败仍是 `roundtrip.test.ts` 的 golden 目录检查，当前只发现 1 组而断言至少 22 组；`quick-open-perf.test.ts` 2/2 通过，其中「参考结果对照」通过。 |
| `pnpm build` | 通过。Markdown 构建、215 个 token 契约、101 个 UI 控件静态契约、TypeScript 与 Vite 2915 个模块构建全部通过；49 项设计债仍为既有基线，没有新增。输出仅含既有 Rollup 注释、动态/静态导入和大 chunk 警告。 |
| `pnpm build:markdown && pnpm exec playwright test -c playwright.worktree.config.ts ...` | 符合基线。最终 7 个 spec 共 153 项，149 项通过、4 项失败，耗时约 2.3 分钟；失败名称与开工前 4 项完全一致。新增 3 项 H4b 用例全部通过，没有相对基线新增失败。 |
| H4b 新增 UI 用例定向复跑 | 使用 `--workers=1 --retries=0` 运行「加入时间线」及「独立图缺失」3 项，3/3 通过，耗时约 10 秒。全量验收没有出现新的偶发失败，因此未把 4 项稳定基线失败误记为本批偶发项。 |
| `rustfmt --edition 2021 --check crates/shard-core/src/frontmatter.rs crates/shard-core/src/graph_region.rs crates/shard-core/src/outline_import.rs` | 通过。 |
| `git diff --check` | 通过。 |

Playwright 改写的 10 个 `tests/evidence` 文件已恢复；`playwright.worktree.config.ts` 保持开工前的未跟踪状态，没有纳入交付改动。

## 偏差及原因

1. 施工令要求图 `createdAt` 解析失败时使用当前时间，同时又要求先复用现有图校验并保证导入后 `read_graph_fragment` 可读。源码中的 `canvas_commands::validate_file` 会拒绝流程图的非法 `createdAt` / `updatedAt`，而 `read_graph_fragment` 也会再次执行该校验。因此流程图非法时间戳按现有校验报错、零写入；当前时间回退只会对能通过类型校验但外层 `createdAt` 不可解析的图格式生效，没有绕过校验导入一篇随后无法读取的流程图。
2. §10.0 原断言使用 `createdFragments` 检查旧的 `create_fragment`，但 H1 后大纲实际走 `create_graph_fragment`。为满足「没有创建调用」的持久状态证据，最小改为现有 `createdGraphFragments`，没有修改业务代码或扩大到其它用例。
3. AGENTS.md 引用的 `docs/design/frontend.md` 在当前 worktree 中不存在。本批没有补造该文件；UI 完整复用 `vendor/kiln`、现有资料库菜单、对话框、按钮和 toast，且没有新增样式。
4. `docs/dev/content-model-tasks-log/H4b.md` 受仓库现有 `docs/dev/*` 忽略规则影响，不会出现在普通 `git status` 中；仍按施工令创建并直接读取核对，没有 stage、commit 或修改 `.gitignore`。

## 遗留问题

- `pnpm test:unit` 仍有 1 项既有、稳定失败：Markdown golden 夹具当前只发现 1 组，断言要求至少 22 组；本批未扩大为夹具补录或测试规则修改。
- §10.4 的 4 项 `library-tree.spec.ts` 既有失败在开工前与最终验收中完全一致，本批没有新增 UI 失败，也没有越界修复这些历史用例。
- 流程图源文件的非法 RFC 3339 时间戳仍由既有流程图校验拒绝；如未来要支持这类历史文件，需要先统一独立流程图与片段流程图的读取合同，不能只在导入时替换 frontmatter 时间。
- H4c 及其它后续批次均未实施。
- 未执行 Git commit、push、合并、部署或 worktree 外写入。
