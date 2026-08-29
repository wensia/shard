# CM6 迁移 · P0 任务清单（交 Codex 执行）

依据：`docs/dev/editor-codemirror-migration-plan.md`（v2，council 审计通过）。本清单只覆盖 **P0：基础替换 + IME 硬门禁**。P1（装饰）、P2（标签补全）、P3（表格）、P4（收口）**不要做**。

## 0. 硬性约束（全程遵守）

- 语言：注释、提交信息、汇报一律简体中文；代码标识符英文。
- 遵守 `AGENTS.md`：Runtime Rules（不在 UI 线程做重操作；量高走 `requestMeasure`）、Design System（只消费 kiln / `--shard-*` token，theme 里不得出现裸 hex；`src/styles/frontend-rules.css` 只放 Shard 特有几何）、Main Layout / Scroll Rules（composer 不加 document 级滚动监听）。
- 不读取 `.gstack/`、`.playwright-mcp/`、`dist/`、`node_modules/`、`src-tauri/target/`。
- 不改 `.md` 文件格式、不改时间线只读渲染（`FragmentContent` 非 `caretAligned` 路径）、不动工具栏 UI。
- `editor-format.ts` 的 20 个纯字符串函数签名不变，所有编辑操作经由 TextEdit 桥接。
- 旧 textarea 实现在 P0 **保留**，由 kill switch 控制；不要在 P0 删除 `editor-caret.ts` 或覆盖层代码（那是 P4）。
- **Codex 不执行任何 git 写操作**（不 commit、不 branch、不 stash、不 reset）：Codex 沙箱对 `.git` 只读。分支 `editor/cm6` 与迁移前快照已由 Claude 提交（T0 已完成）。每完成一个任务，在 `docs/dev/editor-cm6-p0-report.md` 追加一段「T 编号 / 改动文件 / 验证结果」，提交由 Claude 在验收后按任务分批完成。
- 每个任务结束跑 `pnpm build`（含 `scripts/verify-tokens.mjs` + tsc）和 `git diff --check`（只读，允许）；改了 UI 的任务再跑相关 Playwright 用例。
- 遇到与方案冲突、或需要产品决策的问题：**不要自行拍板**，记到 §3「未决问题」，继续做不受影响的部分。

## 1. 现状速查（动手前先读）

| 文件 | 作用 | P0 关系 |
|---|---|---|
| `src/components/shard/capture-box.tsx`（1223 行） | 首页 composer：透明 textarea + `.shard-editor-highlight-layer` + `.shard-custom-caret`；`applyTextEdit`、`formatInline`、`formatLines`、`insertDivider`、`insertTable`、`insertTag`、`handlePaste`、`handleKeyDown`（Cmd+Enter 提交、Ctrl+Shift+F 禅模式、组合态 `Process`、任务行 Enter/Backspace）、`syncSelection`、`startPointerSelection`、mirror 量高（`TEXTAREA_MIRROR_PROPERTIES`）、`editorScrollTop`、`pendingImages` | 接入 `ShardEditor` 完整版（无装饰） |
| `src/components/shard/fragment-editor.tsx`（1554 行） | 片段编辑：`variant = "inline" | "zen"`，结构与 CaptureBox 相同 | 接入 `ShardEditor` 无装饰版 |
| `src/components/shard/fragment-content.tsx` | `caretAligned` 分支是覆盖层渲染 | P0 不动 |
| `src/lib/editor-caret.ts` | 自绘光标 / 点选命中 | P0 不动（kill switch 旧路径仍用） |
| `src/lib/editor-format.ts` | `TextEdit`、`applyInlineFormat`、`applyLineFormat`、`applyTaskLineBreak`、`applyTaskMarkerDeletion`、`insertHorizontalRule`、`insertMarkdownTable`、`insertMarkdownImage`、`applyTagCompletion`、`getTagRanges` 等 | 原样复用 |
| `src/components/shard/editor-toolbar.tsx` | 工具栏，`onInlineFormat("highlight")` 等 | 不动，只换回调落点 |
| `src/index.css` `:root` | `--shard-editor-font-size / -font-weight / -letter-spacing / -line-height`、`--shard-caret-*`、`--shard-editor-tag-fg`、`--shard-editor-highlight-pad-y`、`--shard-memo-font-family` | theme 消费；新增 token 必须登记到 `contract/tokens.json` |
| `tests/ui/shadcn-migration.spec.ts`、`tests/ui/editor-table.spec.ts` | 49 个用例；`installTauriMock` 在前者 1–328 行；`getByPlaceholder("想到什么，写什么...")` 定位 composer | 见 T11 |
| `playwright.config.ts` | `pnpm dev` 起 `127.0.0.1:1420`，Chromium only | — |

已知的当前失败用例（与本次无关，工作区既有改动所致）：`editor toolbars expose visible labels through the shared icon button`、`zen editor renders highlight markup with hidden markers`——不要试图修它们，但也不要让它们变得更糟。

## 2. 任务

### T0 分支与快照 —— **已由 Claude 完成，Codex 跳过**
- 分支 `editor/cm6` 已创建，迁移前工作区快照已提交（见 `git log -1`）。
- bundle 基线已写入 `docs/dev/editor-cm6-p0-report.md`。
- Codex 从 T1 开始；后续所有任务**不做 git 写操作**。

### T1 依赖
- 依赖已由 Claude 预装（见 `package.json`）：`@codemirror/state`、`@codemirror/view`、`@codemirror/language`、`@codemirror/lang-markdown`、`@lezer/markdown`、`@codemirror/autocomplete`、`@codemirror/commands`。确认 `pnpm install` 干净、版本写进 report。若未预装，自行 `pnpm add` 上述 7 个包。
- 不装 `codemirror` 元包、不装 `@uiw/react-codemirror`。

### T2 `src/editor/shard-editor.tsx` —— 宿主无关的 React 包装
Props（至少）：
```ts
interface ShardEditorProps {
  value: string
  documentKey: string            // 变化 = 换了一篇文档，必须新建 EditorState（history 不得跨文档）
  variant: "composer" | "inline" | "zen"
  placeholder?: string
  autoFocus?: boolean
  readOnly?: boolean
  onChange: (value: string) => void
  onSelectionChange?: (start: number, end: number) => void
  onSubmit?: () => void          // Cmd/Ctrl+Enter
  onToggleZen?: () => void       // Ctrl+Shift+F
  onPasteFiles?: (files: File[]) => void
  onDropFiles?: (files: File[]) => void
  onHeightChange?: (height: number) => void   // 走 requestMeasure，宿主用来做自动高度/折叠
  extensions?: Extension[]       // 宿主追加
}
export interface ShardEditorHandle {
  focus(): void
  getSelection(): { start: number; end: number }
  applyTextEdit(edit: TextEdit): void       // 见 T3
  replaceDocument(value: string): void      // 外部整篇替换（Excel 导入等），userEvent 注解隔离 history
  view: EditorView | null
}
```
规则：
- 非受控：内部持有 `EditorView`；`updateListener` 里只在 `docChanged` 时调 `onChange`，并用 `view.requestMeasure` 之后再上报高度；选区变化走 `onSelectionChange`。
- 外部 `value` 变化：先比较 `value === view.state.doc.toString()`，相等则 no-op；不等且 `documentKey` 未变 → 以最小 diff 的 transaction 写入并加 `userEvent: "shard.external"` 注解；`documentKey` 变化 → `view.setState(EditorState.create(...))`。
- composition 期间（`view.composing`）不上报 `onChange`，结束后补一次。
- 卸载时 `view.destroy()`。

### T3 `src/editor/text-edit.ts` —— TextEdit → Transaction
- `textEditToTransaction(state, edit: TextEdit): TransactionSpec`：对 `state.doc.toString()` 与 `edit.content` 做最小公共前后缀 diff，生成单个 `changes` + `selection`（`edit.selectionStart/End`）。
- `applyTextEdit` 走这个桥，保证 history 粒度是「一次工具栏操作 = 一步撤销」。

### T4 `src/editor/extensions/theme.ts`
- `EditorView.theme` + `EditorView.baseTheme`：字体、字号、字重、字距、行高全部 `var(--shard-editor-*)` / `var(--shard-memo-font-family)`；文字色 `var(--shard-memo-content-color)`；caret 色 `var(--shard-caret-color)`、宽 `var(--shard-caret-width)`；placeholder 色用 kiln muted token；内边距由宿主决定（composer 用 `var(--shard-composer-padding)`）。
- 关闭 CM6 默认的 gutter、activeLine、focus outline；`.cm-scroller` 不出现独立滚动条（高度随内容，由宿主容器滚动）。
- IME marked text（`.cm-content` 下浏览器绘制的下划线）不与主题冲突：不要 override `text-decoration`。
- 原生选区：不加 `drawSelection()`；`::selection` 颜色走现有 `rgb(17 19 21 / var(--shard-alpha-13))` 语义（与 `.shard-editor-selection-highlight` 一致）。
- 新增 token 一律先确认 kiln 语义 token 能否表达；确需新增的登记 `contract/tokens.json`，`verify-tokens` 必须绿。

### T5 `src/editor/extensions/keymap.ts`
- `history()` + `historyKeymap`；`defaultKeymap` 只取需要的（移动、删除、选择），去掉与 Shard 冲突的绑定。
- `Mod-Enter` → `onSubmit`；`Ctrl-Shift-f` → `onToggleZen`（保持现有判断：`ctrl/meta + shift + !alt + "f"`）。
- `Enter`：光标在任务/列表行时用 `applyTaskLineBreak` 走桥；否则默认换行。
- `Backspace` / `Delete`：用 `applyTaskMarkerDeletion` 走桥（保持现有「删任务标记」语义）。
- 组合态（`view.composing`）下 Enter/Backspace 交给浏览器，不拦截。
- P0 不做标签补全相关的 ArrowUp/Down/Enter（P2）。

### T6 `src/editor/extensions/clipboard.ts`
- 先读 `capture-box.tsx` 的 `handlePaste`，把现有语义（纯文本粘贴、图片文件 → `pendingImages`）原样搬到 `EditorView.domEventHandlers({ paste, drop })`；文本走 `clipboardInputFilter` 或默认纯文本，行为与旧 textarea 对齐（换行不多不少）。
- 文件通过 `onPasteFiles` / `onDropFiles` 回给宿主，宿主沿用 `pendingImages` 流程。

### T7 `src/editor/test-bridge.ts`
- 仅在 `import.meta.env.DEV` 或 `globalThis.__SHARD_TEST_COMMANDS__` 存在（`installTauriMock` 会设）时挂载 `window.__shardEditorTest`：
  - `list(): string[]`（已挂载的编辑器 id，`composer` / `fragment:<id>` / `zen:<id>`）
  - `get(id): { value, selectionStart, selectionEnd }`
  - `set(id, value)`、`select(id, from, to)`、`type(id, text)`（走真实 transaction，`userEvent: "input.type"`）
  - `pressKey(id, key)` 不做——按键仍用 Playwright 真实键盘。
- 编辑器根元素加 `data-shard-editor="<id>"`，`role="textbox"`、`aria-multiline`、`aria-label` 沿用旧 textarea 的（placeholder 文案要能被 `getByPlaceholder` 之外的方式定位；给根元素加 `aria-placeholder`）。

### T8 `src/editor/kill-switch.ts`
- `isLegacyEditorEnabled()`：`localStorage.getItem("shard.editor") === "legacy"` 或 `import.meta.env.VITE_SHARD_EDITOR === "legacy"`。
- 两个宿主根据它选旧 textarea 路径或 `ShardEditor`。只是临时开关，不进设置 UI，注释写明「IME 门禁通过后删除」。

### T9 CaptureBox 接入
- 用 `ShardEditor variant="composer"` 替换 textarea + highlight layer + custom caret（旧路径保留在 kill switch 分支里，抽成 `LegacyComposerEditor` 子组件以免 JSX 里两套并排）。
- `applyTextEdit` → `handle.applyTextEdit`；工具栏 `formatInline / formatLines / insertDivider / insertTable / insertTag / insertMarkdownImage` 全部走桥；`focusInsertedTable` 用 `handle.getSelection` + `select`。
- 自动高度、`isEditorExpanded`、折叠 / reclaim、`editorScrollTop` 平移：改由 `onHeightChange`（`requestMeasure`）驱动，删掉 mirror 量高在 CM 路径下的调用；**必须保持 composer 的壳层几何**（现有用例 `输入框达到窗口上限时上下留白对称`、`main shell keeps geometry and local scrolling` 要过）。
- `syncSelection` / `selectionStart` state 改由 `onSelectionChange` 提供。
- 提交流程（`onCreate`、lockbox 判断 `wantsLockbox(content, draftTags)`、`pendingImages`）不变。
- 禅模式打开（`openZenEditor`）不变。
- 标签补全弹层：P0 暂时**不显示**（`activeTag` 逻辑保留但 popover 不渲染，或渲染但 `test.fixme`）；记入未决问题以便 P2 接上。

### T10 FragmentEditor 接入（inline / zen，无装饰版）
- 同一个 `ShardEditor`，`variant` 按 `isZen`；`documentKey = fragment.id`（切片段必须新建 state）。
- 保留现有 `commitOnBlur`、保存、`draft` 逻辑；`applyTextEdit` 走桥；表格编辑 `updateTable` 在 P0 走 `replaceDocument`（P3 再做 widget）。
- zen 的高度 / 滚动模型与 inline 不同：`ShardEditor` 通过 `variant` 区分，不在宿主里 if/else 一堆。
- 两宿主快捷键、撤销粒度、粘贴行为必须一致；写一条 Playwright 用例证明（在 inline 编辑器里 Cmd+Z 只撤一步工具栏操作、切换片段后 Cmd+Z 不会撤到上一条）。

### T11 Playwright
- 新建 `tests/ui/editor-helpers.ts`：`fillEditor(page, id, text)`、`readEditor(page, id)`、`selectRange(page, id, from, to)`、`focusEditor(page, id)`，全部基于 `window.__shardEditorTest`，**不要用 `locator.fill()`**（对 contenteditable 走 execCommand，和 CM6 输入处理不兼容）。
- `installTauriMock` 后的 `beforeEach` 里 `toBeFocused()` 改成对 `[data-shard-editor="composer"] .cm-content` 断言。
- **删除**（不是改写）以下旧架构专属用例：`编辑态标签只着色不画芯片，且与 textarea 逐字符对齐`、`末行换行后自绘光标保持在新行`、`可见层滚动状态滞后时光标回退到实时文本框几何`、`editor renders one selection surface while normal text keeps Kiln selection`（改写为「CM 编辑器用原生选区、正文保持 Kiln 选区」一条）。
- 非装饰类用例改写到 helper，必须通过：`main shell keeps geometry and local scrolling`、`capture, card menu, and share dialog remain functional`、`search recall mode preserves context, focus, and timeline scrolling`、`输入框达到窗口上限时上下留白对称`、`自动同步失败通知可关闭且不堆叠`、片段关系层 5 条、表格「保存后的片段用只读表格渲染」「超宽表格导出」「table fragment exports a non-empty PNG」等只读渲染类。
- 装饰类用例（标签 5 条、选区高亮 2 条、荧光笔、`zen editor renders highlight markup`、表格编辑 11 条）改成 `test.fixme("P1/P2/P3 恢复")`，并在 report 里列表。
- `npx playwright test` 全量：除 fixme 与 §1 已知两条外全部通过。

### T12 验证与报告
- `pnpm build`、`node scripts/verify-tokens.mjs`、`git diff --check`、`npx playwright test` 全部跑一遍，结果写入 `docs/dev/editor-cm6-p0-report.md`：commit 列表、bundle 基线 → 现在（gzip）、用例状态表（通过 / fixme / 删除 / 既有失败）、未决问题。
- bundle 增量必须 <160KB gzip；超了先记录，不要为了达标乱删功能。

### T13 停止点：IME 门禁交接
- 写 `docs/dev/editor-cm6-p0-ime-checklist.md`：方案 §6.1 的 8 条清单做成勾选表（场景 / 预期 / 实测 / 备注），说明如何用 `pnpm tauri dev` 起真机、如何用 `localStorage.setItem("shard.editor","legacy")` 对照旧实现。
- **到此停止，不进入 P1。** 由用户在 Tauri 真机完成清单后决定是否继续。

## 3. 汇报格式（Codex 最终输出）

1. 已完成任务列表（T 编号 + commit hash + 一句摘要）
2. `pnpm build` / `verify-tokens` / `git diff --check` / Playwright 结果（数字）
3. bundle 基线 → 现在
4. 用例状态表
5. 未决问题（需要用户或 Claude 决策的，逐条写清「问题 / 影响 / 建议」）
6. IME 门禁清单路径
