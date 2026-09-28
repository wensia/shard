# H2b：流程图片段前端端到端

## 改动文件与要点

- `src/lib/slash-commands.ts`、`src/lib/content-kind.ts`、`src/editor-rich/commands.ts`、`src/editor-rich/extensions/slash-suggestion.ts`、`src/editor-rich/ShardRichEditor.tsx`
  - 新增 `/流程图` 内容类型命令、常量与富文本宿主回调；命令候选按大纲、流程图、文档分别检查宿主能力，非 composer 编辑面不展示流程图命令。
  - 继续通过 callbacks ref 分派宿主命令，没有因回调变化重建 Tiptap editor。
- `src/components/shard/capture-box.tsx`
  - `/流程图` 立即调用 `createGraphFragment("flowchart", operationId, null, ["inbox"])`，成功后直接交给 Workbench 打开流程图宿主。
  - 只移除斜杠命令，原草稿保留；创建失败时保留草稿、回焦并展示宿主错误 toast。
  - 增加轻量 draft 镜像入口，解决流程图 Zen 宿主挂载时 composer 被卸载后草稿丢失的问题。
- `src/features/canvas/canvas-workspace.tsx`
  - 增加可选 `readFromStorage`、`saveTransport`、`fragmentMode`、`onRequestClose` 与 `toolbarLeading`；默认值仍是现有 `readCanvas` / `writeCanvas`，资料库独立流程图行为不变。
  - 碎片模式关闭前排空保存；无 Canvas 局部编辑/选择态时 Escape 交给宿主关闭，存在局部状态时先清局部状态。
  - 碎片模式的 `STALE_BASE` 提供「保留我的版本」与「载入磁盘版本」：前者先读取最新 fileSha 再重写当前草稿，后者放弃本地草稿并重新读取；不显示「另存流程图副本」或旧画布拆分入口。
- `src/workspace/workbench-shell.tsx`、`src/workspace/library-shell.tsx`
  - 新增流程图片段 Zen 宿主与独立 ref，读写适配分别调用 `readGraphFragment` / `writeGraphFragment`，用 `fragment.fileSha` 作为 Canvas 保存基线，并在读写后回灌时间线 fragment。
  - 卡片「编辑」「禅模式」、创建成功、旧前端搜索和 quick-open 都进入 `CanvasWorkspace`，不再把合法 JSON 流程图交给 `FragmentEditor`。
  - 关闭、切换空间、筛选、全局速记、打开其他内容前统一排空流程图草稿；编辑期间阻止自动同步和自动检查点穿透。
  - 流程图引用继续使用 Canvas 既有的先 flush 再跳转语义；碎片/Markdown 引用进入对应碎片或资料库文档，独立思维导图/流程图按稳定 ID 查找后进入资料库。
- `src/workspace/search-target-router.ts`
  - 对 `.md` 且带 object id 的 `flowchart` 搜索目标调用 `readGraphFragment` 并打开碎片宿主；独立 `.shardflow.json` 仍走原有 `readCanvas` 与资料库宿主。
- `src/lib/flowchart-content.ts`、`src/components/shard/fragment-card.tsx`、`src/lib/search-provider.ts`、`src/lib/quick-open-catalog.ts`
  - 新增严格的受管 `shardflow` JSON 读取器，只接受 `kind: "shard.flow"`。
  - 合法流程图卡片显示 JSON 标题及「N 个节点 · M 条连线」；解析失败回退现有原正文渲染。
  - 旧前端搜索与 quick-open 使用流程图 JSON 标题和「未命名流程图」回退标题。
- `src/lib/flowchart-content.test.ts`、`src/lib/quick-open-catalog.test.ts`、`src/lib/slash-commands.test.ts`
  - 覆盖合法/非法/旧画布流程图解析、quick-open JSON 标题和 `/流程图` 命令筛选与内容类型识别。
- `tests/ui/content-types-mock.ts`、`tests/ui/content-types.spec.ts`、`tests/ui/rich-surfaces.spec.ts`
  - mock 同时支持 `ShardMapFile` 与 `CanvasFile`、空流程图后端生成、graph revision/fileSha、可控创建失败与 `STALE_BASE`、`list_diagram_documents`。
  - 覆盖立即创建、草稿保留、失败保留、卡片摘要与非法回退、搜索/quick-open、编辑/禅模式宿主、关闭排空和冲突两分支。
- `tests/ui/rich-composer.spec.ts`、`tests/ui/slash-commands.spec.ts`
  - composer 命令数由 12 更新为 13，并验证其他编辑面仍不展示流程图内容类型命令。
- `tests/ui/rich-surfaces.spec.ts`
  - H2 JSON 大纲的首轮自动保存改为同时等待写调用和「已自动保存」状态，第二轮 Escape 关闭后等待第二次写入，不再以请求已发出代替保存完成。
- `tests/ui/canvas-text-center.spec.ts`
  - 自定义 browser page 使用当前 Playwright fixture 的 `baseURL`，不再写死 1420。
- `docs/dev/content-model-tasks-log/H2b.md`
  - 记录本批实现、基线、验收、偏差与遗留问题。

本批没有新增依赖或视觉样式。UI 复用现有 `ZenSurface`、Canvas 工具栏/冲突条、Kiln `Button`、既有 token 与 Shard 的 pointer-first 交互选择。

## 开工前 UI 基线

1. `tests/ui/canvas-text-center.spec.ts` 的自定义 browser page 写死 `http://127.0.0.1:1420`，与本施工令“绝不能连到 1420”冲突。业务代码改动前先将它最小改为读取 `playwright.worktree.config.ts` 提供的 `baseURL`。
2. 随后使用既有未跟踪的 `playwright.worktree.config.ts` 在 `http://127.0.0.1:1422` 完整运行 §7.5 所列 15 个 UI spec，基线为 126/126 通过，耗时约 1.4 分钟。
3. 后续定向与最终 UI 验收均使用同一 1422 配置；所列测试未连接 1420。

## 验收结果

| 命令 | 结果 |
| --- | --- |
| `cargo test -p shard-core -p shard -p shard-cli` | 通过。`shard` 211 通过、4 忽略；`shard-cli` 10 通过；`shard-core` 35 通过；文档测试 0 项。合计 256 通过、4 忽略、0 失败。 |
| `pnpm test:unit` | 符合 §7.5 的既有失败边界：全套 625 通过、2 失败，共 627 项。`roundtrip.test.ts` 仍是既有 golden 目录仅 1 组、断言至少 22 组；`quick-open-perf.test.ts` 的 `zbrj` warm p95 本轮为 30.35ms，略高于 30ms。性能文件随后单独复跑 2/2 通过，cold 52.23ms，最大 warm p95 8.87ms。新增及相关定向 Vitest 3 个文件 54/54 通过。 |
| `pnpm build` | 通过。Markdown 构建、215 个 token 契约、101 个 UI 控件静态契约、TypeScript 与 Vite 2915 个模块构建全部通过；仅有既有 Rollup 注释、动态/静态导入和大 chunk 警告。 |
| `pnpm build:markdown && pnpm exec playwright test -c playwright.worktree.config.ts ...` | 通过。最终 §7.5 的 15 个 spec 在 1422 上 133/133 通过，耗时约 1.9 分钟；相对开工前基线新增 7 项且没有新增失败。流程图保存/冲突定向复跑为 3/3 通过；最终整套没有偶发 UI 失败，无需 `--workers=1` 补跑。 |
| `rustfmt --edition 2021 --check crates/shard-core/src/frontmatter.rs crates/shard-core/src/graph_region.rs` | 通过。 |
| `git diff --check` | 通过。 |

Playwright 改写的 4 张 `tests/evidence/mind-map-workspace-*` 图片已恢复，未纳入交付改动。

## 偏差及原因

1. `tests/ui/canvas-text-center.spec.ts` 写死 1420，与施工令端口限制直接冲突。为取得合法基线，必须先让自定义 page 消费 worktree 配置的 `baseURL`；用例行为与默认 Playwright 配置未改变。
2. 源码中的 `SearchKind.flowchart` 同时表示 Markdown 流程图片段与独立 `.shardflow.json`。若把全部 flowchart 都交给 `readGraphFragment` 会破坏资料库现有流程图；因此按路径和 object id 最小分流，`.md` 走 graph fragment，独立文件继续走 Canvas 默认 IO。
3. H2 现有大纲 Workbench 宿主没有施工令描述中的统一 Canvas 引用回调可直接复用。为避免扩大到 H2 重构，本批只给流程图宿主补齐 fragment / markdownPath / map / flow 四类引用跳转；大纲路径保持原样并由最终回归验证。
4. 流程图 Zen 宿主会卸载 composer；仅在 `CaptureBox` 内保存草稿会在返回时丢失。按源码事实增加 Workbench 内的 draft ref，并通过可选初值/变更回调镜像，不引入全局 store，也不触发每次输入时的 Workbench 重渲染。
5. `CanvasWorkspace` 原 Escape 会无条件消费事件，单靠 `ZenSurface` 无法关闭。新增可选 `onRequestClose`，只在没有 Canvas 局部编辑、选择或 picker 状态时调用；默认资料库调用方不传该回调，原行为不变。
6. `quick-open-perf.test.ts` 在全套并行负载下出现一次 0.35ms 的 warm p95 越线，按施工令单独复跑后 2/2 通过；未调整阈值或性能实现。

## 遗留问题

- Rust 原生全文搜索当前尚未把 Markdown 流程图片段投影为搜索结果，这是 H3 的搜索投影范围；本批已完成 quick-open、旧前端搜索标题与 `.md` 流程图搜索目标路由。
- `pnpm test:unit` 仍有 1 项既有、稳定失败：Markdown golden 夹具当前只跟踪 1 组，断言要求至少 22 组。本批未扩大为夹具补录或忽略规则调整。
- quick-open 性能测试在全套并行负载下仍可能偶发越过 30ms warm p95 门槛；本次独立复跑通过。
- `playwright.worktree.config.ts` 保持既有未跟踪状态；未执行 Git commit。
