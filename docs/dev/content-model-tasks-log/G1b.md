# G1b：大纲与流程图宿主中的属性

## 改动文件与要点

- `crates/shard-core/src/frontmatter.rs`
  - `validate_property_key` 增加 YAML 非字符串键名边界：拒绝纯数字、带符号数字、小数、科学计数、`0x`/`0o` 前缀，以及 `true`、`false`、`null`、`~` 的大小写变体。
  - 统一返回「属性名不能是数字、布尔或空值写法」，并补充对应单元测试；已有文件的读取行为不变。
- `src/components/shard/mind-map-workspace.tsx`、`src/dev/mind-map-document-test.tsx`
  - 仅在碎片快照模式的大纲工具条增加「文档属性」按钮，复用现有 `Dialog` 与 G1 `PropertiesPanel`；独立 `.shardmap.json` 不显示入口。
  - 打开对话框前排空自动保存，失败时保持关闭并提示；打开期间复用画布交互阻塞机制。
  - 给 `MindMapCanvas` handle 增加最小 `replaceBaseline(fileSha)` 方法；属性写入成功后只替换保存基线与当前碎片快照，不重新载入图草稿，并沿用既有 `storage.afterSave` 回灌时间线。
- `src/features/canvas/canvas-workspace.tsx`、`src/features/canvas/save-queue.ts`、`src/workspace/workbench-shell.tsx`
  - 仅在流程图碎片模式的工具条增加「文档属性」按钮，复用 G1 属性面板；独立 `.shardflow.json` 默认 IO 保持不变且不显示入口。
  - 打开前调用现有保存队列 `flush`，失败时不打开并显示既有错误提示与 toast；对话框打开期间阻塞画布交互。
  - 给 `CanvasWorkspace` handle 与 `CanvasSaveQueue` 增加最小 `replaceBaseline(fileSha)` 能力；属性写入后更新队列的 `lastSavedHash` 和工作台中的碎片对象，后续图保存继续使用新 SHA，不重载草稿。
- `src/dev/canvas-workspace-test.tsx`、`tests/ui/content-types-mock.ts`
  - 测试宿主和内容类型 mock 增加属性登记表、属性读写命令、带 `properties` 的图碎片，以及一次性图写入失败控制；没有把测试辅助能力带入生产路径。
- `tests/ui/mind-map-workspace.spec.ts`、`tests/ui/canvas-workspace.spec.ts`、`tests/ui/rich-surfaces.spec.ts`
  - 新增 10 项 UI 用例：两个宿主的入口与独立图文件隔离、打开前排空、属性新增/修改后的新基线继续保存、排空失败不打开，并覆盖真实工作台的时间线回灌。
- `src/lib/canvas-save-queue.test.ts`
  - 增加保存队列替换基线的定向单元测试。
- `docs/dev/content-model-tasks-log/G1b.md`
  - 记录本批实现、基线、验收、偏差与遗留问题。

本批没有新增依赖、CSS、视觉 token 或通用抽象；没有实施 H2–H4c、G2、G3 或数据集相关改动。

## 开工前 UI 基线

1. 开工前完整读取 `AGENTS.md`、实施方案 §1 与 §13，以及仓库内 `vendor/kiln/SKILL.md` 和相关组件、布局规范；§3–§12 仅用于核对既有内容模型与图宿主背景。
2. 核对并沿用未跟踪的 `playwright.worktree.config.ts`：Vite 命令、健康检查和 `baseURL` 均使用 `http://127.0.0.1:1422`，带 `--strictPort`；本批所有 Playwright 命令均显式使用 `-c playwright.worktree.config.ts`，未连接 1420。
3. 在任何代码改动前运行 §13.4 指定的 6 个 UI spec：84/84 通过，0 失败，耗时 46.0 秒。
4. 基线运行改写了 4 个大纲证据图片；最终验收结束后已全部恢复。

## 验收结果

| 命令 | 结果 |
| --- | --- |
| `cargo test -p shard-core -p shard -p shard-cli` | 通过。`shard` 235 通过、4 忽略；`shard-cli` 单元/集成 25 通过；`shard-core` 71 通过；文档测试 0 项。合计 331 通过、4 忽略、0 失败。 |
| `pnpm test:unit` | 符合 §13.4 的既有失败边界：658 通过、1 失败，共 659 项；64 个测试文件中 63 个通过、1 个失败。唯一失败为 `src/editor-rich/markdown/roundtrip.test.ts:27`，golden 目录当前只发现 1 组而断言至少 22 组。新增保存队列用例通过。 |
| `pnpm build` | 通过。Markdown 构建、215 个 token 契约、105 个 UI 控件静态契约、TypeScript 与 Vite 构建全部通过；49 项既有设计债没有新增。输出仅含既有第三方 PURE 注释、动态/静态导入和大 chunk 警告。 |
| `pnpm build:markdown && pnpm exec playwright test -c playwright.worktree.config.ts tests/ui/properties.spec.ts tests/ui/rich-surfaces.spec.ts tests/ui/mind-map-workspace.spec.ts tests/ui/canvas-workspace.spec.ts tests/ui/canvas-inspector.spec.ts tests/ui/content-types.spec.ts` | 最终 94/94 通过，0 失败，耗时 55.6 秒；新增 10 项全部通过，相对开工前 84/84 基线没有新增失败。 |
| `rustfmt --edition 2021 --check crates/shard-core/src/frontmatter.rs` | 通过。 |
| `git diff --check` | 通过。 |

Playwright 改写的 4 个 `tests/evidence` 文件已全部恢复，最终无证据图片差异。`playwright.worktree.config.ts` 保持开工前的未跟踪状态，没有纳入交付改动。

## 偏差及原因

1. `AGENTS.md` 指向的 `docs/design/frontend.md` 在当前 worktree 中不存在。UI 实现因此遵循同一份 `AGENTS.md` 中已明确的 pointer-first 选择，以及仓库内 `vendor/kiln/SKILL.md` 与对应 references；全部复用现有按钮、对话框和 token，没有创建替代规范或新增视觉样式。
2. 大纲宿主已经通过 `MindMapCanvasStorage` 持有 `snapshot.fragment` 和既有 `afterSave` 回灌入口，不需要另加父级碎片属性。实现直接在该适配器内替换基线、快照碎片并调用原回灌函数，范围小于施工令示例中的通用父级接线。
3. 流程图的 `CanvasReadResult` 只包含图文档和 `fileSha`，没有碎片 DTO。为让 G1 `PropertiesPanel` 获得当前碎片并回灌时间线，最小增加可选的 `fragment` / `onFragmentUpdated` 属性，只由工作台碎片模式传入；独立文件默认 IO 不传入，因此行为不变。
4. 独立流程图测试宿主没有全局 toast 容器。排空失败仍调用既有 toast，同时复用画布原有 `actionError` 可见错误区域作为可断言反馈；生产工作台继续显示 toast，没有新增样式或错误机制。
5. 首次整组新增 UI 用例运行时，流程图失败提示断言使用了过宽的文本定位，同时匹配工作区错误和 toast，造成 1 项测试定位歧义；收窄到流程图工作区既有 `alert` 后，单项复跑及 §13.4 全套 94 项均通过。该失败属于测试选择器问题，业务实现无需变更。
6. `docs/dev/content-model-tasks-log/G1b.md` 受仓库现有 `docs/dev/*` 忽略规则影响，不出现在普通 `git status` 中；仍按施工令创建并直接读取核对，没有 stage、commit 或修改 `.gitignore`。

## 遗留问题

- `pnpm test:unit` 仍有 1 项施工令已注明的既有稳定失败：Markdown golden 夹具当前只发现 1 组，断言要求至少 22 组；本批未扩大为补录夹具。
- `pnpm build` 仍输出既有的第三方注释、动态/静态导入和大 chunk 警告；本批没有新增构建错误或设计债。
- G1b 范围内没有已知功能遗留；G1 属性面板、H2–H4c、数据集能力及独立图文件默认 IO 的相关回归用例均通过。
- 未执行 Git commit、push、合并、部署或 worktree 外写入。
