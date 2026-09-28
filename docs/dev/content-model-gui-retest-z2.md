# Shard 缺陷修复复测：筛选下拉残留、导图改名框被冲掉

> 给执行者（Codex，需可用的 computer use）：请完整阅读本文后严格执行。你是**测试执行者**，只操作与记录，不开发、不修复。完成后把报告交回，由 Claude 审核。

## 一、背景

上一轮真实应用冒烟测试（报告：`/Users/panyuhang/projects/coding/products/shard/docs/dev/content-model-tasks-log/gui-smoke/report.md`）有两项失败，现已修复，修复在分支 `fix/gui-smoke-z2`（worktree：`/Users/panyuhang/projects/coding/products/shard-wt-z2`，提交 `5d80561`），**还没有合入主线**：

1. **筛选下拉残留**：时间线筛选对话框里用过类型、属性、运算等下拉后，对话框关闭了，下拉列表却还叠在屏幕上，Esc 和点击外部都清不掉。修复方式：共享下拉控件关闭时立即卸载弹层。
2. **导图改名框被冲掉**：资料库里导图有未保存修改时点改名，改名框出现后随自动保存完成而消失。修复方式：自动保存后编辑器不再抢走改名框的焦点。

本次只复测这两项，外加与修复相关的回归抽查。

## 二、硬性规则（违反任一条立即停止并在报告中说明）

1. **真实 vault `~/Documents/ShardVault` 不得打开、不得写入**。本次只使用上一轮留下的副本 `~/Documents/ShardVault-冒烟`。
2. **不修改任何源码或已跟踪文件**，不 `git commit` / `push` / 切分支 / reset。发现问题只记录，不修复。
3. 不输入、不索取任何密码；密匣保持上锁。
4. **不要停止或操作用户正在运行的 `pnpm tauri dev`**（主工作区，占用 1420 端口）和它的窗口；不要打开 `/Applications/Shard.app`。
5. computer use 不可用时立即停止，在报告中写明原因与错误原文。
6. 产出写到 `/Users/panyuhang/projects/coding/products/shard/docs/dev/content-model-tasks-log/gui-smoke/`：报告 `retest-z2.md`，截图放 `shots-z2/`。全部用简体中文。

## 三、准备

1. 核对修复分支：`git -C /Users/panyuhang/projects/coding/products/shard-wt-z2 log -1 --format='%h %s'`，应为 `5d80561 fix(ui): Z2 …`。记录真实 vault 基线：`git -C ~/Documents/ShardVault status --short` 与 `git -C ~/Documents/ShardVault log -1 --format=%H`。
2. 确认副本存在：`ls ~/Documents/ShardVault-冒烟`。不存在就停止并报告（不要自行从真实 vault 复制）。
3. **在修复分支 worktree 里打包测试应用**（沿用上轮的独立标识，配置里已记着副本路径）：
   ```bash
   cd /Users/panyuhang/projects/coding/products/shard-wt-z2
   pnpm tauri build --config '{"identifier":"dev.shard.desktop.smoke"}' --bundles app --no-sign \
     > /Users/panyuhang/projects/coding/products/shard/docs/dev/content-model-tasks-log/gui-smoke/tauri-build-z2.log 2>&1
   ```
   产物：`/Users/panyuhang/projects/coding/products/shard-wt-z2/target/release/bundle/macos/Shard.app`。用 `/usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier'` 确认标识为 `dev.shard.desktop.smoke`。
4. 打开这个打包应用（`open` 上面的路径），**确认界面显示的资料库是 `ShardVault-冒烟`**，截图 `shots-z2/00-vault.png`。若出现资料库引导，选择副本；若显示的是真实 vault，立即停止。

## 四、复测清单

每项记录：操作 → 预期 → 实际 → 结论（通过 / 失败 / 无法测试）→ 截图文件名。

1. **筛选下拉：确认关闭**：⌘K 搜索面板 →「筛选碎片」→ 依次展开并选择「类型」「时间」「属性名」「运算」（属性名选一个已有属性，如 `测试数字`，运算选「介于」并填两个数）→ 点确认 → 对话框关闭后，**屏幕上不应残留任何下拉列表**。截图。
2. **筛选下拉：取消关闭**：重新打开筛选，展开并选择几个下拉后点「取消」→ 无残留。
3. **筛选下拉：Esc 关闭**：重新打开筛选，展开一个下拉（列表处于展开状态）→ 按一次 Esc，**只收起下拉、对话框仍在** → 再按一次 Esc，对话框关闭 → 无残留。
4. **筛选下拉：点外部关闭**：重新打开筛选，选择几个下拉后点击对话框外的遮罩 → 无残留。
5. **切到资料库无遮挡**：完成 1–4 后切到资料库，文件列表与操作不被任何弹层遮挡。清除时间线筛选，确认全部卡片恢复。
6. **导图改名框**：资料库打开一个导图 → 双击改一个节点文字 → **不等保存**立刻点标题的改名按钮 → 等到界面显示「已自动保存」→ **改名输入框仍在、光标仍在输入框里** → 输入新名称并确认 → 改名成功，刚才的节点修改仍在，编辑器没有整个重建。截图（改名框在「已自动保存」之后仍可见的状态、改名成功后的状态）。
7. **回归抽查：其它下拉**：在一条碎片的禅模式属性区「添加属性」里展开类型下拉并选择 → 正常；标签主题页或任一处其它下拉，展开再收起 → 无残留、选择生效。
8. **回归抽查：导图键盘操作**：打开一个导图，点画布后用键盘新建一个子节点（Tab）或同级节点（Enter），输入文字 → 正常；切到大纲视图再切回 → 正常。

## 五、收尾

1. 退出打包的测试应用，确认进程消失。**不要**停止用户的 `pnpm tauri dev`，不要打开 `/Applications/Shard.app`。
2. 再次记录真实 vault 的 `git status --short` 与 HEAD，与基线对比。
3. 不删除副本、独立配置目录和打包产物，在报告中列出路径。

## 六、报告结构（`gui-smoke/retest-z2.md`）

1. 环境：修复分支提交、打包产物路径与标识、副本路径、computer use 是否正常。
2. 清单结果表：编号、项目、结论、关键观察、截图文件名。
3. 失败与异常详情：复现步骤、预期、实际、截图。
4. 收尾确认：测试应用已退出、用户的 dev 未被打扰、旧版应用未打开、真实 vault 前后对比。
