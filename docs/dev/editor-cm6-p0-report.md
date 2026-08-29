# CM6 迁移 · P0 执行报告

分支：`editor/cm6`（从 `astryx-migration` 切出）· 快照提交：`80f77f6 wip: CM6 迁移前工作区快照`

## bundle 基线（迁移前，`pnpm build`）

| 产物 | 原始 | gzip |
|---|---|---|
| `dist/assets/index-*.js` | 765,429 B | **242,070 B** |
| `dist/assets/index-*.css` | 493,497 B | 171,001 B |

P0 验收线：JS gzip 增量 < 160 KB（即 < 405,900 B）。

## 依赖版本（已预装）

`@codemirror/state 6.7.1`、`@codemirror/view 6.43.9`、`@codemirror/language 6.12.4`、`@codemirror/lang-markdown 6.5.2`、`@lezer/markdown 1.7.2`、`@codemirror/autocomplete 6.20.3`、`@codemirror/commands 6.11.0`

## 任务进度（Codex 每完成一项在此追加）

| 任务 | 状态 | 改动文件 | 验证 |
|---|---|---|---|
| T0 分支与快照 | ✅ Claude 完成 | — | `git log -1` |
| T1 依赖 | ✅ | `package.json`、`pnpm-lock.yaml`（确认，无内容变更） | `pnpm install --offline --frozen-lockfile --store-dir /Users/panyuhang/Library/pnpm/store/v10` 复用 390 包且锁文件一致；7 个指定依赖版本与报告一致，未安装禁用元包；`pnpm build` 通过（204 token、0 新增设计债），`git diff --check` 通过 |
| T2 shard-editor.tsx | ✅ | `src/editor/shard-editor.tsx` | 新增非受控 `EditorView` 生命周期、文档切换重建 state、同文档最小 diff 外部同步、composition 延迟上报、`requestMeasure` 高度回调及 imperative handle；`pnpm build` 通过（204 token、0 新增设计债），`git diff --check` 通过 |
| T3 text-edit.ts | ✅ | `src/editor/text-edit.ts`、`src/editor/shard-editor.tsx` | 新增公共前后缀最小 diff 的 `textEditToTransaction`，单 transaction 同时应用内容和选区；`ShardEditor.applyTextEdit` 已统一走桥；`pnpm build` 通过（204 token、0 新增设计债），`git diff --check` 通过 |
| T4 theme.ts | ✅ | `src/editor/extensions/theme.ts`、`src/editor/shard-editor.tsx` | 新增 CM6 base/theme：字体、字号、字重、字距、行高、正文、placeholder、caret 与原生选区均消费 Kiln/Shard token；关闭 gutter/activeLine/focus outline 和独立 scroller，未覆盖 IME `text-decoration`；`pnpm build` 通过（204 token、0 新增设计债），`git diff --check` 通过 |
| T5 keymap.ts | ✅ | `src/editor/extensions/keymap.ts`、`src/editor/shard-editor.tsx` | 接入 history/historyKeymap、受限移动/删除/选择键、Mod+Enter、Ctrl/Mod+Shift+F，并将任务行 Enter/Backspace/Delete 经 TextEdit bridge 执行；组合态不拦截；未接入 P2 标签补全按键；`pnpm build` 通过（204 token、0 新增设计债），`git diff --check` 通过 |
| T6 clipboard.ts | ✅ | `src/editor/extensions/clipboard.ts`、`src/editor/shard-editor.tsx` | 普通文本继续走 CM6 纯文本默认粘贴；图片 paste/drop 阻止默认插入并通过宿主回调复用附件流程，过滤规则与旧 textarea 一致；`pnpm build` 通过（204 token、0 新增设计债），`git diff --check` 通过 |
| T7 test-bridge.ts | ✅ | `src/editor/test-bridge.ts`、`src/editor/shard-editor.tsx` | DEV/测试命令环境下注册 `window.__shardEditorTest` 的 list/get/set/select/type；set/type 均走 transaction，type 标注 `input.type`，select 同时聚焦；CM 根元素带 editor id、textbox/多行/label/placeholder ARIA；`pnpm build` 通过（204 token、0 新增设计债），`git diff --check` 通过 |
| T8 kill-switch.ts | ✅ | `src/editor/kill-switch.ts` | 新增 `localStorage["shard.editor"]` 与 `VITE_SHARD_EDITOR` 的 legacy 判定，并标注 IME 门禁后删除；未加入设置 UI；`pnpm build` 通过（204 token、0 新增设计债），`git diff --check` 通过 |
| T9 CaptureBox 接入 | ⚠️ 静态通过 | `src/components/shard/capture-box.tsx`、`src/components/shard/capture-box.module.css`、`src/editor/shard-editor.tsx` | CM/legacy kill switch 双路径；旧 textarea/overlay/caret 抽成 `LegacyComposerEditor`，CM 工具栏、选区、提交、禅模式、图片、Excel 与 requestMeasure 高度/cap/reclaim 已接入，CM 路径不渲染 P2/P3；`pnpm build` 通过（204 token、0 新增设计债），`git diff --check` 通过；针对性 Playwright 在启动 Vite 时被 `listen EPERM 127.0.0.1:1420` 阻塞，未进入断言 |
| T10 FragmentEditor 接入 | ⚠️ 静态通过 | `src/components/shard/fragment-editor.tsx`、`src/editor/shard-editor.tsx` | inline/zen 共用 CM6，fragment/draft 的 documentKey 与测试 id 隔离；保留 legacy、commitOnBlur、dirty/save、zen autosave/flush、Tauri 窗控、图片与 Excel；工具栏走 TextEdit，表格更新走可回推 React 状态的 replaceDocument，补 composition-safe Escape；`pnpm build` 通过（204 token、0 新增设计债；JS gzip 334.65 kB），`git diff --check` 通过；Playwright 仍受 `listen EPERM 127.0.0.1:1420` 阻塞 |
| T11 Playwright | ⚠️ 静态通过 | `tests/ui/editor-helpers.ts`、`tests/ui/shadcn-migration.spec.ts`、`tests/ui/editor-table.spec.ts` | 新增基于 `window.__shardEditorTest` 的 fill/read/select/focus helper，非装饰 composer 操作迁移到 transaction bridge；删除 3 条旧覆盖层/自绘光标用例，原选区用例改写为 CM 原生选区，并新增 inline 工具栏一步撤销与跨片段 history 隔离用例；`npx playwright test --list` 成功发现 47 条（29 条可运行、18 条 P1/P2/P3 fixme），`pnpm exec tsc --noEmit`、`pnpm build`（204 token、0 新增设计债）及 `git diff --check` 通过；实际运行在启动 Vite 时被 `listen EPERM 127.0.0.1:1420` 阻塞，未进入断言 |
| T12 验证与报告 | ⚠️ 静态通过 | `docs/dev/editor-cm6-p0-report.md` | `pnpm build` 通过（2171 modules，3.63s），`verify-tokens` 通过（204 token、49 项存量设计债、0 新增），`git diff --check` 通过；JS gzip 334.65 kB，较 242,070 B 基线增加约 92.58 kB，低于 160 kB 门槛；`npx playwright test` 因沙箱 `listen EPERM 127.0.0.1:1420` 退出 1，WebServer 未启动且未执行断言 |
| T13 IME 门禁交接 | ✅ 文档交接 | `docs/dev/editor-cm6-p0-ime-checklist.md`、`docs/dev/editor-cm6-p0-report.md` | 将方案 §6.1 的 8 条真机场景整理为场景/预期/实测/备注勾选表，补充 `pnpm tauri dev`、CM/legacy localStorage 与环境变量对照步骤、环境信息及失败记录模板；注明 P0 无 decoration/widget 的基线边界和 P1/P3 重测要求；`pnpm build` 通过（2171 modules，3.40s，204 token、0 新增设计债），`git diff --check` 通过；未代替用户执行真实 Tauri IME 验收，按要求到此停止 |

## 提交列表

- T0：分支当前提交 `71985e4`，迁移前快照 `80f77f6`（Claude 已完成）。
- T1–T13：按执行边界未进行任何 git 写操作，等待 Claude 验收后分批提交。

## bundle 基线 → 现在

| 产物 | 基线 gzip | 当前 gzip（Vite） | 增量 | 门槛 |
|---|---:|---:|---:|---:|
| `dist/assets/index-*.js` | 242,070 B | 334.65 kB | 约 92.58 kB | < 160 kB，✅ |
| `dist/assets/index-*.css` | 171,001 B | 173.21 kB | 约 2.21 kB | — |

## 用例状态表

| 分类 | 数量 | 明细 / 证据 |
|---|---:|---|
| Playwright 发现 | 47 | `npx playwright test --list` 成功 |
| 可运行 | 29 | 已完成 CM helper 迁移；本沙箱 WebServer 未启动，不能声称断言通过 |
| `test.fixme` | 18 | 表格编辑 11 条；标签 4 条；选区高亮 1 条；荧光笔 1 条；zen highlight 1 条，留待 P1/P2/P3 |
| 删除 | 3 | 编辑态标签逐字符覆盖层、自绘末行光标、覆盖层滚动滞后回退几何 |
| 改写 | 1 | `editor renders one selection surface...` → `CM 编辑器用原生选区、正文保持 Kiln 选区` |
| 新增 | 1 | inline 工具栏一步撤销、切换片段后 history 隔离 |
| 既有失败 | 2 | 任务书记录的 toolbar tooltip 与 zen highlight；因 WebServer 启动受限，本轮无法复现，且后者现按 P1 标为 fixme |

## 未决问题

| 问题 | 影响 | 建议 |
|---|---|---|
| 沙箱禁止 Vite 监听 `127.0.0.1:1420` | 全量 Playwright 在 WebServer 阶段退出，29 条可运行用例未进入断言；不能作为浏览器运行态验收 | Claude 在允许本机端口监听的环境执行 `npx playwright test`，修复除明确 fixme 外的真实回归 |
| CM P0 路径按范围隐藏标签补全与编辑态装饰 | 标签建议、标签/荧光笔装饰与可编辑表格暂不可用；legacy kill switch 仍可对照 | IME 门禁通过后严格按 P1→P3 恢复；P0 不提前实现 |
| Tauri 真机 IME 尚未人工验收 | 构建和单测不能证明 macOS 候选窗、marked text 与组合态快捷键正确 | 按 T13 清单在真实 `pnpm tauri dev` 窗口逐项对照 CM 与 legacy，完成后再决定是否进入 P1 |

## Claude 验收（2026-08-30）

- Codex 沙箱不能监听端口，Playwright 由 Claude 在本机执行。首次全量 29 条全部倒在 `beforeEach`：dev server 是在装 CM6 依赖之前启动的，Vite 报 `504 Outdated Optimize Dep`、页面空白；重启 dev server 后恢复。
- 验收中发现并修复：
  1. `src/editor/extensions/keymap.ts` 只绑了 `Mod-Enter`（Mac 上 = Cmd），旧实现 meta / ctrl 都能提交 → 补 `Ctrl-Enter`（`capture, card menu…`、两条表格导出用例因此恢复）
  2. `src/editor/shard-editor.tsx` 的 `extensions = []` 默认参数每次渲染都是新引用，CaptureBox 每次 render 都 reconfigure 5 个 Compartment → 改为模块级稳定常量
  3. 根元素 `editorAttributes` 和 `.cm-content` 形成两个嵌套的 `role="textbox"` → role / aria 移到 `contentAttributes`
  4. `src/components/shard/fragment-editor.tsx` 里 `useTableDocumentDrop` 排在 `if (!isOpen) return null` 之后，打开编辑器时 hooks 数量变化，React 报 `Rendered more hooks than during the previous render` 并卸载整棵树——禅模式白屏。legacy 路径同样崩，是迁移前工作区改动（表格拖放）引入的既有 bug，也是 `editor toolbars…` 用例长期失败的真正原因 → hook 移到提前 return 之前
- 最终门禁：`pnpm build` / `verify-tokens`（204 token，0 新增设计债）/ `git diff --check` 通过；Playwright **29 通过 / 18 fixme / 0 失败**（fixme 为 P1–P3 留待）
- bundle：JS gzip 242,070 B → 333,360 B（**+91.3 KB**，< 160 KB 上限）；CSS gzip 不变
- 视觉核对：CM6 composer 与 legacy 的字体、字号、行高、内边距一致；原生选区铺满行盒；inline 编辑器正常挂载并接受输入；P0 按范围无装饰（标签着色、荧光笔、任务 widget 留 P1）
- 下一步：用户在 Tauri 真机完成 `docs/dev/editor-cm6-p0-ime-checklist.md` 的 8 项门禁；不过则停，过了进 P1
