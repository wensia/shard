# 终端命令 `shard` 随 App 自动安装 — 任务清单

## 背景

`crates/shard-cli` 已实现终端快捷创建（`shard #备忘 /任务列表 买咖啡`），目前只能用开发者脚本 `pnpm install:cli` 安装。
目标：用户装好 Shard.app、打开一次，终端里直接能用 `shard`，**不需要用户复制任何命令**。

macOS dmg 拖拽安装无法执行安装脚本，因此由 App 在运行时完成安装：
CLI 作为 sidecar 打进 `.app`，App 探测用户终端真实 PATH，在其中找一个可写目录建软链接；
找不到时一键确认后自动建 `~/.local/bin` 并往 shell 配置追加带标记的 PATH 片段。

## 已有代码（先读）

- CLI：`crates/shard-cli/src/{main.rs,parse.rs}`；核心：`crates/shard-core/src/lib.rs`（`AppConfig` 在这里，`vaultPath` 存于 `app_config_dir/settings.json`）
- App 入口：`src-tauri/src/lib.rs` 的 `run()`（约 6355 行起，`.setup(...)` 与 `generate_handler![...]`）；`run_blocking` 用于把阻塞操作放到线程池
- 打包配置：`src-tauri/tauri.conf.json`（`bundle` 目前无 `externalBin`）；`src-tauri/build.rs`
- 设置面板：`src/components/shard/vault-guide.tsx`（`SettingsSection = "appearance" | "git" | "shortcuts" | "vault"`，中英文案对象在同文件）
- 前端 API 封装：`src/lib/api.ts`；toast 用 `sonner`
- 开发者安装脚本：`scripts/install-cli.sh`（保留）
- 规则：`AGENTS.md` Runtime Rules（重操作异步化）；前端设计以 `vendor/kiln/SKILL.md` 为准

## T1 打包：CLI 作为 sidecar 进入 `.app`

1. 新增 `scripts/build-cli-sidecar.mjs`：
   - 目标三元组取 `TAURI_ENV_TARGET_TRIPLE`，缺省用 `rustc -vV` 的 `host:`
   - `cargo build --release -p shard-cli --target <triple>`（host 构建时可省 `--target`，但产物路径要对应）
   - 复制到 `src-tauri/binaries/shard-cli-<triple>`（Tauri externalBin 命名要求），`chmod 755`
2. `tauri.conf.json`：`bundle.externalBin = ["binaries/shard-cli"]`；`beforeBuildCommand` 改为先 `pnpm build` 再 `node scripts/build-cli-sidecar.mjs`；`package.json` 加 `"build:cli-sidecar"` 脚本
3. `src-tauri/binaries/` 加入 `.gitignore`
4. **干净仓库下 `cargo check/test -p shard` 与 `pnpm tauri dev` 不能因缺 sidecar 失败**：tauri-build 会校验 externalBin 存在。在 `src-tauri/build.rs` 调 `tauri_build::build()` 前，若 `binaries/shard-cli-<TARGET>` 不存在则写一个占位脚本（仅打印「开发构建未包含 shard CLI」并退出 1）。不要在 build.rs 里调用 cargo 构建 CLI（同一 target 目录会死锁）。
5. 验证：`pnpm tauri build --bundles app` 后 `Shard.app/Contents/MacOS/shard-cli --version` 可运行

## T2 Rust：安装模块 `src-tauri/src/cli_install.rs`

所有逻辑写成**可注入**的纯函数（`home`、`path_dirs`、`sidecar`、`shell` 作为参数），Tauri command 只做薄封装，便于 tempfile 单测。

1. **sidecar 路径**：`current_exe().parent()/shard-cli`。仅当 exe 位于 `*.app/Contents/MacOS/` 且文件存在时视为可安装；否则状态为 `unavailable`（开发模式、占位 sidecar 都不自动安装）。
2. **探测真实 PATH**：GUI 进程的 PATH 只有 launchd 默认值。执行 `$SHELL -ilc 'printf "__SHARD_PATH__%s__SHARD_END__" "$PATH"'`，按标记截取（rc 文件可能有杂输出）；**10 秒超时**后 kill（实测重 rc 的 zsh 冷启动约 2 秒，3 秒过紧）；`$SHELL` 为空时回退 `/bin/zsh`；失败时回退 `std::env::var("PATH")`。
3. **归属判定**：链接为软链接且目标 == 当前 sidecar，或目标以 `/Contents/MacOS/shard-cli` 结尾且路径含 `.app/`（App 被移动/旧位置悬空）→ 视为 Shard 所有，可刷新；其他同名文件/链接 → `conflict`，**绝不覆盖**。
4. **状态** `CliInstallStatus`（serde camelCase）：`state: "installed" | "notInstalled" | "needsShellConfig" | "conflict" | "unavailable"`、`linkPath: Option<String>`、`shellConfigPath: Option<String>`、`message: Option<String>`。
   - 已有 Shard 所有且指向当前 sidecar 的链接，且其目录在 PATH 中 → `installed`
   - 已有 Shard 所有但悬空/指向旧位置 → 视为 `notInstalled`（自动安装时会静默修复）
5. **选目录**：候选依次 `~/.local/bin`、`~/bin`、`/opt/homebrew/bin`、`/usr/local/bin`；条件：在探测到的 PATH 中、目录存在、当前用户可写（实际尝试创建并删除临时文件判断）。
6. **`install(allow_shell_config: bool)`**：
   - 有可用目录 → 原子建链（先建临时名软链接再 `rename`）
   - 无可用目录：`allow_shell_config == false` → 返回 `needsShellConfig`（附将要修改的配置文件路径）；`true` → 建 `~/.local/bin`、建链、追加 shell 片段：
     - zsh → `~/.zshrc`；bash → `~/.bash_profile`；fish → `~/.config/fish/conf.d/shard.fish`（写 `fish_add_path ~/.local/bin`）；其他 shell → 返回错误说明
     - 片段带标记、幂等（已有标记则不重复追加）：
       ```sh
       # >>> shard cli >>>
       export PATH="$HOME/.local/bin:$PATH"
       # <<< shard cli <<<
       ```
7. **`uninstall()`**：删除所有候选目录中 Shard 所有的链接；按标记精确删除 shell 片段（fish 直接删 `shard.fish`）；不动其他内容。
8. Tauri commands（`run_blocking`，不持 vault 门）：`cli_install_status`、`install_cli { allowShellConfig }`、`uninstall_cli`，注册到 `generate_handler!`。
9. **偏好持久化**：`shard-core` 的 `AppConfig` 增加 `cli_install_declined: bool`（`#[serde(default, skip_serializing_if = "is_false")]`），提供 `set_cli_install_declined` command；卸载时置 true，手动安装时置 false。注意 `AppConfig` 目前只存 `vaultPath`，写入时必须读-改-写保留其他字段。

## T3 前端：启动自动安装

在 `src/workspace/workbench-shell.tsx` 挂载后（不阻塞首屏，放到空闲/延迟执行）：

1. 调 `cli_install_status`；`unavailable` / `installed` / `conflict` → 什么都不做
2. `notInstalled` 且未 declined → `install_cli(false)`：
   - 成功 → 仅首次安装时 toast「已安装终端命令 shard」+ 说明示例 `shard 今天心情很好`（静默修复悬空链接不提示）
   - 返回 `needsShellConfig` → 走第 3 步
3. `needsShellConfig` 且未 declined → 一次性提示（toast with action 或 kiln 规范的小对话框）：「安装终端命令 shard？将在 <配置文件> 中加入 PATH」，按钮「安装」「不用了」
   - 安装 → `install_cli(true)` → 成功 toast「已安装，新开终端窗口即可使用 shard」
   - 不用了 → `set_cli_install_declined(true)`
4. API 封装加到 `src/lib/api.ts`，非 Tauri 运行时（浏览器 dev / Playwright）必须安全跳过

## T4 前端：设置面板入口

在 `vault-guide.tsx` 设置中新增「终端命令」一项（可放在现有 section 内或新增 section，遵循 kiln 规范与现有布局，中英文案都补）：

- 显示状态：已安装（显示链接路径）/ 未安装 / 冲突（说明已存在非 Shard 的 `shard`，不会覆盖）/ 开发版不可用
- 按钮：未安装 → 「安装」（需要时直接 `allowShellConfig: true`，按钮旁说明会修改哪个配置文件）；已安装 → 「卸载」
- 用法一句话示例：`shard #备忘 /任务列表 买咖啡`

## T5 文档

`README.md` 「终端快捷创建」一节：说明 App 首次启动自动安装、设置里可卸载；`pnpm install:cli` 标注为开发用途。

## 验证（全部要做并在回报中贴结果）

1. `cargo test -p shard -p shard-core -p shard-cli` 全绿；`cli_install.rs` 单测覆盖：选目录（PATH 中/不可写/不存在）、冲突不覆盖、悬空旧链接刷新、原子建链、shell 片段幂等追加与精确删除（zsh/bash/fish）、PATH 探测按标记截取
2. **删除 `src-tauri/binaries/` 后** `cargo check -p shard` 仍通过（占位 sidecar 生效）
3. `pnpm build` 通过
4. `pnpm tauri build --bundles app` 成功，`Contents/MacOS/shard-cli --version` 输出版本
5. 用临时 `HOME`（tempdir）+ 伪造 PATH 手工跑一遍 install/uninstall 流程

## 约束

- **不得修改真实用户环境**：测试一律用临时 HOME，不要改动真实 `~/.zshrc`、`~/.local/bin`、`/opt/homebrew/bin`、`/usr/local/bin`
- 不要 `git commit`；工作区已有大量他人未提交改动，只改本任务相关文件
- 不读 `.gstack/`、`.playwright-mcp/`、`dist/`、`node_modules/`、`src-tauri/target/`（构建产物检查除外）
- 注释与用户可见文案用简体中文，风格贴合周边代码
