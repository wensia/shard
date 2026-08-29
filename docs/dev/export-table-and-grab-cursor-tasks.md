# 遗留问题施工清单：导出表格 + 空格抓手光标

依据：council-20260826-183006（codex / grok / kimi / antigravity，主席裁决 HIGH）
创建：2026-08-27

## 全局约束

- 遵守 `AGENTS.md` Runtime Rules：重操作异步化；Tauri 侧原生调用放主线程。
- 前端设计系统以 `vendor/kiln/` 为唯一真相源；导出模板沿用 `template` 对象里已有的配色字段，不新造颜色常量。
- 精准修改，不顺手重构无关代码。
- 每项任务跑通对应验收命令，失败不得声称完成。

---

# 任务组 A：Canvas 导出支持表格

**背景**：`src/lib/fragment-export-image.ts`（822 行）是独立的 Canvas 2D 导出链路，表格目前被逐行画成原始 `| 日期 | 学校 |` 源码。

**已否决的方向（不要做）**：
- 不要改成 DOM→图片（SVG `foreignObject` 在 WKWebView 上有 canvas tainting、外部字体不加载、CSS 子集随版本漂移的已知问题）
- 不要引入 html2canvas 或任何新依赖
- 不要画等宽 ASCII 伪表格（与三套海报模板的视觉语言冲突）
- 不要为超宽表格做竖排 key/value 降级（整图高度会暴涨）

## A1 表格 block 接入块聚合

**文件**：`src/lib/fragment-export-image.ts`

1. `ExportBlock` 联合类型新增：

```ts
| {
    kind: "table"
    header: string[]
    rows: string[][]
    align: TableAlign[]
  }
```

2. `fragmentToBlocks`（约 594 行）从逐行 `map` 改成 `while` 块聚合，与 `fragment-content.tsx` 主循环同构：遇到 `parseMarkdownTable(lines, index)` 返回非 null 就 push table block 并 `index += table.lineCount`，否则走原有逐行逻辑。

3. 从 `@/lib/markdown-table` 导入 `parseMarkdownTable` 与 `TableAlign`，**不要重写解析**。

**验收**：`pnpm build` 通过；含表格的片段产出的 blocks 里出现 `kind: "table"`，且表格那几行不再作为 text block 出现。

## A2 列宽计算

**文件**：`src/lib/fragment-export-image.ts`

新增纯函数（不依赖 DOM，便于推理）：

```ts
function layoutTableColumns(
  context: CanvasRenderingContext2D,
  table: Extract<ExportBlock, { kind: "table" }>,
  contentWidth: number
): { widths: number[]; visibleColumnCount: number; truncatedColumns: boolean }
```

算法（**严格按此实现**）：

1. **intrinsic 测量**：每列宽 = 该列所有单元格（含表头）`context.measureText(text).width` 的最大值 + `TABLE_CELL_PADDING_X * 2`。表头用粗体字体串测量。
2. **不拉满**：若 `sum(widths) + gaps <= contentWidth`，直接用 intrinsic 值，表格靠左，右侧留白。导出图不是电子表格，不要把列拉伸填满宽度。
3. **等比压缩**：若超出，按每列「可压缩量 = width - TABLE_MIN_COL_WIDTH」等比例收缩到刚好放下。
4. **丢列**：压缩到地板值仍然放不下时，从左往右保留能完整放下的列，其余列丢弃，`truncatedColumns` 置 true。丢列后在表格右侧画一个窄的 `…` 标记列（宽度约 16px），**不要静默裁切**。

常量（相对模板内容宽，参考 `layout.contentWidth`）：

```ts
const TABLE_CELL_PADDING_X = 10
const TABLE_CELL_PADDING_Y = 6
const TABLE_MIN_COL_WIDTH = 36
const TABLE_MAX_CELL_LINES = 2
const TABLE_ELLIPSIS_COL_WIDTH = 16
```

**验收**：`pnpm build` 通过。

## A3 表格绘制并接入两遍流程

**文件**：`src/lib/fragment-export-image.ts`

`renderBody`（约 364 行）已经是 `{ draw, maxY, y }` 的两遍流程（`measureImageHeight` 传 `draw: false` 先算高，`drawTemplate` 再画）。表格必须**同样在两遍里给出一致的高度**，否则整图高度会算错。

在 `renderBody` 的 block 分派里新增 `block.kind === "table"` 分支：

1. 用 A2 得到列宽
2. 每个单元格用**已有的** `wrapText`（约 673 行）折行，**最多 `TABLE_MAX_CELL_LINES` 行**，超出的最后一行用 `…` 截断
3. 行高 = 该行所有单元格折行后的最大高度 + `TABLE_CELL_PADDING_Y * 2`
4. `draw: false` 时只累加 y，不调用任何绘制 API
5. `draw: true` 时绘制：表头底色矩形、1px 边框线、逐格 `fillText`，按 `table.align` 决定每格 x 起点（left / center / right，`null` 视为 left）
6. 颜色一律取自 `template` 已有字段（表头底色与分隔线复用模板里已有的浅色/线色字段），**不要新增硬编码颜色**
7. 沿用现有 `maxY` 截断语义：表格跨过 `maxY` 时按现有方式截断，不要为表格特例化

**验收**：
- `pnpm build`、`pnpm test:ui` 现有 33 项全绿
- 新增 Playwright 测试：导出含表格的片段，断言导出流程不抛错且产出的 PNG blob 尺寸大于 0
- 手工核对：`measureImageHeight` 与 `drawTemplate` 对同一含表格片段算出的 y 推进量一致（可用临时断言或单测验证，**这条是整图高度正确的关键**）

---

# 任务组 B：空格抓手光标

**现象**：思维导图画布按住空格（抓手工具）时，指针先消失，移动鼠标后才变成抓手。期望按下瞬间即为抓手。

**根因**（council 一致确认）：两件事叠加 ——
1. WebKit 主要在 mouseMoved 时才 `updateCursor()`，改 CSS class 不会立刻反映到 `NSCursor`
2. macOS 对会产生字符的按键（空格 U+0020）调用 `setHiddenUntilMouseMoves(true)`，把指针藏到下次移动

**已证伪，不要重试**：
- `event.preventDefault()`：`handleKeyDown` 里**已经有了**，问题依旧（拦得住字符插入，拦不住指针隐藏）
- 不上主线程的 `NSCursor::setHiddenUntilMouseMoves(false)`
- Tauri `window.set_cursor_icon(CursorIcon::Grab)`：会被 WKWebView 的 CSS 光标覆盖

## B1 移除 DOM 覆盖层

**文件**：`src/components/shard/mind-map-canvas-editor.tsx`

上一轮加的「按住空格时插入全画布覆盖层」要**整段移除**（council 3:1 反对）：它解不开系统的指针隐藏，却引入了第二套 pointer 命中路径，框选、节点拖拽、hover、右键都有回归风险。

1. 删除 `spaceHeld ? (<div … cursor: grab … onPointerDown={startCanvasPointer} />) : null` 整块
2. `startCanvasPointer` 与 `suppressNativeCanvasSelection` 的参数类型从 `ReactPointerEvent<Element>` 还原为 `ReactPointerEvent<SVGSVGElement>`
3. **保留** CSS 侧的 `.canvasSvgSpacePan` 及其子元素覆盖规则——鼠标真正移动之后仍要靠它维持稳态

**验收**：`pnpm build` 通过；`pnpm test:ui` 全绿（尤其 `mind map canvas marquee selects nodes and space-drag pans` 必须仍通过）

## B2 补齐原生光标调用

**文件**：`src-tauri/src/lib.rs`

现有 `set_canvas_grab_cursor` 只做了 `setHiddenUntilMouseMoves(false)` + `set()`。缺两件事：

1. **`unhide()` 必须调**。`setHiddenUntilMouseMoves(false)` 与 `unhide()` 是**两套不同机制**，只调前者不足以让已隐藏的指针立刻回来。顺序固定为：

```rust
NSCursor::setHiddenUntilMouseMoves(false);
NSCursor::unhide();
if active { NSCursor::openHandCursor().set(); } else { NSCursor::arrowCursor().set(); }
```

2. **下一个 runloop 再执行一次同样的三句**（仅 `active == true` 时）。WebKit 可能在 IPC 完成之后仍用过期的 hit-test 结果把光标设回箭头，重设一次才能赢过这个延迟的 cursorUpdate。用再排一次 `run_on_main_thread` 实现即可，不要用 sleep。

3. 全部仍在 `window.run_on_main_thread` 内执行（NSCursor 只能主线程）。

4. 顺手移除现有的诊断日志 `eprintln!("[shard] set_canvas_grab_cursor …")`。

**验收**：`cargo check` 通过；`cargo test` 23 项全绿。

**注意**：这个修复**无法用自动化测试验证**（原生指针不经过 DOM，Playwright 观测不到），需要人工在真实窗口里确认。不要为它编造通过的测试。

## B3 记录升级路径（只写文档，不实现）

在 `docs/dev/` 对应文档里记下：若 B2 之后光标**仍**需移动鼠标才出现，下一步依次是

1. 在 command 里对当前鼠标位置做**零位移** `CGWarpMouseCursorPosition` —— 这会生成真实的 mouseMoved，强迫 WebKit 重算；副作用是可能扰动鼠标加速，所以不作为首选
2. 再失败则改为**自绘光标**：`NSCursor::hide()` 后在画布上跟随指针画一个抓手 SVG，松开恢复。这是画布类应用的常规做法，比继续和 WKWebView 抢 `NSCursor` 干净

**明确不要做**：用 `NSEvent` local monitor 在事件到达 WebView 前拦截空格 —— 原生侧无法可靠判断焦点是否在 textarea/IME 里，会误伤 composer 的空格输入。焦点判断必须留在现有 JS（`isTextInputTarget` / `isComposing` / `repeat`）。
