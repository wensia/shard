# CM6 迁移 · P4 执行报告

## X1 · kill switch 与 legacy 分支

- 删除内容：`src/editor/kill-switch.ts`；`CaptureBox` / `FragmentEditor` 的 legacy textarea、覆盖层、自绘光标、指针选区、旧标签弹层、旧表格写回与 textarea 量高分支；`src/lib/editor-caret.ts`、零引用的 `src/lib/textarea-caret.ts`；`tag-completion-popover.tsx` 及其 CSS；`capture-box.module.css` 的 textarea 专属规则；`applyActiveTagCompletion`。
- 保留内容：CM6 仍使用的选区/value helper、`insertTagMarker`、任务与表格编辑逻辑；`MAX_TAG_SUGGESTIONS` 移入 CM autocomplete 扩展并保持 8。
- 引用检查：上述 legacy 符号与文件在运行代码中零引用。
- 验证结果：`pnpm build` ✅（204 token、49 项存量设计债、0 新增；JS gzip 359.15 kB）；`pnpm test:unit` ✅（3 files / 28 tests）；`git diff --check` ✅。

## X2 · `FragmentContent` caretAligned 分支

- 删除内容：`caretAligned`、selection 与 `tableEditing` props；选择态 range/render helper 与 `data-text-*`；编辑态 divider；旧覆盖层的 Markdown/标签高亮分支；`FragmentBody` 的 selection 转发；`EditorTable` 的 measure/sourceActive/让位属性；table widget 的对应 props。
- 只读一致性：表格固定走原有 `MarkdownTableBlock`；task checkbox 保留原有隐藏字符占位的等价几何，仅将 legacy `measure` 语义改名为 `spacer`，避免正文左移；`INLINE_HIGHLIGHT_FALLBACK_PATTERN` 按任务书保留。仓库实况中旧 Markdown/标签高亮入口仅由已删除的 legacy overlay 启用，因此删除而未给只读卡片新增着色行为。
- 验证结果：首次 `pnpm build` 捕获 3 个残留 props/调用并已修复；最终 `pnpm build` ✅（204 token、49 项存量设计债、0 新增；JS gzip 357.72 kB）；`pnpm test:unit` ✅（3 files / 28 tests）；`git diff --check` ✅。

## X3 · legacy CSS

- 删除内容：旧 highlight layer、textarea field/overlay/placeholder、自绘光标与 blink keyframes、编辑态 Markdown/标签/选区类、编辑态 divider、表格 measure/source-active 规则及 `.shard-memo-tags` 编辑态 token 覆盖。
- 合并内容：`.shard-editor-table-surface` 直接采用 CM6 widget 的 `position: relative; inset: auto; overflow-x: auto`，删除 legacy 绝对定位覆盖；顶部编辑器说明改为 CM6 原生光标与 layer 选区。
- 只读一致性：`.shard-task-marker-spacer` 保留原 `.shard-task-marker-measure` 的隐藏占位几何；`.shard-card-tags` 与只读卡片样式未改。
- 验证结果：`pnpm build` ✅（204 token、49 项存量设计债、0 新增；CSS gzip 172.72 kB，JS gzip 357.72 kB）；`pnpm test:unit` ✅（3 files / 28 tests）；`git diff --check` ✅。

## X4 · token

- 删除内容：`src/index.css` 与 `contract/tokens.json` 中的 `--shard-caret-height-ratio`。
- 引用检查：该 token 随 `editor-caret.ts` 删除后零引用；其余 `--shard-editor-*` / `--shard-memo-*` / caret token 仍由 CM theme、只读卡片或分享图导出消费，全部保留。
- 验证结果：`pnpm build` ✅（token contract 从 204 降至 203，49 项存量设计债、0 新增；CSS gzip 172.71 kB，JS gzip 357.72 kB）；`pnpm test:unit` ✅（3 files / 28 tests）；`git diff --check` ✅。

## X5 · 测试与桥

- 删除内容：`tests/ui/shadcn-migration.spec.ts` 中对已不存在的 `.shard-editor-selection-highlight` 的 `toHaveCount(0)` 断言。
- 保留内容：`src/editor/test-bridge.ts` 与 `tests/ui/editor-helpers.ts` 未改。
- 验证结果：`pnpm build` ✅（203 token、49 项存量设计债、0 新增；CSS gzip 172.71 kB，JS gzip 357.72 kB）；`pnpm test:unit` ✅（3 files / 28 tests）；`git diff --check` ✅；`npx playwright test --list` ✅（2 files / 67 tests，仅列举，未运行）。

## X6 · 文档收口

- 更新内容：`editor-codemirror-migration-plan.md` 状态改为“已完成（P0–P4）”；§4.4 改为逐项 ✅；模块树移除已删除的 kill switch。
- 规则检查：`AGENTS.md` / `CLAUDE.md` 没有 textarea、覆盖层或自绘光标的项目规则，因此未改。
- 删除文件：`kill-switch.ts`、`editor-caret.ts`、零引用的 `textarea-caret.ts`、`tag-completion-popover.tsx` 与对应 CSS，共 5 个文件、678 行。
- 变更统计：`git diff --stat` 为 21 个已跟踪文件，155 行新增、3105 行删除；本报告为新文件，未计入该 Git diff 数字。
- Bundle：P3 后 JS gzip 约 365.0xx kB，本次最终 357.72 kB，下降约 7.3 kB；最终 CSS gzip 172.71 kB。
- 门禁数字：203 token；49 项存量设计债、0 新增；unit 3 files / 28 tests；Playwright discovery 2 files / 67 tests。
- 验证结果：`pnpm build` ✅；`pnpm test:unit` ✅；`git diff --check` ✅。

## 未决问题

- 按操作边界未实际运行 Playwright；67 条用例的运行验收由外部负责。
- 本任务未做 commit、add、stash、checkout、reset 或部署。

## Claude 验收（2026-08-30）

- 残留检查：`isLegacyEditorEnabled / LegacyComposerEditor / editor-caret / tag-completion-popover / caretAligned / 旧 .shard-editor-* 与 .shard-custom-caret 类 / TEXTAREA_MIRROR / startEditorPointerSelection / --shard-caret-height-ratio` 在 `src` 与 `tests` 中全部零引用。
- 门禁：`pnpm build` / `verify-tokens`（203 token）/ `pnpm test:unit` 28/28 / `tsc --noEmit` / `git diff --check` 通过；Playwright **67 通过 / 0 失败 / 0 fixme**。
- bundle：JS gzip 365.0 KB → **356.6 KB**；迁移前基线 242.1 KB，整体 +114.5 KB（上限 160 KB）。
- 代码规模：`capture-box.tsx` 1530 → 728 行，`fragment-editor.tsx` 1756 → 924 行，`fragment-content.tsx` 1136 → 732 行；删除 `editor-caret.ts`、`textarea-caret.ts`、`kill-switch.ts`、`tag-completion-popover.tsx(+css)`。
- **只读卡片视觉对照**：在迁移前快照 `80f77f6` 的 worktree 上起第二个 dev server，同一 mock、同一段内容（标签 / 任务勾选框 / `==荧光==` / `**粗体**` / `<u>` / 分割线 / 表格）创建片段后截图并测量——迁移前与现在卡片 900×379.5、表格 107×85.4、勾选框 14×14、分割线 868×1、innerText 完全一致。只读卡片本来就不渲染荧光笔 / 粗体 / 下划线（`FragmentBody` 未开 `highlightTags`），迁移前后一致，不属于本次范围。
