# CM6 迁移 · P3 执行报告

## 任务进度

### W1 · StateField + table widget

- 改动文件：
  - `src/editor/extensions/table-widget.ts`
  - `src/components/shard/editor-table.tsx`
  - `src/styles/frontend-rules.css`
- 完成内容：新增仅由 `StateField<DecorationSet>` 提供的块级表格 replace 装饰；按行调用 `parseMarkdownTable` 并跳过已消费行；实现 50,000 字符与 6,000 单元格回退；组合态只 map changes；焦点/选择变化按含边界规则在源码态与 widget 态间切换；widget 采用精确表格范围写回、`input` user event、可复用 `updateDOM` 与统一 host 接口。`EditorTable.measure` 已改为可选，legacy 继续传入，CM 使用流式块几何。
- 验证结果：
  - `pnpm build`：通过；设计 token 合约 204/204，通过；存量设计债 49 项、无新增；本次构建 JS `1,132.41 kB`，gzip `364.80 kB`。
  - `pnpm test:unit`：通过，2 个文件、26 个测试全部通过。
  - `git diff --check`：通过。
  - 运行态/Playwright：本任务未运行；受沙箱端口限制，按任务书留到 W5 仅做 `--list` 发现确认。

### W2 · 单一 portal host

- 改动文件：
  - `src/editor/table-widget-host.tsx`
  - `src/editor/shard-editor.tsx`
  - `src/editor/extensions/table-widget.ts`
- 完成内容：按 `EditorView` 建立模块级 `WeakMap` host；所有表格共用 `ShardEditor` 既有 React root 内的一个 `TableWidgetHost`，以 `createPortal` 投送到 widget 容器，未创建 per-widget root。store 在 widget `toDOM` 早于 React host 挂载时可惰性创建；每次 mount/update/unmount 都发布新的 `Map` snapshot；portal key 由容器身份稳定派生，props 更新不更换组件实例。补充 `requestMeasure` 后聚焦入口，并在首帧 portal 未提交时仅做一次 rAF 重试。
- 验证结果：
  - `pnpm build`：首次发现 `requestMeasure` 缺少必需 `read` 回调并已修正；复跑通过。设计 token 合约 204/204，通过；存量设计债 49 项、无新增；本次构建 JS `1,136.05 kB`，gzip `366.05 kB`。
  - `pnpm test:unit`：通过，2 个文件、26 个测试全部通过。
  - `git diff --check`：通过。
  - 运行态/Playwright：未运行；本项只完成静态与构建验证。

### W3 · 宿主接入

- 改动文件：
  - `src/editor/shard-editor.tsx`
  - `src/editor/table-widget-host.tsx`
  - `src/components/shard/capture-box.tsx`
  - `src/components/shard/fragment-editor.tsx`
  - `src/lib/markdown-table.ts`
  - `src/lib/markdown-table.test.ts`
- 完成内容：`ShardEditorHandle` 新增经 `requestMeasure` 调用单一 host 的表格单元格聚焦入口；网格插入后 CM 路径直接聚焦首个表头格，不把焦点抢回 contentDOM。Excel 导入使用 `parseMarkdownTable` 同源 helper 定位首张未超阈值表格并聚焦；原有超阈值 toast 流程保留。两个宿主的 `updateTable` 已限制为 legacy-only，CM 单元格修改只由 widget 对表格源码范围发出精确 changes。
- 验证结果：
  - `pnpm build`：通过；设计 token 合约 204/204，通过；存量设计债 49 项、无新增；本次构建 JS `1,136.71 kB`，gzip `366.23 kB`。
  - `pnpm test:unit`：通过，3 个文件、28 个测试全部通过；新增 2 条导入表格偏移测试。
  - `git diff --check`：通过。
  - 运行态/Playwright：未运行；首格实际焦点留待 W5 用例发现及用户本地运行验收。

### W4 · 键盘与焦点

- 改动文件：无新增改动；复核 `src/components/shard/editor-table.tsx`、`src/editor/extensions/keymap.ts`、`src/editor/extensions/table-widget.ts` 与 `src/editor/table-widget-host.tsx` 的既有 W1–W3 实现。
- 完成内容：确认 widget 内 Tab / Shift+Tab / 末格补行 / Escape 继续由 `EditorTable` input 的 `onKeyDown` 处理，`TableWidget.ignoreEvent() === true` 使 CM keymap 不接管 widget 事件；CM 源码侧 ArrowUp / ArrowDown 保留在 movement allowlist。Escape 将选区放到表格 `from` 后聚焦 contentDOM，含边界让位规则会揭示源码；选区离开 `[from, to]` 后 StateField 重建 widget。
- 验证结果：
  - `pnpm build`：通过；设计 token 合约 204/204，通过；存量设计债 49 项、无新增；本次构建 JS `1,136.71 kB`，gzip `366.23 kB`。
  - `pnpm test:unit`：通过，3 个文件、28 个测试全部通过。
  - `git diff --check`：通过。
  - 运行态键盘与焦点：未在沙箱运行；对应断言在 W5 Playwright 用例中静态发现，实际交互由用户本地执行。

### W5 · Playwright

- 改动文件：
  - `tests/ui/editor-table.spec.ts`
  - `tests/ui/shadcn-migration.spec.ts`
- 完成内容：解除原有 11 条表格相关 fixme（`editor-table.spec.ts` 10 条、`shadcn-migration.spec.ts` 1 条），全部改用 `__shardEditorTest` helper 读取/写入/选择 CM 文档；源码让位断言改为 replace widget 消失、`.cm-content` 显示源码、选区离开后 widget 恢复；移除 textarea 与 legacy measure 层断言。新增 4 条：CM 内一步撤销且 widget 保留、同文档双表独立编辑、CDP IME 中文上屏且 input DOM 身份不变、文档超过 50,000 字符整篇回退源码。连续输入用例也补充了 input DOM 身份复用断言。
- 验证结果：
  - `npx playwright test --list`：通过；发现 2 个文件、67 条测试，其中 `editor-table.spec.ts` 15 条、`shadcn-migration.spec.ts` 52 条。
  - `rg 'test\\.fixme|\\.fixme\\(' tests/ui`：无匹配，当前 UI 用例无 fixme。
  - 按任务约束未实际运行 Playwright；上述结果仅证明用例可发现，不代表浏览器断言已通过。
  - `pnpm build`：通过；设计 token 合约 204/204，通过；存量设计债 49 项、无新增；本次构建 JS `1,136.71 kB`，gzip `366.23 kB`。
  - `pnpm test:unit`：通过，3 个文件、28 个测试全部通过。
  - `git diff --check`：通过。

## 门禁汇总

### W6 · 报告收口

- 改动文件：`docs/dev/editor-cm6-p3-report.md`。
- 完成内容：汇总 W1–W6 任务、静态门禁、bundle、用例状态、未决问题与真机复核项；到此停止，不进入 P4。

| 任务 | 主要改动文件 | 状态与验证 |
| --- | --- | --- |
| W1 StateField + widget | `src/editor/extensions/table-widget.ts`、`src/components/shard/editor-table.tsx`、`src/styles/frontend-rules.css` | 完成；块装饰仅由 StateField 提供，parseMarkdownTable 定界，组合态只 map，精确 changes 写回；build/unit/diff 通过 |
| W2 单一 portal host | `src/editor/table-widget-host.tsx`、`src/editor/shard-editor.tsx` | 完成；单一 React root + portal host，无 per-widget createRoot，稳定容器 key 与 props 更新；build/unit/diff 通过 |
| W3 宿主接入 | `capture-box.tsx`、`fragment-editor.tsx`、`shard-editor.tsx`、`markdown-table.ts` | 完成；插入/导入首格聚焦，宿主 updateTable 仅保留 legacy；build/unit/diff 通过 |
| W4 键盘与焦点 | 复核 W1–W3 相关实现 | 完成；widget 内键盘由 React input 处理，源码边界让位与离开恢复路径确认；build/unit/diff 通过 |
| W5 Playwright | `tests/ui/editor-table.spec.ts`、`tests/ui/shadcn-migration.spec.ts` | 完成；11 条 fixme 解除、4 条新增；67 条可发现、0 fixme；未实际运行 |
| W6 报告 | `docs/dev/editor-cm6-p3-report.md` | 完成；最终静态门禁与验收边界如下 |

### 最终门禁

- `pnpm build`：通过；2180 modules；设计 token 204/204；存量设计债 49、无新增。
- `pnpm test:unit`：3 个文件、28 个测试全部通过。
- `git diff --check`：通过。
- `npx playwright test --list`：通过；2 个文件、67 条测试可发现。
- Playwright 实际运行：按约束未执行，因此没有声称 67 条浏览器断言通过。
- Git：仅做只读 `branch/status/diff` 检查；未 add、commit、push、branch、stash、reset，也未改变 Git 状态。

### Bundle

- P2 主 JS：原始 `1,132,286 B`，独立 gzip `363,489 B`。
- P3 主 JS：`dist/assets/index-QD7WkV38.js`，原始 `1,136,713 B`，独立 gzip `364,964 B`。
- P3 相对 P2：原始增加 `4,427 B`；gzip 增加 `1,475 B`（约 `0.41%`）。
- Vite 构建表：主 JS gzip `366.23 kB`；主 CSS gzip `173.33 kB`。保留既有 chunk 大于 500 kB 警告，未做清单外拆包优化。

### 用例状态

- P2 基线：52 通过 / 11 fixme / 0 失败（P2 已验收记录）。
- P3 静态发现：67 条可运行 / 0 fixme；其中包含原 11 条表格用例与新增 4 条 P3 回归。
- P3 实际浏览器结果：未运行，等待用户本地环境执行。

## 未决问题

暂无产品决策未决项。静态发现无法替代浏览器与真机交互验收，见下节。

## 真机需复核项

- widget input 内中文 IME：候选、上屏、退格、Enter 与中英文切换，确认输入框不重建、不丢焦点。
- 表格滚动与高度变化：插入、连续输入、增删行列、源码态/widget 态切换时不跳动。
- 大表格性能：接近 6,000 单元格时的输入延迟，以及超过阈值和文档超过 50,000 字符时退回源码的响应。
- 双表与撤销：同文档两表独立编辑、Cmd+Z 一步撤回，以及 Escape 后源码边界让位。

## Claude 验收（2026-08-30）

Codex 沙箱不能跑 Playwright，浏览器验收由 Claude 完成。首轮全量 66 通过 / 1 失败：

1. `单元格改动在 CM 内 Cmd+Z 一步撤回且 widget 保留`：撤回本身正确（源码回到初始值），但 CM 撤销会恢复被撤事务 **startState** 的选区——插入表格后选区还停在表格源码范围内，于是让位规则把 widget 换成了源码。修法：`focusTableWidgetCell` 在把焦点交给第一格之前，先把 CM 选区挪到表格块之后，之后所有单元格写回事务的起点选区都在表格外。
2. 截图核对发现 **表格第二列消失、页面被横向拉走**：`.cm-content` 宽 1,000,032px。根因是 P0 漏开 `EditorView.lineWrapping`——CM 默认 `white-space: pre`，内容宽度由最长行决定，块级 widget 的 `width: 100%` 又反过来依赖内容宽度，浏览器给了 1e6px。加上 `lineWrapping`（笔记编辑器本就该软换行）后内容宽 898、表格 866、两列各 432px；长段落软换行正常。

最终门禁：`pnpm build` / `verify-tokens`（204 token）/ `pnpm test:unit` 28/28 / `git diff --check` 通过；Playwright **67 通过 / 0 失败 / 0 fixme**。bundle JS gzip 363.5 KB → **365.0 KB**（迁移前 +123 KB，上限 160 KB 内）。

核对项（Chromium）：表格块级 widget 渲染、单元格打字直接写回源码且焦点不丢、光标进入源码范围让位（widget 消失、`|` 源码可编辑）、离开后恢复、Cmd+Z 一步撤回、双表独立、超阈值与超长文档退回源码、`createRoot` 零次（单一 portal host）。

**真机需复核**（WebKit）：单元格内中文 IME；插入 / 增删行列时不跳动；接近 6000 格的输入延迟。
