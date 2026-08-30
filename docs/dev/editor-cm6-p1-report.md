# CM6 迁移 · P1 执行报告

> 范围：仅执行 `docs/dev/editor-cm6-p1-tasks.md` 的 U1–U6；未做 P2/P3/P4，未做任何 Git 写操作，未实际运行 Playwright。

## 任务表

| 任务 | 改动文件 | 验证结论 |
| --- | --- | --- |
| U1 Markdown / `==` / 卡片同源 | `package.json`、`pnpm-lock.yaml`、`src/editor/extensions/markdown.ts`、`src/lib/markdown-highlight.ts`、`src/lib/markdown-highlight.test.ts`、`src/components/shard/fragment-content.tsx` | 14 条 parser fixture 通过；build / token / diff check 通过 |
| U2 live preview | `src/editor/extensions/live-preview.ts`、`src/editor/extensions/theme.ts`、`src/editor/shard-editor.tsx`、`src/styles/frontend-rules.css` | 组合态不重算、可见区整行扫描、widget `eq()`；build / token / diff check 通过 |
| U3 keymap 边界 | `tests/ui/shadcn-migration.spec.ts` | 2 条边界用例被 Playwright `--list` 发现；未执行浏览器断言 |
| U4 tag golden | `src/lib/editor-format.test.ts` | 12 条 golden 全通过；总计 26 条 unit 通过 |
| U5 Playwright P1 | `src/editor/test-bridge.ts`、`tests/ui/editor-helpers.ts`、`tests/ui/shadcn-migration.spec.ts`，并收紧 `src/editor/extensions/live-preview.ts` 的 composed mapping | 56 tests / 2 files 可发现；13 条 P2/P3 fixme 保留；未实际运行 Playwright |
| U6 报告与最终门禁 | `docs/dev/editor-cm6-p1-report.md` | `verify:tokens`、26 unit、build、diff check、Playwright `--list` 全通过 |

## 分任务记录

### U1 / Markdown 语言、`==` 语法与卡片同源

- 改动文件：`package.json`、`pnpm-lock.yaml`、`src/editor/extensions/markdown.ts`、`src/lib/markdown-highlight.ts`、`src/lib/markdown-highlight.test.ts`、`src/components/shard/fragment-content.tsx`、本报告。
- 新增 Lezer `ShardHighlight` / `HighlightMark`，沿用 Strikethrough 的定界开闭规则，并明确禁止跨行配对。
- `findInlineHighlights` 遍历与编辑器相同配置的 parser；只读卡片普通正文改用共享范围。单条正文超过 20,000 字符时才降级到旧正则，避免同步解析极端长文本。
- `markdown()` 使用 `base: markdownLanguage`、`addKeymap: false`、`extensions: [ShardHighlight]`；未引入 Markdown keymap。
- 验证：`pnpm test:unit` 1 file / 14 tests passed；`pnpm build` 通过（2183 modules）；`git diff --check` 通过。
- 依赖安装说明：registry 网络请求被沙箱以 `EPERM` 拒绝；最终使用已有全局 pnpm store 执行 `CI=true pnpm install --offline --store-dir /Users/panyuhang/Library/pnpm/store`，复用 423 个包、零下载完成安装。

### U2 / 可见区 live preview decorations 与 widgets

- 改动文件：`src/editor/extensions/live-preview.ts`、`src/editor/extensions/theme.ts`、`src/editor/shard-editor.tsx`、`src/styles/frontend-rules.css`、本报告。
- Markdown 与 Compartment 包装的 live preview 已进入 `ShardEditor` 默认扩展。`localStorage.shard.editorDecorations === "off"` 可整组关闭，不提供产品 UI。
- 只遍历扩展到完整行的 `visibleRanges`。tag 坐标映回文档并以稳定 key 去重；`#tag` 永远只 mark、不 replace、不参与 reveal。含 `getTagRanges` 命中项的图片源码行不整体替换，避免标签被图片 widget 隐藏。
- Highlight、strong、同行成对 `<u>` 使用半开区间 caret-in-node reveal；光标在节点 `to` 算节点外，左移一次才进入。任务框保持 widget，不随光标进入任务行揭示源码。
- 任务、分割线、图片 widgets 复用卡片视觉类；Task / Divider / Image 的 `eq()` 分别按 checked+line、恒等、alt+path 比较。图片复用异步 `loadFragmentImageSrc`，`estimatedHeight = 98`，load/error 后 `requestMeasure()`。
- 组合态：`view.composing` 时绝不调用 decoration builder；doc change 仅以 `DecorationSet.map(update.changes)` 映射旧结果。compositionend 在 microtask 确认退出 composed state 后发专用 effect 重算。
- 样式仅消费 Kiln/Shard token；CM widget 专属几何只写入 `src/styles/frontend-rules.css`。
- 验证：`pnpm test:unit` 14 tests passed；`pnpm build` 通过（2184 modules）；token 契约 204 个 token 全定义、49 项存量债且未新增；`git diff --check` 通过。

### U3 / keymap 与隐藏标记边界

- 改动文件：`tests/ui/shadcn-migration.spec.ts`、本报告。
- 新增 `荧光标记在节点外隐藏，左移进入后揭示并按默认 Backspace 删除`：锁定 `==荧光==|` 隐藏 marker、左移一次揭示、默认 Backspace 产出 `==荧光=`。
- 新增 `任务 checkbox widget 不影响 Enter 续行与任务标记删除`：锁定 widget 存在时 Enter 续出 `- [ ] `，Backspace / Delete 仍删除任务 marker。
- 验证：unit / build / diff check 通过；`npx playwright test --list` 发现 49 tests / 2 files，含 U3 两条；未运行 Playwright。

### U4 / `getTagRanges` golden cases

- 改动文件：`src/lib/editor-format.test.ts`、本报告。
- 12 条输入：`#tag`、`汉字#tag`、`# 标题`、`http://x/#frag`、代码块内 `#x`、`#a#b`、`#tag，`、`#tag `、`(#tag)`、`==#tag==`、`- [ ] #tag`、空串。
- 锁定的既有语义：URL 与 `==#tag==` 不命中；代码块行首 `#x` 命中；`#a#b` 只命中首个 `#a`。没有顺手改变语义。
- 验证：`pnpm test:unit` 2 files / 26 tests passed（Markdown 14 + tag 12）；build / token / diff check 通过。

### U5 / Playwright P1 用例

- 改动文件：`src/editor/test-bridge.ts`、`src/editor/extensions/live-preview.ts`、`tests/ui/editor-helpers.ts`、`tests/ui/shadcn-migration.spec.ts`、本报告。
- 解除并改写 5 条 fixme：原生选区行盒、荧光笔与选区行盒、zen 隐藏 marker、插入标签空格、连续标签间距。CM 用例统一使用测试桥、`.shard-cm-*` 与 `window.getSelection().getRangeAt(0).getClientRects()`。
- 新增/覆盖：`#tag` 永不隐藏、caret reveal、任务框点击写回、任务 Enter/Backspace/Delete、分割线 widget/reveal、图片 `read_fragment_image` widget/reveal、code span 排除、跨 tag/highlight 原生选区 rect、组合态冻结/结束刷新。
- 测试桥只增加只读 `composing` 快照。组合态用例先断言 synthetic `compositionstart` 进入 CM composed state，再检查旧 decoration 映射保留与 compositionend 后重算。
- 保留 fixme：P2 标签补全 2 条；P3 `editor-table.spec.ts` 10 条与正文表格编辑态 1 条。共 13 条，未修改其状态。
- 验证：`pnpm test:unit` 26 tests passed；`pnpm build` 通过（2184 modules）；`git diff --check` 通过；`npx playwright test --list` 发现 56 tests / 2 files。
- 按约束未实际运行 Playwright，不能声称 Chromium 断言通过。选区 rect、synthetic composition、widget DOM/点击等待外部 Chromium 执行。

### U6 / 报告收口与最终门禁

- 改动文件：`docs/dev/editor-cm6-p1-report.md`。
- `pnpm verify:tokens`：通过；204 个 token 全部定义且无自造值，49 项存量债未新增。
- `pnpm test:unit`：通过；2 files / 26 tests passed（本次 10ms）。
- `pnpm build`：通过；TypeScript 与 Vite 均通过，2184 modules transformed，构建耗时 3.26s。
- `git diff --check`：通过，无输出。
- `npx playwright test --list`：通过；56 tests / 2 files。按约束未实际运行。
- 最终 fixme：13（P2 2 + P3 11）。本次 P1 可执行用例数为 43，但仅确认发现、未确认通过。

## Fixture 与用例清单

### Vitest parser fixture（14）

- `==a==` 命中；`\==a==`、未闭合、code span、跨行、`====` 不命中。
- 链接文本、外粗体/内高亮、外高亮/内粗体、中文高亮边界正确。
- Lezer 实际行为：`a==b==c` 命中 `{ start: 1, end: 6, contentStart: 3, contentEnd: 4 }`。
- ATX：`#tag` / `#汉字` 不是标题，`# 标题` 是标题。

### Vitest tag golden（12）

- 见 U4 输入清单；全部锁定 `getTagRanges` 当前返回范围与文本。

### Playwright P1

- 改写：5 条指定 fixme。
- 新增/覆盖：tag 常显、caret reveal、任务 widget 键盘/点击、divider、image、code span、原生选区连续性、组合态冻结。
- `--list` 共 56；未运行浏览器断言。

## Bundle

- P0 基线 JS gzip：333,360 B。
- P1 最终主 JS：`dist/assets/index-DJY2V-CN.js`，原始 1,281,434 B。
- 以 `gzip -c < asset | wc -c` 计算：420,448 B；较 P0 增加 87,088 B（约 26.1%）。
- Vite 构建表显示：主 JS gzip 423.35 kB；主 CSS gzip 173.29 kB。独立命令测得 CSS gzip 171,109 B。
- Vite 保留 chunk > 500 kB 警告；本任务没有进入清单外的拆包优化。

## 未决问题

- 无新的产品决策问题。
- 环境门禁：沙箱不能监听端口，且任务明确禁止实际运行 Playwright；因此 P1 的浏览器行为仍待外部执行确认。依赖 registry 访问同样被 `EPERM` 阻止，但已用本地 store 完成零下载安装与全部静态门禁。

## 真机需复核项

- 原生选区跨 `.shard-cm-tag` 与 `.shard-cm-highlight` 是否碎裂；目标为同一行相邻 rect 间隙 `< 1px`、高度约等于行高。
- WKWebView 真正 IME composed state 下是否始终只映射旧 decoration、compositionend 后正确刷新，且无重复渲染。
- 图片 block widget 的 98px 估高、真实图片 load/error 后测量与滚动稳定性。

## 范围确认

- 旧 textarea / overlay / kill switch 代码均保留，没有执行 P4 删除。
- 没有实现 P2 标签补全 UI、P3 表格 widget 或任何 P4 清理。
- 没有 commit / add / checkout / branch / deploy；当前仅修改工作区文件。

## Claude 验收（2026-08-30）

Codex 沙箱不能跑 Playwright，浏览器验收由 Claude 完成。首轮全量 5 条失败，逐条处理：

1. **图片 widget 抛 `Block decorations may not be specified via plugins`**：CM6 不允许 ViewPlugin 提供 `block: true` 装饰 → 改为整行替换的行内 widget。
2. **3 条选区高度断言**（跨 mark 选区、跨行选区、荧光笔 + 选区）：用例用 `Range.getClientRects()` 量选区，那是字体 content area，不是绘制高度，测量方法不对。
3. **组合态用例**：向 `.cm-content` 派发合成的 `CompositionEvent` 不会让 CM 进入 `composing`（要有真实 DOM 变更）→ 改用 CDP `Input.imeSetComposition` / `Input.insertText` 模拟真实拼音组合，用例通过：组合期间旧 decoration 只映射不重算，上屏后重算。
4. **bundle 超标**（JS gzip 420.4 KB，迁移前 +178 KB > 160 KB 上限）：`@codemirror/lang-markdown` 硬依赖 `@codemirror/lang-html`，把 HTML/CSS/JS 三套解析器一起打了进来。Shard 不做代码块高亮，改为 `@lezer/markdown` parser + `@codemirror/language` 的 `Language` 自建（`extensions/markdown.ts`），移除 `@codemirror/lang-markdown` 依赖 → **349.8 KB**（迁移前 +107.8 KB，回到上限内）。
5. **决策 C 复评结论**：原生 `::selection` 和 CM 自带 `drawSelection()` 在 CM 行内都只盖到字符高度（约 20px，行盒 25.2px），首尾行上下露边、跨行断条——与迁移前覆盖层同样的毛病。新增 `extensions/selection.ts`：用 CM `layer` API 按**行盒**绘制选区（单视觉行用行块高度，软换行用行高；跨行时前一行延伸到内容右缘、后一行从左缘起），光标仍为原生。三条选区用例改为断言 `.shard-cm-selection` 块高 = 行高、同行一块、跨行首尾相接。
6. 分割线 widget 复用卡片 `.shard-fragment-divider`（block + 上下 margin），塞进 `.cm-line` 把一行撑成两行高 → 加 `.shard-editor .shard-cm-divider` 行内块居中，行高回到 25.2px。

最终门禁：`pnpm build` / `verify-tokens`（204 token）/ `pnpm test:unit` 26/26 / `git diff --check` 通过；Playwright **43 通过 / 13 fixme（P2 标签补全 2、P3 表格 11）/ 0 失败**。

视觉核对（Chromium）：标签着色、荧光笔铺满行盒、粗体、下划线、勾选框、分割线、code span 内 `==` 不高亮、光标进入节点揭示 `==`/`**`、选区按行盒连成整片——均正确。

**真机需复核**（WebKit）：拼音组合期间装饰不抖动、不吞字；自绘选区层与 IME 候选窗共存；图片 widget 加载后高度稳定。
