# Shard 多维表格实现与验收记录

日期：2026-09-07。状态：MT1–MT4 代码已接入，MT5 集成验收进行中，**M1 尚未完成全部验收**。代码与下述自动化、桌面交换验证已完成；剩余原生门禁明确列在文末。

范围与完成门以 [执行计划](multidimensional-tables-plan.md) 为准；逐项测试层次与缺口见 [验收覆盖矩阵](multidimensional-tables-acceptance-matrix.md)；格式、校验和保存协议见 [数据契约](multidimensional-tables-contract.md)。M2 的 Markdown 正文、笔记引用、跨表关联、汇总、看板、日历与搜索扩展，以及 M3 公式均未实施。未启动索引或分片容量分支。

## 2026-09-09 视图标签整体状态

修复选中视图的名称 hover 覆盖外层选中背景、只剩更多按钮亮色的问题。背景统一由标签组控制，名称与更多按钮在默认、悬浮及菜单展开时始终透明；未选中标签整组反馈，选中标签保留完整选中底色。更多按钮与名称同高，保留独立语义和内侧键盘焦点框。Kiln 已记录这一组合标签约束。

现有表工作区与布局 30 项 UI 回归通过；Chromium/WebKit 的宽窄窗口实际样式与截图已核对，使用合成数据和 mock IPC。证据见 [视图标签状态记录](../../tests/evidence/ui-controls/view-tab-surface-2026-09-09.json)。

## 2026-09-08 字段配置细化

针对字段行贴底、更多按钮无悬浮反馈、点击更多会关闭字段配置的问题，字段行增加 Kiln `space-1` 上下留白，列表底部留 `space-3`；更多按钮区分行悬浮/按钮悬浮/展开/焦点，并使用共享 Tooltip。字段目录的菜单改为外层 Popover 内的共享 DropdownMenu，复用列头字段操作，打开后保留目录、搜索和显隐状态。主字段保护与稳定 ID 行为不变。

子菜单打开及关闭还焦点时不自动弹出 Tooltip，避免遮挡或多吞一次 Escape；第一次 Escape 只关菜单并回到更多按钮，第二次才关字段配置。菜单进入编辑保持选中字段表单，取消仍不写入。行高增加后，字段类型选择器允许在视口底部向上翻转，并验证弹层无重叠和越界。

本轮相关 Chromium 53 项、WebKit 7 项通过，构建和主仓/Kiln 差异检查通过；已核对宽屏与 375/680 窄屏实际截图和计算样式。使用合成数据及 mock IPC，未修改用户表格。规则已补入 Kiln 数据编辑器工具栏规范，结果与截图见 [字段配置细化证据](../../tests/evidence/ui-controls/field-menu-refinement-2026-09-08.json)。

## 2026-09-08 飞书桌面设计适配

直接查看用户已打开的 macOS 飞书多维表格，观察视图菜单、字段目录/编辑器、筛选/排序/分组、列头与行号右键菜单及已有记录详情。仅打开和关闭界面，未写入飞书记录或字段；文档最近修改时间未变化。详细参考和功能取舍见 [现场参考记录](multidimensional-tables-feishu-reference.md)。

- 独立视图标签及就近视图菜单，下方为紧凑单行图标工具栏；新增记录置左、辅助动作置右。组件仍消费 Kiln，共享规范增加限定的数据编辑器工具栏模式，原生默认控件门禁不变。
- 字段配置为可搜索、可显隐、带主字段锁与类型图标的目录；单字段编辑采用紧凑草稿表单。确定提交、取消丢弃；未应用字段草稿遇到 Escape/外点保持打开，明确保存/切换仍执行原有校验。
- 筛选、分组、排序和视图设置在入口附近弹出，宽窄窗口均不挤压网格；嵌套选择器/日期面板与外层关闭分别处理，校验失败后恢复草稿焦点。
- 列头右键与原箭头菜单共用稳定字段 ID；行号或单元格右键提供查看详情/删除。详情覆盖右侧，类型与字段名在左、值在右；窄窗单面板。进入时聚焦名称，关闭后恢复网格键盘导航。
- 表尾新增与工具栏新增均先校验正在编辑的内容，并防止重复在途插入。修复 Glide 延迟选区/激活回调覆盖新记录 ID 的竞态；打开详情后旧回调不能清掉当前记录。
- 修复虚拟列头在 pointerdown 打开弹层后，同一次 click 被当作外点立即关闭的问题。背景网格在详情期间保持可见但不参与编辑或焦点，避免草稿和焦点被抢走。

验证使用合成数据、真实 React 组件与 Table Worker、mock Tauri IPC；没有在用户 vault 演练。全量 UI 最终 318 项通过；表格 unit 131 项通过；WebKit 表格回归 53 项通过、2 项剪贴板权限跳过。构建、215 个 token 契约、默认控件 AST 检查、主仓/Kiln 差异检查通过，保留既有大 chunk 提示。宽屏与 680/375 窄屏已核对截图和实际计算样式。完整命令、结果与源码 hash 见 [本轮证据](../../tests/evidence/ui-controls/feishu-design-2026-09-08.json)。

本轮没有更改原生文件模型、Rust/IPC、Worker 数据算法或用户数据。飞书现场观察和浏览器 WebKit 测试均不替代 Shard 真实 WKWebView 的系统输入法、滚动和端到端性能门禁；M1 剩余验收与 M2/M3 边界不变。

## 已接入实现

| 批次 | 实现与主要入口 | 当前边界 |
| --- | --- | --- |
| MT1 文件与保存 | [Rust 表模块](../../src-tauri/src/table/mod.rs)、[表命令](../../src-tauri/src/table_commands.rs)：原生 `.shardtable.json`、稳定 ID、严格校验、revision/hash、原子写入与资料库生命周期 | 内容写入交由 checkpoint 聚合；不逐单元格提交 Git |
| MT2 交互与视图 | [表工作区](../../src/features/tables/table-workspace.tsx)、[Worker](../../src/workers/table.worker.ts)：六种字段、记录/字段管理、多个表格视图、筛选/排序/分组、复制粘贴、撤销/重做与保存队列 | 当前使用 Glide；Canvas 与 DOM 编辑器的原生交互仍有待验收项 |
| MT3 资料库集成 | [资料库壳层](../../src/workspace/library-shell.tsx)：当前目录新建与打开、记录字段详情、草稿 flush、导航与冲突处理接线 | 重命名交接、退出取消和退出等待期间输入/导航竞态已修复并回归，代码接线不等于导航与退出矩阵全部通过 |
| MT4 数据交换 | [交换界面](../../src/features/tables/exchange-dialog.tsx)、[交换命令](../../src-tauri/src/table_exchange_commands.rs)、[XLSX 模块](../../src-tauri/src/table/xlsx.rs)：CSV/XLSX 预览、字段映射、类型校验与导出 | Rust 全量值往返、6 条 UI 测试、真实桌面 CSV/XLSX 导入 → 重启 → 再导出及独立逐格核对均通过 |

XLSX 读写选型与限制见 [调研记录](multidimensional-tables-xlsx-research.md)。原生导出曾遇到 fixture 中的 `0001` 年日期：实现明确拒绝 Excel 1900 日期系统无法表示的值，未静默改值；此结果不能作为成功导出的证据。

## 2026-09-08 统一操作设计续作

- 列头增加六类图标和 Kiln 菜单：编辑、排序、按字段筛选/分组、当前视图列移动/隐藏、删除确认。末列新建字段先进入草稿，应用前不改数据；主字段约束保留。共享菜单统一消费 Kiln popover 圆角与阴影。
- 分组标题显示记录数并支持单组/全部折叠，鼠标与键盘均可操作。标题不显示记录勾选框。状态按当前会话、视图和分组字段隔离，不写文件、不进入 undo；当前视图导出不受折叠影响。
- 勾选多行后出现批量面板，只修改所选稳定 ID 的一个字段，Worker 校验后原子应用，一次撤销。未输入不会误清空，保留 null、false、空多选区别；非法输入或保存失败保留草稿。
- Worker 缓存投影与剪贴板可见行映射，复制/清空/粘贴跳过标题和折叠记录。显示版本拒绝陈旧坐标；行列映射变化通知 UI 清掉旧选区，同位编辑和列宽调整保留光标。批量命令发出后即进入 pending dirty。
- 记录详情打开时阻止背景点击换记录丢草稿；列菜单关闭不抢走新面板焦点；字段面板合并并发提交并保护中文组词。

验证：表格单测 **131 通过**；表格范围 Chromium **35 通过**，WebKit **33 通过 / 2 项剪贴板权限跳过**；`pnpm build` 与主仓/Kiln `git diff --check` 通过。实际截图已核对类型图标、分组标题、菜单、宽窄批量面板与 4px/6px 控件/弹层圆角。命令、源码 hash 与截图见 [本轮证据](../../tests/evidence/ui-controls/table-unified-design-2026-09-08.json)。

全量 UI 首轮为 **292 通过 / 6 失败**；失败相关用例定向复跑 7 条为 **6 通过 / 1 失败**，剩余为 `shadcn-migration.spec.ts` 的导图退出编辑后焦点仍在画布断言（当前第 1251 行）。没有将其算作全量通过。运行期间导图/画布测试存在其他并行改动，本任务保留这些文件，不追加该范围的修复。

测试入口：[统一设计](../../tests/ui/table-unified-design.spec.ts)、[批量操作](../../tests/ui/table-bulk-edit.spec.ts)、[字段草稿](../../tests/ui/table-field-draft-state.spec.ts)、[Worker 分组事务](../../src/lib/table-worker-grouping.test.ts)。本轮没有修改 Rust 数据协议或用户 vault；浏览器与 WebKit 证据不替代下文 MT5 原生门禁。

## 2026-09-07 默认控件整改

截图中的字段选择器使用了原生 `<select>`，闭合态 CSS 无法控制 macOS 绘制的选项面板。本轮新增共享 `SelectControl` / `DatePicker`，并把字段、记录、筛选、排序、分组、导入导出，以及回顾运行器和导图宽度的同类入口全部接入；多选和列显示使用共享 Checkbox。保留 null/false、0001–9999 年日期和已有草稿保护。

点击页面自绘 portal 原先会被网格先判为外部点击并结束编辑；已在 `isOutsideClick` 提前排除共享弹层，真实 UI 验证选择、Esc、关闭状态 Tab、带日期切换视图和清空行为。源文件、数据契约与保存协议未调整。

[Kiln 强制共享控件规范](../../vendor/kiln/SKILL.md#shared-controls-are-mandatory) 明确禁止原生选择器、datalist 和日期/时间/颜色/滑块/勾选等默认控件；普通语义 HTML 仅作为共享或完整自绘交互的底层，隐形文件桥接保留。新增 AST [构建门禁](../../scripts/verify-ui-controls.mjs)，扫描全部 TSX（含 DEV），无违规基线；共享 Input 的类型限制与 number 外观也已收口。

验证：`pnpm build`、`git diff --check`、Kiln 自检通过；全量 Chromium **235 通过**；控件门禁 **9 组通过**；WebKit 共享控件 **5 通过**、表格工作区 **19 通过 / 1 剪贴板权限跳过**。已检查真实 DOM 弹层、宽窄几何、计算样式与键盘操作。本轮没有把浏览器测试当成真实 Tauri 验收，也没有改动用户 vault 数据；既有 Kiln 非本次规范改动已按基线核对保留。截图、命令与源码 hash 见 [验证证据](../../tests/evidence/ui-controls/kiln-controls-2026-09-07.json)。

## 2026-09-07 产品统一与操作调整

按用户“只支持多维表格这一种”的要求，本轮收口产品入口并调整常用操作；参考与取舍见 [产品与操作规范](multidimensional-tables-product-spec.md)。此批交付不代表下文 M1 原生完成门全部通过。

- 资料库统一“多维表格”名称，新建与 CSV/XLSX 导入共享同一工作区。已有 CSV 文件的操作菜单可直接“导入为多维表格”，自动读取并预览，无需再次选择文件；源文件不变。
- 速记、片段和禅模式移除 Markdown 表格创建、Excel 转正文与独立单元格 widget。旧正文继续源码编辑、撤销和阅读渲染；拖放 CSV/XLSX 明确提示正确导入菜单，旧 XLS 系列提示先另存 XLSX，后台编辑器不重复响应前台禅模式的拖放。
- 工作区常显视图标签和新建按钮，筛选/排序/分组使用独立入口与启用数量；列头按稳定字段 ID 打开设置，当前记录可直接展开详情。切换视图继续保护无效单元格、设置草稿与中文组词。
- 直接导入使用可取消的 microtask 启动读取，避免 React StrictMode 重放 effect 时重复读取；XLSX inspect 返回后再次检查读取代次，关闭后不继续请求预览。

本轮独立验证：表格与 Markdown 相关 unit **119 通过**；Chromium 工作区 **17**、交换 **6**、资料库相关回归 **12**、正文编辑器 **15**、Markdown 阅读/源码 **3**，共 **53 项通过**。StrictMode 单次读取修复后再次运行交换与直接导入相关用例通过。WebKit 工作区 **16 通过、1 跳过**（剪贴板权限）；320px 窄窗、标签键盘操作、实际计算样式通过。浏览器测试使用真实组件/Worker 和 Tauri IPC mock，没有新增真实 vault 操作或系统输入法验收。

最终 `pnpm build` 与 `git diff --check` 通过，保留既有大 chunk 提示。期间并行画布代码与测试的未接齐接口、类型错误曾阻断构建；待相关文件修正后重新执行完整构建通过，未通过删测或修改其类型配置规避。命令、结果与本轮源码 hash 见 [本轮验证证据](../../tests/evidence/tables/table-unification-2026-09-07.json)。

## 此前 M1 验证快照

以下为此前批次证据，本轮未重新执行全部 Rust 和全量 UI；当前改动的验证见上一节。

| 验证层 | 已有结果 | 未通过或未覆盖 |
| --- | --- | --- |
| Rust | 全量 96 通过、1 ignored；新增 Git 场景后定向 8 通过；ignored 性能基准另行执行 | 不替代真实桌面完整流程 |
| 构建与检查 | `pnpm build`、`cargo check` 通过 | 不替代行为验收 |
| 前端 unit | 203 通过 | 不等于真实 WKWebView 输入或帧耗时 |
| 全量 UI | 172 通过；随后保存/退出门禁定向 4 通过 | Esc 后继续键盘导航与编辑、结构操作冻结回归均已通过 |
| WebKit UI | 13 通过，1 跳过 | 跳过项为剪贴板权限限制 |
| 原生应用 | 独立 app identifier + 临时 vault，真实后端读写、撤销重做和 CSV/XLSX 重启往返链路已观察 | 中文候选输入、原生横向滚动与完整性能链路仍待补齐 |

原生应用使用测试数据，已观察到以下连续结果：实际读取表 → 逐键输入 `abc` 保存为 revision 2 → 系统粘贴中文保存为 revision 3 → Esc 取消编辑并保留原值 → Undo 恢复 `abc` 保存为 revision 4 → Redo 恢复中文保存为 revision 5。系统粘贴中文与合成 composition 事件均不能证明系统输入法候选选词、取消已通过。

退出处理还修复了取消退出仍执行 `finally destroy()` 的缺陷；重复关闭请求先阻止默认关闭，保存失败时取消会保留草稿。退出全程冻结表格与主界面，直到检查点和关闭完成；取消/异常时解除。正式 Workbench 的 Tauri 事件 mock 已验证取消保留、重复请求、等待期间输入/导航阻止与关闭失败重试。

此前 Esc 焦点测试把 Glide 从 Canvas 转移到可访问单元格的正常行为判作失败；已修正断言，并验证 Esc 后方向键导航、Enter 继续编辑和保存。结构操作先同步冻结交互，再排空既有单元格/详情草稿，完成路径重映射后解冻；新增资料库重命名用例验证操作期间不能编辑或导航，完成后从新路径读取并恢复操作。

真实桌面 XLSX 流程已完成首次导出 → 正式资料库入口导入 → 6 种类型、24 个单元格全量核对 → 正常退出并重启打开 → 再导出 `native-roundtrip.xlsx`；最终文件经独立 openpyxl 解析，全部值与 cell 类型逐格一致。CSV 也完成导入 → 正常退出并重启 → 再导出，24 个值与 6 个表头完全相同；源文件与导出均为 210 bytes，SHA256 相同。CSV 空文本与空值按已公开的有损语义处理。这些操作均使用隔离应用与临时 vault。长期结果与完整值快照见 [原生验收证据](../../tests/evidence/tables/table-native-acceptance-2026-09-07.json)。

原生导出还复现并修复了 macOS 选择单个文件后额外打开父目录导致阻塞的问题：保留文件 `sync_all` 和同目录原子 rename，macOS 跳过额外目录读取与目录同步，其他平台保持原行为。重建隔离应用后，CSV 与 XLSX 均收到成功反馈并核对实际文件。

测试入口为 [表工作区](../../tests/ui/table-workspace.spec.ts)、[组件试验](../../tests/ui/table-spike.spec.ts)、[数据交换](../../tests/ui/table-exchange.spec.ts)；Rust/TS 共用 [表 fixtures](../../tests/fixtures/tables/manifest.json)。所有故障、Git 与落盘验证使用临时数据，不在用户真实 vault 演练。补充的真实 Git 测试已覆盖两份 checkout 的表格同步成功、同一单元格冲突后双方字节/提交保留，以及 purge 只提交回收站目标、不带入无关暂存。

## 性能证据与限制

完整样本、机器、构建模式、源码 hash、优化前后对比与可重复命令见 [试验报告](multidimensional-tables-spike-report.md) 和 [性能脚本](../../scripts/dev/table-performance.sh)。本记录不替换或改写原始证据。

- Node/V8 合成 10,000 × 30 数据层 CPU/clone 基线：编辑 p95 从 1872.7 ms 降至 15.6 ms。该结果不含 WKWebView 帧、IPC 和磁盘。
- 真实 Rust release、临时 vault 与真实 Git 的 10,000 × 30 样本：20 次单格编辑原子保存 p95 **611.6 ms**，20 次 1,000 × 10 批量粘贴原子保存 p95 **606.2 ms**；达到本次后端暖态保存 p95 ≤ 1 秒目标。原始结果见 [最终后端样本](../../tests/evidence/tables/table-backend-performance-final-2026-09-07.json)。
- 冷开表 ≤ 2 秒、单元格确认到像素反馈 p95 ≤ 100 ms，以及完整 IPC、投影回传与渲染链路尚未测量。单表临时 vault 的后端结果不构成多表扫描或整体桌面容量承诺。

原生完整加载采样已建立 [DEV 入口](../../src/dev/table-performance-test.tsx) 和 [A/B 生成脚本](../../scripts/dev/generate-table-performance-inputs.py)。A 实际读取成功并显示 1,000 / 1,000 条、20 列，但 WKWebView 报告 `visibilityState=hidden`：已达到 saved、无 loading 和有效 Canvas 几何，首个 rAF 仍不执行，30 秒的采样超时不能记为加载耗时。另加的不含帧计时模式尚未取得原生样本；之后 Mac 锁屏，CUA 明确要求人工解锁。诊断、输入文件 hash 与只读校验见 [原生性能尝试记录](../../tests/evidence/tables/table-native-performance-attempt-2026-09-07.json)。

隔离测试应用已停止并恢复为下一次启动打开正式应用入口；未操作用户真实 Shard。解锁后才能继续原生验收。本轮最后 `pnpm build` 通过，保留已有大 chunk 提示。

## M1 剩余完成门

1. 在真实 WKWebView 中确认系统中文候选选词与取消、原生横向滚动；继续核对焦点、键盘、独立滚动与可访问性完成门，并对照剪贴板权限跳过项记录原生替代证据的覆盖范围。
2. 补测 A / B 数据集的冷开表、输入到像素和完整 IPC/UI 性能，报告至少 20 次样本分布，不能用 CPU 或后端暖态结果代替。
3. 对照覆盖矩阵补足有效草稿成功导航、自动同步/检查点时序与真实桌面文件生命周期；失败门禁、退出取消/冻结和真实 Git 同步/回收站边界已有新增证据，不重复冒称全矩阵通过。

代码尚未提交或发布。现有用户改动和 Kiln 差异已按执行前基线核对保留；本阶段未修改用户真实 vault。
