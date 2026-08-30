# CM6 迁移 · P2 执行报告

范围：仅执行 `docs/dev/editor-cm6-p2-tasks.md` 的 V1→V5；不做 P3/P4，不做 Git 写操作，不运行 Playwright 测试本体。

## 任务记录

| 任务号 | 改动文件 | 验证结果 |
|---|---|---|
| V1 | `src/editor/extensions/tag-autocomplete.ts` | `pnpm build` 通过（204 tokens、49 项存量设计债、0 新增；2176 modules；JS gzip 351.19 kB）；`pnpm test:unit` 通过（2 files / 26 tests）；`git diff --check` 通过。已实现原生 autocomplete、旧 `applyTagCompletion` 语义、无修饰 Enter 接受、Cmd/Ctrl+Enter 保持宿主提交、listbox a11y，以及 compositionstart 关闭 / 组合态不查询 / compositionend 后重触发。 |
| V2 | `src/editor/extensions/theme.ts` | `pnpm build` 通过（204 tokens、49 项存量设计债、0 新增；2176 modules；JS gzip 351.53 kB）；`pnpm test:unit` 通过（2 files / 26 tests）；`git diff --check` 通过。tooltip、option 选中态、滚动尺寸与“新建/使用”徽标全部使用 Kiln / `--shard-*` token；`icons: false` 且匹配文本不另加强调。 |
| V3 | `src/components/shard/capture-box.tsx`、`src/components/shard/fragment-editor.tsx` | `pnpm build` 通过（204 tokens、49 项存量设计债、0 新增；2176 modules；JS gzip 364.74 kB）；`pnpm test:unit` 通过（2 files / 26 tests）；`git diff --check` 通过。composer / inline / zen 注入稳定补全扩展，标签更新经 ref 读取；CM 路径不再构建 legacy 搜索索引与建议，旧弹层仍只在 legacy 渲染；工具栏 `#` 使用当前 EditorView 文本执行 `insertTagMarker` 后调用 `startCompletion`。 |
| V4 | `tests/ui/editor-helpers.ts`、`tests/ui/shadcn-migration.spec.ts` | `pnpm build` 通过（204 tokens、49 项存量设计债、0 新增；2176 modules；JS gzip 364.74 kB）；`pnpm test:unit` 通过（2 files / 26 tests）；`git diff --check` 通过；`npx playwright test --list` 通过并发现 63 tests / 2 files。解除 2 条 P2 fixme，新增 7 条：键盘第二项、Escape、空 query、未知标签新建、工具栏 `#`、CDP IME、Cmd+Enter。按约束未运行 `playwright test`。 |
| V5 | `docs/dev/editor-cm6-p2-report.md` | 最终 `pnpm verify:tokens`、`pnpm build`、`pnpm test:unit`、`git diff --check`、`npx playwright test --list` 全部通过；详细数字见下文。到 V5 停止。 |

## 实施假设与未决问题

- V1 假设：`getKnownTags()` 返回值以引用变更表示标签集合更新；宿主会通过 ref 指向新的标准化数组，因此扩展可以缓存同一引用对应的搜索索引，避免在输入主路径重复构建。
- V1 键盘结论：旧 textarea 只在无 Alt/Ctrl/Meta/Shift 的 Enter 下接受候选；Cmd/Ctrl+Enter 继续提交，不接受候选。CM6 autocomplete 的最高优先级默认键位与此一致，因为其 Enter 绑定不匹配带修饰键的提交快捷键。

## 最终门禁

- `pnpm verify:tokens`：通过；204 个 token 全部定义，49 项存量设计债，0 项新增。
- `pnpm build`：通过；TypeScript 与 Vite 构建完成，2176 modules transformed。
- `pnpm test:unit`：通过；2 files / 26 tests。
- `git diff --check`：通过，无输出。
- `npx playwright test --list`：通过；63 tests / 2 files。受任务约束未运行 `playwright test`，因此这里只证明用例可发现，不声明浏览器断言通过。

## Bundle

- P1 Claude 验收基线：JS gzip `349,8xx B`（P1 报告保留的展示值为 349.8 kB，没有记录精确个位）。
- P2 当前主 JS：`dist/assets/index-B_DT1xXa.js`，原始 `1,132,286 B`；`gzip -c` 为 `363,489 B`，比 P1 增加约 `13.6 kB`（约 3.9%）。
- Vite 构建表：主 JS gzip `364.76 kB`；主 CSS gzip `173.30 kB`。独立 `gzip -c` 测得 CSS `171,143 B`。
- 保留既有 chunk > 500 kB 警告；P2 未进入清单外的拆包优化。

## Playwright 用例状态

- P1 验收基线：43 通过 / 13 fixme / 0 失败，共 56 条。
- P2 静态发现：共 63 条；52 条可运行、11 条 fixme。解除 P2 的 2 条 fixme，并新增 7 条，所以可运行数由 43 增至 52。
- P3 相关 12 条保持原样：`editor-table.spec.ts` 11 条（10 fixme + 1 条既有只读表格用例）以及 `shadcn-migration.spec.ts` 1 条 fixme；最终仍是 11 条 P3 fixme。未修改 P3 实现或用例状态。
- P2 新增/改写覆盖：鼠标选择与尾随空格、inline 光标间距、ArrowDown + Enter、Escape、空 query、未知标签新建、工具栏 `#`、CDP IME、补全打开时 Cmd+Enter 提交。

## 未决问题

- 无新的产品决策问题。
- 运行态仍待 Claude 执行 Playwright：尤其需要确认 CM tooltip 的实际 a11y 名称、点击后 DOM selection rect、CDP IME 时序和 Cmd+Enter 提交调用。当前仅有构建、单测与测试发现证据。

## 真机需复核项

- WKWebView 中标签候选窗与系统 IME 候选窗同时出现时，组合文本、键盘导航和候选选择互不抢占。
- composer、inline、zen 三种容器内 tooltip 均跟随光标，并在窄窗口、滚动和编辑器边缘不被裁切。
- `compositionstart` 关闭既有补全、组合期间不刷新、`compositionend` 后重新打开的时序在真实中文输入法下无闪烁、吞字或重复候选。
- 补全后的尾随空格在真实字体渲染下仍提供至少 3px 的可见输入间距。

## 范围确认

- 旧 textarea、`TagCompletionPopover`、kill switch 与 legacy a11y/键盘逻辑全部保留，没有执行 P4 删除。
- 未实现或修改 P3 表格 widget，也未继续执行 P3/P4。
- 未执行 commit / add / checkout / branch / stash / reset / deploy；只修改工作区文件。
- 未启动监听端口，未运行 Playwright 测试本体。

## Claude 验收（2026-08-30）

Codex 沙箱不能跑 Playwright，浏览器验收由 Claude 完成。首轮全量 2 条失败：

1. `标签补全用 ArrowDown 与 Enter 选择第二项`：用例假设空 query 时第二项是 `work`，实际候选顺序由标签索引决定（`密匣 / 日程 / notes / work`）。用例改为读出第二项再比对，并断言 `aria-selected` 随 ArrowDown 移动。
2. `未知标签显示新建并由 Enter 应用`：候选出现后立刻 Enter 插入了换行而非补全——CM `autocompletion` 默认 `interactionDelay: 75`，候选刚出现的 75ms 内忽略 Enter，Enter 落到 Shard 自己的换行绑定。旧弹层是候选一出现 Enter 就选中，改 `interactionDelay: 0` 保持一致。

视觉核对发现并修复：CM baseTheme 给 `.cm-tooltip-autocomplete > ul` 写死 `monospace`，优先级高于 tooltip 上的字体声明，候选文字变成等宽字体 → 在 `ul` 上再覆盖 `var(--shard-memo-font-family)`。徽标「使用 / 新建」按旧弹层原样（11px muted 灰字），选中态用 `--accent`。

最终门禁：`pnpm build` / `verify-tokens`（204 token）/ `pnpm test:unit` 26/26 / `git diff --check` 通过；Playwright **52 通过 / 11 fixme（P3 表格）/ 0 失败**。bundle JS gzip 349.8 KB → **363.5 KB**（迁移前 +121 KB，上限 160 KB 内）。

核对项（Chromium）：`#wo` 弹出 `work（使用）/ wor（新建）`；工具栏 `#` 在汉字后补空格并立即弹出已知标签；点选 / Enter 后 `#work ` 且光标停在空格后；Escape 关闭不改文本；CDP IME 组合期间无弹层、上屏后出现；listbox `aria-label="标签建议"`。

**真机需复核**（WebKit）：标签候选窗与系统 IME 候选窗同时出现时互不抢键；inline / zen 里弹层贴近窗口边缘不被裁切。
