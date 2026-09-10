# MT0：XLSX Rust 读写库核实

核实日期：2026-09-07。范围：MT4 单工作表、类型化数据交换；本次只核对当前发行元数据、官方源码与本地依赖，不安装依赖、不执行 XLSX fixtures、不修改 Cargo 或生产代码。

## 1. 结论与精确版本

建议采用 `calamine = "=0.36.1"` 读取、`rust_xlsxwriter = "=0.99.0"` 新建导出文件。两者均先使用空的默认 features；日期可用各自原生日期 API 与项目已有 Chrono 校验。只有明确使用 Calamine 的 `as_datetime()` 时才显式启用它的 `chrono` feature。不要依赖其他 crate 偶然开启的 feature。

| 项目 | 当前稳定版与发布时间（UTC） | 许可 | 声明的最低 Rust |
| --- | --- | --- | --- |
| Calamine | 0.36.1，2026-07-27；非 yanked | MIT | 1.88 |
| rust_xlsxwriter | 0.99.0，2026-08-23；非 yanked | MIT OR Apache-2.0 | 1.88.0 |

已查 crates.io 的 `max_stable_version`、版本 `yanked`/`rust_version`/`license`，并交叉核对对应 tag 的 manifest：[Calamine 发行记录](https://crates.io/crates/calamine/versions)、[Calamine v0.36.1 Cargo.toml](https://github.com/tafia/calamine/blob/v0.36.1/Cargo.toml)、[Writer 发行记录](https://crates.io/crates/rust_xlsxwriter/versions)、[Writer v0.99.0 Cargo.toml](https://github.com/jmcnamara/rust_xlsxwriter/blob/v0.99.0/Cargo.toml)。后续升级需要重新核对，本文不使用可漂移的 `latest` API 作为实现依据。

本地基线：根 `Cargo.toml` 为 edition 2021 workspace；`src-tauri/Cargo.toml` 已有 `anydoc = "0.1.8"` 和 Chrono，尚无直接 Calamine/Writer 依赖。`Cargo.lock` 已通过现有文档导入依赖锁定 Calamine 0.36.1、ZIP 8.6.0、quick-xml 0.41.0；没有 Writer。实际工具链为 `rustc/cargo 1.93.1`、`stable-aarch64-apple-darwin`，未找到仓库 `rust-toolchain*`，也未声明项目 `rust-version`。本机满足两库声明的 MSRV；新增直接依赖后的完整构建及发布机兼容性仍待验证。

Calamine 要求 ZIP `8.6`，Writer 要求 ZIP `8.3`，两个范围与当前锁定的 8.6.0 相容；这是 manifest 范围判断，未执行依赖解析。现有 XLSX → Markdown 通路不能承担原生表格的 typed value 导入。

## 2. 已由 API 和源码证实的能力

| 需求 | 可用 API 与接入约定 |
| --- | --- |
| 工作表与逐单元格读取 | `Xlsx<Read + Seek>`、`Reader::sheet_names()`、`Xlsx::worksheet_cells_reader()`；以返回的零基 `(row, column)` 保存导入位置。优先流式 reader，避免未经容量检查就构造整张 `Range`。 |
| 值与公式来源一起读取 | `XlsxCellReader::next_cell_with_formula_metadata()` 返回位置、`DataRef` 值和 `Option<XlsxFormulaMetadata>`，值可以是字面值或公式缓存；共享公式保留 anchor/derived 元信息，不为每个单元格展开公式。无需将值和公式分别完整读成两张 Range。 |
| 原始类型 | `Data`/`DataRef` 区分数值、文本、布尔、Excel 日期、ISO 日期/时长、错误与空值；`SharedString` 可转为文本。不要先 `to_string()` 再猜类型；`0`、`false`、空字符串与空单元格分别保留。 |
| 1900 / 1904 日期 | `Xlsx::has_1904_epoch()` 可读取系统；`ExcelDateTime::as_f64()` 保留序列值，`to_ymd_hms_milli()` 按其 epoch 返回日期分量，`is_duration()` 区分时长。返回分量需再次校验，不能把日期时间直接静默裁成 M1 日期。 |
| 合并区域 | `Xlsx::merge_cells_by_sheet_name()` 可读取选定工作表的合并范围。首版预览指出合并区域，不自动把左上角值复制到所有格。 |
| 新建导出 | Writer 的 `Workbook::add_worksheet()` 和 `Worksheet::write_string()` / `write_number()` / `write_boolean()` / `write_datetime_with_format()`；日期通过 `ExcelDateTime::from_ymd()` 与 `yyyy-mm-dd` 格式写出。文本必须显式走 `write_string`。 |
| 后台写出 | `Workbook::save_to_writer<W: Write + Send>()` 可以写到后端临时文件后按现有协议完成导出；避免先 `save_to_buffer()` 再把整份 XLSX 经过 IPC 传到前端。 |

API 来源：[Calamine reader 与值类型](https://github.com/tafia/calamine/blob/v0.36.1/src/lib.rs)、[逐单元格与公式元数据](https://github.com/tafia/calamine/blob/v0.36.1/src/xlsx/cells_reader.rs)、[工作表/日期系统/合并区域](https://github.com/tafia/calamine/blob/v0.36.1/src/xlsx/mod.rs)、[日期实现](https://github.com/tafia/calamine/blob/v0.36.1/src/datatype.rs)、[Writer 工作表](https://github.com/jmcnamara/rust_xlsxwriter/blob/v0.99.0/src/worksheet.rs)、[Writer 工作簿](https://github.com/jmcnamara/rust_xlsxwriter/blob/v0.99.0/src/workbook.rs)。

必须保留的语义边界：

- **公式缓存不是计算结果的有效性证明。** 导入器不重算公式、不执行宏或外链；缓存可能过期。存在公式且缓存缺失或为 Error 时标为预览问题，不能当普通空值保存。用户选择公式文本导入时，普通公式直接取文本；共享公式 derived 必须在有界映射中找到 anchor 后展开，找不到则明确报错。
- **值类型不是 XML 字面值保真。** Calamine 将数值 `<v>` 解析为 `f64`，可能已损失长整数的精度，也不返回任意数字格式后的显示文本。源单元格确为文本时可保留前导零；数值 `123` 配 `000000` 不能仅靠 `DataRef` 变回 `000123`。需要把超安全整数/显示格式差异作为导入问题；若要保留 `<v>` 中的原始数字词法，应在下节有界 XML 预检时按坐标保留，再由用户选择文本，不能从已舍入的浮点值恢复。
- **Excel 日期无时区，且存在虚构的 1900-02-29。** `to_ymd_hms_milli()` 按 Excel 语义可返回该日期；Chrono 的 `as_datetime()` 对序列 60 的转换不会保存这个虚构日期语义。M1 应标为无效日期/可选择文本，不静默落成 1900-02-28。日期时间、纯时间、时长与普通数字不能自动都成为日期字段。
- **导出统一使用 1900 系统。** Writer v0.99.0 的 1904 支持是未公开的内部实现，不能依赖该私有开关。先将导入数据规范化到 M1 的合法 `YYYY-MM-DD` 再正常导出，不承诺保留原工作簿 epoch。[Writer 日期源码](https://github.com/jmcnamara/rust_xlsxwriter/blob/v0.99.0/src/datetime.rs)
- Writer 不计算公式；写公式时默认缓存为 0，并要求电子表格软件重算。M1 只写原生表的数据值，不能用 `write_formula()` 输出用户文本；`Formula::set_result()` 仅用于明确构造的测试样例等场景。[Writer 公式语义](https://github.com/jmcnamara/rust_xlsxwriter/blob/v0.99.0/src/formula.rs)

## 3. 文件预算与异常展开的接入点

两库没有一个可直接代替 Shard 容量策略的统一限额开关。Calamine 的 XLSX options 不能限制总解压字节、共享字符串计数与全表内存；仅对原始文件 `metadata().len()` 检查不够。

建议在 MT4 导入后端落地以下顺序；具体上限统一消费 MT0 契约，本文不另立一套容量数字，也不宣称已测试支持容量：

1. 在后台打开文件并按 `maxImportBytes` **实际有界读取**到不可变快照。后续预检与 Calamine 必须使用同一份字节，避免检查后文件被替换；仅事先 stat 不构成硬限制。大样本如改为临时快照文件，保持同样的预算和身份规则。
2. ZIP 阶段检查条目数、重复成员名、支持的压缩方法、加密标记、单成员声明大小和总声明大小；逐成员解压时使用固定小缓冲，并以 `Read::take(remaining + 1)` / 等价计数器检查**实际**展开字节，达到单成员或总预算立即拒绝。`ZipFile::size()` / `compressed_size()` 只提供头部元数据，压缩比只能作为附加指标。禁止解压到用户目录，不递归打开嵌套 ZIP。[ZIP 8.6.0 API](https://docs.rs/zip/8.6.0/zip/read/struct.ZipFile.html)
3. 在 `Xlsx::new()` **之前**做有界 XML 预检：工作表数、实际单元格位置与数量、shared string 实际数量与 `uniqueCount`、单格字符数、公式长度/共享索引、XML 嵌套/事件数、样式数、合并范围均受预算约束；不只信任 worksheet `dimension`。限定支持的 XLSX 内容类型与 ZIP 成员路径，发现宏/外链只报告，不执行或获取远程资源。
4. 预检后，用 `next_cell_with_formula_metadata()` 逐格构造 typed DTO；再检查契约的最大行、列、单元格总数、文本总字节、有限数值和日期。对稀疏的极远坐标也拒绝，不能在 `Range::from_sparse()` 展开矩形后才检查。前端只取有界预览，确认后才构造新表。
5. 解析、预检、序列化与导出都走现有 `run_blocking` / `spawn_blocking`，失败不产生新表。循环中检查取消/工作预算；异步超时或丢弃 JoinHandle 不会自动杀掉阻塞解析线程，不能以此宣称强制限制内存/CPU。

源码证据说明为什么必须在解析前检查：

- Calamine `read_shared_strings()` 对 `<sst uniqueCount>` 执行 `self.strings.reserve(n)`；它在 `Xlsx::new()` 构造阶段就运行。一个很小的 XML 计数也可触发超大分配，因此总展开字节限制不能替代计数检查。[v0.36.1 XLSX 实现](https://github.com/tafia/calamine/blob/v0.36.1/src/xlsx/mod.rs#L340)
- `next_cell_with_formula()` / `worksheet_formula()` 的共享公式展开路径按 `si + 1` 扩大内部向量。`next_cell_with_formula_metadata()` 不展开，避开此分配；后续如需要导入公式文本，仍须使用有界索引与长度规则。[v0.36.1 公式 reader](https://github.com/tafia/calamine/blob/v0.36.1/src/xlsx/cells_reader.rs#L317)
- ZIP 8.6.0 的读取 Config 仅提供 archive offset 配置，没有应用级最大条目/展开字节限额。[ZIP Config](https://github.com/zip-rs/zip2/blob/v8.6.0/src/read/config.rs) Shard 如直接调用 ZIP / quick-xml 作上述预检，应将它们声明为直接依赖并锁定经验证版本，不能依赖传递依赖可导入。

这些是源码审阅结论及拟采用的防护设计，**尚未完成恶意样本与资源预算验证**，不能作为任意 XLSX 都可安全解析的证明。MT4 采用该组合的前提是实现预检并完成下表；不需要为 M1 引入完整电子表格引擎。

## 4. 仍需 fixtures / 构建验证

| 样本组 | 必须断言 |
| --- | --- |
| 类型与精度 | Empty / `""` / 0 / false 分开；中文、换行、共享与内联字符串；文本前导零；数字显示格式前导零；大于 `2^53-1` 的编号与超过 Excel 常见精度的数字不静默改值。 |
| 日期 | 1900/1904 同一真实日期得到相同 M1 值；1900 序列 0/59/60/61，1904 序列 0；时间小数、时长、ISO 日期、错误/非日期格式均有明确结果；导出再解析保持合法日期。 |
| 公式缓存 | 数字/文本/布尔/错误/空字符串缓存、缺失 `<v>`；普通/共享/数组公式，derived 在 anchor 前、孤立或超大 `si`；标记公式来源、拒绝缺失/错误缓存的静默转换。缓存新旧无法由导入器验证，预览须注明。 |
| 文件结构 | 多 sheet 选择、空 sheet、合并区、隐藏 sheet/行列、不一致 dimension、重复成员、坏 XML/ZIP、加密文件、宏/外链；不联网、不自动执行，失败无半张表。 |
| 资源边界 | 在测试进程中构造小压缩体的大展开、超大 uniqueCount、远端稀疏坐标、超长字符串/公式、过多 styles/成员、截断或大小声明不一致，验证分配前拒绝、取消与峰值内存；避免将 OOM 样本直接喂给桌面主进程。 |
| 导出与往返 | 显式文本 `=SUM(...)` / `+...` / `-...` / `@...` 不生成 `<f>`；六类 M1 值和全部/视图范围正确；日期类型可再读；失败保留旧文件并清理自身临时文件。选项/多选如何交换标签需遵守 MT4 映射契约。 |
| 依赖与性能 | 新增依赖后 `cargo check` 和相应 round-trip 测试；记录 debug/release、工具链、fixture 大小、耗时与峰值内存。Writer `constant_memory` 只在正常模式实测不足时再评估，其顺序写入约束需单独测试。 |

当前完成证据仅为版本/MSRV/许可与具体 API/源码核对；本研究不把上表写成通过，也不替代 MT0/MT4 的实际 fixture 结果。
