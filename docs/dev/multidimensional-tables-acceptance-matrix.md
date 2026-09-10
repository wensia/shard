# Shard 多维表格验收覆盖矩阵

日期：2026-09-07。对照 [执行计划](multidimensional-tables-plan.md) MT1 / MT3 / MT5 及第 8 节核对。**M1 尚未全部验收**；测试套件通过只证明下表列明的层次和场景。本次未重复全量测试，新增 2 个真实 Git 用例和 2 个整页表格失败门禁用例，并定向验证相关测试。

状态含义：**已通过 R** = Rust 真实文件系统/临时 Git；**已通过 T** = TypeScript 逻辑与模拟传输；**已通过 U/W** = Chromium / Playwright WebKit，Tauri IPC 为 mock；**已通过 N** = 独立标识的真实 Tauri/WKWebView + 临时 vault。**静态接线**表示已读代码但未找到专属行为证据，**未验证**表示完成门仍缺结果。不同层次不能互相替代。

## 2026-09-08 MT2 统一操作补充

本轮浏览器真实 DOM + Worker、mock Tauri IPC：字段快捷菜单和稳定 ID 草稿定位、末列新增字段、内嵌分组折叠/数量、分组剪贴板、批量单字段原子更新和一次撤销、IME 草稿与并发提交、背景点击不卸载记录草稿、宽窄 Kiln 计算样式均有自动化证据。表格 Chromium 35 通过，WebKit 33 通过 / 2 剪贴板权限跳过；Worker/领域层单测 131 通过。详见 [本轮证据](../../tests/evidence/ui-controls/table-unified-design-2026-09-08.json)。

全量回归尚有一项导图退出编辑后的焦点断言未通过（定向复跑确认），不属于本轮新增表格用例，也未记为全量通过。下列 MT5 原生系统输入法、滚动及端到端性能缺口继续保留，不因这批交互完成而关闭。

## 已运行证据

原始日志已保存到 [验收运行记录](../../tests/evidence/tables/table-acceptance-runs-2026-09-07.json)，每条包含原路径、修改时间、SHA256 与完整输出，避免证据只留在 `/tmp`。

| 编号 | 已核对的运行结果 | 原始日志与边界 |
| --- | --- | --- |
| R0 | Rust 全量 96 passed / 1 ignored | `/tmp/shard-tables-mt5-native/rust-tests.log`；在 macOS 导出调整之前。ignored 性能测试已另行执行，见 P0 |
| R1 | `table_commands::tests::native_table_` 定向 8 passed / 91 filtered，4.18 秒 | `/tmp/shard-tables-mt5-native/acceptance-targeted-rust.log`；本次新增 2 例 + 原有 6 例，不将它与 R0 相加冒称重跑全量 |
| T0 | 21 个文件，203 passed | `/tmp/shard-tables-mt5-native/unit-final.log` |
| U0 | Chromium 全量 172 passed | `/tmp/shard-tables-mt5-native/ui-verified.log` |
| U1 | 正式 Workbench 的 Tauri 关闭事件 mock 定向 2 passed，3.4 秒 | `/tmp/shard-tables-mt5-native/table-close-regression.log`；取消退出、重复关闭请求、等待检查点时禁止输入/切空间，以及 destroy 失败后释放门禁并重试 |
| U2 | 整页导航/手动同步失败门禁 2 例 + 原退出回归 2 例，4 passed，5.8 秒 | `/tmp/shard-tables-mt5-native/table-navigation-regression.log`；真实 Worker + mock IPC，重查 2 条退出用例以验证测试 helper 默认行为未变 |
| W0 | 表格工作区 WebKit 13 passed / 1 skipped | `/tmp/shard-workspace-webkit-final.log`；矩形剪贴板用例因权限跳过，其他 WebKit 通过项仍是 mock IPC |
| C0 | `cargo check` 通过 | `/tmp/shard-tables-mt5-native/cargo-final.log`；构建不证明行为 |
| N0 | 原生读写、Esc、Undo/Redo、CSV/XLSX 导入/退出重启/导出值核对 | [原生验收证据](../../tests/evidence/tables/table-native-acceptance-2026-09-07.json)；独立 `dev.shard.tables-acceptance-20260907`，测试数据 |
| P0 | Rust release A/B 读取、编辑和批量保存；Node 数据层前后对比 | [最终 Rust 样本](../../tests/evidence/tables/table-backend-performance-final-2026-09-07.json)、[数据层样本](../../tests/evidence/tables/table-domain-performance-2026-09-07.json)、[试验报告](multidimensional-tables-spike-report.md) |

## MT1：原生文件、生命周期与 Git

| 要求 | 实际证据与测试名称 | 当前结论 / 缺口 |
| --- | --- | --- |
| 六类值、空值与格式一致性 | R0：[validation.rs](../../src-tauri/src/table/validation.rs) `reads_shared_valid_and_rejects_each_invalid_fixture`、`direct_cell_deserialization_matches_prior_wire_and_rejects_non_string_arrays`；T0：[table-model.test.ts](../../src/lib/table-model.test.ts) `agrees with Rust on shared scalar and malformed cell-array cases` | **已通过 R/T**。共同 fixtures 覆盖非法引用、未知版本、重复键/ID、混合或非字符串数组、null/空串/0/false |
| 创建、重开、确定性字节与请求幂等 | R0：[storage.rs](../../src-tauri/src/table/storage.rs) `create_retry_reopen_and_mutation_retry_preserve_identity`、`parsed_save_uses_exact_public_mutation_bytes_and_preserves_strict_input_checks`；R1：[table_commands.rs](../../src-tauri/src/table_commands.rs) `native_table_create_retry_finds_actual_path_after_rename` | **已通过 R**。重试返回改名后的实际路径；不同 payload 使用相同请求身份报冲突；优化路径与公开校验路径字节一致 |
| 两个旧基线写入、无效批量与外部删除 | R0：`failed_batch_stale_bytes_and_deleted_target_never_overwrite`；R1：`native_table_stale_missing_and_invalid_writes_preserve_disk` | **已通过 R**。顺序提交两个相同旧基线，后者拒绝；只改磁盘空白也触发 hash 冲突；整批非法不写、已删除不重建。未模拟任意外部进程在最后校验后竞争写入，不承诺跨进程原子 CAS |
| 原子安装失败与临时文件清理 | R0：[storage.rs](../../src-tauri/src/table/storage.rs) `failed_install_cleans_temp_and_preserves_existing_target` | **已通过 R**。已有目标拒绝覆盖、rename 目标为目录时失败，保留原目标并清临时项。磁盘满、fsync 失败与进程中途崩溃未注入 |
| 坏表邻居、重复身份与路径隔离 | R1：`native_table_bad_neighbor_does_not_block_healthy_table_and_duplicates_are_detected`、`native_table_rejects_non_public_and_ambiguous_paths`、`native_table_rejects_symlink_file_and_directory_even_inside_notes` | **已通过 R**。坏 JSON/新版表报错而不阻塞健康表，重复 tableId 拒绝；公开路径、身份与符号链接约束有直接用例 |
| 中文双扩展名 rename/move/trash/restore 与重名恢复 | R1：`native_table_complete_vault_git_and_recycle_lifecycle` | **已通过 R**。真实临时 Git 核对 tableId、hash、类型与原路径；旧位置被另一张表占用时恢复分配新路径，两份数据保留。未完成对应真实桌面菜单全链路 |
| purge 与路径级提交 | R1：新增 `native_table_purge_commits_only_trash_path_and_keeps_unrelated_index`；R0：[lib.rs](../../src-tauri/src/lib.rs) `purge_and_empty_trash_reject_paths_outside_canonical_trash_root` | **已通过 R**。表文件与原路径均消失，purge 只提交该回收站路径，无关已暂存 `personal.txt` 保留；通用回收站越界拒绝有测试。原生表 UI purge 未验证 |
| 内容不产生微提交，checkpoint 纳入表 | R1：`native_table_complete_vault_git_and_recycle_lifecycle` | **已通过 R**。创建与单格编辑 commit 数均为 0，脏路径含表；checkpoint 后为 1，工作树干净；后续结构操作单独增加提交 |
| 崩溃遗留不进检查点、同步提交或结构提交 | R0：[lib.rs](../../src-tauri/src/lib.rs) `native_table_crash_leftovers_stay_out_of_checkpoint_sync_and_structural_commits` | **已通过 R**。包括超过 500 条脏路径的目录回退、目录 move、相似用户文件不误排除。只验证人为构造的遗留文件，不等于真实崩溃演练 |
| 两份 checkout 同步成功与同单元格冲突 | R1：新增 `native_table_syncs_two_checkouts_and_preserves_both_sides_on_conflict` | **已通过 R**。本地 bare remote；新表自动 checkpoint/push，另一 checkout 编辑再 pull 后字节一致；双方修改同一格后同步明确报冲突，rebase 中止，本地完整字节及提交、远端字节及 tip 均保留。没有网络服务或真实用户 vault |
| 外部 Git 操作期间让路 | R0：[lib.rs](../../src-tauri/src/lib.rs) `checkpoint_blocks_on_external_git_operation_without_touching_index`；T0：队列 `does not read or automatically retry a known unwritten failure` | **已通过 R/T（部分）**。真实 checkpoint 在 `CHERRY_PICK_HEAD` 存在时不暂存/提交；表格 `GIT_BUSY` mock 保留草稿。表写命令对真实未完成 Git 状态的专属用例未验证 |
| Git 合并后无效模型可定位且保留原件 | 严格 `read_in_vault` 与前端错误入口已接线，坏文件读取用例通过；双 checkout 冲突见上一行 | **静态接线 / 部分 R**。未构造 Git 文本合并成功但模型引用失效的表并验证桌面错误状态 |

## MT3：导航、保存与失败恢复

| 要求 | 实际证据与测试名称 | 当前结论 / 缺口 |
| --- | --- | --- |
| 连续输入、保存期间继续输入与迟到响应 | U0/W0：[table-workspace.spec.ts](../../tests/ui/table-workspace.spec.ts) `late save response retains newer edits and a failed save prevents closing`；T0：[table-save-queue.test.ts](../../src/lib/table-save-queue.test.ts) `never lets a late response overwrite a newer draft; the next request uses confirmed hash/revision` | **已通过 U/W/T**。后续输入保留，下一次用确认后的 hash；N0 另有逐键 `abc` 保存。真实慢磁盘/IPC 期间尾随输入未单独测 |
| 未知保存结果不盲目重发 | T0：队列 `accepts an unknown successful write only after a full business snapshot check, then replays later gestures`、`retries exactly the same frozen request only after confirming unchanged disk bytes/revision`、`preserves dirty content when read-back fails and never resends before that read succeeds`；R0：[mutations.rs](../../src-tauri/src/table/mutations.rs) `unknown_response_and_reused_id_do_not_apply_twice` | **已通过 T/R**。核对完整业务快照，保留同一请求身份与后续手势，有界重试；实际原生 IPC 丢回包未注入 |
| 不完整/异常成功响应不推进基线 | T0：[table-save-queue.test.ts](../../src/lib/table-save-queue.test.ts) `read-checks an incomplete success delta instead of silently advancing its hash` 及 8 种异常 delta 参数用例 | **已通过 T**，真实后台不完整响应只通过模拟注入 |
| 外部替换、删除与冲突选择保留草稿 | U0/W0：[table-workspace.spec.ts](../../tests/ui/table-workspace.spec.ts) `own-save refresh keeps undo; external replacement preserves dirty edits; narrow details use one pane`、`pristine overlay cannot overwrite an externally refreshed record`、`clean external deletion allows leaving; dirty deletion requires explicit abandonment` | **已通过 U/W**。脏表阻止 flush，显式载入外部版本；干净删除可离开，脏删除需明确放弃。真实双 checkout 冲突后的桌面选择流程未验证 |
| 冲突副本身份与重新打开 | R0：[storage.rs](../../src-tauri/src/table/storage.rs) `copy_has_new_identity_and_source_without_reusing_creation_metadata`；U0/W0：上述 `late save response...` 检查发起一次副本保存 | **已通过 R/U/W（部分）**。新身份与来源信息已核对；真实保存冲突副本 → 关闭 → 再打开完整链路未验证 |
| Worker 崩溃、重载与放弃时的在飞写入 | T0：[table-worker-recovery.test.ts](../../src/lib/table-worker-recovery.test.ts) `a failed read after an unknown write preserves fatal state until a later explicit read succeeds`、`disposing a crashed session while its native write is pending never starts a replacement Worker`；U0：[table-worker-recovery.spec.ts](../../tests/ui/table-worker-recovery.spec.ts) `reload waits for a crashed Worker's pending write with a successful response / a lost response`；U0/W0：`fatal Worker recovery accepts a generation-zero reset and editing works again`、`abandon waits for a pending edit and its late response never triggers a save` | **已通过 T/U/W**。真实 Worker 组件测试与 FakeWorker 逻辑测试分开；native 文件 I/O 仍为 mock |
| 结构冻结能先保存既有草稿 | U0/W0：[table-workspace.spec.ts](../../tests/ui/table-workspace.spec.ts) `structural freeze flushes existing drafts and blocks editing until released` | **已通过 U/W**。单元格与详情表单在冻结时仍可 flush，冻结后拒绝新编辑；这是组件命令链路 |
| 重命名期间阻止编辑/导航，新路径交接 | U0：[library-tree.spec.ts](../../tests/ui/library-tree.spec.ts) `数据表重命名期间冻结编辑与导航，完成后按新路径恢复工作区` | **已通过 U**。正式资料库整页 + mock IPC，测干净表；挂起 rename 时输入/切目录无效，完成后读取新路径并恢复操作。与上一行组合仍不能声称“脏表先存再重命名”整页链路已测 |
| 脏表切另一表、目录、碎片流 | U2：[library-tree.spec.ts](../../tests/ui/library-tree.spec.ts) `表格无效数字草稿阻止切目录与切碎片空间`；[library-shell.tsx](../../src/workspace/library-shell.tsx) 各选择入口先调用 `saveCurrentNote` | **已通过 U（切目录失败分支）**。无效数字阻止导航，保留同表、原编辑值且不写入。有效草稿保存后导航、切另一表与资料库内碎片流仍仅静态接线；既有 Markdown 用例不能外推 |
| 脏表切空间、全局搜索、捕捉或搜索结果 | U2：`表格无效数字草稿阻止切目录与切碎片空间`；[workbench-shell.tsx](../../src/workspace/workbench-shell.tsx) `saveLibraryDraftBeforeNavigation`、`openSearch`、`handleGlobalCapture` | **已通过 U（切碎片空间失败分支）**。点击后仍保持资料库 route 与草稿。其他空间、搜索、捕捉及成功 flush 后导航仍仅静态接线 |
| 手动同步、手动检查点前保存失败阻止操作 | U2：[library-tree.spec.ts](../../tests/ui/library-tree.spec.ts) `表格无效数字草稿阻止手动同步与检查点调用` | **已通过 U（无效单元格分支）**。正式 Workbench 中点击两项操作均提示草稿保存失败，`sync_vault` / `checkpoint_vault` 调用数不增，同表与编辑值保留。真实 I/O 失败后的整页操作以及成功 flush 后调用顺序未单独验证 |
| 自动同步、自动检查点与失焦保存 | [workbench-shell.tsx](../../src/workspace/workbench-shell.tsx) 表格 dirty 接入自动同步与检查点条件；[use-auto-checkpoint.ts](../../src/workspace/use-auto-checkpoint.ts) 失焦 flush | **静态接线**。没有表格专属定时/失焦竞争用例；通用自动同步错误通知通过不等于此门禁通过 |
| 正常退出与重启恢复已保存数据 | N0：CSV/XLSX 正常退出、重启、正式资料库重新打开及全量值核对 | **已通过 N（已保存数据）**。退出时存在未确认草稿、慢保存、失败或用户取消退出的原生情况未验证 |
| 保存失败时取消正常退出 | 本次发现的 `return` 仍执行 `finally destroy()` 缺陷已修复；U1：[library-tree.spec.ts](../../tests/ui/library-tree.spec.ts) `保存失败取消退出保留表格草稿，明确放弃后才关闭`、`重复退出请求不能越过正在执行的检查点，关闭失败后可以重试` | **已通过 U（Tauri 事件 mock）**。无效数字 flush 失败后拒绝退出保留草稿，再次明确同意才 destroy；重复请求不能越过 held checkpoint，destroy 失败可重试。真实桌面失败取消退出仍未验证 |
| 退出等待检查点期间禁止新增草稿 | [workbench-shell.tsx](../../src/workspace/workbench-shell.tsx) 捕获 `LibraryDraftHandle` 后同步 `setInteractionBlocked(true)`，覆盖 flush/checkpoint/destroy；`isClosing` 阻止快捷键与自动调度，主页面 `inert` 阻止整页导航，finally 释放门禁。U1：`重复退出请求不能越过正在执行的检查点，关闭失败后可以重试` | **已修复并通过 U（Tauri 事件 mock）**。held checkpoint 期间尝试双击/late-input 无编辑器，点击“碎片”仍在同表；重复 close 不绕过，destroy 失败后 `inert` 解除并可重试。真实桌面等待期间输入仍未单独演练 |

## MT5：其余完成门

| 维度 | 已有证据 | 仍缺的完成证据 |
| --- | --- | --- |
| 视图与稳定记录身份 | T0：[table-views.test.ts](../../src/lib/table-views.test.ts) `keeps independent views isolated and never returns group headers as record IDs`、稳定排序/分组测试；U0/W0：`filter/sort then edit targets the projected record and view settings persist` | 真实桌面完整多视图操作与保存后重启核对仍未单独完成 |
| 批量粘贴与单次撤销 | U0：`rectangular paste adds rows atomically and undo reverts one whole gesture`；W0 此条跳过；N0 有真实系统粘贴与 Undo/Redo；P0 有后端 1,000 × 10 批量保存 | 大批量真实桌面粘贴期间响应性 / 进度，不能由后端基准或小块原生粘贴代替 |
| CSV/XLSX 交换 | N0 完成正式入口导入、退出重启、再导出；XLSX 6 类型 / 24 格独立 openpyxl 核对，CSV 24 格与表头核对；U0：[table-exchange.spec.ts](../../tests/ui/table-exchange.spec.ts) 6 条预览、映射、幂等、取消、全视图与原生格式测试；R0：[xlsx.rs](../../src-tauri/src/table/xlsx.rs) `export_roundtrip_never_interprets_user_text_as_formula` 及容量/日期/公式缓存等 fixtures | 已验证导出日期 `0001` 明确拒绝；所有异常 XLSX fixtures 的真实桌面逐项交互未演练。格式与公式来源提示仍按测试层次认定 |
| 输入、键盘与可访问性 | N0：ASCII、系统中文粘贴、Esc、Undo/Redo；U0/W0：`real keyboard input keeps its editor and Escape restores grid focus`，Esc 后继续方向键/Enter 编辑通过 | 系统中文候选选词/取消未验证；synthetic composition 与 Playwright WebKit 不替代真实系统输入法；完整原生键盘/可访问性矩阵未完成 |
| 布局与 Kiln | U0：[table-spike.spec.ts](../../tests/ui/table-spike.spec.ts) `10k rows project in the Worker and both axes stay inside the table`、`Canvas and portal consume the same Kiln font, colors and pixel lengths`；工作区窄窗和交换界面窄窗用例；试验报告有原生 DPR2/字体与纵向滚动观察 | 原生横向滚动、完整窄高/键盘布局验收未完成；原型样式证据不能覆盖所有正式工作区状态 |
| 性能与主线程 | P0：B 真实后端编辑 p95 611.6 ms、批量保存 p95 606.2 ms；Node 数据层编辑 p95 15.6 ms；相关命令与 Worker 静态后台接线 | A/B 冷开表、确认输入到像素、IPC/clone/渲染完整链路及每类至少 20 次分布未测。暖态 Rust < 1 秒不等于 UI 全门通过 |
| 既有功能回归 | U0 全量 172 通过，包含资料库 Markdown、导图、CSV 预览、密匣、侧栏、捕捉等浏览器回归；R0 既有后端测试通过 | 真实桌面全域回归、上述表格退出缺陷的修复后验证需单独记录 |

## 本次新增验证与收口顺序

新增测试位于 [table_commands.rs](../../src-tauri/src/table_commands.rs) 的测试模块，未修改运行算法。R1 在移除 Git 环境中的替代仓库/index 设置、禁用全局配置与测试仓库 hooks 后执行；全部 remote、checkout 与用户文件样例均在临时目录，测试结束自动清理。复现：

```bash
cargo test -p shard --lib table_commands::tests::native_table_ -- --test-threads=1
```

U2 的两条新增用例位于 [library-tree.spec.ts](../../tests/ui/library-tree.spec.ts) 末尾，仅复用表 fixture 与正式 Workbench。测试 helper 的同步入口选项默认关闭，只有同步用例提供 dirty/hasRemote 状态。定向运行两条新增及两条退出回归共 4 项，不修改产品代码、不操作原生窗口或真实 vault。

取消退出仍销毁窗口、退出等待检查点期间允许新输入/导航的两项问题均已修复并通过 U1 回归。其余表格专属导航、同步/检查点时序按上表区分静态接线与行为证据。真实中文候选输入、原生横向滚动和完整 A/B UI 性能保持待验收。表格文件生命周期和双 checkout 同步已有直接后端证据，不需为凑门禁数量再重复完整 Rust 或 UI 套件。

## 原生采样阻塞补充

A 数据已由真实 Rust 读取并显示 1,000 × 20，但页面 `visibilityState=hidden`、rAF 阶段停在 0，帧就绪样本超时；这不是加载耗时。新增独立 `data-react-ready-no-frame` 模式仍未运行完原生样本，随后 Mac 锁屏、CUA 要求人工解锁。详见 [诊断与样本身份](../../tests/evidence/tables/table-native-performance-attempt-2026-09-07.json)。WebKit 正式工作区双轴滚动与 560px 详情补充证据见 [滚动记录](../../tests/evidence/tables/table-workspace-scroll-webkit-2026-09-07.json)，其 IPC 为 mock，不替代原生触控板。
