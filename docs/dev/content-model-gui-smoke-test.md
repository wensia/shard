# Shard 内容模型：桌面端真实应用冒烟测试

> 给执行者（Codex，需可用的 computer use）：请完整阅读本文后严格执行。你是**测试执行者**，只操作与记录，不开发、不修复。测试完成后把报告交回，由 Claude 审核。

## 一、背景

Shard 是 Tauri 2 + React 19 + Rust 的本地优先桌面笔记应用，仓库在 `/Users/panyuhang/projects/coding/products/shard`（主工作区，分支 `astryx-migration`）。最近合入了一轮「内容模型」改动，此前只做过 Rust 测试、单元测试和浏览器 mock 的 UI 测试，**从未在真实 Tauri 应用里验证过**。本次测试要在真实应用、真实数据的副本上把关键流程点一遍。

本轮改动要点（测试对象）：

- **大纲 / 流程图**：各是一篇 md，正文是唯一一段 ```` ```shardmap ```` / ```` ```shardflow ```` JSON。速记框 `/大纲`、`/流程图` 创建；大纲可在「大纲 / 导图」两个视图间切换；卡片显示缩略与标题。
- **自定义属性**：碎片、文档、大纲、流程图都能在 frontmatter 里加属性（文本、数字、日期、日期时间、勾选、列表、链接）；禅模式与资料库编辑器顶部有属性区，大纲/流程图工具条有「文档属性」按钮。
- **筛选与标签主题页**：时间线可按类型、按属性筛选；点卡片标签进入标签主题页（卡片 / 表格视图）；搜索框输入 `#` 出现主题页候选。
- **资料库**：导图条目菜单「加入时间线」；导图改名时编辑器不应重建。
- **密匣**：大纲与流程图不能进密匣。

## 二、硬性规则（违反任一条立即停止并在报告中说明）

1. **真实 vault `~/Documents/ShardVault` 只能作为复制源读取**：不得在应用里打开它，不得写入、删除、移动其中任何文件。
2. **不修改仓库任何源码或已跟踪文件**，不 `git commit` / `push` / 切分支 / reset。发现问题只记录，不修复。
3. 不输入、不索取任何密码；副本里的密匣保持上锁，不要尝试解锁。
4. 只操作 Shard 相关的应用与窗口，不碰其它应用。
5. computer use 不可用时立即停止，在报告中写明原因与错误原文，不要改用其它方式伪造结果。
6. 所有产出写到 `/Users/panyuhang/projects/coding/products/shard/docs/dev/content-model-tasks-log/gui-smoke/`：报告 `report.md`，截图放 `shots/`，日志放同目录。全部用简体中文。

## 三、准备（按顺序）

1. **记录基线**（写进报告）：
   - `git -C /Users/panyuhang/projects/coding/products/shard log -1 --format='%h %s'`（预期 `5ce1ed4` 或更新）
   - `git -C ~/Documents/ShardVault status --short` 与 `git -C ~/Documents/ShardVault log -1 --format=%H`（真实 vault 测试前状态，收尾时要对比）
2. **退出旧版应用**：`/Applications/Shard.app` 可能正在运行。它是旧版本，保存时会删除自己不认识的 frontmatter 字段，必须退出：`osascript -e 'tell application "Shard" to quit'`，确认进程消失。**测试全程不要再打开它。**
3. **停止现有开发进程**：主工作区可能有一个长期运行的 `pnpm tauri dev`（进程树包含 `pnpm tauri dev`、`tauri.js dev`、占用 1420 端口的 vite、`target/debug/shard`）。对这组进程发送 SIGINT/SIGTERM，确认 1420 端口释放、`target/debug/shard` 已退出。报告里记下被停止的进程命令行。
4. **复制 vault**：`rsync -a ~/Documents/ShardVault/ ~/Documents/ShardVault-冒烟/`（目标若已存在，先删除再复制，保证是全新副本）。
5. **用独立应用标识启动**（这样不会读写真实配置、缓存与 vault 设置）：在主工作区后台执行
   ```bash
   cd /Users/panyuhang/projects/coding/products/shard
   nohup pnpm tauri dev --config '{"identifier":"dev.shard.desktop.smoke"}' \
     > docs/dev/content-model-tasks-log/gui-smoke/tauri-dev-smoke.log 2>&1 &
   ```
   等 Rust 编译完成、窗口出现（首次编译可能要几分钟，看日志）。
6. 首次启动会出现资料库引导，选择 `~/Documents/ShardVault-冒烟`。**确认应用里显示的资料库路径是副本**，截图 `shots/00-vault.png`。之后若任何界面显示的路径是 `~/Documents/ShardVault`（不带「-冒烟」），立即停止。

## 四、测试清单

每项记录：操作 → 预期 → 实际 → 结论（通过 / 失败 / 无法测试）→ 截图文件名。

1. **启动与搜索**：时间线正常显示；⌘K 搜索副本里存在的一个词，能搜到结果。
2. **大纲**：速记框输入 `/大纲` 进入大纲态 → 写三层节点 → Cmd+Enter 提交 → 时间线新卡片显示根节点标题与导图缩略图 → 卡片菜单「编辑」进入全屏编辑，默认是大纲（幕布）视图 → 切到「思维导图」视图，给一个节点改颜色 → Esc 关闭 → 重新打开，内容与颜色一致。
3. **流程图**：速记框 `/流程图` → 进入流程图编辑器 → 添加两个节点并连线 → Esc → 卡片显示节点与连线计数（如「2 个节点 · 1 条连线」）。
4. **碎片属性**：新建一条普通碎片 → 进入禅模式 → 在顶部属性区添加文本、数字、日期、勾选、列表各一个属性并填值 → 再修改正文、等待自动保存 → **不应出现冲突提示**。随后在终端用 `cat` 查看这条碎片的 md 文件（在 `~/Documents/ShardVault-冒烟/fragments/` 下），确认 frontmatter 里有这些属性、正文正常；把 frontmatter 部分贴进报告。
5. **图的文档属性**：在第 2 步的大纲全屏编辑器工具条点「文档属性」→ 添加一个属性 → 关闭对话框 → 继续编辑大纲并等待自动保存 → **不应出现冲突提示**。流程图同样测一次。
6. **时间线筛选**：打开筛选（入口：⌘K 搜索面板里的「筛选碎片」）→ 类型选「大纲」，只剩大纲卡片；再加属性条件（第 4 步的数字属性，运算选「介于」一个包含其值的区间）→ 结果正确 → 清除筛选，恢复全部。
7. **标签主题页**：点某张卡片上的标签 → 进入该标签的主题页，数量合理 → 切到「表格」视图，能看到第 4 步的属性列 → 点表头排序 → 点某一行打开对应内容。另在 ⌘K 搜索框输入 `#` 加该标签的前几个字，出现「标签主题页」候选，选中能进入。
8. **资料库「加入时间线」**：进入资料库 → 选一个导图（`.shardmap.json` 条目）→ 条目菜单「加入时间线」→ 确认 → 时间线出现对应大纲，资料库里原文件不再显示（已移入回收站）。
9. **资料库导图改名**：打开另一个导图，改一个节点文字后**不等保存**立刻给文件改名 → 编辑器不应整个重建，刚才的修改不丢。
10. **密匣边界**：大纲卡片、流程图卡片的操作菜单里**没有**「移入密匣」；速记框大纲态里写一个含 `#密匣` 的节点再提交 → 被拦截并提示「大纲不能放入密匣」，草稿保留。
11. **界面稳定性**：时间线快速上下滚动、进出禅模式、切换大纲/导图视图时，页面不跳动、不闪白、没有明显卡顿；有异常就截图并描述。

## 五、收尾（必须做）

1. 停止用独立标识启动的 tauri dev 进程树，确认 1420 端口释放。
2. **恢复原开发环境**：在主工作区后台重新启动普通的 dev（不带 `--config`）：
   ```bash
   cd /Users/panyuhang/projects/coding/products/shard
   nohup pnpm tauri dev > docs/dev/content-model-tasks-log/gui-smoke/tauri-dev-restored.log 2>&1 &
   ```
   等窗口出现即可，不做任何操作。**不要**重新打开 `/Applications/Shard.app`。
3. 不删除 `~/Documents/ShardVault-冒烟` 和 `~/Library/Application Support/dev.shard.desktop.smoke`，在报告中列出路径，由用户决定是否清理。
4. 再次执行 `git -C ~/Documents/ShardVault status --short` 与 `git -C ~/Documents/ShardVault log -1 --format=%H`，与测试前基线对比，写进报告。

## 六、报告结构（`gui-smoke/report.md`）

1. **环境**：仓库 HEAD、被停止与新启动的进程、副本路径、独立标识目录、computer use 是否正常。
2. **清单结果表**：编号、项目、结论（通过 / 失败 / 无法测试）、关键观察、截图文件名。
3. **失败与异常详情**：复现步骤、预期、实际、截图，以及 `tauri-dev-smoke.log` 中相关的报错片段。
4. **收尾确认**：独立 dev 已停止、普通 dev 已恢复、旧版应用未重新打开、真实 vault 前后对比结果。
