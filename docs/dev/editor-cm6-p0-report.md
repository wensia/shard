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
| T1 依赖 | ⏳ | | |
| T2 shard-editor.tsx | ⏳ | | |
| T3 text-edit.ts | ⏳ | | |
| T4 theme.ts | ⏳ | | |
| T5 keymap.ts | ⏳ | | |
| T6 clipboard.ts | ⏳ | | |
| T7 test-bridge.ts | ⏳ | | |
| T8 kill-switch.ts | ⏳ | | |
| T9 CaptureBox 接入 | ⏳ | | |
| T10 FragmentEditor 接入 | ⏳ | | |
| T11 Playwright | ⏳ | | |
| T12 验证与报告 | ⏳ | | |
| T13 IME 门禁交接 | ⏳ | | |

## 用例状态表

（T11 完成后填写：通过 / fixme / 删除 / 既有失败）

## 未决问题

（问题 / 影响 / 建议）
