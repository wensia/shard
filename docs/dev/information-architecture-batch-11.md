# 资料库容纳图片资源 + 按类型选形态（IA 重整第十一批 I）

## Context

用户定调：**「资料库应该是一个文件管理，可以使用列表或者目录格的形式展示，这样对文件格式的支持才更好」**。

查证后发现这个诉求包含两层，而第二层是第一层的前提：

**第一层 · 视图形态**：资料库当前只有树。`LibraryTreeEntry` 全部字段只有 `{ name, path, kind, children }`（`src/types.ts:71-76`）——没有大小、没有修改时间、没有预览。列表视图要的元数据列一个都没有，网格视图要的缩略图能力全仓库也没有。

**第二层 · 文件类型覆盖**：`build_library_tree`（`lib.rs:2465`）只扫 `notes/`，加上第七批的 `maps/`。而 vault 顶层是 `fragments/ notes/ archive/ assets/ maps/ lockbox/ .shard/`（`lib.rs:48`）——**`assets/` 完全不在资料库里**，那里存着全部图片附件。

网格视图的价值几乎全部来自图片，而图片恰恰是唯一不在地图上的东西。先做网格只会得到"格子里全是文档图标"的空壳。

## 关键发现：图片没有名字

`save_fragment_image`（`lib.rs:1866-1890`）是**内容寻址存储**：

```rust
let hash = hash_bytes(&bytes);
let dir = vault.join("assets").join(&hash[..2]);
let path = dir.join(format!("{hash}.{extension}"));
```

- 路径形如 `assets/a3/a3f5e8c9....png`，**文件名就是内容哈希**
- `save_fragment_image` 的 `_file_name` 参数带下划线前缀，**原始文件名被直接丢弃**
- 同内容同哈希，`if !path.exists()` 才写，去重天然

**这推翻了「先补数据层、再做视图形态」的分批直觉**：对图片而言，网格不是增强形态，而是**最小可用形态**——树或列表里显示 `a3f5e8c9d2...png` 对用户毫无意义，图片自己就是自己的标识。

## 本批的核心裁决

| # | 裁决 |
|---|---|
| D1 | **按类型选形态，不强求统一。** 每种内容用适合它的形态：`notes/` 有文件名 → 树展开；导图有标题 → 树展开；碎片有时间 → 分组节点进第三栏时间线；**图片无名字 → 分组节点进第三栏网格**。这正是「对文件格式的支持更好」的落点。 |
| D2 | **不做全局视图切换**（树/列表/网格三态）。那是第十二批。本批只让图片在第三栏用网格——因为那是它的最小可用形态，不是增强。 |
| D3 | **不生成缩略图。** 复用 `src/lib/fragment-images.ts` 的 `loadFragmentImageSrc` → `convertFileSrc(hash, "shard-attachment")` 自定义协议（浏览器流式加载，不走 base64），配合 `loading="lazy"` 与 CSS 缩放。缩略图缓存留给实测出性能问题后再做。 |
| D4 | 图片在树上是**单个分组节点**「图片（N）」，不可展开列单文件（hash 名无意义），与碎片流同构。 |
| D5 | `LibrarySelection` 加第五支 `{ kind: "assets"; path?: string }`——无 `path` 时第三栏显示网格，有 `path` 时显示单张大图。selection 仍是组件 state 不进路由。 |
| D6 | 树排序沿用第十批 D5 原则「就地内容在上、传送门在下」：碎片流 → 图片 → 思维导图 → notes 树 → 密匣挂载点殿后。图片紧邻碎片流（都是无名字的就地内容）。 |

## 非目标

- **不做引用计数与孤儿检测**（「这张图被哪几篇文档引用」「哪些图没人用」）。需要全库正文扫描 `![](assets/...)` 建反向索引，与第九批非目标里的「导图反链」是同一类成本，一并留待「全库正文引用索引」单独立项。孤儿图片清理是真实需求，但不在本批。
- **不做全局视图切换**（第十二批）。
- 不做图片编辑、裁剪、格式转换。
- 不改图片存储结构（内容寻址与去重保持原样）。
- 不给图片加重命名/移动能力——内容寻址下路径由哈希决定，重命名无意义。

---

## T11.1 Rust：枚举 assets/ 并返回元数据

**文件**：`src-tauri/src/lib.rs`

**做什么**

1. `LibraryTreeSnapshot` 新增字段 `assets: Vec<LibraryAssetEntry>`，新结构体：
   ```rust
   struct LibraryAssetEntry {
       path: String,        // vault 相对路径 assets/xx/<hash>.<ext>
       size: u64,
       modified_at: String, // rfc3339
       mime_type: String,
   }
   ```
   serde camelCase，前端读到 `assets`。
2. 递归扫描 `vault.join("assets")`，跳过符号链接与隐藏目录（复用 `collect_mind_map_files` 的防护写法）。
3. `mime_type` 用既有的 `image_mime_type` / `sniff_image_mime_type` 判定；**非图片文件跳过**（本批只收图片，不收将来可能出现的其他资源）。
4. 按 `modified_at` 倒序返回（新图在前）。
5. 单个文件读取失败（权限、损坏）**跳过而非整树报错**，与第七批导图的处理一致。
6. **不改 `save_fragment_image` / `read_fragment_image` / `fragment_image_file_path`**，本批只加枚举。

**验收**：`cargo test` 通过；新增单测见 T11.5

**禁止**：不要改图片存储路径规则；不要在 Rust 侧生成缩略图；不要扫描正文建引用索引（见非目标）

---

## T11.2 前端：资料库树加「图片」分组节点

**文件**：`src/types.ts`、`src/workspace/library-shell.tsx`

**做什么**

1. `src/types.ts` 补 `LibraryAssetEntry` 类型与 `LibraryTreeSnapshot.assets`。
2. `LibrarySelection` 加第五支 `{ kind: "assets"; path?: string }`（第十批后现有四支：note / mindmap / fragments / null）。
3. 树上新增**不可展开**的分组节点「图片（N）」，位置按 D6：**碎片流之后、思维导图之前**。
4. 点击分组头 = `selectAssetsView()`——与既有 `selectFragmentsView` / `selectMindMap` **同构**：先 `saveCurrentNote()` flush 草稿，成功才 `setSelection({ kind: "assets" })`，清树高亮哨兵、`setIsZen(false)`、`setMobilePane("editor")`。
5. `assets` 为空时分组节点不渲染（不显示「图片（0）」）。

**验收**：`pnpm build` 通过；UI 用例见 T11.5

**禁止**：不要让图片分组可展开；不要给图片加重命名/移动/删除菜单；不要动其他分组节点的顺序以外的行为

---

## T11.3 第三栏图片网格

**文件**：新建 `src/components/shard/asset-grid.tsx`（+ `.module.css`），`src/workspace/library-shell.tsx`

**做什么**

1. `renderSelectedViewer` 加 `assets` 分支：`selection.path` 为空 → `AssetGrid`；有 `path` → 单张大图视图。
2. `AssetGrid`：CSS Grid 自适应列宽（`repeat(auto-fill, minmax(...))`），每格显示图片 + 底部元信息（大小、日期）。
3. 图片加载**复用 `src/lib/fragment-images.ts` 的 `loadFragmentImageSrc`**，不要新写加载逻辑、不要走 base64。每个 `<img>` 加 `loading="lazy"`。
4. 点击格子 → `setSelection({ kind: "assets", path })` 显示单张；单张视图提供「返回图片列表」。
5. 单张视图显示：大图 + 路径 + 大小 + 修改时间，并复用既有的 `getFragmentImageFilePath` / `revealFragmentImageInDir` 提供「在访达中显示」。
6. 空态文案：「还没有图片附件」。
7. 尺寸与间距消费 Kiln token，**不新造色板与阴影**。

**验收**：`pnpm build` 通过；UI 用例见 T11.5

**禁止**：不要生成缩略图；不要新增 Tauri command（读取走既有通路）；不要给网格加多选/批量操作

---

## T11.4 禅模式与第四栏的处理

**文件**：`src/workspace/library-shell.tsx`

**做什么**

1. **禅模式对 assets 视图隐藏禅按钮**——与第十批对 fragments 视图的处理一致（列表/网格无「专注编辑」语义）。单张大图视图**可以**进禅模式（全屏看图有意义）。
2. **第四栏对 assets 一律空态**——与第十批 fragments 的处理一致（网格是列表视图，无单一可检查对象）；单张视图本批也保持空态（引用计数在非目标里）。
3. 移动端两级导航（`mobilePane`）对 assets 视图同样生效。

**验收**：`pnpm build` 通过

**禁止**：不要为 assets 造新的第四栏面板

---

## T11.5 测试

**做什么**

1. **Rust 单测**：
   - `assets/` 下的图片出现在 `build_library_tree` 的 `assets` 字段，含 size / modified_at / mime_type
   - 非图片文件被跳过
   - 损坏/不可读文件被跳过，其余图片与 `notes/` 条目仍正常返回
   - `notes` entries 与 `mind_maps` 不受影响（回归保护）
2. **Playwright**：
   - 资料库树出现「图片（N）」分组，点击后第三栏显示网格，侧栏与目录树仍可见
   - 点击格子进单张视图，可返回列表
   - assets 视图**无禅按钮**、第四栏为空态
   - 图片为空时不渲染分组节点
   - 打开笔记/导图/碎片流的既有行为不受影响（回归保护）
3. **补齐全部 spec 文件的 mock**：`list_library_tree` 返回值新增 `assets` 字段后，**所有** mock 该命令的 spec 都要同步补上，否则壳层拿到 `undefined` 会连锁失败（T5 与第七批的同一个坑，第七批补了 9 个 spec、21 处字面量）。
4. 断言用 `exact` 或区域限定：「图片」二字容易撞既有文案，必须用 `treePane` 或视图区域限定。

**验收命令**（三条全绿，既有用例只增不减）：

```bash
cargo test --manifest-path src-tauri/Cargo.toml
pnpm build && pnpm test:unit
pnpm test:ui
```

**禁止**：不要放宽既有断言

---

## 主要风险

- **R1 · mock 扩散**：`LibraryTreeSnapshot` 加字段会波及所有 mock `list_library_tree` 的 spec。这是本批最大的踩坑点，第七批同样的改动补了 9 个文件、21 处字面量。
- **R2 · 大 vault 性能**：`assets/` 可能有几百上千张图。本批靠 `loading="lazy"` 与自定义协议扛，不做缩略图。若实测卡顿，缩略图缓存（`.shard/thumbnails/`）单独立项，**不要在本批临时加**。
- **R3 · 网格与禅模式的交互**：网格本身不进禅模式，单张大图可以——两者用同一个 `ZenSurface`，不要为看图新造全屏。
- **R4 · 图片被删后的悬挂引用**：正文里 `![](assets/...)` 指向已删图片时，网格不显示它但正文仍引用。本批不处理（属于引用索引范畴，见非目标）。

## 后续批次

- **第十二批 J · 全局视图形态切换**：树 / 列表 / 网格三态，需要 `LibraryTreeEntry` 补 size/mtime 元数据，并解决目录层级在网格下的表达。
- **全库正文引用索引**（未编号）：一次性解决导图反链（第九批非目标）、图片引用计数与孤儿检测（本批非目标）。这两个需求同源，应合并立项。
