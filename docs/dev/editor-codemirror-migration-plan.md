# Shard 编辑器迁移方案：textarea + 覆盖层 → CodeMirror 6

状态：**审计通过，修订版 v2**（council-20260829-185911 裁决已吸收；分歧点按多数派定）· 2026-08-30

## 1. 背景：问题不是一个个 bug，是架构

Shard 编辑区现在的实现是「三层贴合」：

| 层 | 职责 | 代码 |
|---|---|---|
| `<textarea>`（文字透明） | 真正的输入、选区、IME、滚动 | `capture-box.tsx` 1223 行、`fragment-editor.tsx` 1554 行（inline / zen 两种 variant） |
| `.shard-editor-highlight-layer` | 用 `FragmentContent caretAligned` 重新渲染同一段文本，加标签着色、荧光笔、任务勾选框、表格 widget 等 | `fragment-content.tsx` 1121 行（约 1/3 是 caretAligned 分支） |
| 自绘光标 + 自实现点选 | 因为 textarea 文字透明，光标和鼠标命中都得在覆盖层上重新算 | `editor-caret.ts` 336 行 |

三层贴合的硬约束是：**覆盖层必须和 textarea 逐字符同宽**。最近两周暴露的问题全部由此而来：

- 标签芯片字号 12px ≠ 正文 14px → 覆盖层每过一个标签就向左偏 5px，四个标签后点选偏 16.5px
- 芯片留白只能靠负 margin 向相邻空格「借」，一借就把标签后补出来的空格吃掉（用户多次反馈「间隔总是消失」）
- 选区高亮只有字体 content area 高（16px），行高 25.2px，跨行断成横条
- `==` 标记用 `width: 0` 藏起来但 overflow 可见，选区背景从标记里溢出，看起来像「荧光笔后多了个空格」
- 表格可视化编辑要在覆盖层里挂 React 组件，还要处理「光标回到源码时让位」

每个新特性都要再做一次对齐工程，而 textarea 根本做不了真正的 replace / widget。最终决定：**换成单层真实渲染的编辑器**。

## 2. 目标 / 非目标

**目标**
- Markdown 源码仍是唯一真相（`.md` 文件、`content: string`），编辑器只是它的 live preview 视图
- 光标、选区、点击命中、IME、撤销全部交给编辑器库，删掉 `editor-caret.ts`、覆盖层、滚动/高度同步等全部对齐代码
- 保留 `editor-format.ts` 的字符串 `TextEdit` 模型（`applyInlineFormat` 等 20 个函数）和 kiln 视觉
- 现有 tests/ui 用例改写后全部通过（对齐类旧用例删除，见 §7）

**非目标**
- 不做所见即所得（不引入 ProseMirror/TipTap 的 doc 模型，不做 Markdown 序列化层）
- 不改文件格式、不改时间线只读渲染（`FragmentContent` 非 caretAligned 路径原样保留）
- 不重做工具栏 UI
- v1 不做标题放大、列表 widget 化——这是 flomo 式碎片编辑器，不是迷你 Obsidian

## 3. 选型：CodeMirror 6（council 4/4 一致）

| 候选 | 模型 | 结论 |
|---|---|---|
| **CodeMirror 6** + `@codemirror/lang-markdown` | 源码即真相，decoration 做 live preview（Obsidian Live Preview 同架构） | **选它**。唯一不用改数据层就能接上的方案；decoration 三件套刚好对应现在手写的东西：mark ↔ 标签着色/荧光笔，replace ↔ 隐藏 `==`，widget ↔ 勾选框/分割线/图片/表格；`@codemirror/autocomplete` ↔ 标签补全 |
| TipTap（flomo 同款） | ProseMirror 所见即所得 | 要加 Markdown 往返序列化层，`==`、`#tag`、`<u>`、表格都得自写扩展且不保证无损；数据模型从字符串变 doc，等于换数据层 |
| Milkdown | ProseMirror + remark | 生态小、文档一般 |
| Lexical | Meta，React 友好 | Markdown 只是导入导出，不是源码编辑 |
| Vditor / Toast UI | 整套带 UI | 风格无法融进 kiln |

翻转条件（council 记录）：若产品未来转向块级编辑器或需要 CRDT 多人协同，底层必须是 doc AST，届时改推 ProseMirror / Lexical。

## 4. 方案

### 4.1 依赖
`@codemirror/state`、`@codemirror/view`、`@codemirror/language`、`@codemirror/lang-markdown`、`@lezer/markdown`、`@codemirror/autocomplete`、`@codemirror/commands`。不装 `codemirror` 全家桶。

bundle 实测量级约 **+130–150KB gzip**（view ~60、state+language ~25、lang-markdown+lezer ~40–50、autocomplete ~15），不是 90KB；CaptureBox 是首屏组件，不能懒加载，验收线放宽到 **<160KB gzip**。

### 4.2 新模块 `src/editor/`

```
src/editor/
  shard-editor.tsx          React 包装，宿主无关：value / onChange / onSelectionChange / variant(inline|zen|composer) / placeholder / autoFocus
  text-edit.ts              TextEdit → Transaction 桥接（最小公共前后缀 diff）
  test-bridge.ts            window.__shardEditorTest：读写 doc / selection、dispatch transaction，供 Playwright 用
  kill-switch.ts            临时开关（localStorage/env），IME 门禁期间可退回旧 textarea；过门禁即删
  extensions/
    markdown.ts             lang-markdown + GFM（任务列表、表格）+ Lezer MarkdownConfig 自定义 inline `==高亮==`
    live-preview.ts         Compartment 包裹；视口内按语法树生成 decorations（mark / replace / widget）
    tags.ts                 `#tag` 着色：走 getTagRanges（全文扫描语义，不交给 Lezer）
    tag-autocomplete.ts     CM6 原生 autocompletion 源 + kiln 主题；检索走 tag-index.ts，apply 内置 applyTagCompletion 的补空格/新建语义
    keymap.ts               Cmd/Ctrl+Enter 提交、Ctrl+Shift+F 禅模式、任务/列表行 Enter 续行、Backspace/Delete 删任务标记、表格内 Tab 走格
    theme.ts                EditorView.theme 只写 var(--token)；含 IME marked text 样式
    clipboard.ts            clipboardInputFilter：粘贴对齐现有 textarea 语义（换行、列表）；图片 paste/drop 沿用 pendingImages
    tables.ts               表格 widget：单一 React portal host + 容器；定界用 parseMarkdownTable；写回走 updateTable；超阈值退回源码
```

### 4.3 关键设计（含 council 修订）

**受控桥接**
- CM6 非受控。`updateListener` 同步 `doc` 与 selection 到 React；`onChange` 走事务批处理/节流，不让每次击键重渲父树（时间线、标签索引）
- 外部 `value` 回写：`value === view.state.doc.toString()` 则 no-op（比较当前 doc，不比较上次 emit 值，否则 echo-loop）
- **切换片段必须新建 `EditorState`**，禁止 dispatch 进同一份 history，否则 Cmd+Z 会撤到上一条笔记
- 外部替换（Excel 导入等）用 `userEvent` 注解 + `history` 隔离，不能被用户撤销成导航操作
- composition 期间不触发父组件状态更新；不重算光标前方的 decoration

**TextEdit 桥接**：`editor-format.ts` 签名不变，`text-edit.ts` 转最小 `changes` + `selection`；工具栏、快捷键全部经由此桥

**标签**：继续用 `getTagRanges`/`isTagBoundary`，不交给 Lezer。注意它是全文原始字符串扫描（会命中代码块、URL），迁移**不得暗中改语义**，P1 加 golden case 固定现状；`#tag` 只着色、永不隐藏、不进 source-reveal

**`==高亮==`**（决策 F，多数派）：`@lezer/markdown` `MarkdownConfig` 定义 inline `Highlight` 节点。需明确并用 parser fixture 锁定：转义 `\==`、未闭合、code span 内不生效、不跨行、链接文本内、`**==x==**` 定界符优先级。只读卡片 `INLINE_HIGHLIGHT_PATTERN` 在 P1 同步改为消费同一解析结果，避免编辑态与卡片语义分叉

**标记隐藏**（决策 A）：replace decoration；光标/选区/composition 所在 inline 节点内显示源码（窄版 Obsidian）。永远隐藏就是「看不见的字符被选中」这类 bug 的根

**选区**（决策 C）：P0 用原生 `::selection`（contenteditable 原生选区铺满行盒，即 flomo 效果）；P1 上 mark 后复评——WebKit 在多 span 文本上选区可能碎成块，碎了再上 `drawSelection()` + kiln token。`--shard-editor-highlight-pad-y` 只服务荧光笔

**表格**：**禁止 per-widget `createRoot`**（React 异步渲染让 CM6 量高取 0、单元格写回源码会拆掉正在打字的 input）。做法：一个常驻 React root 作 portal host，每个表格 widget 只提供容器 DOM，通过 portal 渲染现有 `MarkdownTableEditor`；`eq()` 按块身份判定容器复用，`updateDOM` 推 props；实现 `estimatedHeight`，量高走 `requestMeasure`；定界用 `parseMarkdownTable` 而非 Lezer table 节点（否则和 `updateTable`、只读卡片对不上）；光标进入表格源码范围时 widget 让位；`MAX_EDITABLE_TABLE_CELLS` 沿用

**标签补全**（决策 B，多数派）：CM6 原生 `autocompletion` + tooltip，theme 套 kiln；定位、键盘导航、IME 共存全托管。现有 `TagCompletionPopover` 的语义（补空格、新建 vs 已有、汉字后不粘连、listbox a11y）整体迁入 `apply` 与 `render`，对应用例改写而非删除

**源码模式**（决策 E）：live-preview 做成 `Compartment`，提供内部/调试开关（localStorage），不进设置 UI

**自动高度 / 折叠**：CaptureBox 现在每次输入同步 mirror 量高并带 composer 负 margin reclaim；CM6 必须走 `requestMeasure`，量高、折叠、`collapseSignal` 写进 P0 验收，不能一句「自动高度」带过

**只读渲染**：`FragmentContent` 删掉 `caretAligned` 分支，只剩卡片渲染

### 4.4 删除清单
`editor-caret.ts`；`fragment-content.tsx` caretAligned 分支；capture-box / fragment-editor 里的 `syncTextareaGeometry`、`editorScrollTop`、mirror 量高、`startPointerSelection`、composition 补丁；`tag-completion-popover.tsx`（语义迁入 autocomplete 后）；CSS：`.shard-editor-highlight-layer`、`.shard-custom-caret`、`.shard-editor-overlay-field`、`.shard-editor-tag-highlight`、`.shard-editor-markdown-marker`、`.shard-editor-selection-highlight`；token：`--shard-caret-*`、`--shard-editor-tag-fg`（改由 theme 消费）、`--shard-editor-highlight-pad-y`（视 P1 选区复评）

## 5. 分阶段（决策 D：先 CaptureBox，但 FragmentEditor 在 P0 同挂）

| 阶段 | 内容 | 验收 | 估算 |
|---|---|---|---|
| **P0 基础替换 + IME 硬门禁** | 宿主无关 `ShardEditor`（props 覆盖 composer / inline / zen）；CaptureBox 接入完整版，**FragmentEditor 同周接入无装饰版**；theme、history、Cmd+Enter、禅模式、占位符；自动高度/折叠/reclaim 走 `requestMeasure`；粘贴过滤；图片 paste/drop；`test-bridge` + Playwright helper（`fillEditor`/`readEditor`/`selectRange` 基于 dispatch transaction，不用 `fill()`）；临时 kill switch | **首日真机 Tauri WKWebView IME 清单全绿**（见 §6.1）；非装饰类用例通过；两宿主行为一致 | 3d |
| P1 装饰 | 标签着色、`==`/`**`/`<u>` mark + replace 隐藏 + caret-in-node 揭示、任务勾选框 widget + Enter/Backspace、分割线、图片行；Lezer `Highlight` 扩展 + parser fixture；卡片改用同一解析；选区碎裂复评 | 标签 5 + 选区/荧光笔 4 + golden case 通过 | 4d |
| P2 标签补全 | 原生 autocomplete 源 + kiln 主题 + a11y 用例迁移 | 标签补全用例通过 | 1d |
| P3 表格 | portal host、Tab 走格、行列操作、超大退回、Excel 导入走受控桥 | 表格 13 用例通过 | 5d+ |
| P4 收口 | FragmentEditor 补齐装饰（应已自动获得）；删旧代码与 token、kill switch；`verify-tokens` 清理；文档 | 全量通过、bundle 增量 <160KB gzip | 3d |

**合计 16 个工作日 + 1 周缓冲**（council 四家：16–20 / 20–25 / 13–16 / 15–18）。最可能爆：P3 表格、P0 IME、P4 收口。

**共存策略**：不做产品级 feature flag、不做双实现；P0 起两个宿主就用同一个 `ShardEditor`（一个带装饰一个暂不带），避免用户保存后再编辑看到两套编辑器；仅保留临时 kill switch 到 IME 门禁通过。

**门禁失败预案**（codex/grok）：若 WKWebView 中文 IME 在 `replace decoration + widget` 下稳定破坏组合输入、且「composition 期间冻结当前行 decoration」无法规避——整次迁移停下，退到「CM6 纯源码编辑 + 非交互 preview」或维持现状；**不要**「先做装饰再修 IME」。

## 6. 风险

### 6.1 P0 真机 IME 门禁清单（Playwright 是 Chromium，永远测不到这条）
- 拼音选词、候选上屏、数字选候选
- 组合态 Enter：只上屏，不提交笔记（Cmd+Enter 同理）
- 组合态 Backspace 删组合串，不删已上屏文字
- 中英切换、Shift 切换、长按选词
- 组合态期间父组件状态更新（时间线刷新、标签索引变化）不炸组合串
- 组合态期间 decoration 重算不抖候选窗
- marked text 下划线样式与 kiln 主题不冲突
- 光标在隐藏标记边界、表格 widget 旁边时的组合输入

### 6.2 其它
1. **Lezer 与 Shard 语法**：`#tag` 不会成 ATX 标题（`#` 后无空格），但要在 P1 用例里显式覆盖 GFM Setext / 列表延续对 `#汉字` 行首的影响；`==` 与 `**` 定界符优先级预留半天
2. **表格 widget**：portal host 生命周期、焦点拦截、退格边缘态、高度重测——按 5d+ 排，仍是最大爆点；视口内大量表格同时挂 widget 会掉帧，需节流
3. **测试改写面**：真实是 35–40 处，不是 25。对齐类用例（`逐字符对齐`、`自绘光标`、`可见层滚动滞后`）是旧架构的锁，**删除**而非移植；其余断言改到源码字符串与可见 widget，不再碰 `.shard-editor-highlight-layer`
4. **AGENTS.md Runtime Rules**：Lezer 增量解析对碎片笔记不是瓶颈；会卡 UI 的是 `updateListener` 每次 `doc.toString()`、表格 React 重绘、自动增高——全部走批处理/`requestMeasure`
5. **设计系统**：CM6 默认样式全部用 kiln token 覆盖；theme 只写 `var(--token)`（`verify-tokens` 扫裸 hex）
6. **行为差异**：撤销粒度、富文本粘贴、Tauri 全局快捷键与 CM6 keymap 优先级——P0 补用例
7. **学习曲线**：Lezer 扩展、Transaction/State、widget 生命周期比 React 状态驱动陡；相关决策集中在本文档

## 7. 决策记录（原 A–F，已定）

| 项 | 决定 | 依据 |
|---|---|---|
| A live preview | 光标所在 inline 节点显示源码；`#tag` 永不隐藏；v1 不做标题/列表 widget | 4/4 |
| B 补全 UI | CM6 原生 autocomplete + kiln 主题，语义与 a11y 用例整体迁入 | 3/4（grok 持复用 popover） |
| C 选区 | 原生 `::selection`，P1 上 mark 后复评碎裂 | 4/4 |
| D 宿主顺序 | 先 CaptureBox；FragmentEditor 在 P0 同挂无装饰实例 | 3/4（antigravity 持先 FragmentEditor + 全局 flag） |
| E 源码模式 | Compartment 内部/调试开关，不进设置 UI | 4/4 |
| F `==` 语法 | Lezer `MarkdownConfig` + parser fixture，卡片同步用同一解析 | 3/4（grok 持正则共用；用户拍板服从多数） |
| 表格形态 | 单一 portal host，禁 per-widget createRoot | 4/4 |
| 共存 | 无产品级 flag；临时 kill switch 到门禁通过 | 3/4 |

## 8. 验收标准

- 改写后的 tests/ui 全量通过；对齐类旧用例已删除；`pnpm build`、`verify-tokens`、`git diff --check` 通过
- `editor-caret.ts` 与覆盖层代码删除，`fragment-content.tsx` 无 `caretAligned`，kill switch 已删
- Tauri 真机：§6.1 IME 清单全绿；粘贴图片、长文档滚动、禅模式、表格编辑手测通过
- 两宿主（CaptureBox / FragmentEditor inline / zen）行为、快捷键、撤销粒度一致
- bundle 增量 <160KB gzip

## 9. 工作量

16 个工作日 + 1 周缓冲（AI 协作）。P0 首日 IME 门禁决定整个项目是否继续。

## 审计记录
- 2026-08-30 · council-20260829-185911 · 选手:codex,antigravity,grok,kimi（mimo 失败） · 主席claude裁决 medium:「批准 CM6 选型；P0 真机 IME 硬门禁；表格禁 per-widget createRoot 改 portal host；FragmentEditor 在 P0 同挂；工期改 15–18 天；B 采原生 autocomplete、F 采与卡片一致的解析器、Lezer 后置」· 报告 /Users/panyuhang/.council/shard/council-20260829-185911/viewer.html
- 2026-08-30 · 用户拍板：分歧点全部服从多数派——F 改为 Lezer `MarkdownConfig`（推翻主席少数派裁决），其余维持；方案正文按此补订为 v2
