# 终端交互界面 `shard -i`：搜索 + 内置编辑器 — 施工令

## 背景

`shard -s` / `shard -e` 已可用（`crates/shard-cli/src/{find.rs,edit.rs}`），但 `-e` 依赖外部编辑器，默认 `vi` 对多数用户不友好（方向键无效、不会退出）。用户决定在 CLI 内自建 TUI：**搜索与编辑一体、普通编辑器按键风格**。

分支 `feat/cli-tui`（worktree `shard-wt-tui`，基于 `astryx-migration` 的 `5ce1ed4`）。分三批执行，每批独立一次 Codex 运行、独立提交，Claude 逐批验收后再发下一批。**本次只执行调用时指定的那一批。**

## 通用约束（每批都适用）

- 只改 `crates/shard-cli/**`、根 `Cargo.toml`/`Cargo.lock`（仅为新增依赖）、`README.md`（仅 C 批）与本文件的「回报」小节。不改 `shard-core`、`src-tauri`、前端。
- 测试与手工验证只用临时目录，显式设置 `SHARD_VAULT`/`--vault`、`SHARD_LOCK_DIR`、`SHARD_CLI_STATE_DIR`、`TMPDIR`；不得读写 `~/Documents/ShardVault`、`~/Library/Application Support/dev.shard.desktop`。
- 只跑 `cargo test -p shard-cli -p shard-core` 与 `cargo clippy -p shard-cli --all-targets`。**不要** `cargo test --workspace`：`src-tauri` 构建会把占位 sidecar 复制到 `target/debug/shard-cli`，覆盖真正的 CLI，导致集成测试随机失败。
- 格式化只针对本批新建或改动的文件：`rustfmt --edition 2021 --config skip_children=true <文件…>`，不要整 crate `cargo fmt`（`parse.rs` 为存量未格式化文件）。
- 新增依赖：`ratatui`（最新稳定版，终端后端一律经 `ratatui::crossterm` 再导出使用，不单独引入第二份 `crossterm`）、`unicode-width`、`unicode-segmentation`。不引入其他 TUI/编辑器 crate。
- 用户可见文案与注释用简体中文，风格贴合现有 CLI 代码。
- 每批完成后在 `feat/cli-tui` 上提交本批文件（提交信息见各批），不 push；最后一条消息按「回报」格式。

## A 批：编辑器内核（纯逻辑，无终端依赖）

新建 `crates/shard-cli/src/tui/mod.rs`（仅 `pub mod editor;`，其余模块留给 B 批）与 `crates/shard-cli/src/tui/editor.rs`，`main.rs` 声明 `mod tui;`（未使用项用 `#[allow(dead_code)]` 限定在 tui 模块内，C 批接线后去掉）。

### 数据与坐标

- 缓冲区：`Vec<String>` 逻辑行（按 `\n` 切分；载入时 `\r\n` → `\n`）。
- 光标：`(行号, 字节偏移)`，字节偏移始终落在**字素簇**边界（`unicode-segmentation`）。
- 显示宽度：`unicode-width`；制表符按 4 列计；宽度为 0 的字素按 1 计（避免卡住光标）。

### 软折行（`layout(width) -> Vec<VisualRow>`）

- 每个逻辑行按显示宽度 `width` 折成若干视觉行，空行也占一行。
- 中日韩等宽字符可在任意字素处断开；连续 ASCII 字母数字构成的单词尽量不断开：若当前视觉行里在该单词前有空格，就在空格后断行；单词本身超过 `width` 时才强行断开。
- 视觉行记录：所属逻辑行、起止字节偏移、每个字素的起始显示列（供光标定位与鼠标点击换算）。
- 提供 `cursor_visual(width) -> (视觉行, 列)` 与 `position_at(width, 视觉行, 列) -> 光标`（列落在宽字符中间时取该字符左侧）。

### 编辑与移动（全部是 `Editor` 的方法，返回是否改变了文本）

- 插入文本（支持多行粘贴，`\r\n`/`\r` 归一为 `\n`）、换行、Tab 插入两个空格。
- 退格 / 删除：按字素；在行首退格与上一行合并，在行尾删除与下一行合并。
- 按词删除（Option+Backspace）：删除光标前一个「词」——连续 ASCII 字母数字，或单个中日韩字素，或连续空白。
- 删除到视觉行首（Ctrl+U）、删除到逻辑行尾（Ctrl+K；已在行尾时删除换行）。
- ←/→ 按字素（跨行），Option+←/→ 按词（同上词定义），Home/End 与 Ctrl+A/Ctrl+E 到**视觉行**首尾，Ctrl+Home/Ctrl+End 到全文首尾。
- ↑/↓ 按视觉行移动并保持「期望列」（连续上下移动时不因短行丢失列位置；任何水平移动或编辑后重置）；PageUp/PageDown 按给定行数移动。
- **列表续行**：在以 `- `、`* `、`+ `、`- [ ] `、`- [x] `/`- [X] `、`N. `、`> `（允许前导空格）开头的行按 Enter：新行带上同样前缀（任务项一律续为 `- [ ] `，有序号的续为 `N+1. `，保留缩进）；若当前项只有前缀没有内容，Enter 改为清除该前缀（留下空行），不新建行。
- 撤销 / 重做：快照式（文本 + 光标）。连续的单字符插入合并为一步，遇到空白、换行、光标跳转或距上次输入超过 1 秒时断开；删除同理单独成组；粘贴、列表续行、按词删除各自一步。重做栈在新编辑后清空。上限 200 步。
- `text() -> String`（`\n` 连接）、`is_dirty()`（与载入时或上次 `mark_saved()` 时的文本比较）、`mark_saved()`。

### 单元测试（至少覆盖）

中文/英文/emoji/组合字符混排的折行宽度与断点；英文单词不被断开及超长单词强断；上下移动跨折行保持期望列；宽字符上的点击定位；各删除操作跨行；列表续行 6 种前缀与空项清除；撤销分组（连续打字一步撤销、空白断组、粘贴单步）与重做清空；`\r\n` 载入与 `text()` 往返。

提交：`feat(cli): TUI 编辑器内核——软折行、光标、编辑与撤销`

## B 批：界面外壳（ratatui）

新建 `crates/shard-cli/src/tui/{app.rs,search_view.rs,editor_view.rs,terminal.rs}`。界面逻辑与终端 I/O 分离：`App` 是纯状态机（`handle(Event) -> Action`），渲染函数只读状态，可用 `ratatui::backend::TestBackend` 测试。

### 终端（`terminal.rs`）

- 进入：备用屏幕、raw 模式、括号粘贴（bracketed paste）、鼠标捕获；退出与 panic 时**必定**恢复（安装 panic hook；`Drop` 兜底）。
- 事件：键盘、粘贴（整段文本一次插入）、鼠标左键按下（定位光标 / 选中结果）、滚轮（滚动 3 行）、窗口尺寸变化。

### 搜索页

- 布局：顶部一行查询框（`搜索：` + 输入内容 + 光标）；中部结果列表（沿用 `find::format_hits` 的列：日期、短 id、带高亮的预览；当前项反色）；底部预览区（选中碎片正文，按宽度折行，最多占 40% 高度）；最底一行按键提示。
- 行为：每次按键实时调用 `find::search`（空查询 = 最近修改，上限 200 条）；查询框支持 ←/→、退格、Ctrl+U 清空、粘贴；↑/↓、Ctrl+P/Ctrl+N 选择，PageUp/PageDown 翻页；Enter 打开编辑页；Esc：查询非空则清空，为空则退出；Ctrl+C 随时退出（有未保存编辑时先确认）。
- 无结果显示「没有找到包含「…」的碎片」；窗口小于 40×10 时整屏显示「窗口太小」。

### 编辑页

- 顶栏：`编辑 <短id> · <标题> · #标签…`，右侧未保存时显示 `● 未保存`，保存后短暂显示 `已保存`。
- 正文：用 A 批 `layout` 渲染，光标用终端真实光标（`frame.set_cursor_position`），保持光标可见的自动滚动；鼠标点击定位。
- 底栏：`Ctrl+S 保存  Esc 返回  Ctrl+Z 撤销  Ctrl+Y 重做  Ctrl+Q 退出`；错误信息显示在底栏上方一行（红色），直到下一次按键。
- 按键：A 批定义的全部编辑与移动；Ctrl+S 保存（留在编辑页）；Esc 返回搜索页；Ctrl+Q 退出程序；Ctrl+Shift+Z 也作重做。Option 组合键兼容两种终端编码：`Alt+Left/Right/Backspace` 与 `Alt+b/f`、`Esc 前缀`。
- 有未保存修改时 Esc / Ctrl+Q / Ctrl+C 弹出确认框：「保存修改？」`Enter/S 保存  D 不保存  Esc 取消`。

### 保存接口（为 C 批预留，B 批用可注入的 trait 实现测试）

`trait Store { fn save(&mut self, id: &str, body: &str) -> Result<SaveReport, SaveError>; fn reload(&mut self) -> Result<Vec<FragmentEntry>, String>; }`，`SaveError` 至少区分：`Conflict { draft_path }`（文件在打开后被改动，已把当前文本另存到临时文件）、`Locked`、`Invalid(String)`（空正文、密匣标签等）。编辑页按类型显示：冲突时底栏提示「这条碎片已被其他地方修改，没有覆盖；你的内容已另存到 <路径>」，保留缓冲区与未保存状态。

### 测试

用 `TestBackend` 与假 `Store`：输入查询后结果过滤；Enter 进入编辑页且顶栏正确；打字后显示 `● 未保存`；Ctrl+S 调用 `Store::save` 且状态变为已保存；Esc 在未保存时弹确认、选 D 回搜索页且不保存；冲突与加锁失败的提示文案；窗口太小提示；中文长段落在编辑页折行渲染正确（断言若干行的文本）。

提交：`feat(cli): TUI 搜索页与编辑页`

## C 批：接入、保存与文档

- 从 `edit.rs` 抽出共用保存逻辑：`open_session(entry) -> Session`（读文件、记下全文 sha256、`parse_fragment`、拒绝大纲/流程图）与 `save_session(&mut Session, body, lock_dir, timeout) -> Result<SaveReport, SaveError>`（沿用现有语义：空正文拒绝、`edited_tags`、含 `#密匣` 拒绝、取 `VaultProcessLock`、核对 sha、`write_fragment_update`、刷新 `updated_at`；成功后把 `Session` 的基线 sha 与 raw 更新为新文件，使同一会话可连续保存；冲突时把正文写入临时文件并返回路径）。外部编辑器流程改为调用它，行为与退出码不变（现有集成测试必须原样通过）。
- 入口：
  - `shard -i [关键词…]` / `--interactive`：打开搜索页，可带初始查询。
  - `shard -e [目标]`：stdin 与 stdout 都是终端时，解析目标后直接进入内置编辑页（关键词多条命中时改为打开带该查询的搜索页）；加 `--external` 或不在终端中时走现有外部编辑器流程。
  - `-i` 在非终端中报错「交互界面需要在终端中运行」，退出码 1。
- 实现 `Store`：保存走 `save_session`，`reload` 重新 `load_fragments`；保存成功后刷新搜索结果并保持选中。
- HELP 与 README「终端快捷创建」一节：补 `shard -i`、内置编辑器按键、`--external`、鼠标捕获时用 Option（iTerm2）或 Fn（Terminal）拖动做原生选择复制。
- 测试：`save_session` 连续两次保存、冲突写临时文件、锁超时（单测，临时资料库）；`-i` 非终端报错；`--external` 参数解析；现有 `tests/search_edit.rs` 全部原样通过。

提交：`feat(cli): shard -i 交互界面，shard -e 默认使用内置编辑器`

## 回报（每批最后一条消息）

改动文件与要点；测试清单与结果（贴 `cargo test` 与 `clippy` 摘要）；与施工令的偏差及原因；遗留问题。
