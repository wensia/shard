# 多维表格原型与性能验证（MT0 / MT5）

日期：2026-09-07。本文同时保留 MT0 渲染原型的历史基线与 MT5 数据层复测。真实 WKWebView 原型、Node 数据层计算、Rust 文件保存分别记录，不能互相替代验收。资料库接线已写入当前工作区；正式整合 UI 与系统中文候选词输入仍需完成验收。

## 当前结论

- Glide 原型已在真实 Tauri 2.11.2 / WKWebView 加载。原生 ASCII 编辑后 Enter 保存、2×2 系统粘贴、前导零/长数字文本保留、Esc 取消以及纵向滚动已有观察，详见下方状态表。系统中文候选选词/取消仍为 pending；不能用 composition 事件出现或 Chromium 合成测试替代。
- 原型的 10,000×30 整表回传基线：生成响应 p50 89.5 ms，筛选排序 52 ms。该路径只用于早期渲染器验证。
- 正式 Worker 已接入不可变草稿、prepared mutation、增量记录输出和可信投影。10,000×30 的 20 次单格编辑 CPU/clone 组合 p95 从 1,872.7 ms 降至 15.6 ms，mock 保存队列含 snapshot 从 1,088.4 ms 降至 10.5 ms；这组结果不含真实磁盘或 WK 帧。
- [资料库接线](../../src/workspace/library-shell.tsx) 已包含新建、导入、表格详情工作区与保存门；这项源码现状不等于已完成正式应用端到端验收。
- Rust release 真实保存复测已完成：B 单格 p95 611.6 ms、1,000×10 粘贴 606.2 ms。该后端样本低于 1 秒，完整 IPC/UI 验收仍单列。
- 原始样本与源码 hash 现存于仓库的 [数据层前后性能证据](../../tests/evidence/tables/table-domain-performance-2026-09-07.json)，不再只依赖 `/tmp`。

## 隔离与运行环境

| 项目 | 本次条件 |
| --- | --- |
| 设备 | Apple M3 Max |
| 系统 | macOS 26.7，build 25G227 |
| WebView | Tauri 2.11.2；UA 包含 AppleWebKit/605.1.15 |
| 显示 | DPR 2；WebView 内容区域 1280 × 808 CSS px |
| Glide | `@glideapps/glide-data-grid` 6.0.4-alpha24 |
| 原型地址 | `http://127.0.0.1:1421/table-spike.html` |
| 数据 | Worker 内生成的确定性中文记录；没有用户资料库数据 |

原型入口为 [table-spike-main.tsx](../../src/dev/table-spike-main.tsx)，不导入 App、Workbench 或业务 API。独立 Tauri harness 位于 `/tmp/shard-tables-mt0/harness`，identifier 为 `dev.shard.table-spike`，使用 incognito 窗口和独立 Cargo target；没有 Shard 后端、vault 访问、配置迁移、同步或提交逻辑。

最小应用包为 `/tmp/shard-tables-mt0/harness/Shard Table MT0.app`。首次命令行进程 PID 为 87412，包装为 `.app` 后仅替换此测试进程，新 PID 为 1826；PID 仅记录本次会话，不应作为以后停止进程的依据。测试没有启动、停止或配置用户的 1420 服务或真实 Shard 应用。

测试 harness 只有 `mt0_report` IPC：将测试事件交给后台线程追加到固定临时日志。独立 eval 通道只读取本临时目录的 `eval-request.json`，不建立网络控制端口。真实 WebView 已成功执行 eval 并读回 `window.__tableSpike.snapshot()`。

## 性能采样方法

1. 等待当前页面字体和首批合成数据就绪；使用实际页面上的数据规模选择器触发生成。
2. 每个规模连续生成 20 次；每次等待 Worker 响应和随后两次 `requestAnimationFrame` 后再进行下一次。
3. 在筛选输入框设置 `记录 1`，连续触发“筛选并倒序”20 次。筛选基于名称包含匹配，排序使用 `Intl.Collator("zh-CN", { numeric: true })`。
4. 1,000 行筛选后 112 行，10,000 行筛选后 1,112 行。每次响应仍包含全部数据行和结果索引。
5. 共计 80 次计入统计的操作；最后另生成一次 1,000 × 20，恢复供原生交互使用的基线。

这是一组当前设备上的暖运行序列。p50 使用样本中位数，p95 使用 nearest-rank，即 20 个样本排序后的第 19 个。WebView 计时存在毫秒级量化，表中的 0 ms 不表示没有成本。

### Worker 与响应总耗时

单位：ms。每行样本数均为 20。

| 数据规模 | 操作 | Worker p50 / p95 / max | 响应总耗时 p50 / p95 / max |
| --- | --- | --- | --- |
| 1,000 × 20 | 生成 | 0 / 1 / 1 | 3 / 5 / 7 |
| 1,000 × 20 | 筛选并倒序 | 0 / 1 / 1 | 3 / 4 / 4 |
| 10,000 × 30 | 生成 | 4 / 10 / 11 | 89.5 / 97 / 102 |
| 10,000 × 30 | 筛选并倒序 | 2 / 3 / 3 | 52 / 55 / 59 |

Worker 耗时在生成/筛选/排序结束、调用 `postMessage` 之前取值。响应总耗时从主线程发送请求计到响应 handler 收到消息，包括投递、克隆和调度，但结束于 React 状态更新之前，**不等于首屏绘制时间**。

### 响应后两次帧回调观察

| 数据规模 | 操作 | p50 / p95 / max |
| --- | --- | --- |
| 1,000 × 20 | 生成 | 33 / 35 / 40 |
| 1,000 × 20 | 筛选并倒序 | 33 / 34 / 35 |
| 10,000 × 30 | 生成 | 100 / 101 / 117 |
| 10,000 × 30 | 筛选并倒序 | 67 / 67 / 67 |

此项从触发 DOM 控件计到收到响应后的两次帧回调，用于描述调度后可继续观察页面的时间；没有测量浏览器实际 presentation，因此不能标为真实首帧、交互延迟或 FPS。它也不包含磁盘 I/O、索引加载、Rust IPC、自动保存或检查点提交。

### 正式实现应保留的边界

[table-spike.worker.ts](../../src/dev/table-spike.worker.ts) 当前对生成、投影和单元格编辑统一回传 `{ rows, order }`，属于验证渲染器的整表克隆原型。正式实现应在相同可靠数据协议下分别处理首次加载、视图索引变化和编辑补丁；筛选只需回传必要索引，编辑只需确认受影响记录/字段与版本，不应每次回传全部 30 万个单元格。

以上描述保留 MT0 当时的原型基线。当前 [正式 Worker](../../src/workers/table.worker.ts) 已使用不可变引用与记录增量输出，下方另列其函数组合复测。50,000 行、长期内存和完整生产上限未由这些结果证明；首次加载与编辑/筛选继续分别验收。

## 真实 WebView 布局、字体与 Canvas

### 已观测

- `document.fonts.status` 为 `loaded`；`document.fonts.check('400 14px "Noto Sans SC"')` 与 500 字重检查均为 true。实际按 Unicode 子集加载 400/500 字体，未用到的子集保持 unloaded 是正常状态。
- 主工作区和映射到 Glide 的 `fontFamily` 都以 `Noto Sans SC` 开头；正文映射为 13px，表头为 500 13px，行号为 12px。
- 主 Canvas 客户区为 1280 × 632，backing store 为 2560 × 1264；表头 Canvas 为 1280 × 37，对应 2560 × 74，符合 DPR 2。
- 顶部工具区高度 57，表格工作区高度 632，底部状态区高度 36，辅助编辑区高度 83；合计为 808 CSS px。
- 文档的 `scrollWidth/clientWidth` 均为 1280，`scrollHeight/clientHeight` 均为 808，初始 `scrollLeft/scrollTop` 均为 0。性能采样结束后文档滚动位置仍为 0。
- 表格外框透明，Canvas 主题背景消费 `--card`，文本消费 `--foreground`，选中态消费 `--table-row-selected`。当前主题主色为 `rgb(46, 110, 121)`；本次不修改用户主题选择。

这些证据覆盖加载状态、几何、主题输入及 Canvas 像素密度。它们不替代实际字形绘制检查，也不证明用户滚轮事件的滚动链行为。

### 主题映射基线问题与代码修正

1. [kiln-grid-theme.ts](../../src/features/tables/kiln-grid-theme.ts) 对长度 token 使用 `parseFloat`。`--radius-sm` 在 [radius.css](../../vendor/kiln/tokens/radius.css) 中为 `0.25rem`，实测 `theme.roundingRadius` 得到 `0.25`；Glide 将该数值用于 Canvas 坐标，不能据此视为已正确映射控件圆角。应使用浏览器将 CSS 长度解析为像素，并复核所有数值型长度输入。
2. 实测 `borderColor` 与 `horizontalBorderColor` 均为 `color(srgb 0.931176 0.922353 0.91)`，同宽线条将具有相同视觉权重。Kiln 的 [Table 规范](../../vendor/kiln/references/components.md) 要求纵向辅助线显著弱于横向行分隔线；应映射更轻的列线语义，或关闭非必要纵线，并验证真实 Canvas 绘制。

此处保留采样时的问题。当前主题适配已通过 DOM 探针解析圆角 CSS 长度，并将纵向线映射为 border 的 35% 透明混合；源码问题已处理。Noto 字体与 Retina 样式探针已有观察，修正后圆角/线权重的实际 Canvas 视觉验收仍应单列，不能仅因代码变更就标记完成。

## 原生交互状态

以下由主任务操作隔离 `.app` 后记录；不是本性能脚本生成的交互。

| 项目 | 已知状态与证据边界 |
| --- | --- |
| 原生 ASCII | WKWebView 中输入 `abc`，Enter 保存成功。 |
| 系统矩形粘贴 | 选中 grid 后粘贴 `中文甲\t00123\n中文乙\t98765432101234567890`，四格正确；前导零与长数字保留文本。工具 paste 曾超时，随后截图和真实 `isTrusted` paste 日志确认结果，未重复粘贴。 |
| Overlay 粘贴与取消 | Overlay 中多行粘贴按单个 cell 编辑；Esc 后原值保持。 |
| 纵向独立滚动 | 原生窗口滚动到约第 43 行，工具栏固定。 |
| 横向滚动 | Chromium 已检查；原生 WK 横向结果尚未确证。 |
| Retina 与字体 | DPR 2、Canvas backing 2×、Noto 字体 ready 及样式 probe 已观察。 |
| 再次打开编辑器焦点 | 默认 Glide 第二次打开曾丢焦点；自有 textarea 已用 requestAnimationFrame focus 修正，Chromium 4 项相关测试通过。合成 composition 不等于系统候选词操作。 |
| 系统中文输入法 | **Pending**：尚未完成可确认的中文候选选词、提交与取消验收。`Ctrl+Space` 工具调用不能证明输入源切换；日志中的 ABC/ab/composition 记录不能单独作为通过证据。 |
| 窄窗口、辅助技术与正式 UI | 仍需正式表格工作区的整合验收，不能继承原型结论。 |

## Worker 数据层性能修复

合成数据为 10,000×30，300,000 个已填单元格，18,678,748-byte JSON；其中 100k 中文文本、100k 数字、50k 日期、50k 布尔。该组用于定位单格编辑热点；下方 Rust 基准另覆盖多选、null/空文本与较长文本。Apple M3 Max、Node 22.17.0 / V8 12.4。每版均 20 轮 edit → flush → undo → flush；默认无筛选/排序/分组；p95 用 nearest-rank，包含首轮。

| 阶段 p95，ms | 修复前 | 修复后 |
| --- | ---: | ---: |
| 单格 edit 到 snapshot | 1,872.7 | 15.6 |
| Undo 到 snapshot | 1,189.1 | 12.4 |
| queue.flush CPU | 908.2 | 4.5 |
| flush 含 snapshot | 1,088.4 | 10.5 |
| history 自身 | 971.0 | 4.2 |
| queue.enqueue | 706.2 | 0.03 |
| snapshot | 197.6 | 6.3 |

修复前一次 edit 包含 7 次完整验证、11 次全表 clone 和 4 次 businessSnapshot。当前只对内部已验证且递归冻结的内容使用 setCells 局部 copy-on-write、触达值逆操作和 prepared change 共用；公开不可信输入、结构变更、未知保存结果回读仍保留完整校验。增量 ack 检查返回记录所有 values，并拒绝遗漏与非预期变化。新增回归后 89 项相关测试通过。

复测函数组合包括 `peekDraft`、`applyPrepared → enqueuePrepared`、记录引用 diff、`projectOwnedTableView`、增量消息 clone。mock transport p95 约 0.05 ms，没有真实磁盘/IPC。结果符合函数计算层面的 100 ms 目标，但不证明系统输入到像素的完整延迟，也不证明真实落盘目标。完整原始阶段分布与对应源码 hash 见 [长期证据 JSON](../../tests/evidence/tables/table-domain-performance-2026-09-07.json)。

## Rust 真实文件保存复测

最终入口为 [table-performance.sh](../../scripts/dev/table-performance.sh)，调用 [ignored Rust 基准](../../src-tauri/src/table/performance.rs)。使用真实 `create_in_vault` / `read_in_vault` / `apply_in_vault`、真实 vault gate、独立临时 vault 与真实本地 Git，执行文件 `sync_all` 和原子安装/替换；不读取 AppHandle 配置，也不访问用户 vault。每个规模的 vault 仅含一张表，没有 remote；开始时建立一个基线提交，40 次内容保存后 HEAD 保持原提交，修改留待 checkpoint。每次 ack 的 hash 均与实际磁盘字节重新核对，未留下临时写入文件。

构建为 `cargo test --release`（`debugAssertions=false`），aarch64、Apple M3 Max、macOS 26.7 / 25G227、rustc 1.93.1、Git 2.54.0。A 为 1,000×20，B 为 10,000×30；均含六种字段、中文、多选、约每 17 格一个 null、空文本、每 100 行的 560 字以上长文本。A 初始文件 1,888,352 bytes，B 为 27,243,928 bytes；所有粘贴后分别为 1,946,446 / 27,302,050 bytes。样本内容比前述 Node 热点表更丰富，两者不可直接拼接成一个端到端计时。

每个规模各 20 次读、20 次单格保存、20 次 1,000×10 单元格粘贴；每次粘贴是一条原子 mutation 请求。保留全部样本，p50/p95 为 nearest-rank；不删除慢值。首次创建各测一次：A 87.4 ms、B 567.7 ms，不能据此给出创建 p95。

| 最终阶段，ms | A p50 / p95 | B p50 / p95 |
| --- | ---: | ---: |
| 单纯读取文件 bytes | 0.3 / 0.4 | 3.7 / 3.9 |
| 严格 JSON 解析 + 完整模型校验 | 14.1 / 14.5 | 204.2 / 205.8 |
| read_in_vault 完整读取 | 18.1 / 19.1 | 262.7 / 269.7 |
| 单格 apply_in_vault，含真实落盘 | 77.8 / 82.4 | 572.3 / 611.6 |
| 1,000×10 paste，含真实落盘 | 100.4 / 102.0 | 599.1 / 606.2 |
| 独立 Git 未完成操作检查 | 32.2 / 35.2 | 33.1 / 35.7 |

B 的单格 ack 约 2.5 KB，粘贴 ack 约 2.20 MB；Rust ack JSON 编码 p95 分别 0.016 / 1.695 ms。完整读取结果编码 p95 为 16.1 ms；这些编码单独计时，没有包含到表中的 command 内部耗时。

### 瓶颈与最小修复

| B 的 p95，ms | 原始版本 | 仅去重遍历 | 最终版本 |
| --- | ---: | ---: | ---: |
| read_in_vault | 1,572.9 | 706.0 | 269.7 |
| 单格真实落盘 | 1,215.0 | 1,009.0 | 611.6 |
| 1,000×10 真实粘贴 | 1,211.8 | 1,074.9 | 606.2 |
| 严格 parse + validate | 684.9 | 649.7 | 205.8 |

1. 同一次保存原先重复完整校验已解析的 current，并两次生成相同 canonical bytes。现在仅由严格解析器构造私有不可变 token，携带原 limits，storage→apply 复用校验；同一份 canonical bytes 同时生成 hash 和写入磁盘。公开 `apply_mutations` 仍完整校验普通输入。
2. `read_in_vault` 的身份扫描原先又 probe/parse 已读目标。现在复用本次已严格读取的目标，只扫描其他路径，重复 ID 检查保留；没有新增索引。
3. `CellValue` 原先通过 untagged enum 为每格逐个试错 variant。改为按 JSON 类型直接分派的 Deserialize visitor，减少失败分支分配；Serialize wire 不变，仍只接受 null、bool、number、string、string[]。所有层级的 duplicate-key、容量、字段、日期和多选完整校验保留。

原字节/hash 等价、错误不落盘、深层重复键、公开脏输入以及 mixed/null/object 数组拒绝均有回归；新 [共享值用例](../../tests/fixtures/tables/cell-wire-cases.json) 同时由 Rust 与 TypeScript 检查。35 项相关 Rust 测试通过（含 table 核心、commands 路径/重复 ID/生命周期与表格回收/提交边界），33 项 TS 模型测试通过；ignored 性能测试已单独使用 release 构建运行。

本机这组暖缓存真实后端保存 p95 已低于 1 秒，最终单格最慢 613.8 ms、粘贴最慢 610.6 ms。尚未覆盖冷缓存、多表大目录、慢盘、IPC/主线程 clone 或最终渲染，因此不能据此宣称完整冷开表≤2秒或正式应用所有交互达标。无需为本次目标引入索引或分片。

最终脚本从头执行至退出码 0，样本中的全部编译源码 hash 与复测结束工作区一致。长期原始证据：

- [原始后端样本](../../tests/evidence/tables/table-backend-performance-before-2026-09-07.json)
- [去重后中间样本](../../tests/evidence/tables/table-backend-performance-deduplicated-2026-09-07.json)（仍超 1 秒，未标通过）
- [最终确认样本](../../tests/evidence/tables/table-backend-performance-final-2026-09-07.json)，含每次读写、文件/请求/响应大小、硬件、构建、Git 状态与源码 hash。

复现命令：`scripts/dev/table-performance.sh /tmp/shard-table-performance-results.json`。默认输出也在独立临时目录；测试结束自动删除临时 vault，不改变用户配置、现有服务或真实 Git 仓库。

## 复现与原始证据

临时证据位置：

- `/tmp/shard-tables-mt0/harness/performance-samples.json`：80 次计入统计的操作与恢复操作原始数据。
- `/tmp/shard-tables-mt0/harness/performance-summary.json`：本报告统计表。
- `/tmp/shard-tables-mt0/harness/layout-before.json`：字体、主题、Canvas、布局及文档滚动快照。
- `/tmp/shard-tables-mt0/harness/events.jsonl`：真实 WebView 页面生命周期、eval 结果和输入事件。
- `/tmp/shard-tables-mt0/harness/build.log`、`README.md`：离线构建结果及启动/eval 方法。

基线源码 SHA-256：

| 文件 | SHA-256 |
| --- | --- |
| `src/dev/table-spike.worker.ts` | `96d296276a2af5217b4db876427775fba002b3fe483582400c2de31c1a3657e4` |
| `src/dev/table-spike-main.tsx` | `076dd63dce76402bd11a97336be2e2038ee2b46eb6238d5c8385e300c70ee150` |
| `src/features/tables/kiln-grid-theme.ts` | `9eb05d7ef95e27c4dc3039aab42b5e8df528aca7b535184f086b426c2db388b0` |

## 正式工作区当前结果

原型结论与正式工作区分别记录。[实现与验收记录](multidimensional-tables-implementation.md) 已更新 MT1–MT4 实现、203 项 unit、172 项 Chromium UI、13 项 WebKit（另 1 项剪贴板权限跳过）、真实原生读写和 CSV/XLSX 导入 → 重启 → 再导出结果。原生 XLSX 的 24 个值与单元格类型经独立解析逐格一致，CSV 往返字节哈希相同；完整数据快照见 [原生证据](../../tests/evidence/tables/table-native-acceptance-2026-09-07.json)。

系统中文输入法候选操作、原生横向滚动和完整输入到像素/冷开表性能仍待验收，不从原型或自动化结果推定为通过。
