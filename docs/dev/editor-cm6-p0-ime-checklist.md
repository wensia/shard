# CM6 迁移 · P0 真机 IME 门禁清单

本清单必须在 macOS 的真实 Tauri WKWebView 中完成。Playwright 使用 Chromium，不能替代本门禁。8 项全部通过后，才可决定是否进入 P1。

## 启动与对照

1. 在仓库根目录运行 `pnpm tauri dev`，确认测试窗口来自本次开发构建，而不是 `/Applications` 中的已安装版本。
2. 默认使用 CM6：打开开发者工具控制台，执行 `localStorage.removeItem("shard.editor"); location.reload()`。
3. 对照旧 textarea：执行 `localStorage.setItem("shard.editor", "legacy"); location.reload()`。
4. 每个场景先测 CM6，再用同一段输入在 legacy 路径复测。记录 macOS 版本、输入法与复现步骤；不要只填“正常”。
5. 完成对照后恢复 CM6：`localStorage.removeItem("shard.editor"); location.reload()`。

也可在启动前以 `VITE_SHARD_EDITOR=legacy pnpm tauri dev` 为整个会话启用旧实现；localStorage 或环境变量任一为 `legacy` 都会启用旧路径。

## 测试环境

| 项目 | 实测 |
|---|---|
| macOS 版本 |  |
| 机器 / 芯片 |  |
| 输入法及版本 |  |
| Shard 提交 | 等待 Claude 验收提交后填写 |
| 测试日期 / 测试人 |  |

## §6.1 门禁

| 完成 | 场景 | 预期 | 实测 | 备注 |
|---|---|---|---|---|
| ☐ | 拼音选词、候选上屏、数字选候选 | composer、inline、zen 中候选窗稳定；空格/回车/数字选择的文字只上屏一次，顺序和光标位置正确 |  |  |
| ☐ | 组合态 Enter；并在组合态测试 Cmd+Enter | Enter 只确认候选，不额外插入换行、不提交笔记；Cmd+Enter 也不得在组合串尚未结束时提交 |  |  |
| ☐ | 组合态 Backspace 删除组合串 | Backspace 只修改当前未上屏的组合串，不误删已上屏文字、任务标记或相邻 Markdown |  |  |
| ☐ | 中英切换、Shift 切换、长按选词 | 切换输入模式与长按选词不中断组合输入；选区、候选窗和最终光标位置正确 |  |  |
| ☐ | 组合态期间触发父组件状态更新 | 时间线刷新、标签索引变化或同类父状态更新后，组合串、候选窗与选择位置保持，不重复或丢失文字 |  |  |
| ☐ | 组合态期间 decoration 重算 | 候选窗不闪烁、不跳位，组合串不被拆断。P0 的 CM 路径尚不启用装饰；本轮先确认无装饰基线，P1 接入装饰后必须重测本项 |  |  |
| ☐ | marked text 下划线与 Kiln 主题 | 系统 marked text 下划线可见且不被编辑器主题覆盖；文字、选区、caret 与背景对比正常 |  |  |
| ☐ | 光标在隐藏标记边界、表格 widget 旁边时组合输入 | 组合输入不跳位、不吞字、不破坏 Markdown。P0 尚无隐藏标记和表格 widget；本轮在对应 Markdown 源码边界记录基线，P1/P3 接入后必须重测本项 |  |  |

## 判定与故障记录

- 门禁结论：**☑ 全部通过**（用户 2026-08-30 在 Tauri 真机确认；进入 P1）/ `☐ 未通过，停止迁移并保留 legacy kill switch`
- 任一失败都记录：宿主（composer / inline / zen）、输入法、原始文本、按键序列、CM6 实测、legacy 对照、是否稳定复现。
- 若 WKWebView 的组合输入稳定失败，不进入 P1；按迁移方案退回纯源码编辑或维持旧实现，由用户与 Claude 决策。

| 失败编号 | 场景 | 最小复现步骤 | CM6 结果 | legacy 结果 | 截图 / 录屏 |
|---|---|---|---|---|---|
|  |  |  |  |  |  |
