# 多维表格共用 fixtures

这些文件是 [MT0 数据契约](../../../docs/dev/multidimensional-tables-contract.md)的跨 Rust/TypeScript 输入，不是已经实施的存储功能。`manifest.json` 列出合法文件、错误 code/JSON Pointer、投影和领域操作样例。

- `valid/empty.json`：空表、主字段与默认视图。
- `valid/six-types.json`：六种字段、中文/换行、0/false/空串/缺省/null、真实闰日、稳定选项 ID。
- `valid/independent-views.json`：同记录独立视图、字段顺序、隐藏、宽度、筛选与分组。
- `invalid/`：每个样例集中违反一项 wire/model 条件；`duplicate-*-key.json` 是故意包含重复键的原始 JSON 文本，测试必须直接读取字节，不能先 JSON.parse 再传给待测读取器。
- `projection-cases.json`：相同源表下的查询输入与预期 recordId 顺序，覆盖空值/否定比较/稳定排序语义。
- `operations/`：实际领域批次与结果断言；失败批次必须保持原件和 revision/hash，不只检查抛错。

表内部 ID 固定便于断言；生产 ID 必须使用随机生成。creation.payloadHash 为固定的合法 hash 样例，只用于格式读取；真实创建请求的规范化 payloadHash 必须由正式后端生成并由幂等行为测试验证，不能把本样例 hash 当成客户端序列化算法约定。

更新时间/落盘 hash 等运行态元数据由正式测试捕获，不在操作 fixture 中伪造。投影 fixture 的 `source` 以及操作 fixture 的 `source` 都相对本目录解析。非法文件中 null 被保留用于读取边界；合法写端应按契约省略 null 值键。

规模样本不提交大文件：原型按明确 seed 生成 A=1,000×20、B=10,000×30、C=50,000×30，在真实宿主测量后写入 MT0 报告。
