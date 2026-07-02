# Shard 前端设计

状态：已与当前实现同步
日期：2026-06-09

视觉概念：[docs/design/shard-main-screen-concept.png](docs/design/shard-main-screen-concept.png)

## 产品形态

Shard 是一个轻量级 Markdown 片段捕获桌面应用。UI 必须围绕一个循环优化：

1. 输入一段片段。
2. 按 Cmd+Enter 或 Ctrl+Enter。
3. 创建一个 Markdown 文件。
4. 时间线中出现一张安静的纸片卡片。
5. Git 状态在后台更新。

这个应用不是 Markdown 编辑器、文档工作区、图谱视图或仪表盘。首屏就是真正的产品。

## UI 基座

使用：

- Tauri 桌面壳
- React + TypeScript
- Tailwind CSS
- shadcn/ui 组件
- shadcn 下可用时使用 Base UI primitives
- lucide-react 图标，除非最终 shadcn 配置选择了其他图标库

理由：

- shadcn 提供预设样式的源码组件，仓库可以直接拥有和维护。
- Base UI 在底层提供可访问、无样式、可组合的 primitives。
- Tailwind tokens 保持样式一致，避免一次性自定义 CSS。

实现规则：优先使用 shadcn 组件，再由它们组合自定义 Shard 组件。当 shadcn 已有对应组件时，不要构建基于原始 div 的控件。

## 视觉方向

名称：quiet paper tool

界面应像一个原生开发者工具，带有纸片卡片时间线：

- 白色或极浅灰色应用背景。
- 主要结构使用 1px 实线边框，而不是阴影。
- Composer 和片段卡片共享同一个 surface radius token。
- 最小化 chrome。
- 高对比度文字。
- 小面积暖色强调和语义状态色只用于标签、焦点和状态。
- 不使用渐变、装饰性 blob、玻璃效果或营销页式构图。

视觉中心是时间线，不是侧边栏或 inspector。

## 主色策略

Shard 应有一个主强调色，但必须保持克制。当前运行态使用暖赭色作为主强调色，它是精确的状态色，不是大面积品牌填充色。

- 主强调色：`#b6533c`
- Hover 强调色：`#96432f`
- 柔和强调底色：`#f8ede9`
- 强调文字色：`#743225`
- 色彩性格：暖红土/赭色，中低亮度；清晰但不偏橙、不偏棕、不荧光。
- 视觉占比：首屏约 3%-5%。
- 强调色用于焦点/编辑卡片边框、focus ring、链接、AI 建议强调、细微侧边栏选中指示、已勾选任务框，以及少量主强调。
- 不要把强调色用作完整侧边栏、应用顶部栏、页面背景，或每个按钮的默认颜色。
- 保留 `--solid` 给普通 shadcn filled 控件；`--primary` / `--shard-accent` 只用于状态、焦点、选中和破坏性语义。
- 当前组件仍在引用 `--shard-sapphire` 及相关变量；这些是映射到 `--shard-accent` 的兼容别名。

相关强调色保持语义归属：

- 陶土红 `#b6533c` 表示主色/焦点/破坏性。
- 绿松石 `#3e8c7d` 表示成功/正向强调。
- 孔雀蓝 `#2e6e79` 表示信息/次级点缀。
- 暖琥珀 `#be7c32` 表示待处理/警告。

## 布局

桌面默认：双区域写作壳。

```text
┌───────────────┬───────────────────────────────────────────────────────┐
│ Left rail     │ Capture input + two-column fragment cards             │
│ 240-272px     │ flexible writing surface                              │
└───────────────┴───────────────────────────────────────────────────────┘
```

默认屏幕必须聚焦在捕获和回顾上。不要保持一个常驻右侧 inspector；它会和写作争夺注意力，并让片段显得次要。

### 左侧栏

目的：导航和同步感知。

内容：

- Shard logo/name/version。
- 筛选项：收件箱、标签、每日回顾、AI 洞察、随机漫步、归档。
- 数量右对齐。
- 底部图标按钮：sync、还原窗口，以及一个紧凑的支持菜单。
- Sync 是一个紧凑图标按钮，带小状态点；branch、commit 和 vault path 放在 tooltip 中。
- 设置、快捷键、帮助放在支持菜单里；这些低频工具不要继续占据一级按钮位。
- 不要在底部工具上方使用分割线；只用留白分隔这个区域。

规则：

- 桌面端首选宽度：240px。
- 左侧栏在应用壳内固定于 viewport，不参与内容滚动。
- 右边框：1px solid token border。
- 侧栏外不要包 card。
- 选中项使用细微填充背景和更强文字，而不是亮色。
- 选中项可以有 2px 强调色指示条，但绝不能整行填充强调色。
- 小 viewport 下，将导航折叠为紧凑底部 tabs。

### 中心列

目的：捕获和回顾片段。

结构：

- 顶部是 capture textarea。
- 可滚动的倒序时间线。
- 只有中心时间线拥有垂直滚动；document body 和左侧栏锁定在 viewport 中。

Capture 输入：

- 居中的 composer card，最大宽度 `--shard-content-max-width`，surface radius 为 `--shard-surface-radius`，使用细微边框和非常轻的阴影。
- Composer 内部使用无边框 textarea，四周使用 `--shard-composer-padding`。
- 默认编辑器高度为 2 行文字；用户激活后展开到 4 行。向下滚动时间线会把短内容折叠回 2 行。较长内容会增长到测量出的内容高度，直到达到应用 viewport 扣除 composer 间距和工具栏 chrome 后的可用高度，之后在 textarea 内部滚动。
- 桌面顶部偏移：从主内容 viewport 顶部起 `--shard-composer-top-gap`。
- Placeholder：`想到什么，写什么...`
- 底部工具栏使用 `src/styles/frontend-rules.css` 中可复用的 `.shard-edge-action-row` 规则：同一个 inset token 控制左右 padding 和底部 padding，让边缘动作拥有相等的侧边和底部间距。
- Composer action inset：`--shard-space-3`。保存按钮：32px 正方形。底部工具栏最小高度由 action size 加两个相等 inset 推导。
- 工具栏工具包括图片上传、标签、无序列表、有序列表、任务清单、粗体、下划线和高亮按钮。列表工具把 Markdown 标记应用到当前行或当前选区中的每一行。行内工具把 Markdown 风格标记应用到当前选区。
- 应用启动时必须聚焦。
- `Enter` 或 `Shift+Enter` 插入换行。
- `Cmd+Enter` 或 `Ctrl+Enter` 创建片段，除非 IME composition 正在进行。
- 输入 `#` 或点击 `#` 按钮，会在 capture box 中打开一个紧凑标签 popover，直接定位在当前文本光标下方。
- 保存时提取 `#work` 这类内联标签，并和 `inbox` 一起写入片段 frontmatter。
- 图片上传会插入 Markdown image 行，并在 capture、editor 和片段内容中渲染为紧凑方形附件。附件 chrome 必须保持安静，并使用同一套 radius/alpha 系统。

Composer 标签语言：

- 通用标签是 28px 高 pill；memo/card 标签通过 `.shard-card-tags` 和 `.shard-memo-tags` 降到 24px。
- 默认标签使用中性填充，不使用大面积饱和色。
- 活跃标签创建使用一个极简 capsule：左侧是强调色文字的当前标签值，右侧是紧凑的 `新建` / `使用` 按钮。
- 标签创建 capsule 应小于 tooltip，大约 168px 宽、38px 高，文字 12px；它不能读起来像 composer 内的 card。
- 它跟随活跃 `#tag` 的 caret 位置，绝不能固定在 composer 某个角落。
- 默认捕获循环中不要展示多行建议菜单。
- `#book/marketing` 这样的多级标签是合法的，并应作为捕获流程的一部分保留在正文文本中。

Timeline：

- 桌面端卡片使用响应式双列网格，中心区域较窄时回到单列。
- 卡片呈现为安静、无边框的纸面 surface，不带垂直时间轴。
- 避免卡片左侧日期缺口或装饰性偏移。
- 倒序时间排列。

### 详情表面

目的：可选编辑和 AI 建议回顾，默认隐藏。

只在用户明确操作后显示，例如编辑动作或 overflow menu 项。当前实现使用 `FragmentEditor` 作为主要编辑表面；未来详情视图可以使用 Sheet、Dialog 或紧凑 Popover，而不是常驻第三列。

区块：

- 基本信息：创建时间、id。
- 标签及添加按钮。
- Git 状态。
- 内容预览/编辑器。
- 回顾表面通过 `MarkdownDocument` 提供 Markdown 预览。
- AI 建议预览。
- 底部动作：archive、edit。

规则：

- 默认写作视图中不要为详情预留布局宽度。
- 详情在视觉上不要比卡片网格更重。
- 标签编辑和 AI 建议应次于捕获。

## 卡片组件

卡片结构：

- 创建时间 metadata，只显示时间戳，不加前置标签。
- 正文预览，1-4 行。
- 标签行。
- 右上角 More menu，用于次级动作。
- 卡片动作菜单应紧凑并贴合内容：32px 行高、13px 文字、14px 轻描边图标、固定图标/文字列、左右 padding 对称。除非菜单项实际使用 shortcut/checkmark，否则不要预留对应空间。
- Archive 使用 archive 图标和中性文字；普通 archive 不要使用 trash 图标或破坏性红色样式。

卡片状态：

- 默认：白色 surface，无卡片边框。
- 片段卡片使用 `--shard-surface-radius`，与 capture composer 一致。
- Hover：保持 chrome 安静；默认不要引入 outline。
- Focus 或明确编辑状态可以使用强调色，但只在存在可编辑 surface 或明确选中时使用。
- Commit 和 sync 状态不作为默认卡片 chrome 展示；保留在侧边栏 sync block 或明确详情表面中。
- AI suggested 状态仅在可操作且不占主导时使用小强调色 chip。

卡片不应像沉重的仪表盘 widget。它们是纸片片段。

片段内容规则：

- 任务清单标记渲染为行内复选框，并可从卡片/回顾表面切换。
- 当 `vaultPath` 可用时，Markdown image 行渲染为紧凑附件。
- 富 Markdown block 属于回顾/详情表面；卡片保持轻量片段阅读风格。

## 几何 Tokens

Shard 使用一套小而可测量的几何系统。组件添加新值之前，应优先使用这些 tokens。

```css
--shard-space-1: 4px;
--shard-space-2: 8px;
--shard-space-3: 12px;
--shard-space-4: 16px;
--shard-space-5: 20px;
--shard-space-6: 24px;
--shard-space-8: 32px;
--shard-space-micro: 6px;

--shard-sidebar-width: 240px;
--shard-content-max-width: 900px;
--shard-sidebar-inset: var(--shard-space-5);
--shard-content-inset: var(--shard-space-5);
--shard-content-inset-lg: var(--shard-space-8);
--shard-composer-top-gap: var(--shard-space-4);
--shard-composer-bottom-gap: var(--shard-space-4);
--shard-composer-padding: var(--shard-space-4);
--shard-card-padding-x: var(--shard-space-5);
--shard-card-padding-y: var(--shard-space-4);
--shard-card-padding-bottom: calc(var(--shard-card-padding-y) - 2px);
--shard-card-gap: var(--shard-space-4);

--shard-radius-control: 6px;
--shard-surface-radius: 12px;

--shard-heatmap-cell: 12px;
--shard-heatmap-column-gap: 5px;
--shard-heatmap-row-gap: 6px;
--shard-chip-height: var(--shard-space-6);
--shard-chip-padding-x: 10px;
--shard-tag-height: 28px;
--shard-tag-font-size: 13px;
--shard-tag-padding-x: 11px;
--shard-memo-content-color: #323232;
--shard-memo-font-size: 14px;
--shard-memo-font-weight: 400;
--shard-memo-letter-spacing: 0px;
--shard-memo-line-height: 1.8;
--shard-memo-meta-font-size: 13px;
--shard-memo-meta-font-weight: 400;
--shard-memo-meta-line-height: 20px;
--shard-editor-line-height: var(--shard-memo-line-height);
--shard-caret-color: var(--shard-sapphire);
--shard-caret-height-ratio: 1.22;
--shard-caret-width: 1.5px;
```

Heatmap 计算：`12 columns * 12px + 11 gaps * 5px = 199px`，适配侧边栏 16px 左右 inset 后的内部宽度。

Composer 放置：capture box 是主要动作，因此不使用大的 32px 页面区块 inset。它的顶部和底部间距保持在 16px 网格上，让写作 surface 靠近窗口边缘但不贴边。

前端规则来源：`src/styles/frontend-rules.css` 把共享几何契约编码为可复用 utilities。添加组件局部 spacing 或 grid math 之前，先使用 `.shard-content-inset`、`.shard-content-measure`、`.shard-heatmap-grid` 和 `.shard-edge-action-row`。

编辑器光标规则：原生 textarea caret 无法满足这个 surface——它的高度跟随引擎的 line box 而非字形——因此编辑器字段隐藏原生 caret，渲染 `.shard-custom-caret`（高度由 `--shard-caret-height-ratio` 决定，垂直居中于字形盒）。caret 位置必须用 Range API 在可见高亮层的 `data-text-start` span 上测量，禁止用离屏 textarea mirror 估算：用户看到的渲染字形就是唯一事实来源，caret 物理上不可能偏离它。mirror 几何只允许作为高亮层无可测文字时的兜底（空内容、图片附件行）。

编辑器选区规则：渲染标签、渲染选区并承托 caret 的是同一个可见叠层，因此拖拽选区必须实时重绘这层高亮。textarea 的 `select` 事件在指针仍按下时不会触发，所以编辑器改为监听 document 的 `selectionchange` 流，在每一次移动时重绘，而不是松手后才显示。任务复选框也属于这个 surface：它对齐文字 line box、垂直居中于所在行，绝不浮在所标记文字的上方或下方。

## 颜色 Tokens

使用语义 CSS 变量。当前运行态值如下：

```css
--background: #fbfaf8;
--foreground: #2f2f2f;
--card: #ffffff;
--muted: #f1eee9;
--border: #efece7;
--border-visible: #d8d3cc;
--border-strong: var(--border-visible);
--muted-foreground: #6f6760;

--primary: #b6533c;
--primary-subtle: #f8ede9;
--solid: #2f2f2f;
--solid-foreground: #ffffff;

--shard-accent: #b6533c;
--shard-accent-hover: #96432f;
--shard-accent-soft: #f8ede9;
--shard-accent-text: #743225;
--shard-sapphire: var(--shard-accent);
--shard-sapphire-hover: var(--shard-accent-hover);
--shard-sapphire-soft: var(--shard-accent-soft);
--shard-sapphire-text: var(--shard-accent-text);
--shard-primary-rgb: 182 83 60;
--shard-primary-soft-rgb: 222 150 129;
--shard-success: #3e8c7d;
--shard-success-rgb: 62 140 125;
--shard-info: #2e6e79;
--shard-info-rgb: 46 110 121;
--shard-warning: #be7c32;
--shard-warning-rgb: 190 124 50;
--shard-danger: #b6533c;
--shard-danger-rgb: 182 83 60;
--shard-emerald: var(--shard-success);
--shard-emerald-rgb: 62 140 125;
--shard-amber: var(--shard-warning);
--shard-amber-rgb: 190 124 50;
--shard-ruby: var(--shard-danger);
--shard-ruby-rgb: 182 83 60;
--shard-editor-tag-fg: var(--shard-info);

--shard-radius-control: 4px;
--shard-radius-card: 6px;
--shard-radius-panel: 8px;
--shard-surface-radius: var(--shard-radius-card);
```

Radius：

- App panels：0
- Controls：`--shard-radius-control`
- Composer、片段卡片、popover 和 dialog：`--shard-surface-radius`
- 大面板：`--shard-radius-panel`
- Surface 内的 inputs：当它们构成 surface 边缘时继承父 surface radius
- Buttons 和 inputs：4px
- Badges 和状态 tags：4px

Borders：

- 结构分隔：1px solid `--border`
- Composer：1px solid `--border`；focus border 通过 `--shard-sapphire` 使用当前强调色
- Cards：默认无边框
- Focus/edit card：只有存在明确选中或编辑状态时，使用 1px solid 当前强调色

Shadows：

- 默认避免使用。
- 只在 popovers 需要时使用：小 elevation、低 opacity。

## 字体排版

flomo 启发的 composer 字体要求：

- 首选拉丁字体：`Barlow`
- 中文/系统 fallback：`"PingFang SC", "Microsoft YaHei", Helvetica, Arial, sans-serif`
- 在 Tauri 桌面应用中，不要运行时拉取 Google Fonts。先使用字体栈，如果之后需要精确拉丁字形一致性，再本地打包 Barlow。

使用这个字体栈：

```css
font-family: "Barlow", "PingFang SC", "Microsoft YaHei", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
```

文字尺度：

- App title：22px / 28px，700
- Section labels：13px / 18px，600
- Body/card text：14px / 25.2px，400
- Metadata：13px / 20px，400
- Button/control text：13px / 18px，600
- Tag text：12px / 16px，600

规则：

- 不使用基于 viewport 的字号缩放。
- Letter spacing 保持 0。
- 中文正文在默认桌面缩放下必须保持可读。

## shadcn 组件

初始组件集：

- `Button`
- `Badge`
- `Textarea`
- `Input`
- `ScrollArea`
- `Separator`
- `Tooltip`
- `DropdownMenu`
- `Popover`
- `Dialog`
- `Sheet`
- `Tabs`
- `Switch`
- `Command`
- `Sonner`
- `Spinner`

Shard 特定组件：

- `AppShell`
- `SidebarNav`
- `BottomTabs`
- `CaptureBox`
- `EditorToolbar`
- `FragmentTimeline`
- `FragmentCard`
- `FragmentContent`
- `FragmentEditor`
- `FragmentDetailPanel`
- `MarkdownDocument`
- `ReviewWorkspace`
- `TaggedPanel`
- `VaultGuide`
- `StatusBadge`
- `TagBadge`
- `TagCompletionPopover`

组合规则：

- 使用 `Badge` 表示标签和状态 chip。
- 使用 `Textarea` 进行捕获，不使用 contenteditable div。
- Composer 的 list/checklist 和行内格式控件使用 Markdown 文本插入，不在 textarea 内使用富文本 widgets。
- 卡片 overflow actions 使用 `DropdownMenu`。
- 纯图标按钮使用 `Tooltip`。
- 底部对齐的边缘动作行使用 `.shard-edge-action-row`；不要围绕动作按钮独立调水平 padding 和底部 padding。
- 破坏性确认使用 `Dialog`。
- 之后用 `Command` 做快速搜索 / command palette。
- 保存/同步错误使用 `Sonner`。

## 交互规则

Capture：

- 应用启动时聚焦 capture textarea。
- `Enter` 或 `Shift+Enter` 插入换行。
- `Cmd+Enter` 或 `Ctrl+Enter` 创建片段。
- IME composition 不得提前提交；composition 活跃时忽略保存快捷键。
- 空内容或仅空白内容提交会被忽略。
- 提交后 textarea 立即清空。

卡片动作：

- 单击卡片不会打开常驻 inspector。
- 明确 edit 或 overflow action 之后可以打开 Sheet/Dialog。
- `Esc` 关闭临时编辑/详情表面。

手动标签：

- 标签在卡片上可见。
- 在 capture box 中输入 `#` 会触发标签输入和已有标签建议。
- 保存片段时，把内联 `#tag` tokens 提取到 frontmatter tags。
- 标签编辑发生在详情面板或紧凑 popover 中。
- v1 中避免在 timeline 内进行内联标签编辑，除非它能保持简单。

AI：

- AI 建议是 opt-in，不自动执行。
- AI 绝不改写正文。
- AI 只在用户批准后写入建议标签/分类。
- AI 更新与创建 commit 分开提交。

Git：

- `committed` 为绿松石。
- `sync pending` 为暖琥珀。
- `commit failed` 为陶土红。
- Git 失败绝不移除卡片，也不阻塞继续输入。
- Git / GitHub CLI / 文件系统扫描或读写 / 网络请求 / 外部进程必须后台执行，不得卡住 WKWebView 或 UI 线程。
- 配置、创建仓库、同步等 Git 流程必须以异步状态驱动局部组件 loading / disabled / `aria-busy`，成功后保留用户当前上下文，除非用户明确选择关闭或切换。

## 响应式行为

因为这是 Tauri 应用，所以 desktop-first。

断点：

- >= 1200px：左侧栏加双列卡片网格。
- 900-1199px：左侧栏加一列或两列卡片，取决于内容宽度。
- < 900px：左侧栏折叠为紧凑底部 tabs。

每种布局中，capture input 和 timeline 都保持可见。

## 空状态

空状态不应变成 onboarding 营销文案。

首选：

- 输入仍然是主要对象。
- Timeline 区域显示一行安静文字：
  `还没有片段。写下第一条，按 Cmd/Ctrl+Enter 保存。`
- 不需要插图。

## 可访问性

- 所有图标按钮都需要 labels/tooltips。
- 卡片必须可通过键盘选中。
- 状态不能只依赖颜色；需要包含文字。
- Dialog/Sheet title 必须存在，即使视觉上隐藏。
- Focus ring 必须保持可见。
- 尊重 reduced motion。

## 设计锁定项

要做：

- 保持首个 viewport 就是可用应用。
- 使用安静纸片卡片；实线边框只用于结构、焦点和明确的容器 surface。
- 保持 AI 次要。
- 让 Git 状态可见但小。
- 让中心时间线成为主对象。

不要做：

- 添加 landing page。
- 添加 hero section。
- v1 添加 graph view。
- v1 添加 kanban board。
- 把 cards 放进另一个 card。
- 使用渐变或装饰性背景效果。
- 让 AI 建议在视觉上比捕获的片段更响亮。

## 实现说明

脚手架 shadcn 时，选择 Base UI 作为 primitive base。实现时使用当前 shadcn CLI 文档，因为 shadcn/Base UI API 正在快速变化。

如果生成的组件使用 Base UI `render` 组合，确保自定义组件 forward refs 并 spread props。

主要实现成功标准是视觉和行为：

- 应用打开后进入聚焦的 capture box。
- Cmd+Enter 或 Ctrl+Enter 创建一张卡片。
- 卡片看起来像实线纸片。
- 时间线在至少 24 个片段时仍保持可读。
- 没有 AI 时 UI 仍然有用。
