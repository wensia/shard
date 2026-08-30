# CM6 迁移 · P4 任务清单（收口：删旧实现，交 Codex 执行）

依据：`docs/dev/editor-codemirror-migration-plan.md` v2 §4.4 删除清单、§5 P4。P0–P3 已验收合入（Playwright 67 通过 / 0 失败 / 0 fixme），真机复核通过。P4 是**纯删除与清理**：不加新功能、不改行为；删完后 67 条用例必须原样通过，只读卡片视觉不得变化。

## 0. 硬性约束

- 中文注释与汇报；遵守 `AGENTS.md`、`CLAUDE.md`。
- **不做任何 git 写操作**；进度写到 `docs/dev/editor-cm6-p4-report.md`。
- Codex 沙箱不能监听端口：Playwright 只 `--list`，运行由 Claude 做。
- 每删完一块跑 `pnpm build`（tsc 会把残留引用全部报出来）+ `pnpm test:unit` + `git diff --check`。
- 删除以「tsc 零报错 + 无 dead import + 无 dead CSS」为准；不确定是否还有人用的符号先 `grep -rn` 再删。
- 只读卡片（时间线、分享图、只读表格）**渲染结果不得变化**：改类名必须同步 CSS 与用例。

## 1. 删除清单（盘点结果，按文件）

### X1 kill switch 与 legacy 分支
- 删 `src/editor/kill-switch.ts`。
- `src/components/shard/capture-box.tsx`（1530 行）、`src/components/shard/fragment-editor.tsx`（1756 行）：`isLegacyEditorEnabled` / `legacyEditorEnabled` / `useLegacyEditor` 共 72 处引用及其分支全部删除，包括：`LegacyComposerEditor` 子组件与 `LegacyComposerEditorProps`、`<textarea>` JSX、`.shard-editor-highlight-layer` JSX（`FragmentContent caretAligned` 用法）、`.shard-custom-caret` JSX、`textareaRef`、`syncTextareaGeometry`、`editorScrollTop`、mirror 量高（`TEXTAREA_MIRROR_PROPERTIES`、`resizeInlineEditorTextarea` 等）、`startPointerSelection` / `stopPointerSelectionRef` / `lastPointerRef` / `PointerPoint`、`isComposingRef`、`caretEpoch` / `customCaret` / `showCaretImmediately`、legacy 的 `handleKeyDown` / `handlePaste` / `onSelect` / `onScroll`、`activeTag` / `rawActiveTag` / `tagSuggestions` / `activeSuggestionIndex` / `boundedActiveSuggestionIndex` / `tagPopoverPosition` / `tagPopoverId` / `suppressedActiveTag` / `isSuppressedActiveTag` / legacy `applyTag`、`tagSearchIndex` / `activeNewTag`（CM 路径由 autocomplete 扩展自己算）、legacy `updateTable`（CM 由 widget 写回）、`getCurrentEditorValue` 若只为 legacy 服务、`aria-controls` / `aria-activedescendant` / `aria-expanded` / `aria-autocomplete` 等 legacy 属性、`MAX_TAG_SUGGESTIONS` 若只剩 autocomplete 用则挪到扩展里。
- 删 `src/lib/editor-caret.ts`（`getEditorCaretBox` / `getEditorSelectionFromPoint` / `startEditorPointerSelection`）及全部 import。
- 删 `src/components/shard/tag-completion-popover.tsx` 与 `tag-completion-popover.module.css`，以及 `getBoundedTagSuggestionIndex` / `getNextTagSuggestionIndex` / `getTagCompletionPopoverPosition` / `getTagSuggestionOptionId` / `TagSuggestion` 的 import。
- `capture-box.module.css`：删 `.textareaField` 及其 `::placeholder` / `:focus-visible`；`fragment-editor.module.css` 同类 textarea 专属样式。
- `src/lib/editor-format.ts` 里只被 legacy 用的函数（如 `applyActiveTagCompletion`、`insertTagMarker` 若 CM 已不用——先 grep）删除；被 CM / 卡片 / 单测用的保留。

### X2 `fragment-content.tsx` 的 caretAligned 分支（15 处）
- 删 `caretAligned` / `selectionStart` / `selectionEnd` / `tableEditing` props 与 `TableEditing` 接口；`renderSelectedText` / `renderSelectionRuns` / `SelectionRange` / `getSelectionRange` / `doesSelectionIntersectText` / `data-text-start` / `data-text-length`；`TaskMarker` 的 `measure` + `caretAligned`（只保留只读 checkbox）；`FragmentDivider` 的 editor 版；`EditorTable` 用法与 `editsTables` / `renderTables`（只读永远 `MarkdownTableBlock`）；`INLINE_HIGHLIGHT_FALLBACK_PATTERN` 保留（只读用）。
- 类名：`.shard-editor-markdown-marker` 删；`.shard-editor-markdown-highlight` / `.shard-editor-tag-highlight` / `.shard-editor-selection-highlight` 若**只读卡片**也在用（荧光笔 / 标签着色），改名为 `.shard-memo-highlight` / `.shard-memo-tag-text`（语义：只读卡片），同步 CSS 与用例；只服务编辑态的直接删。先 grep 用例里的断言。
- `src/components/shard/editor-table.tsx`：删 `measure`、`sourceActive`、`data-source-active`、`.shard-editor-table-measure` 与 `aria-hidden` 让位逻辑（CM 下让位 = widget 不存在）；`sourceStart` 保留（host `focusCell` 用它匹配）；`table-widget.ts` 同步 props。

### X3 CSS（`src/styles/frontend-rules.css`）
- 删：`.shard-editor-highlight-layer`、`.shard-custom-caret`、`@keyframes shard-caret-blink`、`.shard-editor-overlay-field`（含 `::selection`）、`.shard-editor-field`（若只有 textarea 用；`.shard-editor-drop-hint` 保留）、`.shard-editor-tag-highlight`、`.shard-editor-markdown-marker`、`.shard-editor-selection-highlight`、`.shard-task-marker-measure`、`.shard-fragment-divider-editor` / `-measure` / `-line`、`.shard-editor-table-measure`、`.shard-editor-table-block[data-source-active] …` 两条、`.shard-editor-table-surface` 里为 legacy 绝对定位写的 `position: absolute; inset: 0` —— 与 P3 加的 `.shard-cm-table-widget .shard-editor-table-surface { position: relative; inset: auto }` 合并成一份。
- `.shard-editor-markdown-highlight` 按 X2 结论改名或删。
- 顶部注释第 18–20 行「editor caret is custom…」改为「编辑器是 CodeMirror 6，光标原生、选区由 layer 按行盒绘制」。
- `.shard-memo-tags` 作用域里只为编辑态覆盖层写的 token 覆盖若已无人用则删。

### X4 token（`src/index.css` + `contract/tokens.json` 同步）
- 删 `--shard-caret-height-ratio`（只 `editor-caret.ts` 用）。
- 保留：`--shard-caret-color` / `--shard-caret-width`（theme 用）、`--shard-editor-tag-fg`、`--shard-editor-highlight-pad-y`、`--shard-editor-font-*` / `-line-height` / `-letter-spacing`（theme 用）。
- 其余 `--shard-editor-*` / `--shard-memo-*` 逐个 `grep -rn` 确认无引用再删；`verify-tokens` 必须绿。

### X5 测试与桥
- `tests/ui/shadcn-migration.spec.ts` 里对 `.shard-editor-selection-highlight` 的 `toHaveCount(0)` 断言删除（类已不存在）；其它用例不动。
- `src/editor/test-bridge.ts`、`tests/ui/editor-helpers.ts` 保留。
- `npx playwright test --list` 仍是 67 条。

### X6 文档
- `docs/dev/editor-codemirror-migration-plan.md`：状态改「已完成（P0–P4）」，§4.4 每项标 ✅。
- `docs/dev/editor-cm6-p4-report.md`：删除的文件 / 行数统计（`git diff --stat` 由 Claude 补）、bundle（P3 后 JS gzip 365,0xx B → 现在，预期下降）、门禁数字。
- `AGENTS.md` / `CLAUDE.md` 若有 textarea / 覆盖层 / 自绘光标的规则先 grep，有则改成 CM6 表述；没有就不动。

## 2. 汇报格式
同前：删除清单（文件 / 符号）、门禁数字、bundle、用例 `--list` 数量、未决问题。
