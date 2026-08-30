# CM6 迁移 · P2 任务清单（标签补全，交 Codex 执行）

依据：`docs/dev/editor-codemirror-migration-plan.md` v2 §4.2 `tag-autocomplete.ts`、§7 决策 **B**（3/4：CM6 原生 autocomplete + kiln 主题，旧弹层的语义与 a11y 用例整体迁入）。P0、P1 已验收合入（Playwright 43 通过 / 13 fixme / 0 失败），真机复核通过。本清单只做 P2；P3（表格 widget）、P4（删旧代码）不要做。

## 0. 硬性约束（同 P0/P1，全程遵守）

- 中文注释与汇报；遵守 `AGENTS.md`（Runtime Rules、只用 kiln / `--shard-*` token、不写裸 hex）、`CLAUDE.md`。
- **不做任何 git 写操作**；进度写到 `docs/dev/editor-cm6-p2-report.md`，提交由 Claude 验收后完成。
- Codex 沙箱不能监听端口：Playwright 用例写好并 `npx playwright test --list` 确认可发现即可，运行由 Claude 做。
- 每个任务结束跑 `pnpm build`（含 `verify-tokens` + tsc）、`pnpm test:unit`、`git diff --check`。
- legacy 路径（kill switch）与旧 `TagCompletionPopover` 保留到 P4，但 CM 路径下不再渲染它。
- **IME**：组合态期间不得弹出或刷新补全，`compositionend` 后再触发；用 CDP IME 用例证明。
- 有产品决策疑问记到报告「未决问题」，继续做不受影响的部分。

## 1. 现状速查

| 位置 | 内容 | P2 关系 |
|---|---|---|
| `src/components/shard/tag-completion-popover.tsx` + 同目录 `.module.css` | 旧 React 弹层：`role="listbox"` `aria-label="标签建议"`，option `role="option"`，徽标文案「新建」/「使用」，`TagSuggestion` 接口，`getBoundedTagSuggestionIndex` / `getNextTagSuggestionIndex` / `getTagSuggestionOptionId` / `getTagCompletionPopoverPosition` | 视觉与文案复刻到 CM tooltip；组件本体保留给 legacy |
| `src/lib/editor-format.ts` | `getActiveTag(value, cursor) → { hashStart, query } \| null`（光标所在的 `#query`）；`applyTagCompletion(value, activeTag, tag) → TextEdit`（替换为 `#tag`，后面没有行内空白就补一个空格，光标停在空格后）；`insertTagMarker(value, cursor) → TextEdit`（工具栏 `#`：汉字/文字后先补空格再插 `#`）；`normalizeTag` / `normalizeTagList` | 语义全部原样复用，不改 |
| `src/lib/tag-index.ts` | `buildTagSearchIndex(tags)`、`getMatchingTagsBySearchQuery(index, query, limit)` | 候选检索 |
| `capture-box.tsx` / `fragment-editor.tsx` | P0 保留但 CM 路径下**未渲染**的逻辑：`knownTags` prop（过滤 `inbox`）、`tagSuggestions`（匹配 + query 不在已知列表时追加新建项）、`MAX_TAG_SUGGESTIONS`、`activeTag`、`applyTag(tag)`、`insertTag()`（工具栏）、`suppressedActiveTag`（fragment-editor）、legacy `handleKeyDown` 里 ArrowUp/Down/Enter/Escape 的处理 | 先读一遍旧行为，CM 路径必须等价 |
| `src/editor/shard-editor.tsx` | `extensions` prop（宿主注入，已 Compartment 化，**传稳定引用**）、`ShardEditorHandle.applyTextEdit` / `.view` | 注入补全扩展、工具栏 `#` 走桥 |
| `src/editor/extensions/keymap.ts` | Enter 已绑任务续行；Mod-Enter / Ctrl-Enter 提交 | 补全打开时 Enter 必须先被 autocomplete 接住（它的 keymap 是 `Prec.highest`），Codex 验证优先级 |
| `src/editor/test-bridge.ts` | `get / set / select / type`，`get` 返回 `value / selectionStart / selectionEnd / composing` | 用例用；如需暴露 `coordsAtPos` 可加 |
| 依赖 | `@codemirror/autocomplete 6.20.3` 已装 | — |
| Playwright fixme（本阶段解除） | `shadcn-migration.spec.ts` 中 `从建议里选中标签后自动补空格`、`编辑模式选中标签后留出输入边距`（两条仍用旧 textarea API：`composer.fill / press / toHaveValue / .shard-custom-caret / .shard-editor-tag-highlight`，要按 CM 结构与 `editor-helpers.ts` 重写） | V4 |
| Playwright fixme（**留着**） | `editor-table.spec.ts` 全部 + `编辑态给出可编辑表格…`（P3） | 不动 |

## 2. 任务

### V1 `src/editor/extensions/tag-autocomplete.ts`
- `createShardTagAutocomplete({ getKnownTags: () => string[], maxSuggestions: number }): Extension`，内部 `autocompletion({ override: [tagSource], activateOnTyping: true, icons: false, defaultKeymap: true, closeOnBlur: true, tooltipClass: () => "shard-cm-tag-tooltip", optionClass: … , addToOptions: [徽标渲染] })`。
- `tagSource(context)`：
  - `const active = getActiveTag(context.state.doc.toString(), context.pos)`，为 null 返回 null；
  - 组合态返回 null（`context.view?.composing`；若 source 拿不到 view，用一个记录 `composing` 的 ViewPlugin/StateField 兜底）；
  - 候选：`getMatchingTagsBySearchQuery(index, normalizeTag(active.query), maxSuggestions)` → `{ label: tag, type: "shard-tag", apply }`；query 非空且不在已知列表 → 追加 `{ label: normalizeTag(query), type: "shard-tag-new", detail: "新建" }`；空 query（刚打 `#`）→ 已知标签前 N 个、不出新建项（与旧 `tagSuggestions` 一致，先读旧代码确认）；
  - 返回 `{ from: active.hashStart, to: context.pos, options, filter: false }`；不用 `validFor`（排序依赖 query，每次重算）。
- `apply(view, completion, from, to)`：`applyTagCompletion(view.state.doc.toString(), active, completion.label)` → `textEditToTransaction` → dispatch（补空格、光标停在空格后），**语义与旧 `applyTag` 完全一致**。
- `getKnownTags` 用 ref 读，known tags 变化时不重建扩展。
- a11y：CM 的 `ul[role="listbox"]` 加 `aria-label="标签建议"`（CM 没有配置项；用 ViewPlugin 在 tooltip 出现后设置，或 `EditorView.updateListener` 里查 `.cm-tooltip-autocomplete > ul`），option 的 `role="option"` 与 contentDOM 上的 `aria-activedescendant` 由 CM 维护。
- 键盘：ArrowUp/Down 循环、Enter 接受、Escape 关闭（CM 默认）；确认补全打开时 `Cmd+Enter` 的行为与旧 `handleKeyDown` 一致（先读旧代码：是提交还是先接受候选），写进用例。

### V2 主题（`theme.ts` 追加，只用 token）
- `.cm-tooltip.shard-cm-tag-tooltip`：`background: var(--popover)`、`color: var(--popover-foreground)`、`border: 1px solid var(--border-visible)`、`border-radius: var(--shard-radius-control)`、`box-shadow: var(--shard-shadow-popover)`、内边距、最大高度与滚动、字号——对齐旧弹层 `.module.css` 的尺寸。
- `li[role="option"]`：行高 / 内边距对齐旧 `styles.item`；`[aria-selected="true"]` 用 `var(--accent)` / `var(--accent-foreground)`（对齐旧 `itemActive`）；「新建」/「使用」徽标复刻旧样式。
- `icons: false` 后确认没有残留的图标占位；`.cm-completionMatchedText` 若保留则用 token，否则关掉。

### V3 宿主接入
- `capture-box.tsx`、`fragment-editor.tsx`：CM 路径下用 `useMemo` 创建 `createShardTagAutocomplete` 并合并进 `extensions`（fragment-editor 已有 `fragmentEditorExtensionSet`，合并进去，保持稳定引用）；`knownTags` 通过 ref 提供。
- CM 路径下不再计算 / 渲染 `tagSuggestions`、`activeSuggestionIndex`、`tagPopoverPosition`、`aria-controls` / `aria-activedescendant`（这些只在 legacy 分支保留；能收进 `LegacyComposerEditor` 的就收进去）。
- 工具栏 `#` 按钮 `insertTag()`：CM 路径 → `handle.applyTextEdit(insertTagMarker(...))` 后 `startCompletion(view)` 立刻打开补全。
- `suppressedActiveTag` 仅 legacy 需要；CM 路径选中后光标已在空格后，`getActiveTag` 为 null，自然不再弹。

### V4 Playwright
- 解除并重写 `从建议里选中标签后自动补空格`（composer）与 `编辑模式选中标签后留出输入边距`（`fragment:fragment-1`）：`fillEditor` + `selectRange` 到 `#wo` 末尾 → `getByRole("listbox", { name: "标签建议" })` 出现 → 点 `/work/` option → `readEditor` 为 `#work `、`selectionStart` 为 6、编辑器仍聚焦；「留出输入边距」改为：光标 x（`getSelection().getRangeAt(0).getClientRects()[0].left`）减去 `.shard-cm-tag` 右缘 ≥ 3px。
- 新增：ArrowDown + Enter 选第二项；Escape 关闭且不改文本；打 `#` 后立即弹已知标签（空 query）；输入未知标签显示「新建」并 Enter 得到 `#新标签 `；光标在汉字后按工具栏 `#` 按钮 → 自动补空格、插 `#`、弹层打开；组合态（CDP `Input.imeSetComposition`）期间无弹层，`Input.insertText` 上屏后出现；补全打开时 Cmd+Enter 的行为断言（按 V1 结论）。
- `npx playwright test --list` 确认。

### V5 报告 `docs/dev/editor-cm6-p2-report.md`
任务表（任务 / 改动文件 / 验证）、门禁数字、bundle（P1 后 JS gzip 349,8xx B → 现在）、用例状态（本阶段解除 2 条 fixme，新增 N 条，P3 仍留 12 条）、未决问题、真机需复核项（候选窗与 IME 候选窗共存、弹层定位在 zen / inline 里是否被裁切）。

## 3. 汇报格式
同 P0/P1。
