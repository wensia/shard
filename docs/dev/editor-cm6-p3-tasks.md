# CM6 迁移 · P3 任务清单（表格 widget，交 Codex 执行）

依据：`docs/dev/editor-codemirror-migration-plan.md` v2 §4.3「表格」、§6 风险 2、§7「表格形态」（council 4/4：**禁 per-widget `createRoot`，单一 portal host**）。P0–P2 已验收合入（Playwright 52 通过 / 11 fixme / 0 失败），真机复核通过。本清单只做 P3；P4（删旧代码、kill switch）不要做。council 把 P3 列为最大爆点，按 5 天量级排。

## 0. 硬性约束（同前，全程遵守）

- 中文注释与汇报；遵守 `AGENTS.md`（Runtime Rules、只用 kiln / `--shard-*` token）、`CLAUDE.md`。
- **不做任何 git 写操作**；进度写到 `docs/dev/editor-cm6-p3-report.md`。
- Codex 沙箱不能监听端口：Playwright 用例写好并 `npx playwright test --list` 确认可发现，运行由 Claude 做。
- 每个任务结束跑 `pnpm build`、`pnpm test:unit`、`git diff --check`。
- **块级装饰（`block: true`）只能来自 `StateField`**——P1 踩过：ViewPlugin 提供会抛 `Block decorations may not be specified via plugins`。
- **禁止 per-widget `createRoot`**：整个编辑器只有一个常驻 React root（portal host）承载全部表格；widget 只提供容器 DOM；`eq()` 按块身份、`updateDOM()` 推 props 复用 DOM——单元格打字时 input **不得被重建、焦点不得丢**。
- 表格定界用 `parseMarkdownTable`（与只读卡片、`replaceTableLines` 同源），**不用** Lezer 的 `Table` 节点。
- 写回 doc 用精确 `changes`（表格源码范围 → `serializeMarkdownTable`），不整篇替换；Cmd+Z 能撤回一步。
- `MAX_EDITABLE_TABLE_CELLS`（6000）沿用，超阈值退回源码；文档超过 50 000 字符时整体不做表格 widget（主线程规则）。
- 组合态期间不重算表格装饰，只 `map` 变更。
- kill switch、legacy 路径、`fragment-content.tsx` 里 caretAligned 的 `EditorTable` 用法保留到 P4。
- 有产品决策疑问记到报告「未决问题」，继续做不受影响的部分。

## 1. 现状速查

| 位置 | 内容 | P3 关系 |
|---|---|---|
| `src/lib/markdown-table.ts` | `parseMarkdownTable(lines, index) → MarkdownTable \| null`（含 `lineCount`）、`serializeMarkdownTable`、`replaceTableLines(content, startLine, lineCount, table)`、`getLineStartOffset`、`getTableCellCount`、`MAX_EDITABLE_TABLE_CELLS`、`hasOversizedTable`、`createMarkdownTable`、`withTableCell / withInsertedTableRow / withoutTableRow / withInsertedTableColumn / withoutTableColumn / withTableAlign`、`isTableCandidateLine` | 全部复用，不改语义 |
| `src/components/shard/editor-table.tsx` | `EditorTable { measure, onChange(table), onExit?, sourceActive, sourceStart, table }`：每格 `<input data-cell="row:col">`（表头 row = -1），Tab / Shift+Tab 走格、最后一格 Tab 补行，Escape → `onExit`，行列操作条 `.shard-editor-table-action[title="在右侧插入一列" / "删除光标所在行" …]`，根 `.shard-editor-table-block[data-source-active]`、`.shard-editor-table`、`.shard-editor-table-input`。`measure` 是旧覆盖层的测量层 | 组件复用；`measure` 改可选（CM 不传），legacy 照旧传 |
| `src/components/shard/table-size-picker.tsx` | 工具栏网格面板 | 不动 |
| `capture-box.tsx` / `fragment-editor.tsx` | `insertTable(columns, rows)` → `insertMarkdownTable` → `focusInsertedTable(nextContent, cursor)`（先读 P0 时它在 CM 路径怎么做的）；`updateTable(startLine, lineCount, table)`（P0 走 `replaceDocument`）；`insertTableDocuments(paths)`（Excel 导入 → `convertTableDocumentToMarkdown` → `hasOversizedTable`） | W3 |
| `src/styles/frontend-rules.css` | `:451` `.shard-markdown-table`（只读）；`:493` 起 `.shard-editor-table-block` 等编辑态样式 | 复用；新增只放 Shard 几何 |
| `src/editor/shard-editor.tsx` | React 组件，可在 JSX 内挂 portal host；`updateListener` 已有；`extensions` 装配点 | W1 / W2 |
| `src/editor/extensions/live-preview.ts` | 行内装饰（ViewPlugin）。表格**另起文件**，不要塞进去 | — |
| `src/editor/test-bridge.ts` | `get / set / select / type` | 用例用 |
| 用例 | `tests/ui/editor-table.spec.ts` 11 条 fixme（文件内有 `insertTable(page, cols, rows)` helper；旧断言用 `getByPlaceholder().toHaveValue`、`textarea.setSelectionRange`、`[data-cell]`、`.shard-editor-table`、`.shard-editor-table-block[data-source-active]`、`.shard-editor-highlight-layer`）；`shadcn-migration.spec.ts` 的 `编辑态给出可编辑表格，但源文本仍逐字符保留` | W5 |

旧「让位」语义（用例 `光标回到表格源文本时让位给源码编辑`）：textarea 光标进入表格源文本范围 → 表格 widget `aria-hidden` + `data-source-active`，源码可直接编辑。CM 下等价见 W1。

## 2. 任务

### W1 `src/editor/extensions/table-widget.ts` —— StateField + widget
- `StateField<DecorationSet>`：扫描 `doc`（按行 + `parseMarkdownTable`，跳过已消费行）→ 每张表一个 `Decoration.replace({ widget: new TableWidget(descriptor), block: true }).range(from, to)`，`from` = 表首行行首，`to` = 表末行行尾（不含尾换行）。
- 重算时机：`docChanged || selectionSet || refreshTableEffect`；**组合态**只 `decorations.map(tr.changes)` 不重算——组合态与焦点状态各用一个 `StateField<boolean>` 记录，由 `EditorView.domEventHandlers({ compositionstart, compositionend, focus, blur })` 通过 effect 更新（`compositionend` / 焦点变化后 dispatch `refreshTableEffect`）。
- **让位规则**：`sourceActive = contentDOM 有焦点 && selection.main 与 [from, to] 相交（含两端边界）`。sourceActive 的表不放 replace（显示源码，光标可在里面编辑）。焦点在 widget 里的 input 时 contentDOM 无焦点 → 永远是 widget 态。
- 退回源码：`getTableCellCount(table) > MAX_EDITABLE_TABLE_CELLS`，或 `doc.length > 50_000`。
- `TableWidget`：`descriptor = { from, to, sourceText, table }`
  - `eq(other)`：`from` 与 `sourceText` 都相同才相等；
  - `updateDOM(dom, view)`：同一块（`from` 相同）内容变化时 `host.update(dom, props)` 并返回 `true`——这是「打字不重建 input」的关键；
  - `toDOM(view)`：创建 `div.shard-cm-table-widget` 容器，`host.mount(container, props)`；
  - `destroy(dom)`：`host.unmount(dom)`；
  - `estimatedHeight`：`(rows + 2) × 行高估算`（读 `--shard-editor-line-height` 或按 40px/行），图片 widget 那套；
  - `ignoreEvent()` 返回 `true`（widget 内事件全部交给 React）。
- 传给 `EditorTable` 的 props：`table`；`onChange(next)` → `view.dispatch({ changes: { from, to, insert: serializeMarkdownTable(next) }, annotations: Transaction.userEvent.of("input") })`（from / to 取当前 descriptor；写回后 StateField 重算、同一块走 `updateDOM`）；`onExit` → `view.dispatch({ selection: { anchor: from } }); view.focus()`（→ sourceActive → 源码揭示）；`sourceActive: false`；`sourceStart: from`；`measure` 不传。

### W2 `src/editor/table-widget-host.tsx` —— 单一 portal host
- 模块级 `WeakMap<EditorView, HostApi>`；`HostApi { mount(container, props), update(container, props), unmount(container), focusCell(from, cell) }`。
- `<TableWidgetHost view>`：`useSyncExternalStore`（或 `useState` + 订阅）维护 `Map<HTMLElement, Props>`，渲染 `createPortal(<EditorTable key=容器身份 {...props} />, container)`。挂在 `shard-editor.tsx` 的 JSX 里，随 `ShardEditor` 生命周期；`view` 创建后注册、销毁前注销。
- `key` 用容器身份，保证 `update` 只是 props 变化、组件实例不变。

### W3 宿主接入（capture-box / fragment-editor）
- CM 路径下 `insertTable` / `insertTableDocuments` 写回后，聚焦第一个表头格：等 `requestMeasure` 完成后 `host.focusCell(from, "-1:0")`；`focusInsertedTable` 的旧实现读一遍，CM 等价（用例要求 `[data-cell="-1:0"]` 聚焦，且 `readEditor` 为 `|     |     |     |\n| --- | --- | --- |\n|     |     |     |\n\n`）。
- CM 路径下 `updateTable` 不再由宿主做（widget 侧精确写回）；legacy 保留。
- Excel 导入超阈值（`hasOversizedTable`）沿用现有提示流程。

### W4 键盘与焦点
- widget 内 Tab / Shift+Tab / 最后一格补行 / Escape 由 `EditorTable` 处理（焦点在 input，CM 不拦截；确认 CM 的 keymap 不会因 `ignoreEvent` 配置吃掉这些键）。
- CM 内 ArrowDown / ArrowUp 经过表格块：光标停在块边界即触发 sourceActive → 源码揭示，与旧「光标回到表格源文本时让位」等价；用例里用 `selectRange(2, 2)` + `focusEditor` 触发。
- 从源码态再离开表格范围 → widget 恢复。

### W5 Playwright
- `tests/ui/editor-table.spec.ts` 11 条：解除 fixme，按 CM 重写——`getByPlaceholder().toHaveValue(x)` → `expect.poll(() => readEditor(page, "composer")).toBe(x)`；`textarea.focus + setSelectionRange` → `selectRange` + `focusEditor`；让位断言 → `.shard-editor-table-block` 消失且 `.cm-content` 显示 `|` 源码，再 `selectRange` 到表格外 → widget 回来；`.shard-editor-highlight-layer` → `.cm-content`；`[data-cell]`、`.shard-editor-table`、`.shard-editor-table-action` 选择器沿用；`insertTable` helper 保留。
- `shadcn-migration.spec.ts` 的 `编辑态给出可编辑表格，但源文本仍逐字符保留` → widget 可见 + `readEditor` 返回原文一字不差。
- 新增：单元格打字后在 CM 内 Cmd+Z 撤回一步且 widget 仍在；同一文档两张表各自独立编辑；CDP IME 在单元格内打中文不破坏表格；文档超 50 000 字符不做 widget。
- `npx playwright test --list` 确认。

### W6 报告 `docs/dev/editor-cm6-p3-report.md`
任务表、门禁数字、bundle（P2 后 JS gzip 363,5xx B → 现在）、用例状态（应无 fixme 剩余）、未决问题、真机需复核项（widget 内中文 IME、表格滚动跳动、大表格性能）。

## 3. 汇报格式
同前。
