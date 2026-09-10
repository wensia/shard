# Shard 多维表格数据契约（MT0）

日期：2026-09-07。状态：可用于 MT0 原型与共同 fixtures；容量为待实测候选，正式持久化命令尚未实施。

本契约细化[执行计划](./multidimensional-tables-plan.md)，定义首版公开资料库数据表的磁盘格式、DTO、操作、查询与失败语义。文件是唯一真相源；不增加数据库依赖、事件日志或新托管根目录。共同样例位于 [tests/fixtures/tables](../../tests/fixtures/tables/README.md)。

## 1. 身份、路径与编码

- 文件路径为 `notes/<目录>/<名称>.shardtable.json`；显示名称只来自文件名去掉完整后缀，JSON 不保存独立表名。
- ID 为前缀加 128 位加密随机数的小写十六进制：`tbl_`、`fld_`、`opt_`、`rec_`、`view_`、`req_`、`mut_` 后接 32 位 `[0-9a-f]`。不使用时钟或数组下标生成 ID。
- 表 ID 在公开 vault 内唯一；字段、记录、视图在所属表内唯一，选项在所属字段内唯一。复制表分配新 tableId，允许保留内部 ID；未来记录的跨表身份始终为 `(tableId, recordId)`。
- 创建/打开/显式刷新时检查已知可解析表身份。无法解析身份的坏文件保留自身读取错误，不阻塞无关健康表；不能声称已证明这些坏文件的身份唯一。外部程序在打开后复制同 ID 文件，须在下次打开/刷新时检测；普通保存始终校验精确 path + ID + hash，不为每次单元格编辑扫描全 vault，也不承诺实时跨进程唯一性。
- 表移动/重命名/回收/恢复不改变 ID。创建请求必须核对同 tableId / requestId 的现存结果；重复表 ID 报错，不选择第一个文件写入。
- 磁盘使用严格 UTF-8 JSON、2 空格缩进、LF、末尾一个 LF。对象键按 Unicode 码点排序，数组保持契约顺序；不做文字 trim、Unicode 归一化或日期时区转换。
- 读取在反序列化为普通对象前拒绝任意层级的重复 JSON 键、无效 Unicode/孤立代理项及非有限数字；不能通过 `JSON.parse` 或 `serde_json::Value` 先覆盖掉重复键再校验。JSON Pointer 用于定位错误。
- `contentHash` 为实际读取/写出 UTF-8 字节的 SHA-256 小写 64 位 hex。读文件不能先重排/格式化再计算 hash。客户端把后端 hash 当成不透明基线，不重新序列化文件推算该 hash。
- 创建 payload 的幂等 hash 由后端基于同一冻结 DTO 的确定性编码计算；所有重试提交同一 DTO。跨 Rust/TS 数字格式未统一前，客户端不得自算该 hash 代替后端结果。

## 2. 精确 DTO

以下 TypeScript 是 wire DTO，不依赖渲染器。ID 类型中的字符串还须满足第 1 节格式。Rust 使用对应结构与显式枚举，不用任意 JSON 值承接单元格。

```ts
type TableId = string
type FieldId = string
type OptionId = string
type RecordId = string
type ViewId = string
type RequestId = string
type MutationId = string
type Sha256 = string
type Timestamp = string // UTC RFC3339，形如 2026-09-07T00:00:00.000Z
type DateOnly = string // 有效 Gregorian YYYY-MM-DD，0001-01-01 至 9999-12-31

type CellValueByType = {
  text: string | null
  number: number | null
  date: DateOnly | null
  select: OptionId | null
  multiSelect: OptionId[] | null
  checkbox: boolean | null
}
type FieldType = keyof CellValueByType
type CellValue = CellValueByType[FieldType]
type OptionColor = "neutral" | "red" | "orange" | "yellow" | "green" | "blue" | "purple"
type SelectOption = { id: OptionId; label: string; color: OptionColor }
type FieldBase = { id: FieldId; name: string }
type TableField =
  | (FieldBase & { type: "text" | "number" | "date" | "checkbox" })
  | (FieldBase & { type: "select" | "multiSelect"; options: SelectOption[] })

type TableRecord = {
  id: RecordId
  createdAt: Timestamp
  updatedAt: Timestamp
  values: Record<FieldId, CellValue>
}

type FilterCondition =
  | { fieldId: FieldId; operator: "isEmpty" | "isNotEmpty" }
  | { fieldId: FieldId; operator: "eq" | "ne"; value: string | number | boolean }
  | { fieldId: FieldId; operator: "contains" | "notContains" | "startsWith" | "endsWith"; value: string }
  | { fieldId: FieldId; operator: "gt" | "gte" | "lt" | "lte"; value: number | DateOnly }
  | { fieldId: FieldId; operator: "between"; lower: number | DateOnly; upper: number | DateOnly }
  | { fieldId: FieldId; operator: "in" | "notIn" | "hasAny" | "hasAll" | "hasNone"; optionIds: OptionId[] }
type TableFilter = { operator: "and" | "or"; conditions: FilterCondition[] }
type TableSort = { fieldId: FieldId; direction: "asc" | "desc" }
type TableView = {
  id: ViewId
  name: string
  type: "table"
  filters: TableFilter
  sorts: TableSort[]
  groupBy: FieldId | null
  fieldOrder: FieldId[]
  hiddenFieldIds: FieldId[]
  columnWidths: Record<FieldId, number>
}

type TableContent = {
  primaryFieldId: FieldId
  fields: Record<FieldId, TableField>
  fieldOrder: FieldId[]
  records: Record<RecordId, TableRecord>
  recordOrder: RecordId[]
  views: Record<ViewId, TableView>
  viewOrder: ViewId[]
}
type TableFile = TableContent & {
  kind: "shard.table"
  schemaVersion: 1
  id: TableId
  revision: number // 1..Number.MAX_SAFE_INTEGER；每个已落盘批次 +1
  creation: { requestId: RequestId; payloadHash: Sha256 }
  lastMutationId: MutationId | null // 新建时 null
  lastMutationHash: Sha256 | null // 与 ID 同时为空/非空；仅保存最后一批
  createdAt: Timestamp
  updatedAt: Timestamp
  copiedFrom?: { tableId: TableId; revision: number; contentHash: Sha256 }
}

type TableReadResult = {
  file: TableFile
  path: string
  title: string // 后端从实际 path 派生
  revision: number // 必须等于 file.revision
  contentHash: Sha256
}
```

Rust 的 `CellValue` wire 等价于 `Null | Text(String) | Number(f64) | Checkbox(bool) | OptionIds(Vec<String>)`，日期和单选依靠所属字段验证字符串语义。用 `untagged` 表达 wire 值时仍要严格检查有限数、完整类型与数组元素，绝不把数字/布尔转成字符串兜底。TypeScript 更新入口可使用 `<T extends FieldType>(field: TableField & { type: T }, value: CellValueByType[T])` 限定类型，后端始终再验证。

`lastMutationHash` 是执行计划中 `lastMutationId` 的最小补充：同 mutationId 配不同操作必须被识别，不引入无限历史表。所有对象拒绝未知属性；新增持久属性要更新本契约及兼容策略，不能靠读取后丢弃未知属性保存。

### 2.1 值与模型不变量

- 缺省键与 `null` 均表示未设置；写出时规范化为省略键。`""`、`0`、`false` 必须原样保存；`[]` 是多选的合法空集合，不能改成文本。
- 数字必须有限，绝对值不超过 `9007199254740991`；`-0` 写为 `0`。长编号、手机号、前导零数据必须用文本；不进行浮点精确十进制/财务计算承诺。
- 日期为真正存在的日历日期；`2024-02-29` 合法，`2025-02-29` 非法。创建/更新时间只接受有效 UTC RFC3339，写端使用毫秒精度；`updatedAt >= createdAt`。
- 保存时间不得倒退：遇到跨机器时钟偏差或恢复的较晚元数据，本批时间取后端当前时间与现有/恢复实体时间的较晚者；保留已有较晚时间的原精度。不能因本机时钟暂时较早而把已存在的合法表变为无法编辑。
- 单选引用本字段现存 optionId。多选数组无重复、只引用本字段选项；写端按 optionId 码点排序，选项显示顺序来自 `field.options`，选项重排不重写每行值。
- ID 映射键必须与实体 `id` 一致；根级三份 order 是各自映射键的完整排列，每个视图 fieldOrder 是全部字段的完整排列。隐藏仅靠 hiddenFieldIds，无重复且只引用现存字段。
- 主字段必须存在且为 text；不得删除、换类型或隐藏。名称可重复，ID 不可重复；名称/视图名/选项标签不为空白，但不擅自 trim 正文值。
- 至少一个字段和一个 table 视图。列宽为整数 CSS px，范围 64..1200；缺省宽度由 UI 设计规范确定。重复排序字段非法；sorts、filters、groupBy、宽度映射均须引用现存字段。
- 视图筛选只支持一层 and/or，没有任意表达式。单字段分组支持 text/number/date/select/checkbox；M1 不对 multiSelect 分组。
- 现有非空字段换类型在 M1 禁止。这里“空”仅指全部记录值为缺省/null；`""`、`[]` 也须先显式清空再换类型，不能借换类型静默丢弃值。
- 删除正在使用的选项时，整个批次须明确替换/清空受影响单元格和筛选配置；仅替换字段定义而留下失效选项引用时整批失败。
- 未知 kind/schemaVersion/字段或视图类型、错误键、非法值均拒绝正常编辑，保留原文件并返回位置；不能初始化成空表。

### 2.2 过滤、排序和分组

| 字段 | 允许的运算符 |
| --- | --- |
| 所有类型 | isEmpty、isNotEmpty |
| text | eq、ne、contains、notContains、startsWith、endsWith |
| number/date | eq、ne、gt、gte、lt、lte、between |
| select | eq、ne、in、notIn |
| multiSelect | hasAny、hasAll、hasNone |
| checkbox | eq、ne |

每个运算符严格要求其 DTO 的参数，禁止额外 `value`、缺参数或类型不匹配；选项参数只接受现存 optionId，集合参数非空且无重复。between 两端同类型、包含边界且 lower <= upper。筛选值不能为 null；查询空值使用 isEmpty。

`isEmpty` 对缺省/null、文本 `""` 和多选 `[]` 返回 true，其他值包括 `0`/`false` 都为 false。普通比较对缺省/null 返回 false，**包括 ne/notContains/notIn/hasNone**，避免空值被隐式当成不同值；空多选数组是已设置集合，hasNone 对它为 true。空文本正常参与文本运算。无条件过滤器匹配全部记录，包括 operator 为 or 的空过滤器。

文本匹配区分大小写、无 Unicode 归一化；排序按 Unicode 码点序，不用宿主区域 Collator 或 JS UTF-16 默认比较。数字按数值、日期按日历日、checkbox 按 false/true；select 按 options 顺序，multiSelect 按已选选项序号排序形成的元组字典序。缺省/null 不受方向影响始终排最后；同值按后续 sort，全部相同时按根 recordOrder 稳定排序。`""`、`[]` 保持真实值，不与 null 合并排序。

分组 key 包含字段类型和值，null 与空字符串分开；组选项顺序遵循上述升序规则，组内遵循视图 sorts。每个记录在投影中恰好出现一次。输出为 `recordIds` 与 `{ key, start, count }[]` 分组段，不把分组标题伪装成记录 ID。投影响应附原 generation 与 viewId，调用方丢弃过期响应。

## 3. 最小领域操作与撤销

```ts
type CellEdit = { recordId: RecordId; fieldId: FieldId; value: CellValue }
type NewRecord = { id: RecordId; values: Record<FieldId, CellValue>; createdAt?: Timestamp }
type TableMutation =
  | { type: "setCells"; cells: CellEdit[] }
  | { type: "insertRecords"; records: NewRecord[]; beforeRecordId: RecordId | null }
  | { type: "deleteRecords"; recordIds: RecordId[] }
  | { type: "setRecordOrder"; recordIds: RecordId[] }
  | { type: "putField"; field: TableField; beforeFieldId: FieldId | null }
  | { type: "deleteField"; fieldId: FieldId }
  | { type: "setFieldOrder"; fieldIds: FieldId[] }
  | { type: "putView"; view: TableView; beforeViewId: ViewId | null }
  | { type: "deleteView"; viewId: ViewId }
  | { type: "setViewOrder"; viewIds: ViewId[] }

type ApplyTableMutationsRequest = {
  path: string
  tableId: TableId
  expectedRevision: number
  expectedHash: Sha256
  mutationId: MutationId
  operations: TableMutation[]
}
type ApplyTableMutationsResult = {
  tableId: TableId
  path: string
  mutationId: MutationId
  baseRevision: number
  revision: number
  contentHash: Sha256
  updatedAt: Timestamp
  changedRecords: TableRecord[]
  deletedRecordIds: RecordId[]
  changedFields: TableField[]
  deletedFieldIds: FieldId[]
  changedViews: TableView[]
  deletedViewIds: ViewId[]
  fieldOrder?: FieldId[]
  recordOrder?: RecordId[]
  viewOrder?: ViewId[]
}
```

- 一个 request 是一个事务；operations 按顺序作用于内存副本，最后验证整个文件，再一次落盘。常规编辑不回传整表，回传所有被直接/间接修改的实体与顺序；删列可能涉及全部 records，不能只回传字段而让前端保留旧值。
- 单个 setCells 不允许重复 `(recordId, fieldId)`。不同 op 可以有显式先后依赖；同一个逻辑手势只产生一个撤销步骤。操作不能以视图行号定位目标。
- insertRecords 的 ID 必须尚不存在；beforeRecordId 为 null 表示追加，否则为现存记录。NewRecord.createdAt 仅用于撤销删除/受控导入保留时间，缺省由后端生成；updatedAt 为本批保存时间。不允许插入触发隐式覆盖。
- deleteRecords 只接受现存且不重复的 ID，删除对应 values 与根顺序；不级联写别的表。M1 恢复是同会话 Undo 或整表历史/文件回收恢复，不增加跨会话记录回收站。
- putField 是完整定义的新建/替换。新字段按 beforeFieldId 插入根顺序，并追加到每个视图字段顺序、默认可见。更新已有字段时 beforeFieldId 必须为 null，且不改变顺序；重排用 setFieldOrder/putView。类型变更的空值条件在该操作执行前检查。
- deleteField 禁止主字段；同时删除所有记录对应键、根/视图顺序、hidden/width 配置、引用该字段的过滤条件和 sorts，并将该字段 groupBy 置 null。过滤条件清空后按“不过滤”处理；一次整体 Undo 恢复原字段、values 与完整受影响视图。
- putView 新建完整视图或替换已有配置；新建 beforeViewId=null 表示追加，更新已有时必须 null。deleteView 不能删除最后一个视图。set*Order 始终为当前实体全集的完整排列。
- 操作中的引用必须在该时刻存在（例如先插行再 setCells）；最终值/配置一致性在全批完成后检查，允许同批移除选项并修正原值。批次失败不更新 revision、时间戳或任何磁盘数据。
- 后端为本批创建/修改的记录统一生成 updatedAt；纯视图修改不刷新记录时间。无内容差异的非空批次仍落盘增加一次 revision，记录 mutation 身份；客户端应在入队前去掉无操作手势，后端不以不写入来破坏幂等确认。
- Undo 由客户端记录手势前后差异，用相同 op 提交逆向修改，**基于最新确认的 hash/revision**。事务的原子性不等于多个 IPC 请求之间有事务；不能把大批粘贴切成多个已保存批次后仍声称原子。

## 4. 创建、读取与结果未知

```ts
type CreateTableRequest = {
  requestId: RequestId
  tableId: TableId
  parentPath: string // notes 或公开 notes 子目录
  suggestedName: string
  content: TableContent // 空表也显式提供主字段、默认视图与预分配 ID
}
type ReadTableRequest = { path: string; expectedTableId?: TableId }
type SaveTableCopyRequest = {
  requestId: RequestId
  tableId: TableId // 新分配，不能等于 source.tableId
  parentPath: string
  suggestedName: string
  source: { tableId: TableId; revision: number; contentHash: Sha256 }
  content: TableContent // 显式保留的草稿；不用 source.path 读取旧内容替代
}
```

create_table/save_table_copy 均返回 TableReadResult。新文件 revision=1、lastMutationId/hash=null，table 时间戳由后端生成。导入确认、新建表、保留副本使用相同创建协议，包含完整冻结 content；复制不把 source 的 creation/lastMutation/revision 当成新表元数据。

所有命令为 async，重操作放在 `run_blocking` 或等价后台；拿到 vault 后，写命令立即持 `lock_vault_gate`，路径与身份、幂等检查、内存操作和原子替换都在门内。公开 notes 路径使用 canonical 边界和符号链接校验；缺失/删除的文件不能由 apply 重建。未完成 Git 操作时停止内容写入，保留草稿。

创建幂等顺序：先定位预分配 tableId 和 requestId，再验证冻结 payloadHash；同身份同 payload 返回现存结果、同身份不同 payload 报 IDEMPOTENCY_CONFLICT。若文件已移动，返回实际新 path；若身份在回收站，报 TARGET_IN_TRASH，不能又新建。仅在确定身份未创建后执行文件名避让。核对创建身份是低频后台目录操作，可借助可失效 ID→path 缓存；不能把它复制到每次单元格保存中。

创建响应丢失时可使用同一冻结请求再次调用创建命令，由后端完成核对后返回。若期间文件已被永久删除、vault 已切换或并发外部状态无法确定，则停止自动重试并保留原请求，让用户决定恢复/重新创建；M1 不引入永久幂等请求账本，也不承诺 purge 后还能识别历史请求。

保存顺序：确认 target 身份 → 检查 expectedRevision/hash → 应用 op → 全量验证 → 确定性序列化与容量校验 → 同目录临时文件写/fsync/rename → 返回变化。保存最后一批 mutationId 与后端生成的操作 payloadHash。同 mutationId 不同 payload 报 IDEMPOTENCY_CONFLICT；若收到已应用的同 ID/hash 重试，不再应用而报 ALREADY_APPLIED，调用方 read 并对齐完整快照，不伪造当前基线的增量响应。

结果未知处理：暂停该表发送队列，保留请求与后续草稿 generation；read_table 读取实际文件。lastMutationId 命中、lastMutationHash 为合法非空 hash，且业务快照与该批预期结果相同，才视为成功并接受新完整基线；客户端不计算后端 payloadHash，hash 的精确匹配由后端同 ID 重试校验。排除后端生成的 revision/lastMutation/时间戳比较，但不能排除字段、值、顺序、视图等业务数据。随后重放尚未发送的局部手势。只命中 ID 而业务内容不同进入冲突。若仍是请求原 expectedHash/revision，则可用**同一** mutationId/op 重试；其余状态均冲突，不盲目重发。

hash 只检测已发生的外部变化；gate 只协调本应用，不对外部编辑器承诺跨进程 CAS。冲突不写原件，提供保留草稿/另存副本/载入磁盘；不能默认覆盖。接受外部完整版本后清理旧 undo/redo。正常导航、结构操作、同步、检查点、退出先确认活动单元格再 flush；强退只保证已确认落盘的内容。

文件名 rename/move/delete/restore/purge 继续使用现有结构命令、前置 checkpoint 和路径级语义提交。创建/表内容修改不内嵌 Git commit。临时文件不进入托管提交快照；失败清理和崩溃残留识别由正式 MT1 验证。

### 4.1 错误 DTO

```ts
type TableError = {
  code:
    | "INVALID_JSON" | "DUPLICATE_KEY" | "UNSUPPORTED_VERSION"
    | "INVALID_MODEL" | "INVALID_VALUE" | "INVALID_FILTER"
    | "LIMIT_EXCEEDED" | "INVALID_PATH" | "NOT_FOUND" | "TARGET_IN_TRASH"
    | "IDENTITY_MISMATCH" | "DUPLICATE_TABLE_ID" | "STALE_BASE"
    | "IDEMPOTENCY_CONFLICT" | "ALREADY_APPLIED" | "GIT_BUSY" | "IO_ERROR"
  message: string
  pointer?: string // JSON Pointer；例如 /records/rec_.../values/fld_...
  operationIndex?: number
  recordId?: RecordId
  fieldId?: FieldId
}
```

错误通过结构化 invoke 错误传递，前端不能只按中文句子猜语义。IO_ERROR 与连接中断不等于“未写入”，必须进入结果核对。批次校验错误已知未写入，无须伪造重试。schemaVersion 未知优先返回 UNSUPPORTED_VERSION，其余字段无需用旧版反序列化器强行读取。

## 5. 容量候选与共同 fixtures

以下数字用于 MT0 原型，**不是已支持容量或已完成性能验收**。通过测量再锁定，不允许静默降低执行计划 B 样本要求。

| 维度 | MT0 候选上限 |
| --- | --- |
| 单表行数 | 10,000；50,000 仅压力探索 |
| 字段数 | 128；`max(1, rows) * fields <= 300,000` |
| 表 JSON 文件 | 64 MiB UTF-8，包括元数据/格式空白；读取前检查字节数 |
| 单元格文本 | 16,384 Unicode 码点，同时受整文件字节上限约束 |
| 字段名/视图名/选项标签 | 128 Unicode 码点；表文件名沿用现有路径约束 |
| 每字段选项 / 单元格选项 | 256 / 256 |
| 视图 / 每视图条件 / 排序字段 | 32 / 64 / 16 |
| 一次 mutation request | 64 operations、50,000 个显式 cell 值、16 MiB 请求字节 |
| 创建 request | 64 MiB；仍受最终文件字节上限约束 |

删列/删行等领域 op 可以隐式影响更多单元格，最终全量校验与写盘在后台；不能因 50k cell 限额而把一次 deleteField 拆多次提交。大粘贴超过候选容量时提交前明确报错；不截断、不先写前半份。读取、创建、修改、导入、Worker 数据集生成共用一组常量。前端必须测大对象 IPC/structured clone 对 UI 的实际影响。

fixtures 清单见 manifest.json，包含完整合法/非法文件和投影预期。重复键 fixture 保留原始文本，必须从字节读取，不能先 parse/重新 stringify。非法 fixture 由正常文件只改一项，测试断言 code+pointer（重复键只断言明确层级）；fixtures 不模拟“验证函数返回自己写入的对象”，而覆盖实际 wire 输入边界。

MT0 的 A/B/C 规模样本由原型按确定性 seed 生成，不提交 50k 行大文件。A=1k×20，B=10k×30，C=50k×30；混合中文、长文本、空值、六种类型。需要记录机器/构建方式与读取、clone/IPC、过滤排序、批量保存 p95，不能把本契约编写完成写成性能通过。
