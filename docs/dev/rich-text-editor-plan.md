# 富文本编辑器技术方案：Tiptap 内核、Shard Markdown 方言与自造组件

日期：2026-09-21。状态：技术方案，已由用户确认内核选型；阶段 0–3 已于 2026-09-23 全部实施并验收，CodeMirror 已删除（见 §8）。

产品依据：[产品框架](product-framework.md)。本文定义编辑器内核、Markdown 方言、组件清单、宿主接口、迁移阶段与验收标准。实施按阶段拆成独立计划，每阶段单独验收。

## 1. 目标与非目标

目标：

- 编辑态不显示任何 Markdown 语法；所有可见元素是 Shard 自造组件。
- 文件仍是 Markdown，编辑器读写经方言转换，往返无损。
- 中文输入法在所有组件内可靠工作。
- 四个编辑面（速记框、行内编辑、禅模式、资料库编辑器）最终统一到新内核，删除 CodeMirror 及其扩展。

非目标：

- 协作编辑、实时多人光标。
- 更换碎片卡片的只读渲染管线，`packages/markdown` 继续负责卡片渲染。
- 首版实现可编辑导图画布；导图视图先只读。

## 2. 内核选型

**Tiptap 3.x（基于 ProseMirror）。**

- ProseMirror 的文档模型、选区、撤销与输入法组合处理是现有开源方案里最成熟的，中文场景尤其重要。
- Tiptap 提供 React NodeView（`ReactNodeViewRenderer`），自造组件即自定义 Node + React 组件，符合"自造组件"的要求，同时不必重写底层。
- 现成扩展可直接复用：Bold、Underline、Highlight、BulletList、OrderedList、TaskList、Table、Placeholder、Suggestion（用于 `/`、`#`、`[[`）、History。

Markdown 转换层有两个候选，阶段 0 评估后二选一：

1. 官方 `@tiptap/markdown`（当前 3.31.x，基于 marked，官方标注为早期版本，可能有未覆盖的边界情况）。
2. 自写转换：解析侧复用 `packages/markdown` 已有的 Lezer 语法（CommonMark + GFM + `==高亮==`），序列化侧按方言手写。

评估标准：能否表达第 3 节全部方言元素；未知结构能否原样保留；往返 golden 测试能否全部通过；扩展点是否足以挂自定义节点。任一不满足即选自写转换。

**结论（2026-09-21）：选 2（自写转换）。** `@tiptap/markdown` 3.31.3 的序列化把 `&`/`<`/`>` 强制编成 HTML 实体且无法覆盖，列表续行丢缩进，表格前后多写空行，任务项细节被插入空行；证据与实现细节见[阶段 0 报告](rich-text-stage-0-report.md)。

依赖观察：Tiptap 3.x 与 `@tiptap/markdown` 仍在快速演进，实施前核对当前版本、CHANGELOG 与 breaking changes，与 `AGENTS.md` 对 `@base-ui/react` 的要求一致。

## 3. Shard Markdown 方言草案

方言是编辑器与卡片渲染的共同契约。所有元素写法固定，输出规范化；非规范输入（如 `*` 列表、四空格缩进）在解析时接受，首次保存后被规范化，这是可接受的代价。「首次保存」指用户真正编辑之后的保存：只打开不编辑时，归一化只发生在文档模型里，编辑器不向宿主报值，宿主不标脏、不自动保存，关闭或失焦也按磁盘原文比较，不改写文件。

| 元素 | Markdown 写法 | 节点 / 标记 | 备注 |
| --- | --- | --- | --- |
| 段落 | 空行分隔 | `paragraph` | 段内软换行保留为单个换行 |
| 标题 | `#` 到 `####` | `heading` level 1–4 | 碎片不在工具栏暴露，但正确解析与保存 |
| 无序列表 | `- ` 两空格缩进 | `bulletList` / `listItem` | 接受 `*`、`+` 输入 |
| 有序列表 | `1. ` | `orderedList` | 序号重排由序列化负责 |
| 任务列表 | `- [ ] ` / `- [x] ` | `taskList` / `taskItem` | 与现有卡片渲染的任务勾选一致 |
| 有序任务 | `1. [ ] ` / `2. [x] ` | `taskList` ordered=true / `taskItem` | 序号从 1 起按位置重排；编辑区在复选框前显示序号，与卡片的 `.md-task-list-marker` 一致 |
| 引用 | `> ` | `blockquote` | |
| 分割线 | `---` 前后各一空行 | `horizontalRule` | |
| 代码块 | ```` ``` ```` 围栏 | `codeBlock` language | 语言为 `mindmap` 时不是代码块，见大纲块 |
| 粗体 | `**文本**` | `bold` | |
| 下划线 | `<u>文本</u>` | `underline` | 沿用现有写法，CommonMark 允许行内 HTML |
| 高亮 | `==文本==` | `highlight` | 沿用 `packages/markdown` 现有语法 |
| 链接 | `[文本](url)` | `link` | |
| 图片附件 | `![alt](path)` 独占一行 | `image` 块节点 | 沿用附件路径规则与上传流程 |
| 标签 | `#词` | `tag` 行内原子节点 | 前后必须是边界；沿用 `normalizeTag` 与受保护 type 标签 |
| 双链 | `[[目标]]` | `wikilink` 行内原子节点 | 沿用 `parseWikilinks` 的目标解析 |
| CSV 嵌入 | `![[x.csv]]` 独占一行 | `csvEmbed` 块节点 | 只读预览 |
| 大纲块 | ```` ```mindmap ```` 围栏内缩进列表 | `shardBlock` id=mindmap | 复用 `parseMindMapOutline` / `serializeMindMapOutline` |
| 表格 | GFM 管道表格 | `table` | 复用 `prosemirror-tables`；静态小表 |
| 备忘卡片 | `- [ ] 标题` 加缩进细节 | `taskItem` 含子段落 | 不新增语法；带子内容的任务项渲染为卡片。规范化输出是标题与细节之间空一行（两个段落）；缩进续行写法（无空行）解析为单段软换行，同样渲染为卡片 |
| 数据表 | ```` ```datatable ```` 围栏内 JSON | `shardBlock` id=datatable | 列定义 + 内联 `rows` 或 `src` 指向库内 CSV；可选 `view` 持久化排序/分组/筛选 |
| 原始块 | 方言不认识的块级 HTML、注释、链接引用定义 | `rawBlock` | 原样保留，编辑态显示为不可编辑灰块 |
| 未注册围栏 | 注册表里没有的围栏语言 | `codeBlock` 保留 language | 按普通代码块显示与保存，不丢内容；安装对应插件后自动升级为 `shardBlock` |
| Frontmatter | 文件头 `---` 块 | 不进入文档模型 | 读写时剥离并原样回写 |

转义：用户输入的字面 `*`、`_`、`#`、`=`、`[`、`<` 在序列化时按 CommonMark 规则转义，重新解析后仍是普通字符。标签与双链只在边界位置识别，行内 `a#b` 不是标签。

大纲文件：type 为大纲时整篇正文就是一个 `outlineBlock`，序列化不加围栏；type 不是大纲时围栏块序列化为 ```` ```mindmap ````。

往返测试：`packages/markdown` 或新目录下建 golden 用例目录，每个用例一对 `input.md` / `expected.md`，断言 `serialize(parse(input)) === expected` 且 `parse(expected)` 与 `parse(input)` 的文档 JSON 相等。

## 4. 组件清单

### 4.1 基础层（Tiptap 现成扩展，只定样式）

段落、标题、无序/有序/任务列表、引用、分割线、代码块、粗体、下划线、高亮、链接、占位符、撤销。样式全部消费 Kiln token，密度与焦点沿用 `docs/design/frontend.md` 的约定（焦点策略现为 managed-navigation）。

### 4.2 Shard 层（自造 NodeView）

| 组件 | 交互 | 复用 |
| --- | --- | --- |
| 标签芯片 | `#` 触发 Suggestion，候选来自已知标签，选中生成原子节点；Backspace 整体删除；点击进入标签筛选 | `getMatchingTagsBySearchQuery`、flomo 式可见间隔规则 |
| 双链芯片 | `[[` 触发 Suggestion，候选来自碎片与大纲；断链样式；点击导航 | `buildMindMapWikilinkCandidates`、`onNavigate*` 回调 |
| 图片附件 | 拖放/粘贴/命令上传；预览、删除、原图对话框 | `useImageUpload`、`saveFragmentImage` |
| CSV 嵌入 | 只读表格预览 | `CsvPreview` |
| 斜杠命令 | Suggestion 驱动的命令菜单，条目与现有 `SLASH_COMMANDS` 一致并增加"文档" | `slash-commands.ts` 的注册表与过滤 |

### 4.3 结构层（自造 NodeView）

| 组件 | 交互 | 复用 |
| --- | --- | --- |
| 大纲块 | NodeView 内挂幕布式大纲编辑器；Enter/Tab/Shift-Tab 由组件消化；Escape 回到外层；只读时显示导图预览 | `MindMapOutlineEditor` compact 模式、`MindMapFenceEmbed`、`mind-map-outline.ts` |
| 备忘卡片 | 任务项带子内容时渲染为卡片：复选框、标题、细节区可折叠；`/备忘卡片` 插入标题加细节两段 | Tiptap TaskItem 扩展加自定义 NodeView |
| 数据表 | 列头排序、按列分组、筛选与搜索、全屏、导出 CSV；内联行可编辑单元格写回围栏 JSON；`src` 指向 CSV 时写回 CSV 文件 | craft-agents `MarkdownDatatableBlock` 的功能集（原生 table + React state，不引入 TanStack）、现有 CSV 读写与 `CsvPreview` |
| 表格 | 单元格编辑、行列增删、Tab 走格 | `prosemirror-tables`、Kiln 表格样式 |
| 原始块 | 不可编辑灰块，显示前几行源码，提供"删除" | 无 |

### 4.4 块注册表

所有围栏块组件（大纲块、数据表，以及未来插件的块）通过同一个注册表接入，Tiptap 只定义一个通用 `shardBlock` 节点（属性：`lang`、`source`），NodeView、卡片渲染、斜杠命令都按 `lang` 从注册表分派。这避免了 craft-agents 那种按语言硬编码 if 链的做法，也是插件架构的底座。

```ts
interface ShardBlockDefinition<Data> {
  lang: string                         // 围栏语言标识，全局唯一
  title: string                        // 命令菜单与占位显示名
  icon: ShardIconName                  // 只能来自 @/components/icons 注册表
  parse(source: string): Data | { error: string }
  serialize(data: Data): string        // 必须与 parse 往返一致
  Editor: ComponentType<BlockEditorProps<Data>>   // 编辑态 NodeView 内容
  Preview: ComponentType<BlockPreviewProps<Data>> // 卡片只读渲染
  slash?: { keywords: string[]; template: string } // 可选：/ 命令条目
}
```

- 方言转换：围栏语言在注册表中则生成 `shardBlock`，否则生成保留 language 的 `codeBlock`。注册表变化（如启用插件）后重新解析当前文档即可升级。
- 卡片渲染：`fragment-content.tsx` 的 `renderFence` 改为查注册表，替换现有只认 `mindmap` 的分支。
- 备忘卡片不是围栏块，它是 GFM 任务项的渲染增强，走 TaskItem 扩展而不进注册表。

NodeView 内的 textarea 与 ProseMirror 的 contenteditable 共存时，NodeView 必须实现 `stopEvent` 与 `ignoreMutation`，把组件内部的键盘、输入法、DOM 变更全部拦在 ProseMirror 之外；这与现有 CodeMirror widget `ignoreEvent` 恒 true 的经验一致。

## 5. 宿主接口与目录

- 新目录 `src/editor-rich/`：`ShardRichEditor` 组件、扩展集、方言转换、NodeView 组件、测试桥。
- 宿主接口不再基于文本偏移。`ShardRichEditorHandle` 提供 `focus`、`getMarkdown`、`setMarkdown`、`insertCommand(id)`、`isComposing`；`onChange` 回调给出 Markdown 字符串，宿主的 `content` state 语义不变。
- 三个宿主的注入点（`capture-box.tsx`、`fragment-editor.tsx`、`library-shell.tsx`）改为传入 `variant` 与回调，不再传 CodeMirror 扩展数组。
- 迁移期曾用开关（`localStorage["shard.richEditor"]` / `VITE_SHARD_RICH_EDITOR`）在旧 `ShardEditor` 与 `ShardRichEditor` 之间切换；D2b（2026-09-23）连同 CodeMirror 一起删除，现在四个编辑面只有富文本一条路径。
- 测试桥：`window.__shardEditorTest` 由 `src/editor-rich/test-bridge.ts` 提供，契约 `list`/`get`/`set`/`select`/`type`/`focus`/`snapshot` 不变；`set` 模拟用户写入，会向宿主报规范化后的值。
- 自动保存取值走 `peekMarkdown(hostValue)`：与 `getMarkdown()` 同一套行内收敛口径（`#词`、`[[x]]` 落盘为标签与双链而不是转义文本），但只算不改，编辑区里的字面文本原样留着，用户停顿后还能接着打；组合输入期间与宿主有未同步写入时返回宿主值。

## 6. 迁移阶段与验收

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| 0 方言与转换 | 定稿第 3 节方言；评估 `@tiptap/markdown`；实现转换层；golden 往返测试；Frontmatter 剥离回写 | 往返用例全绿；现有碎片样本（含标签、双链、图片、任务、表格、大纲围栏）全部无损 |
| 1 速记框 | `ShardRichEditor` 基础层 + 标签芯片 + 斜杠命令 + 占位符；速记框在开关下切换；输入法门禁 | 速记框全部现有 Playwright 用例在开关下通过；CDP 输入法用例通过；提交内容与旧编辑器一致 |
| 2 组件补齐 | 先建块注册表并把大纲块迁入；再做双链芯片、图片附件、备忘卡片、数据表、表格、原始块；CSV 嵌入并入数据表；前缀自动转换；粘贴 Markdown 解析 | 每个组件独立 Playwright 用例；碎片卡片渲染与编辑器所见一致；注册表能在不改编辑器代码的前提下新增一个块 |
| 3 四面统一 | 行内编辑、禅模式、资料库编辑器切换；类型专属功能集合；删除 CodeMirror 及扩展、旧测试桥 | 全量 `pnpm test:ui` 通过；`pnpm build` 无 CodeMirror 依赖；`git diff --check` 干净 |

每阶段结束都跑：`pnpm test:unit`、`pnpm build`、相关 Playwright 套件、`git diff --check`。

## 7. 风险与对策

| 风险 | 对策 |
| --- | --- |
| `@tiptap/markdown` 早期版本无法表达方言 | 阶段 0 评估失败即切自写转换，解析侧复用已有 Lezer 语法 |
| 输入法在 NodeView 内被 ProseMirror 打断 | `stopEvent`/`ignoreMutation` 全拦；每个含输入框的组件都配 CDP 输入法用例 |
| 往返丢失用户内容 | 原始块兜底；golden 测试覆盖真实样本；保存前对比解析结果，发现不一致时拒绝写入并提示 |
| 速记框高度自适应 | 沿用 contentDOM ResizeObserver 报高的做法 |
| 大文档性能 | ProseMirror 无虚拟化；碎片场景短，文档类型超过阈值时禁用重型 NodeView 并提示 |
| 迁移期两套编辑器并存 | 开关默认关闭；共用方言与测试桥语义；阶段 3 才删旧代码 |

## 8. 资产处置

继续使用：`packages/markdown`（卡片渲染、Lezer 语法）、`src/lib/mind-map-outline.ts`、`src/lib/slash-commands.ts` 的注册表与过滤、`MindMapOutlineEditor`、`MindMapPreview`、`mind-map-layout.ts`、图片上传与附件流程、标签与双链的纯函数。

阶段 3 删除：**已完成（2026-09-23，D2b 第二步）**。实际删除项：

- `src/editor/` 整个目录：`shard-editor.tsx`、`text-edit.ts`、`test-bridge.ts`（富文本实现迁到 `src/editor-rich/test-bridge.ts`）、`table-widget-host.tsx`、`mind-map-widget-host.tsx`，以及 `extensions/` 下的 `clipboard`、`document-link`、`keymap`、`live-preview`、`markdown`、`mind-map-widget`、`selection`、`slash-commands`、`table-widget`、`tag-autocomplete`、`theme`、`wikilink`。
- 迁移开关 `src/lib/rich-editor-flag.ts`，以及 `tests/ui/editor-helpers.ts` 的 `enableRichEditorFlag` / `disableRichEditorFlag`。
- 只服务 CodeMirror widget 的组件：`src/components/shard/editor-table.tsx`、`src/components/shard/table-size-picker.tsx`。
- `src/lib/editor-format.ts` 中基于文本偏移的函数：`applyLineFormat`、`applyInlineFormat`、`insertHorizontalRule`、`insertMarkdownTable`、`insertMarkdownBlock`、`insertMarkdownImage`、`applyTaskMarkerDeletion`、`insertTagMarker`（规则保留为按字符判断的 `getTagMarker`）、`applyTagCompletion`，以及 `TextEdit`、`TaskMarkerDeletionKey`；保留 `extractTags`、`getActiveTag`、`toggleTaskLine`、`getMarkdownImageAlt` 与 `@shard/markdown/core` 的再导出。
- `src/lib/editor-list.ts` 及其单测。
- `src/lib/slash-commands.ts` 的 `runSlashCommand`、`insertMindMapOutlineBlock`、`insertMemoCardBlock`、`SLASH_COMMAND_COMPLETION_TYPE`；保留注册表、过滤、`getActiveSlashCommand`、`isContentTypeSlashCommand` 与备忘卡片占位文案。
- `src/styles/frontend-rules.css` 中的 `.cm-content`、`.shard-cm-*`、`.shard-editor-table-*`、`.shard-table-size-*` 规则；补全面板规格已在 `rich-editor.css`。
- 依赖 `@codemirror/autocomplete`、`@codemirror/commands`、`@codemirror/language`、`@codemirror/state`、`@codemirror/view`；`@lezer/markdown` 保留（转换层与 `packages/markdown` 使用）。`pnpm build` 产物中不再含 codemirror。

## 9. 插件架构

目标是 Obsidian 式的插件与自定义组件能力。Obsidian 的自定义组件机制核心是围栏块处理器加命令与设置注册；Shard 以第 4.4 节的块注册表为底座，分三步开放：

**第一步：内部注册表（阶段 2）。** Shard 自己的块全部通过 `ShardBlockDefinition` 注册。验收标准是新增一个块不需要改编辑器、方言转换或卡片渲染的代码。

**第二步：插件包与 API（阶段 3 之后）。**

- 插件位于库内 `.shard/plugins/<id>/`，含 `manifest.json`（id、名称、版本、最低 Shard 版本、权限声明）、`main.js`（ES module）、可选 `styles.css`。
- 加载：Tauri 读取文件后以 blob URL `import()`；React、Tiptap 与 Shard UI 组件以宿主提供的方式注入，插件不自带第二份 React。
- API 面（`window.shard` 或模块参数）：`registerBlock(definition)`、`registerCommand`、`registerSlashItem`、`settings.get/set`、`vault.read/write/list`（限库内路径，走既有 Tauri command 与 vault gate）。插件不能直接 `invoke`。
- 卸载或禁用时注销全部注册项，已有文档中该语言的围栏退回原始块。

**第三步：分发与安全。**

- 插件默认关闭；启用时展示权限声明与"与应用同权运行"的风险说明。Obsidian 同样不做沙箱，这是有意的取舍；如需隔离，后续评估 Worker 或 iframe 方案，但那会限制 NodeView 能力。
- Tauri capability 只对宿主开放，插件走 API 间接调用；`AGENTS.md` 的 vault gate 与合并保存规则对插件写入同样生效。
- 首版不做插件市场，只支持本地目录安装。

### 9.1 网页采集插件

网页采集作为第一个官方插件实现，随应用内置。它对插件 API 提出两项新要求：受控的网络请求与库内写入。

**抓取与转换在 Tauri 侧完成。** 前端只发起异步调用并显示进度：

- `clip_url(url, mode)`：`async` command，`reqwest` 抓取页面，正文提取使用 Rust 侧 readability 类 crate（实施前核对候选：`dom_smoothie`、`readability`），HTML 转 Markdown 按第 3 节方言输出（标题、列表、引用、代码块、图片、链接；不认识的块转为原始块）。
- 图片下载为碎片附件，路径规则沿用现有图片附件；下载失败保留原 URL。
- 写入走 `create_fragment` 语义：内容型写入不内嵌 git 提交，拿到 vault 后立刻 `lock_vault_gate`，网络阶段不持门。
- Frontmatter 字段：`source`、`title`、`author`、`published`、`clipped`；默认产物是碎片，只有整页采集且用户选择"存为文档"时 type 为文档；标签追加 `采集`。
- 速记框粘贴 URL 的轻量路径只取标题与摘要（`<title>`、`og:description`），不抓全文，响应控制在一次请求内；"采集全文"才走完整提取。
- 可选保存原始 HTML 到 `.shard/clips/<hash>.html`，供重新提取；受隐私设置控制，私密碎片不保存快照。

**浏览器扩展。** 参考 Obsidian Web Clipper 的做法：扩展内用 Defuddle 提取正文、Turndown 转 Markdown、模板决定标题与属性，然后通过自定义协议交给桌面应用。Shard 用 `tauri-plugin-deep-link` 注册 `shard://clip`。协议 URL 有长度上限，正文超限时扩展把内容写入剪贴板并只传元数据，桌面端从剪贴板读取；不在本机开监听端口。扩展首版只做 Chrome 与 Safari，模板固定不开放自定义。

**Agent 路径。** 采集暴露为 Agent 工具契约里的一个工具（`clip_url`），Hermes / OpenClaw 收到 URL 即可调用，结果与桌面端一致。这是手机端采集的唯一路径。

**插件 API 增补。** `net.fetch(url, options)` 只对声明了 `network` 权限的插件开放，默认拒绝；官方采集插件由宿主授予。`vault.createFragment(content, tags, type)` 作为写入入口，插件不直接触碰文件路径。

**验收。** 三类页面样本（长文、含图文章、含代码块的技术文）采集后：正文可读、图片本地化、Frontmatter 完整、重新用 Shard 打开与保存前一致；重复采集同一 URL 提示已存在；私密模式下不落 HTML 快照。

## 10. 参考

- Tiptap Markdown 支持发布说明：https://tiptap.dev/blog/release-notes/introducing-bidirectional-markdown-support-in-tiptap
- Tiptap Markdown 文档：https://tiptap.dev/docs/editor/markdown
- `@tiptap/markdown` 包：https://www.npmjs.com/package/@tiptap/markdown
- Obsidian Web Clipper（开源，浏览器扩展采集与 `obsidian://` 协议传递的参考实现）：https://github.com/obsidianmd/obsidian-clipper
- craft-agents-oss（Tiptap + Markdown 编辑器、`datatable` 围栏块的参考实现）：https://github.com/lukilabs/craft-agents-oss 。它同时保留 `tiptap-markdown` 与官方 `@tiptap/markdown` 两套引擎做灰度切换，印证官方包仍需评估。
