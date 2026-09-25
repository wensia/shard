# 阶段 0 报告：Markdown 转换层选型与实现

日期：2026-09-21。对应[技术方案](rich-text-editor-plan.md)第 6 节阶段 0、[产品框架](product-framework.md)路线图阶段 A。

**结论：放弃官方 `@tiptap/markdown`，自写转换层。** 解析侧复用 `packages/markdown` 已有的 Lezer 语法（CommonMark + GFM + `==高亮==`），序列化侧按方言手写。对外 API 与原计划一致：`parseShardMarkdown` / `serializeShardMarkdown`。

## 1. 安装的依赖

全部锁在 `3.31.3`（当前 latest，无 deprecated 标记）：

`@tiptap/core`、`@tiptap/pm`、`@tiptap/starter-kit`、`@tiptap/extension-underline`、`@tiptap/extension-highlight`、`@tiptap/extension-task-list`、`@tiptap/extension-task-item`、`@tiptap/extension-table`、`@tiptap/extension-link`、`@tiptap/extension-image`、`@tiptap/markdown`。未装 `@tiptap/react`（阶段 1 才需要）。

两条与版本相关的事实：

- StarterKit 3.31 已自带 `underline` 与 `link`，独立包是同一份实现。`src/editor-rich/schema/index.ts` 里把 StarterKit 的这两项关掉、改用同名独立扩展，只为把方言用到的扩展在一处列全，并避免 Tiptap 的重复注册告警。
- **peer 告警（需要决策）**：`@tiptap/markdown` 依赖 `marked@^17`，安装后仓库里的 `marked` 从 16.4.2 升到 17.0.6，`@glideapps/glide-data-grid@6.0.4-alpha24` 的 peer 声明是 `marked@^16.0.10`，pnpm 报 `unmet peer marked@^16.0.10: found 17.0.6`。glide 只在 `internal/markdown-div` 里用 `marked(contents)` 这一种同步调用，marked 17 仍然支持，`pnpm build` 通过；但既然评估结论是不用官方包，`pnpm remove @tiptap/markdown` 可以让 `marked` 退回 16 并消掉告警。验收时已执行 `pnpm remove @tiptap/markdown`（2026-09-21），该包不再出现在依赖里。

## 2. 官方 `@tiptap/markdown` 评估

评估按技术方案 §2 的五条标准做，spike 直接用 `MarkdownManager`（该类是 public export，可脱离 Editor 实例构造）。

| 标准 | 结果 |
| --- | --- |
| 无 DOM 的 node 环境可用 | 部分通过 |
| 能否表达全部方言元素 | **不通过** |
| 未知结构能否原样保留为 rawBlock | 通过（需自挂 tokenizer） |
| 扩展点是否够用 | 通过 |
| golden 往返能否全绿 | **不通过** |

### 2.1 通过的部分

`getSchema(extensions)` 与 `new MarkdownManager({ extensions })` 在 vitest 默认 node 环境（`typeof document === "undefined"`）下都能跑。标题、列表、引用、围栏、粗体/斜体/高亮/链接、GFM 表格、任务列表的基础往返正确；`***`/`___` 归一成 `---`、`~~~` 归一成 ```` ``` ````、setext 标题归一成 ATX、缩进代码块归一成围栏、有序列表重排序号，这些正是方言想要的规范化。

扩展点也够用：`markdownTokenizer` + `parseMarkdown` + `renderMarkdown` 能把 `#标签`、`[[双链]]`、块级 HTML → `rawBlock`、`<u>` → underline 全部接上，实测都能正确往返。

### 2.2 决定性的失败项

**（1）文本转义把 `&`、`<`、`>` 编成 HTML 实体，且无法覆盖。**

```
输入： A & B < C > D "q" 'a'
输出： A &amp; B &lt; C &gt; D "q" 'a'
```

序列化路径上的 `encodeTextForMarkdown` / `escapeMarkdownSyntax` 是 `MarkdownManager` 的私有方法，对所有非 code 文本节点无条件生效。尝试用 `Extension.create({ priority: 10000, markdownTokenName: "text", nodeName: "text", renderMarkdown })` 覆盖 `text` 渲染，输出仍然是 `A &amp; B`——注册的 handler 根本没被调用。

这条同时违反三件事：

- 产品框架 §1 原则 2「文件永远是可读的 Markdown」：用户输入 `A & B`，磁盘上变成 `A &amp; B`。
- 技术方案 §3 的转义约定是 CommonMark 反斜杠转义，不是 HTML 实体。
- `packages/markdown` 的卡片渲染对行内源码是**逐行字面输出**（`renderLiteralInline`），`&amp;` 会原样显示给用户。这也意味着任何多余转义都是用户可见的噪音，不只是文件里的脏字符。

**（2）列表续行丢掉缩进。**

```
输入： - 第一行\n  第二行\n- 第二项
输出： - 第一行\n第二行\n- 第二项
```

文档 JSON 因为懒续行规则仍然相等，但输出违反方言 §3「无序列表 `-` 两空格缩进」，而且卡片渲染是按行的，`第二行` 会掉出列表渲染成普通行——编辑器所见与卡片所见不一致。

**（3）表格前后稳定多写空行。**

```
输入： 前段\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n后段
输出： 前段\n\n\n| a   | b   |\n| --- | --- |\n| 1   | 2   |\n\n\n后段
```

三连换行不是一次性噪音，每次保存都会写进去。

**（4）任务项细节被插入空行，且与 CommonMark 不一致。**

```
输入： - [ ] 买菜\n  番茄、鸡蛋
输出： - [ ] 买菜\n\n  番茄、鸡蛋
```

marked 把懒续行当成任务项里的第二个段落（CommonMark 里它是同一段落的软换行），写回时补了空行，与产品框架 §5.2 的备忘卡片存储示例不一致。

**（5）HTML 路径依赖 DOM，在 node 下静默降级。**

`parseHTMLToken` 走扩展的 `parseHTML` 规则（内部 `elementFromString`），无 DOM 时不抛错，而是把 HTML 当字面文本再做实体编码：`<div class="x">…` → `&lt;div class="x"&gt;…`，`<u>下划线</u>` → `&lt;u&gt;下划线&lt;/u&gt;`。必须自己挂 tokenizer 绕开整条 HTML 路径。

### 2.3 架构层面的第二个理由

官方包基于 marked，`packages/markdown` 的卡片渲染基于 Lezer。技术方案 §3 明确「方言是编辑器与卡片渲染的共同契约」；走官方包意味着同一份方言有两个解析器，`==高亮==` 的定界规则要在 marked 里照着 `ShardHighlight` 再实现一遍，标签与双链的边界规则也要再实现一遍，两边一旦漂移就是静默的内容差异。

### 2.4 修复成本

要把（1）～（4）修掉，得同时覆盖 `text`、`paragraph`、`listItem`、`taskItem`、`table` 的 renderer——也就是把整个序列化器重写一遍，只留 marked 做解析；而解析恰恰是仓库里已经有现成且与卡片同源实现的那一半。结论是切自写转换层。

## 3. 自写转换层的实现要点

- **解析**：`@shard/markdown/core` 的 `markdownParser`（CommonMark + GFM + `==高亮==`）产出 Lezer 树，再映射为 ProseMirror JSON。`packages/markdown` 未做任何改动，`markdownParser` 本来就在 `core` 的公开导出里。
- **标签与双链**：不重写规则。在每个行内容器里先把「受保护区间」（行内代码、转义、实体、HTML 标签、链接目标与标题、autolink）挖掉，剩下的片段交给 `getTagRanges`（`@shard/markdown/core`，`editor-format.ts` 转出的同一份）与 `parseWikilinks`（`src/lib/wikilink.ts`）。扫描片段时多带一个前置字符，保证 `isTagBoundary` 的判断与整行扫描一致；`a#b`、`docs/a#b` 因此不会被认成标签。
- **原子优先**：Lezer 会把 `[[双链]]` 解析成引用式 `Link`、把 `![[x.csv]]` 解析成 `Image`。行内遍历时标签/双链原子优先于任何与之相交的 Lezer 节点，相交的节点整个跳过。
- **CSV 嵌入**：整段正文等于 `![[…]]` 且 `isCsvWikilinkTarget` 为真时才是块级 `csvEmbed`；行内写法退回 `!` 文本 + `wikilink` 原子，往返仍然逐字相同。
- **围栏**：语言命中块注册表 → `shardBlock`（只存 `lang` + `source` 原文，不调用注册表的 parse，未装插件也不会丢内容）；否则普通 `codeBlock` 并保留 language。
- **转义**：只在会被重新解析成语法的位置加反斜杠。`\` `` ` `` `*` `[` 总是转义；`_` 只在非词内位置转义（`snake_case` 保持原样）；`<` 只在后面跟 `[A-Za-z/!?]` 时转义；`&` 只在后面能凑成实体时转义；`~` `=` 只在成对时转义；`#` 只在「前一个输出字符是标签边界且后续能构成合法标签」时转义；行首另外处理 ATX、列表标记、有序标记、`>`、分割线与 setext 下划线。实体在解析时解码（`&amp;` → `&`），因此文件里不会留 HTML 实体。
- **标记嵌套**：已经打开的标记优先保持原有嵌套顺序，否则 `**粗体 ==高亮==**` 会被拆成 `**粗体 **==**高亮**==`（这是 spike 里踩到的真实 bug，已有 golden 用例 `inline-formats` 守着）。

## 4. 与技术方案的偏离

| 项 | 技术方案原文 | 实际做法 | 理由 |
| --- | --- | --- | --- |
| 未注册围栏语言 | §3/§4.4 写 `rawBlock` | `codeBlock` 并保留 language | 按本阶段任务书 §4；代码块本身是方言元素，`rawBlock` 留给块级 HTML、注释、链接引用定义这类真正无法建模的结构。两者都原样保留，往返都无损 |
| 图片 | §3 写「`image` 块节点」 | `Image.configure({ inline: true })`，独占一行表现为「段落里只有一个 image 子节点」 | 块节点无法表达行内图片，行内图片只能降级成字面文本；行内节点两种形态都无损，序列化时独占一行的图片仍然独占一行 |
| 标题层级 | §3 写 level 1–4 | schema 保留 1–6 | 把 5/6 级裁到 4 级会静默丢内容；方言与工具栏仍然只暴露 1–4 |
| 斜体 / 删除线 / 行内代码 | §3 方言表未列 | 保留为标记 | 卡片按字面渲染行内源码，把 `*斜体*` 转义成 `\*斜体\*` 会在卡片上肉眼可见，属于内容回退 |
| 硬换行 | 未规定 | 写成 `\` + 换行，不用两个尾随空格 | 尾随空格被 `git diff --check` 判为 whitespace error，且在编辑器里不可见 |
| 行内 HTML | §3 只列 `<u>` | 只认 `<u>`，其余行内标签降级为字面文本并按 CommonMark 转义（`<span>` → `\<span>`） | 方言里没有别的行内 HTML；降级后仍能往返 |
| `ShardBlockDefinition.icon` | §4.4 写 `ShardIconName` | 可选 `string`，注释标明阶段 2 收紧 | 仓库里还没有 `ShardIconName` 类型；直接引 `@/components/icons` 会把 React 与 lucide 拉进 node 测试路径 |
| 注册表 parse/serialize | §4.4 | 不参与方言转换，只由 `registry.test.ts` 守往返 | `shardBlock` 存原文即可保证无损；parse/serialize 留给阶段 2 的 NodeView 与卡片渲染 |

另有两条约定：

- 转换层契约里的正文**不含末尾换行**；golden 文件按普通文本文件保存（末尾一个换行），测试加载时去掉一个尾换行。
- 大纲类型文件（整篇纯缩进列表）本阶段不处理，只处理 ```` ```mindmap ```` 围栏形式。

## 5. golden 用例

`src/editor-rich/markdown/golden/<case>/{input.md,expected.md}`，共 25 个用例。`roundtrip.test.ts` 对每个用例断言四件事：`serialize(parse(input)) === expected`、`serialize(parse(expected)) === expected`（幂等）、`parse(expected).doc` 深等于 `parse(input).doc`、`Node.fromJSON(shardSchema, doc).check()` 不抛（文档 JSON 合法）。

| 用例 | 覆盖 |
| --- | --- |
| `paragraph-soft-break` | 段落与段内软换行 |
| `headings` | 标题 1–4 |
| `bullet-list` | 无序列表与嵌套 |
| `ordered-list` | 有序列表，序号重排（`3/5/9` → `3/4/5`） |
| `nested-list` | 无序里套有序再套无序 |
| `task-list` | 任务列表；懒续行细节（备忘卡片存储形态）与空行分隔的独立细节段 |
| `blockquote` | 引用，含引用内列表与空引用行 |
| `horizontal-rule` | 分割线，`***` 归一成 `---` |
| `code-block` | 带语言的代码块 |
| `inline-formats` | 粗体/下划线/高亮/链接，以及粗体套高亮、链接套粗体、带 title 的链接 |
| `image-block` | 图片独占一行 |
| `image-inline` | 行内图片 |
| `tags` | 行首、句中、中文紧贴汉字、多个标签，以及 `a#b`、`docs/a#b` 不识别 |
| `wikilinks` | 正常双链、断链、`\|` 别名 |
| `csv-embed` | 独占一行的 `![[x.csv]]`、行内写法、普通 `[[x.csv]]` 链接 |
| `mindmap-fence` | ```` ```mindmap ```` 围栏 |
| `datatable-fence` | ```` ```datatable ```` 围栏 |
| `unknown-fence` | 未注册语言与无语言围栏 |
| `html-block` | 块级 HTML 与注释块 → `rawBlock` |
| `frontmatter` | Frontmatter 原样剥离与回写 |
| `escapes` | 字面 `*` `_` `#` `=` `[[` `<` 与 `&amp;` 实体 |
| `gfm-table` | GFM 表格含三种对齐 |
| `empty-document` | 空文档 |
| `list-normalization` | `*` / `+` 列表与 4 空格缩进归一成 `-` 与 2 空格 |
| `real-fragment-sample` | 混合真实碎片样本：frontmatter + 标题带标签 + 双链别名 + 高亮 + 任务列表 + 行内代码 + `<u>` + mindmap 围栏 + CSV 嵌入 + 图片 + 表格 + 引用 + 分割线 + 裸 URL |
