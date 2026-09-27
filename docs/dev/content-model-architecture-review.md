# 内容模型架构评审（2026-09-28）

评审对象：`e4600ea` 对 [产品框架](product-framework.md) 的修订（大纲改存导图 JSON、流程图资源化、入口 md、四种 type、自定义属性、路线图 G/H）。

来源：ChatGPT Pro（6 Pro 档）一轮评审（[会话](https://chatgpt.com/c/6ab957b1-53c4-83ea-864b-bc3fed48eeda)），源码经只读工作区连接器（`workspace: shard`）读取，未打包 ZIP、未读取用户 vault。Claude 对照本地源码逐条核实；下表只收录核实过的结论。

状态：评审完成；**容器方案 A/B 待用户裁决**（§2）。

## 1. 结论

- 保留四项已定决策：大纲存 JSON、大纲与导图是同一份 JSON 的两个视图、导图和流程图进入时间线并能打标签和属性、自定义属性。
- 「大纲用 JSON」和「一个条目用两个文件」是两件事，应分开裁决。评审推荐 **B：单篇 md，frontmatter 放标签和属性，正文是唯一一个受管 JSON 区域**；A（入口 md + 旁路 JSON）可行，但现有计划低估了它需要的成组事务、恢复和加密协议。Claude 同意推荐 B。
- 无论选 A 还是 B，都要先做三件事：真正的 G-P0（保真读写合同）、隔离旧迁移、建立覆盖完整文件的保存基线。

## 2. 候选容器对比

| 方案 | 收益 | 代价 | 工作量 |
| --- | --- | --- | --- |
| A 入口 md + `maps/<id>.shardmap.json` | 原生 JSON 可直接给 Agent、jq；复用现有导图文件 | 一个条目两个文件：创建、删除、恢复、转私密、冲突副本、备份、同步都要成组；需要持久化操作记录、幂等、孤儿判定 | 高 |
| **B 单篇 md，正文是受管 JSON 区域** | 元数据和图内容共用一个物理保存边界；回收站、密匣、Git、同步沿用 md 链路；两个视图照样编辑同一份 JSON（`mind-map-workspace.tsx` 已共享 `draftFile`） | md 正文不宜直接阅读；要有专用区域解析器，普通 Markdown 提取器、Tiptap、搜索不能按普通正文处理它 | 中 |
| C JSON 自带元数据，直接进时间线 | 单文件，模型直接 | 时间线、属性、私密、回收站、关系、导出都要支持第二种一等载体；丢掉 md properties 互通 | 高，不推荐 |

B 的约束（采纳时写入框架）：

- 独立大纲和流程图的 md 里只能有**一个**受管 JSON 区域；零个、多个或损坏时显示格式问题并停止自动保存，不猜。它和碎片里的 ```` ```mindmap ```` 小树是两种东西，不能送进 Tiptap 代码块、Markdown 美化或小树解析器。
- 保存方式是「读取当前完整文件 → 只替换受管区域 → 原子写回」，基线校验覆盖完整文件；图编辑器不能拿旧的 frontmatter 重建整篇 md。
- 外部写入的其他正文原样保留，不在图编辑器里编辑。
- 导出的 `.shardmap.json`、缩进列表、SVG 都是派生产物，不能和 md 里的 JSON 同时充当权威。
- 单文件省掉的是双文件事务，不是一切问题：原子替换、并发校验、幂等、索引失效、跨设备冲突仍要处理。

## 3. 已核实的现状缺口

| 级别 | 问题 | 位置（核实结果） |
| --- | --- | --- |
| 阻塞 | 未知 frontmatter 键被丢弃：固定 struct 反序列化后整体重写 | `crates/shard-core/src/lib.rs:45`、`src-tauri/src/lib.rs` `parse_fragment_text`、`write_fragment_file`（确认） |
| 阻塞 | 密匣写入按字段子集重建 frontmatter，且把 `related` 置空；只加 `extra` 不够 | `src-tauri/src/lib.rs` `write_lockbox_fragment_file` 约 5108 行（确认） |
| 阻塞 | 转换路径自己调用 `serde_yaml::to_string` 拼文件，绕过核心 writer | `convert_fragment_file` 约 3882 行（确认） |
| 阻塞 | 保存基线 `expected_sha` 只覆盖正文，frontmatter 的并发修改检测不到；标签由前端 DTO 整体覆盖 | `update_fragment` → `ensure_expected_content_sha(current_body…)`（确认） |
| 阻塞 | 旧迁移把 `maps/` 下所有合法导图搬进 `notes/`，每次资料库准备都会跑；A 方案的新文件会被搬走 | `migrate_legacy_mind_maps_in_vault` 4057 行，由 `migrate_legacy_notes` 调用，前端 `workbench-shell.tsx` `prepareLibraryTree`（确认） |
| 迁移前置 | 结构操作前的检查点失败只打日志，不阻止后续操作，不能当作可回滚保证 | `checkpoint_before_structural_locked` 6066 行（确认） |
| H 前置 | 大纲预览解析上限 200 节点，后端导图上限 400；拿预览解析器做迁移会截断 201–400 节点的图 | `mind-map-outline.ts:9`、`SHARD_MAP_MAX_NODES` 65 行（确认） |
| H 前置 | 导图保存先写主文件再写 last-good，后者失败会出现「已保存但报错」；流程图已是先备份再发布 | `write_mind_map_in_vault` 1533 行（确认） |
| H 前置 | 流程图公开路径只允许 `notes/` | `canvas_commands.rs` `public_path` 178 行（确认） |
| H 前置 | 回收站移动与恢复是单路径操作且各自提交 Git；清空回收站按顶层目录区分 | `move_to_trash_in_vault` 3589 行、`empty_trash_in_vault` 3687 行（确认；A 方案受影响最大） |
| 文档 | 导图 schema 只有 `tone` 颜色、备注、折叠、宽度、文档链接，没有关联线和概要；框架 §2 写多了 | `ShardMapNode`、`ShardMapNodeStyle` 375–398 行（确认，已修正框架） |
| 文档 | 围栏块命令早已改名「导图块」，框架 §11 的命名问题已过时 | `registry-ui.tsx:146–148`（确认，已修正框架） |

## 4. 大纲离开 md 的补偿

- **迁移不能用预览解析器。** 保留轻量预览解析器，另写正式导入器：完整扫描、上限明确，遇到无法表示的段落、代码块、链接或超限节点时报告损失并停止，不静默生成更小的图。
- **CLI 分三类接口**：原生 JSON 读写（完整交换，写入校验基线）；缩进列表导出（只读投影，不承诺往返）；按节点 ID 的结构化修改（Agent 改指定节点）。「导出缩进列表 → 编辑 → 导入」只能作为显式的有损替换，先展示损失清单。现有 CLI 只有快捷创建。
- **搜索做图内容投影**：标题、节点文字与备注、流程图连线标签、节点链接、入口标签和属性；结果以条目为单位，不索引 JSON 键名、坐标和 ID。
- **稳定键序只改善 diff，不解决合并**：合并后要验证 ID 唯一、父子关系、根数量、无环、排序和连线端点；没有语义合并器前保留完整冲突版本，不取最后写入者。视口和选区不改节点更新时间。
- **schema 演进**：现为 `schemaVersion: 1` 且 `deny_unknown_fields`；UI 要把「版本不支持」显示为只读，不能走读取失败后新建空文档的路径。新增关联线、概要要升版本。
- **`/大纲` 提交**：完整解析和校验 → 幂等创建（稳定操作 ID）→ 返回正式 ID、内容和修订 → 清草稿 → 用同一份内容打开编辑器。失败保留草稿，不先建空 md 再补图。

## 5. 自定义属性

- **G-P0 正式路线**：保留原始 YAML 文本，用保格式语法树做局部修改；`#[serde(flatten)] extra` 只能作为止血补丁，不能叫「原样保留」。遇到无法安全局部修改的表示时拒绝写入、保留原文件，不回退到有损的整体序列化。写入改为明确的操作（设置置顶、改一个属性、替换正文），不从 UI 回传的整个 Fragment 重建。
- **一起收口的路径**：核心库读写入口；`update_fragment`、`update_fragment_tags`、`link_fragments`、`unlink_fragments`、`set_fragment_pinned`；`convert_fragment_file`；密匣载荷（改存原始 frontmatter 文本，新载荷带版本）；前端 `splitFrontmatter`（会把 CRLF 归一化，已核实）；CLI；搜索只消费投影。
- **YAML 库**：`serde_yaml` 已于 2024-03-25 归档（已核实）。候选：`yaml-edit` 0.3.2 做保格式编辑，`serde-saphyr` 1.3.0 做类型化解析（两者存在已核实；本地 rustc 1.93.1 满足 serde-saphyr 的 1.89 要求）。未在 Shard 样本上验证，先写保真测试再定；业务代码只调用 Shard 自己的 frontmatter 合同。serde-saphyr 要显式开 `strict_booleans`。
- **值保真合同**：未登记属性保留原值和原表示；日期不加时区；无偏移的日期时间按本地未指定时区处理；数字不经 JS number 往返；`"00123"` 不因登记为数字变成 123；`x`、`[x]`、`[]` 是不同值；缺键、null、空串、空列表分别保存；新写布尔用 `true/false`；嵌套值先不给编辑 UI，但必须保留。类型不符的值不参与正常比较。
- **`.shard/properties.json` 是解释规则，不是值的真相源**：缺失、损坏、冲突都不能删改 frontmatter 的值；多设备按属性定义合并，同名不同类型保留冲突待裁决。改显示名不动文件；改存储键是可恢复的全库迁移，第一版先只支持改显示名。
- **Obsidian 互通**：Obsidian 属性类型没有 link；`types.json` 走显式导入导出，不互相后台覆盖。
- **私密边界**：属性名本身可能敏感。私密条目新建的属性名进入公开的 `properties.json` 前要让用户知情，或给密匣单独的加密类型配置。

## 6. 路线顺序

G-P0 止血与读写合同 → G/H 共用前置合同 → H → G-P1 → G-P2 → G-P3。

共用前置合同：系统保留名的闭合清单；受保护 type 的读写与冲突规则；原文保留与字段级更新接口；完整保存基线与共享写协调器（GUI、CLI、迁移共用）；条目 ID、载荷与私密边界；registry 最低版本合同；隔离或版本化 `maps → notes` 旧迁移。选 B 时 H 可相对独立推进；选 A 时成组恢复协议是 H 的一部分。

旧数据迁移：默认不因打开文件而改格式，先出预检报告；用正式导入器；保留原文件字节与哈希；失败不改原篇；只有目标仍是迁移生成版本时才自动回滚。迁移前要求已确认成功的检查点或独立备份。`notes/` 下旧 JSON 保留旧图 ID 和节点 ID，保留创建时间，兼容 `shard://map|flow` 链接。

## 7. 待本地验证

frontmatter 全路径保真（注释、引号、嵌套、大数、日期、空值、列表、重复键、BOM/CRLF）；YAML 库在工具链与样本上的表现；GUI、CLI、Agent 并发写；A 方案的故障注入；旧迁移隔离与 201–400 节点不截断；外部移动、删除、复制导致的重复 ID；私密完整性（last-good、冲突副本、回执、索引、编辑器缓存无明文残留）；检查点失败不当成功；多设备 registry 冲突；输入法与保存中继续输入；Obsidian 目标版本的实际互通。

## 8. 附注

- `docs/design/*` 被 `.gitignore` 忽略（`.gitignore:45`），连接器读不到 `commit-coalescing-plan.md`、`sqlite-index-plan.md`，这两份文档也不在 Git 里。
