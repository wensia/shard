# 宫格缩略图：每种文件显示内容预览（IA 重整第十四批 L）

## Context

用户诉求：**「文件宫格展示的图标应该改为缩略图」**。

这切中了宫格的存在意义——**只显示类型图标的话，宫格跟列表没有本质区别**，还更占空间。Finder 的图标视图对文档同样显示内容预览。第十一批 D3 定的「不生成缩略图」是针对图片的性能取舍，不该被推广成「所有类型都只画图标」。

现状：图片格已有缩略图（第十一批），md / csv / 导图格仍是类型图标。

## 分类型策略

| 类型 | 数据来源 | IO 成本 | 缩略图形态 |
| --- | --- | --- | --- |
| 图片 | 已实现（`AssetThumbnail`） | 已解决 | 原图缩放 |
| **md** | **内存中的 `Fragment.content`** | **零** | 前若干行文本预览 |
| **导图** | `readMindMap(id)` 异步 | 每文件一次 | `layoutMindMap` 结构简图（SVG） |
| **csv** | `readCsvFile(path)` 异步 | 每文件一次 | 前几行极简表格 |
| 目录 | 无内容可预览 | — | 保持文件夹图标 + 条目数 |

**md 是零成本的**：`library-shell.tsx:185` 的 `notes` 由 `fragments` 派生，`Fragment.content`（`types.ts:25`）已在内存里，直接取用即可，不需要任何新的读取。

## 核心裁决

| # | 裁决 |
| --- | --- |
| D1 | **按类型分级投入**：md 零成本立即渲染；导图 / csv 走懒加载；目录不做预览（它没有"内容"）。不要为了统一而给 md 也套异步加载。 |
| D2 | **懒加载 + 视口触发**：导图与 csv 用 `IntersectionObserver`，只有格子进入视口才发起读取。宫格一屏十几个格子，不能一次性读全部文件。 |
| D3 | **缓存键 = `path + modifiedAt`**（`modifiedAt` 是第十二批加的字段）。文件改了缓存自然失效，不需要手动清理。缓存放模块级 `Map`，不进 React state。 |
| D4 | **降级到类型图标**：加载中、加载失败、内容为空，一律回退到现有的类型图标渲染。缩略图是增强，不是必需——任何一环出错都不能让格子空白或崩溃。 |
| D5 | **导图缩略图只画结构不画文字**：`layoutMindMap(file)` 拿 `bounds` + `edges` + 节点坐标，节点画小圆角矩形、边画细线，`viewBox` 用 `bounds` 自适应。缩略图尺寸下文字不可读，画了只会糊成一团。 |
| D6 | **不引入任何渲染库**。SVG 手写，文本预览用 CSS `line-clamp`，表格用原生 `<table>`。 |

## 非目标

- 不做 Rust 侧缩略图生成与磁盘缓存（沿用第十一批 R2 的判断：等实测出性能问题再说）。
- 不做 PDF / 视频等新类型的预览（当前 vault 里没有）。
- 不改图片格的现有实现（`AssetThumbnail` 已验证可用）。
- 不做缩略图尺寸的用户可调（宫格列宽已由 `minmax` 自适应）。
- 不在列表视图里加缩略图（列表的价值是密度与元数据列）。

---

## T14.1 预览数据层

**文件**：新建 `src/lib/library-preview.ts`

**做什么**

1. 定义预览数据类型：
   ```ts
   type LibraryPreview =
     | { kind: "text"; lines: string[] }
     | { kind: "mindmap"; layout: MindMapLayout }
     | { kind: "table"; rows: string[][] }
   ```
2. 模块级缓存 `Map<string, LibraryPreview>`，key 为 `${path}::${modifiedAt}`（D3）。
3. 导出 `loadLibraryPreview(entry): Promise<LibraryPreview | null>`：
   - `markdown` → **不走这里**，由调用方直接用内存 content（D1）
   - `mindmap` → `readMindMap(id)` → `layoutMindMap(file)`，返回 `{ kind: "mindmap", layout }`
   - `csv` → `readCsvFile(path)` → 复用既有 CSV 解析取前 4 行 × 前 4 列，返回 `{ kind: "table", rows }`
   - 其他 → `null`
4. 失败一律 `return null`，**不抛异常**（D4）。
5. 导出 `extractTextPreview(content: string): string[]`：剥掉 frontmatter，取前 6 个非空行，每行截断到 40 字符。

**验收**：`pnpm build && pnpm test:unit` 通过；单测覆盖 frontmatter 剥离与行截断

**禁止**：不要在这里做 React 状态管理；不要引入渲染库；不要新增 Tauri command

---

## T14.2 宫格格子渲染缩略图

**文件**：`src/components/shard/asset-grid.tsx`（`LibraryItemGrid`）、对应 `.module.css`

**做什么**

1. 新增 `LibraryItemThumbnail` 组件，按 `item.kind` 分派：
   - `image` → 复用现有 `AssetThumbnail`（**不要改它**）
   - `markdown` → 调用方传入的 content 经 `extractTextPreview` 渲染多行文本
   - `mindmap` / `csv` → 懒加载（T14.3）后渲染
   - `directory` → 文件夹图标 + `N 项`（现状保持）
2. **md 的 content 由 `library-shell` 传入**：`LibraryItemGrid` 的 item 增加可选 `content?: string` 字段，`library-shell` 从 `notes` 里按 path 匹配填入。不要让宫格组件自己去查 fragments。
3. 文本预览样式：小字号、`line-clamp`、左对齐、`overflow: hidden`，消费 Kiln token。
4. 导图 SVG：节点小圆角矩形、边细线、`viewBox` 用 `layout.bounds`、`preserveAspectRatio="xMidYMid meet"`，颜色用 Kiln token（`--muted-foreground` 类），**不画文字**（D5）。
5. csv 表格：原生 `<table>`，前 4 行 × 4 列，无边框仅细分隔线，超出裁剪。
6. 任何一类渲染不出来时回退类型图标（D4）。

**验收**：`pnpm build` 通过；UI 用例见 T14.4

**禁止**：不要改 `AssetThumbnail`；不要在宫格里加交互（点击行为不变）；不要新造色板

---

## T14.3 懒加载

**文件**：`src/components/shard/asset-grid.tsx`

**做什么**

1. 用 `IntersectionObserver` 观察每个需要异步预览的格子（`mindmap` / `csv`），进入视口才调 `loadLibraryPreview`（D2）。
2. 组件卸载时断开 observer，避免 setState-after-unmount。
3. 同一 `path::modifiedAt` 命中缓存时**同步返回**，不重复读取（D3）。
4. `markdown` 与 `directory` **不参与懒加载**（前者零成本，后者无预览）。

**验收**：`pnpm build` 通过；滚动长列表时不应一次性发起全部读取

**禁止**：不要用轮询或定时器替代 IntersectionObserver；不要给 md 也套异步

---

## T14.4 测试

**做什么**

1. **Vitest**（`src/lib/library-preview.test.ts`）：
   - `extractTextPreview` 正确剥离 frontmatter
   - 空行被跳过、超长行被截断、行数封顶
   - 内容为空时返回空数组
2. **Playwright**：
   - 宫格里 md 格显示**文本预览**而非类型图标（断言预览文本可见）
   - 宫格里导图格渲染 SVG 结构（断言 svg 元素存在）
   - 读取失败时降级为类型图标，格子不空白、不报错
   - 列表视图**不受影响**（无缩略图，回归保护）
   - 图片格现有缩略图行为不变（回归保护）
3. mock：若 spec 需要 `read_mind_map` / `read_csv_file` 返回值，按既有 mock 风格补齐。
4. 断言用 `exact` 或区域限定。

**验收命令**（三条全绿）：

```bash
cargo test --manifest-path src-tauri/Cargo.toml
pnpm build && pnpm test:unit
pnpm test:ui
```

**禁止**：不要放宽既有断言

---

## 主要风险

- **R1 · 异步加载导致格子闪烁**：先渲染类型图标、加载完再替换，会有一次跳变。可接受，但不要为此加骨架屏动画（过度设计）。
- **R2 · 大目录性能**：一屏十几个格子各读一次文件。靠 IntersectionObserver 限制在视口内，且有缓存兜底。若实测仍慢，缩略图缓存另行立项，**不要在本批临时加**。
- **R3 · 导图 layout 成本**：`layoutMindMap` 对大导图有计算量。缓存后每个文件只算一次；若单张导图节点数极多导致卡顿，可在 T14.1 里对节点数设上限、超限返回 `null` 降级图标。
- **R4 · md content 与磁盘不同步**：内存里的 `Fragment.content` 是已加载的快照，若文件被外部改动，预览可能滞后。与既有笔记列表同性质，不额外处理。
