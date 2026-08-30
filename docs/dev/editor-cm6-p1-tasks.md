# CM6 迁移 · P1 任务清单（装饰 / live preview，交 Codex 执行）

依据：`docs/dev/editor-codemirror-migration-plan.md` v2 §4.3、§5、§7；P0 报告 `docs/dev/editor-cm6-p0-report.md`。P0 已验收（Playwright 29 通过 / 18 fixme / 0 失败），**真机 IME 门禁已由用户于 2026-08-30 确认通过**。本清单只做 P1；P2（标签补全 UI）、P3（表格 widget）、P4（删旧代码）不要做。

## 0. 硬性约束（同 P0，全程遵守）

- 中文注释与汇报；遵守 `AGENTS.md`（Runtime Rules、kiln token、不在 theme 里写裸 hex）、`CLAUDE.md`。
- **不做任何 git 写操作**（沙箱对 `.git` 只读）；进度写到 `docs/dev/editor-cm6-p1-report.md`，提交由 Claude 验收后分批完成。
- Codex 沙箱不能监听端口：Playwright 用例要写好并用 `npx playwright test --list` 确认能发现，运行由 Claude 做。
- 每个任务结束跑 `pnpm build`（含 `verify-tokens` + tsc）、`git diff --check`；引入 vitest 后跑 `pnpm test:unit`。
- kill switch 与 legacy 路径保留；旧覆盖层代码不删（P4）。
- 已定决策（方案 §7）：**A** 光标所在 inline 节点显示源码（caret-in-node），`#tag` 只着色永不隐藏；**C** 原生 `::selection`，本阶段复评碎裂；**E** decoration 做成 Compartment，留 localStorage 调试开关不进 UI；**F** `==` 用 Lezer `MarkdownConfig`；v1 不做标题放大、列表符号 widget 化；**组合态期间不重算 decoration**。
- 有产品决策疑问记到报告「未决问题」，继续做不受影响的部分。

## 1. 现状速查

| 位置 | 内容 | P1 关系 |
|---|---|---|
| `src/editor/shard-editor.tsx` | `extensions` prop（宿主追加，已 Compartment 化）、`createExtensions()`、测试桥注册 | 把 P1 扩展加进默认扩展列表 |
| `src/editor/extensions/theme.ts` | `createShardEditorTheme(variant)`，只用 `var(--token)` | 追加装饰类样式 |
| `src/editor/extensions/keymap.ts` | Enter / Backspace / Delete 已走 `applyTaskLineBreak` / `applyTaskMarkerDeletion` | U3 验证与 widget 共存 |
| `src/lib/editor-format.ts` | `getTagRanges` / `isTagBoundary`（全文原始字符串扫描，会命中代码块、URL——**保持现状**）、`toggleTaskLine`、`parseMarkdownImageLine`、`isMarkdownHorizontalRuleLine` | 直接复用 |
| `src/components/shard/fragment-content.tsx` | 只读卡片：`INLINE_HIGHLIGHT_PATTERN = /==(.+?)==/g`（87 行）、`renderInlineContent`（887）、`TaskMarker`（`.shard-task-checkbox` / `-checked`）、`.shard-fragment-divider`、图片 `<img>`（562 / 571 / 665 行，含 vault 图片取用逻辑）；`caretAligned` 分支是旧覆盖层（P4 删，**本阶段不动**） | U1 让卡片消费同一解析；widget 复用卡片样式与取图逻辑 |
| `src/styles/frontend-rules.css` | 旧覆盖层样式可作视觉参考：`.shard-editor-tag-highlight { color: var(--shard-editor-tag-fg) }`、`.shard-editor-markdown-highlight`（`padding-block: var(--shard-editor-highlight-pad-y)`、`border-radius: calc(var(--shard-radius-control)/2)`、`background: rgb(var(--shard-warning-rgb)/var(--shard-alpha-21))`、`box-decoration-break: clone`） | 新类 `.shard-cm-*` 复刻这些 |
| token | `--shard-editor-tag-fg`、`--shard-editor-highlight-pad-y: 0.33em`、`--shard-warning-rgb`、`--shard-alpha-*`、`--shard-radius-control` | 直接消费；新增 token 登记 `contract/tokens.json` |
| 依赖 | `@codemirror/lang-markdown 6.5.2`、`@lezer/markdown 1.7.2`、`@codemirror/language 6.12.4` 已装 | U1 |
| 单元测试 | 仓库没有 vitest。**允许**引入 `vitest`（devDependency）+ `pnpm test:unit` 脚本，只用于解析器 fixture / golden case | U1、U4 |
| Playwright fixme（本阶段解除） | `shadcn-migration.spec.ts`：423 `选区高亮铺满行盒且字形垂直居中`、489 `荧光笔高亮与选区共用行盒高度`、554 `zen editor renders highlight markup with hidden markers`、1682 `插入标签按需补空格，汉字后不粘连`、1753 `连续标签高亮保留可见空格` | U5 |
| Playwright fixme（**留着**） | 1706、1734（标签补全，P2）；`editor-table.spec.ts` 全部 + 2045（表格，P3） | 不动 |

## 2. 任务

### U1 Markdown 语言 + `==` 语法（Lezer）+ 卡片同源
- 新建 `src/editor/extensions/markdown.ts`：`markdown({ base: markdownLanguage, addKeymap: false, extensions: [ShardHighlight] })`。`markdownLanguage` 自带 GFM（Table、TaskList、Strikethrough）；**不要**它的 keymap。
- `ShardHighlight`：`@lezer/markdown` `MarkdownConfig`，`parseInline` 定义 `Highlight` 节点与 `HighlightMark` 定界（`==`），风格参照 lezer 的 `Strikethrough` 实现（`~~`）。
- 新建 `src/lib/markdown-highlight.ts`：`findInlineHighlights(text) → { start, end, contentStart, contentEnd }[]`，用同一 parser 解析后遍历 `Highlight` 节点。这是**编辑器与只读卡片共用的唯一真相**。
- 只读卡片：`fragment-content.tsx` 的 `INLINE_HIGHLIGHT_PATTERN` 用法改为调用 `findInlineHighlights`，`renderInlineContent` 输出结构不变。碎片短，同步解析可接受；单条正文 > 20 000 字符时退回原正则并在注释里说明。
- vitest fixture（`src/lib/markdown-highlight.test.ts`）锁定规则：`==a==` 命中；`\==a==` 不命中；`==a` 未闭合不命中；`` `==a==` `` code span 内不命中；`==a\nb==` 跨行不命中；`[==a==](u)` 链接文本内命中；`**==a==**` 与 `==**a**==` 都命中且边界正确；`====` 空不命中；`==荧光==` 命中；`a==b==c` 紧贴字符按 Lezer 实际行为记录。
- `#tag` 不交给 Lezer。加 fixture 证明 `#tag`、`#汉字` 行首不会被解析成 ATX 标题（Lezer 要求 `# ` 有空格），`# 标题` 会。

### U2 装饰插件 `src/editor/extensions/live-preview.ts`
- `ViewPlugin.fromClass` 提供 `decorations`，外包一层 `Compartment`；`localStorage.getItem("shard.editorDecorations") === "off"` 时整组关闭（调试用，不进 UI，注释说明）。
- 只在 `view.visibleRanges` 内生成；`docChanged || viewportChanged || selectionSet` 时重算；**`view.composing` 为 true 时不重算，沿用上一次结果**。
- 规则（基于 `syntaxTree(view.state)` 遍历 + `getTagRanges` 扫描可见范围文本）：
  - `#tag` → `Decoration.mark({ class: "shard-cm-tag" })`。永不隐藏、不参与 reveal。范围必须与 `extractTags` 抽出的标签一致（U4 golden case）。
  - 荧光笔 `Highlight` → 内容 `Decoration.mark({ class: "shard-cm-highlight" })`；两侧 `HighlightMark` → `Decoration.replace({})` 隐藏。
  - 粗体 `StrongEmphasis` → 内容 mark `shard-cm-strong`；`EmphasisMark` 隐藏。
  - 下划线 `<u>…</u>`（Lezer `HTMLTag`）→ 内容 mark `shard-cm-underline`；仅当 `<u>` 与 `</u>` 成对且在同一行时隐藏标签。
  - **caret-in-node 揭示**：主选区（光标或范围）与某 inline 节点（含定界）相交 → 该节点的所有 replace 不应用，mark 保留。
  - 任务标记：Lezer `TaskMarker`（`[ ]` / `[x]`）→ `Decoration.replace({ widget: TaskCheckboxWidget })`，只替换 `[ ]`/`[x]`，不替换列表符 `- `。widget 渲染 `<span class="shard-task-checkbox [shard-task-checkbox-checked]">`（复用卡片样式），`ignoreEvent` 放行 mousedown/click；点击 → `toggleTaskLine` 经 `textEditToTransaction` 写回。勾选框不是隐藏标记，光标在该行时仍显示 widget；`eq()` 按 checked 比较。
  - 分割线：`HorizontalRule` 整行 → `Decoration.replace({ widget: DividerWidget })` 替换整行文本，样式复用 `.shard-fragment-divider`；光标在该行时揭示源码。
  - 图片行：`parseMarkdownImageLine(lineText)` 命中的整行 → `Decoration.replace({ widget: ImageWidget, block: true })`；取图逻辑与 `fragment-content.tsx` 卡片一致（先读那三处 `<img>` 怎么拿 src）；实现 `estimatedHeight` 防滚动跳动；加载失败显示 alt 文本；光标进入该行时揭示源码。
  - 不做：标题放大、列表符号 widget、链接、代码块/行内代码样式（保持源码）。
- 样式（`theme.ts` 追加，只用 token）：
  - `.shard-cm-tag { color: var(--shard-editor-tag-fg) }`
  - `.shard-cm-highlight { background: rgb(var(--shard-warning-rgb) / var(--shard-alpha-21)); border-radius: calc(var(--shard-radius-control) / 2); padding-block: var(--shard-editor-highlight-pad-y); box-decoration-break: clone; -webkit-box-decoration-break: clone }`
  - `.shard-cm-strong { font-weight: 600 }`（若 kiln 有字重 token 用 token）
  - `.shard-cm-underline { text-decoration: underline }`
- 把 markdown 语言与 live-preview 加入 `shard-editor.tsx` 的默认扩展。

### U3 keymap 与隐藏标记的边界行为
- 光标停在 `==荧光==|`（节点外）→ `==` 不可见；按 ← 一次进入节点 → 两侧 `==` 显示；再按 Backspace 删掉一个 `=`（CM 默认行为即可，不要自定义）。写成 Playwright 用例。
- 任务行：P0 的 Enter 续行 / Backspace 删标记在 widget 存在时仍正确（用例）。

### U4 golden case（vitest）
- `src/lib/editor-format.test.ts`：`getTagRanges` 12 条输入快照——`#tag` 行首、`汉字#tag`、`# 标题`、`http://x/#frag`、代码块内 `#x`、`#a#b`、`#tag，`（标点结尾）、`#tag ` 空格结尾、`(#tag)`、`==#tag==`、`- [ ] #tag`、空串。目的是锁定现状，不是改语义。

### U5 Playwright
- 解除并按 CM 结构改写：423、489（`.shard-cm-highlight` 替代 `.shard-editor-markdown-highlight`；选区几何用 `window.getSelection().getRangeAt(0).getClientRects()`）、554（隐藏标记：`==` 在光标外不可见——检查 `.cm-content` 文本 rect 或 replace 后 DOM 无 `==`）、1682、1753（`.shard-cm-tag`）。
- 新增：`#tag` 永不隐藏；caret-in-node 揭示（U3）；任务勾选框点击写回 `- [x]`；分割线 widget 与揭示；图片行 widget（用 mock 的 `read_fragment_image` 返回值）；code span 内 `==` 不高亮；**选区复评**——选中跨越 `#tag` 与荧光笔的文本，`getClientRects()` 相邻 rect 间隙 < 1px 且高度 ≈ 行高（Chromium 结果写入报告，并标注需真机 WebKit 复核）。
- 组合态不重算：若能用 `page.evaluate` 派发 `compositionstart` 后再 dispatch 文本变更并断言 decoration 不变就写；做不到就在报告里说明原因。
- `npx playwright test --list` 确认全部可发现。

### U6 报告
`docs/dev/editor-cm6-p1-report.md`：任务表（任务 / 改动文件 / 验证）、fixture 与用例清单、`pnpm build` / `verify-tokens` / `test:unit` 结果、bundle（P0 后 JS gzip 333,360 B → 现在）、未决问题、**真机需复核项**（选区是否碎裂、组合态 + decoration、图片 widget 高度）。

## 3. 汇报格式
同 P0：任务列表与改动文件、门禁数字、bundle、用例状态、未决问题、需真机复核项。
