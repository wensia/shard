# Shard 图形工作台任务清单

> 2026-09-07 架构调整：混排目标已被用户修订为独立图文档，当前实施规则见 [图文档分离计划](diagram-document-separation.md)。下文保留历史实现与验收记录。

更新：2026-09-07。范围：本地实现与验证；保留当前未提交的表格、资料库、Kiln 改动，不提交、不部署，不改真实 vault 数据。

## 目标与取舍

资料库里的画布文档支持流程图、只读资料引用、结构化导图混排。Shard 拥有文档语义、撤销和保存；React Flow 只承担画布交互。借鉴 Plait/Drawnix 的结构化对象分工、Excalidraw 的操作粒度、NoteGen 的资料引用体验，不复制 GPL 源码。不做多人协作、自由手绘、卡片内修改源文档、通用插件平台或旧导图覆盖迁移。

同一画布只有一份草稿、一套历史和一个串行保存入口。普通连线不改变树；整棵树自由摆放，树内坐标从 parentId/sortKey 推导。引用保存已有 ShardDocumentLink，不复制正文成为另一份权威数据。新建的片段和笔记引用统一保存稳定的来源 ID，移动、重命名不会改变指向；找不到来源时展示缺失状态。兼容格式中的纯 markdownPath 引用只能按路径解析，不能识别路径复用，初版选择器不生成这种引用。打开源文档须先通过保存门禁。

## 分阶段任务

- [x] C1 数据契约：自有版本化文件、节点/边验证、树与普通边隔离；单元测试覆盖非法输入、删除清理、树编辑、历史粒度。
- [x] C2 本地存储：notes/*.shardcanvas.json；异步后台 I/O；vault gate；revision/hash 冲突、原子写、last-good、冲突副本；内容写不内嵌 Git 提交。
- [x] C3 流程画布：新建流程/判断/起止/文本、拖拽、多选、删除、连线及标签、编辑文字、缩放平移、撤销重做；保存中继续编辑不丢更新。
- [x] C4 资料库与引用：新建/打开/预览、只读片段和笔记卡片、跳回原文、缺失状态；复用生命周期路径；离开前 flush，失败阻止导航。
- [x] C5 导图混排：新建结构化导图、现有导图导入副本、树内编辑/折叠/子节点和同级操作、整树移动；父子线只从树派生，共享画布历史。
- [x] C6 自动化与原生存储验收：相关 TS/Rust 测试、pnpm build、cargo check、git diff --check、pnpm test:ui；真实计算样式、Tauri/WKWebView 中文文字编辑、临时 vault 保存与进程重启后重开。
- [ ] C7 人工桌面验收：真实输入法候选窗口、物理触控板手势、原生大画布性能。自动化接口不能替代物理输入；首版尚不宣称这些项目通过。

## 数据契约 v1

文件 `kind: "shard.canvas"`，`schemaVersion: 1`，元数据 `id/title/createdAt/updatedAt/revision`，内容 `nodes/edges`。

节点：`id/kind/x/y/text`，可选 `width/height/link/mindMap`。kind 为 `process | decision | terminal | text | reference | mindmap`。reference 必须有公开 ShardDocumentLink；mindmap 必须包含独立 ShardMapFile 副本。mindMap 的内部元数据不作为画布保存版本，画布 revision 是唯一保存依据。节点坐标为画布坐标；内部导图坐标不重复落盘。

边：`id/source/target/label`，可选 `sourceHandle/targetHandle`（top/right/bottom/left）。端点仅指顶层节点；流程允许回路，导图父子边不存入此数组。删除对象时一起删除关联边。

边界：最多 400 个顶层节点、1600 条边、总计 2000 个包含导图内部节点的可视内容节点、单个导图沿用 400 节点上限、文件最大 8 MiB。初版用这些明确限额控制序列化和布局成本，不宣称大规模性能通过。

Tauri 命令：`create_canvas(parentPath, title, file)`、`read_canvas(path)`、`write_canvas(path, file, expectedRevision, lastSavedHash)`；返回 `{file,path,lastSavedHash}`。结构化错误采用字符串，冲突包含“冲突”及已保留副本路径。创建采用 file.id 防重复请求，并核验目标目录。读写限定公开 notes 路径、拒绝符号链接/路径穿越/格式与身份不匹配。

## 验证分层

1. 纯模型：引用不改正文；删除/撤销恢复节点与边；树层级不受流程线影响。
2. 保存：串行请求；保存期间的新编辑、撤销、导航；错误不自旋，保留草稿；Rust 临时 vault 原子写/冲突/重读/路径隔离。
3. 浏览器：真实编辑器 + 明确标记的 Tauri mock；编辑、连线、混排、引用、保存门禁、计算样式。mock 不当作文件系统或桌面证据。
4. 原生：临时 vault、不切换现有用户配置；构建的 Tauri/WKWebView 上验证中文输入、缩放平移、保存重启。无法取得的证据明确标注待验收。

## 执行记录

### 无限画布细节优化（2026-09-07）

- [x] 统一节点选中与编辑轮廓；移除内嵌输入框重复边框和浏览器缩放手柄，保持文字与连接点位置稳定。
- [x] 检查流程、判断、起止、文本、导图、引用的默认／选中／编辑状态，修正形状、连接点和连线标签反馈。
- [x] 修正多选框配色、选区与侧栏语义、Escape 清选、连续新建遮挡、缩放读数与边界状态。
- [x] 按实际画布容器处理窄布局，保证矮窗口侧栏内容可访问；浏览器真实计算样式与隔离原生视觉检查。
- [x] 专项回归、完整 UI 回归、构建及差异校验，记录原生和浏览器证据的边界。

本轮将文字显示层作为节点尺寸的依据，编辑层共用相同字体、换行宽度与中心位置；只有对象外壳表达选中／编辑／键盘焦点。判断节点使用菱形 SVG 轮廓，不叠矩形框。连接点在悬停、选中、键盘焦点和连线期间显示，连线与箭头、框选与多选组框统一消费当前主题 token；组框不覆盖内容底色。连线标签输入即时投影，导图节点可用键盘进入编辑。

新建按已测量对象矩形寻找附近空位，空间不足时保持缩放比例并平移到新对象；不重新排列既有内容。大型导图导入先等待既有 Worker 的实际布局，再插入和提交一次历史，布局失败不产生半成品。多选不再打开任一单对象面板，Escape 可清空选区；缩放区展示实际百分比、恢复 100% 和上下限禁用状态。

窄布局以实际画布容器为判断依据，440px 工作区不会再被面板挤为窄缝。矮窗口侧栏可滚动，大纲保留至少三行高度，底部删除按钮可到达。独立 WebKit 复核记录见 `tests/evidence/canvas-polish-review.json`，截图为 `tests/evidence/canvas-polish-webkit.png` 和 `tests/evidence/canvas-polish-import-webkit.png`。

原生复用独立应用 `dev.shard.multidrag-acceptance-20260907` 与临时 vault，实际核对新建流程单层边框、多行编辑与结束编辑位置稳定、判断节点编辑保持菱形、保存重新打开。文件 revision 11，四个对象；原有真实资料库未操作。证据见 `tests/evidence/canvas-polish-native.json`。原生检查通过可访问性接口输入中文，不替代物理输入法、触控板与大画布性能验收。

最终验证：新增 `tests/ui/canvas-polish.spec.ts` 的 10 项 WebKit 专项通过；`pnpm test:ui --workers=4` 共 200 项通过（1.4 分钟）；`pnpm build` 与 `git diff --check` 通过。构建只保留原有 Glide PURE 与主 chunk 大小提示。独立复核还验证了导入布局失败时节点、写入与撤销重做历史均保持原状。

### 导图键盘协议（2026-09-07）

- [x] 核对 XMind 官方 Topic / Text / 折叠说明，分清选中态命令与文字编辑态。
- [x] 移除 SVG 节点与画布重复处理 Enter 的逻辑；画布和大纲单击均只选中，首次 Enter 直接创建后同级。
- [x] 补齐前插同级、父级插入、方向导航、折叠、同级排序、编辑入口及焦点恢复，复用现有纯树模型与画布历史／保存。
- [x] 树模型与 WebKit 键盘回归、既有 UI 回归、构建、原生隔离检查与差异校验。

快捷键只在导图选中范围内解释，不抢工具栏按钮、搜索框或其他表单的 Enter / Tab；方向键与空格不会继续冒泡为 React Flow 的对象移动／平移。新节点默认文字被选中，可直接输入替换；已改名的节点用空格进入时光标在文字末尾。新建、导航和删除后的焦点均回到明确节点，必要时只平移画布视口以显示目标。

| 状态 | 按键 | 行为 |
| --- | --- | --- |
| 选中节点 | Enter / Shift+Enter | 在当前节点之后／之前创建同级；根节点创建分支 |
| 选中节点 | Tab | 创建子节点；折叠父节点先展开 |
| 选中非根节点 | Cmd/Ctrl+Enter | 插入父节点，保留原位置和整个子树 |
| 选中节点 | Space / F2 / 双击 | 进入文字编辑；F2 为兼容键 |
| 选中节点 | 直接输入字符 | 替换文字并进入编辑 |
| 选中节点 | ← / → / ↑ / ↓ | 父／子／上同级／下同级；→ 先展开折叠节点 |
| 选中节点 | Cmd/Ctrl+/ | 折叠／展开非根分支 |
| 选中节点 | Option/Alt+↑↓ | 调整同级顺序 |
| 选中节点 | Cmd/Ctrl+R | 返回中心主题 |
| 选中非根节点 | Delete / Backspace | 删除节点及子树；加 Cmd/Ctrl 只删除节点并提升子节点 |
| 编辑文字 | Enter / Tab | 提交当前文字并继续创建同级／子级（沿用本项目连续录入约定） |
| 编辑文字 | Shift+Enter | 换行，不创建节点 |
| 编辑文字 | Escape / Cmd/Ctrl+Enter | 结束编辑、保留选中；之后 Escape 清选 |
| 画布 | Cmd/Ctrl+0 / + / − | 恢复 100%／放大／缩小 |

来源：[XMind Topic](https://xmind.com/user-guide/topic-editing-new)、[Text](https://xmind.com/user-guide/text-new)、[官方快捷键文章](https://xmind.com/blog/shortcuts-in-xmind-that-improve-mapping-efficiency)、[折叠文档](https://xmind.com/user-guide/fold-unfold-subtopic-new)。只对齐现有导图能力的核心键位，不声称完整复刻 XMind。编辑态连续录入、方向导航和删除焦点沿用本项目已有交互约定；官方文档没有完整定义这些状态转换。中文组合输入期间不触发结构命令，合成 composition 回归不能替代物理输入法验收。

验证补充：新增 `tests/ui/canvas-keyboard.spec.ts` 五项 WebKit 专项，含单击一次 Enter、SVG/大纲统一键位、连续录入、结构／排序／删除与撤销重做、门户菜单事件隔离。模型新增 `src/lib/mind-map-tree.test.ts` 十二项，覆盖前插顺序、插入父级、输入不可变与导入数据极端排序键。普通按钮与门户菜单保留原生键盘协议，避免 Escape 后残留遮罩。

原生独立应用中已真实执行：单击已有子节点，按一次 Return 即新建后同级；Escape 保留选区，↑ 切换同级，Space 编辑正文，Tab 新建子节点；保存重开后两个新增节点的父子关系正确，全部外层对象坐标与之前隔离夹具一致。文件 revision 15，导图从两个节点变为四个节点，证据为 `tests/evidence/canvas-keyboard-native.json`。真实资料库未操作。

最终 `pnpm test:unit` 266 项、`pnpm test:ui --workers=4` 205 项、`pnpm build`、`git diff --check` 均通过。修正旧视觉用例的新建菜单聚焦等待后，四类节点编辑专项连续三轮共 12 项通过，再跑全量 UI 205 项通过。

### 内嵌导图文字垂直居中（2026-09-07）

- [x] 复用既有导图编辑器的实际字形测量，为每行 SVG 文字设置明确基线，修正无限画布内根节点、子节点及多行文字偏上。
- [x] 从现有 Kiln 样式读取字体、字号和字重；字体加载完成后清理旧测量缓存并重新定位，即使字体族字符串未改变也会更新。
- [x] 保持节点尺寸、坐标、字号与行距；原生独立窗口核对中文和中英混合文字在 100% 与 173% 缩放下的视觉位置。
- [x] WebKit / Chromium 实际截图墨盒、缩放与延迟字体专项；既有完整 UI 回归、构建与差异校验。

新增 `tests/ui/canvas-text-center.spec.ts` 四项通过，使用整页截图与节点实际坐标扫描字形墨盒，覆盖中文、英文、中英混合、自动三行文字在 48% / 100% / 207% 缩放下的中心误差不超过 1 CSSpx；另用延迟加载的真实 WOFF2 检查相同字体族字符串下的缓存刷新。相同像素检查能检出旧 DOM 基线逻辑的中文偏上约 4.39px；修后 100% 样本误差为 0.11–0.86px。证据为 `tests/evidence/canvas-text-center-review.json` 和 `tests/evidence/canvas-text-center-webkit.png`，均明确为浏览器 mock 层。

验证结果：既有 `pnpm test:ui --workers=4` 205 项通过，新增字体专项 4 项通过；`pnpm build`、`git diff --check` 通过。构建保留原有 Glide PURE、Tauri window 导入方式与主 chunk 大小提示。

原生检查使用既有隔离应用和临时 vault，只读核对既有四个对象，文件 revision 仍为 15；检查后恢复 100% 缩放并退出隔离应用。证据为 `tests/evidence/canvas-text-center-native.json`，它记录原生截图目视检查，不冒充像素测量或真实用户资料库导航验收。

### 上下文属性侧栏（2026-09-07）

- [x] 核对 XMind 主题格式面板、大纲视图和 draw.io 上下文属性面板，按现有 Kiln 规范落实分区。
- [x] 导图拆为「属性 / 大纲」line tabs；固定标题、标签和常用操作，内容单独滚动；侧栏收窄，窄画布浮出显示。
- [x] 收起面板保留对象、主题选择和已输入内容；工具栏持续提供恢复入口，编辑命令可重新打开属性页。
- [x] 接通现有主题强调色和宽度字段，即时渲染并复用画布历史／保存；流程文字、连接线标签、资料引用与空选／多选呈现各自上下文。
- [x] 大纲采用紧凑层级行、独立展开折叠和画布定位；删除、前插、父级插入及排序收进更多主题操作菜单。
- [x] 回归新建与编辑焦点、菜单、宽度选择器原生键盘行为、组合输入切页门禁和窄矮窗口；浏览器计算样式及隔离原生检查。

借鉴的是工作区组织与操作语义：[XMind 主题格式面板](https://xmind.com/user-guide/topic-editing-new)、[XMind 独立大纲模式](https://xmind.com/user-guide/outliner-new)、[draw.io 上下文面板及收起恢复](https://www.drawio.com/docs/manual/editor/panels/format-panel/)。Shard 将属性和大纲作为内嵌导图的两个侧栏视图，保留已有画布混排方式；未扩展字体、任意颜色、结构类型等新的文件字段，也不宣称完整复刻 XMind。

「关闭」现在只控制面板可见性，不再清空选区。切页／收起先完成当前文字提交，组合输入期间保持编辑器；从大纲或已收起的画布触发 Enter / Tab / Space / F2 会打开属性并恢复正确焦点。原生 select 和其他表单控件保留自身按键协议。大纲点击仅平移 React Flow 视口，计算可见区域时排除浮出面板的遮挡，不滚动 document。

主题外观消费现有 `style.tone` 和 `width`；颜色使用 Kiln 语义 token，宽度遵循既有布局的自动／最小宽度行为。相同属性值不产生多余历史。属性编辑区与宽度控件实测为正文 13px、4px 圆角，line tabs 为 40px 高、无底板；侧栏为 288px。浏览器证据为 `tests/evidence/canvas-inspector-webkit.json`、`canvas-inspector-properties-webkit.png`、`canvas-inspector-outline-webkit.png`。

新增 `tests/ui/canvas-inspector.spec.ts` 六项，覆盖属性落盘／撤销重做、上下文切换、收起恢复、折叠定位、窄矮布局、组合输入与真实 select 键盘操作。旧测试按独立大纲页和更多菜单更新；连接线测试改为根据实际对象边界摆放目标，避免固定拖动坐标把判断节点拖到源连接点上。最终画布专项 38 项、完整 `pnpm test:ui --workers=4` 215 项、`pnpm build` 与 `git diff --check` 均通过。

原生独立应用实际修改既有「子主题保持可见」的强调色为「完成」、宽度为「适中」，保存重开后 UI 与 Rust 文件均保留 `tone: success`、`width: 240`。revision 15 → 17，四个外层对象的 ID 和坐标完全不变。大纲定位、收起保留选择、Space 恢复属性并聚焦文字框均已实际核对；证据为 `tests/evidence/canvas-inspector-native.json`。验收后已退出隔离应用，真实用户资料库未操作。

### 已有实现与验收

- 已只读核对当前工作树、导图模型/保存队列、表格文件生命周期和 Kiln 规范。
- React Flow 固定为 12.11.6；导图布局与 JSON 编解码在 Worker，Rust 文件读写与扫描在后台任务。画布组件按需加载。
- `pnpm test:unit`：最新 266 项通过，其中画布模型、保存与性能边界 51 项，新增树模型键盘操作 12 项。性能边界为 Node 中 400 对象、接近 8 MiB 的提交链路，不能作为浏览器或原生帧率指标。
- `pnpm test:ui --workers=4`：最新完整 215 项通过。25 项明确使用 WebKit（2 项连续多选拖动、10 项细节优化、5 项键盘协议、2 项文字居中、6 项属性侧栏）。画布相关覆盖中文编辑、拖动与撤销、连线标签与删除、资料拖入与失效状态、导图混排与副本导入、保存失败导航门禁、composition 门禁、冲突另存副本及创建响应丢失重试；完整旧功能回归通过。
- `pnpm build`、`cargo check -p shard`、`git diff --check` 通过。Kiln 215 个 token 校验通过；窄窗口计算样式无页面横向溢出。构建保留现有 Glide PURE 注释和主 chunk 大小提示。
- Rust 专项 `cargo test -p shard canvas_commands::tests --lib`：15 项通过；`cargo check -p shard` 通过。
- 保存失败可显式“另存画布副本”；完整草稿保存到新 ID 后再切换资料库路径，原文件保持原状。创建响应丢失时重试同一身份，失败后新增编辑继续补写到该副本。
- 修复并回归两类延迟菜单聚焦竞态：流程文字输入被菜单抢走焦点，以及新建子节点后焦点回到导图根节点。导图专项连续 5 次通过，随后全量 UI 通过。
- 原生拖动曾触发浮点往返不一致，已用真实坐标复现并启用 serde_json 的 float_roundtrip；保留严格响应判等，2,048 个邻近 double 的位级回归通过。
- 独立验收应用 `dev.shard.canvas-acceptance-20260907` 使用临时 vault `/var/folders/jd/9rnt7sl15d7_gkzln2svt9xw0000gn/T/shard-canvas-native-ybp3ux0x`，配置与真实用户应用隔离。WKWebView 实际完成新建、中文文字编辑、导图子节点编辑、引用卡片、保存和进程重启后的重开；修复后二次拖动使 revision 从 7 增至 8，坐标精确保留，Git 提交数始终为准备夹具时的 1。
- 原生中文文字通过可访问性编辑接口写入，不能冒充真实输入法候选验收；触控板物理手势和原生大画布性能仍待人工验收。浏览器 composition 事件与鼠标测试另行记录，不替代这些证据。
- 最终临时文件 revision 为 9，包含流程节点、2 节点导图及按 ID 关联的笔记引用；引用没有复制正文。证据：`tests/evidence/canvas-native-storage.json`；浏览器真实资料库界面 `tests/evidence/canvas-library-workspace.png`，窄窗口计算样式截图 `tests/evidence/canvas-workspace-narrow.png`。原生验收使用独立开发入口，不等同于完整原生主界面导航验收。
- 所有实现保留在当前本地工作树，未提交、推送或发布。原有未提交改动继续保留。
- 连续多选拖动消失问题已在 WebKit 复现：节点和坐标仍在，DOM 却变为 `visibility:hidden` 并伴随 ResizeObserver 循环。根因是受控节点重新投影时丢失 `measured`，忽略了 `dimensions` 回调。现将测量结果作为独立运行时状态回填；相同尺寸不触发更新，删除清理，切换文件重置，不进入文档、历史或保存队列。保留现有拖动生命周期和视口裁剪。
- 新增 `tests/ui/canvas-multidrag.spec.ts`：真实 WebKit 指针框选拖动、直接拖动多选节点、连续手势、每次可见性与坐标、一次撤销一手势、慢保存不回滚，且全程无页面错误。原生独立验收确认创建、框选、连续键盘移动、保存重开；CUA 鼠标拖拽未产生可确认的位移，不冒充原生鼠标验收。分层证据见 `tests/evidence/canvas-multidrag-native.json`。
