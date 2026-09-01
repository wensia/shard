# 目录可打开 + 列表/宫格视图切换（IA 重整第十二批 J）

## Context

用户诉求：**「资料库应该是一个文件管理，可以使用列表或者目录格的形式展示」**，目标定为「文件管理系统实现宫格目录和列表」。

第十一批（I）解决了图片进资料库并用网格展示；本批解决**通用的文件管理形态**——目录可打开、内容可用列表或宫格浏览。

## 现状缺口

**目录不是可打开的对象。** `library-shell.tsx:755-758` 点击目录只做一件事：

```tsx
if (entry.kind === "directory") {
  toggleSetValue(setExpandedPaths, entry.path)
  return
}
```

只展开/折叠树节点，第三栏毫无反应。`LibrarySelection`（第十/十一批后为 note / mindmap / fragments / assets / null）**没有 directory 支**。

后果：Shard 有树导航，但没有"浏览一个目录里有什么"的主区域——而这正是文件管理器的核心动作。`selectedTreePath` 只被用来决定新建文件落在哪个目录（`:623-628`），不驱动内容展示。

**元数据缺失**：`LibraryTreeEntry` 只有 `{ name, path, kind, children }`，列表视图要的 size / mtime 一个都没有。

## 核心裁决

| # | 裁决 |
|---|---|
| D1 | **采用 Finder 模型**：第二栏树 = 位置导航，第三栏 = 当前位置的内容。点目录**同时**做两件事——展开树节点（导航）+ 在第三栏显示该目录内容（浏览）。不是二选一。 |
| D2 | `LibrarySelection` 加第六支 `{ kind: "directory"; path: string }`。`notes/` 根目录也可选中（显示顶层内容）。selection 仍是组件 state 不进路由。 |
| D3 | **视图形态是第三栏的属性，不是全局属性**：切换按钮放在第三栏头部，只在 `directory` selection 下出现。笔记/导图/碎片流/图片网格各有自己的固定形态，不受这个开关影响。 |
| D4 | **视图偏好全局单值**，存 localStorage（键 `shard.library-directory-view`，取值 `list` / `grid`），不做 per-directory 记忆——Finder 那套每目录记忆的复杂度不值得，且用户 vault 目录数量有限。 |
| D5 | **宫格组件从第十一批的 `AssetGrid` 泛化**，不新造第二套。图片格显示缩略图（复用 `loadFragmentImageSrc`），非图片格显示类型图标 + 名字，目录格显示文件夹图标 + 条目数。 |
| D6 | 列表视图列：名称 / 类型 / 大小 / 修改时间。点击行为与树一致（目录→进入该目录，文件→在第三栏打开对应查看器）。 |
| D7 | **双击不引入**。单击即打开，与树的既有交互一致；桌面端双击语义留给将来重命名。 |

## 非目标

- **不做全局视图切换**（把第二栏的树本身换成列表/宫格）。树是导航，保持树形；形态切换只作用于第三栏的目录内容。
- 不做排序/筛选/搜索栏（列表列头点击排序留待后续）。
- 不做多选与批量操作、不做拖拽移动（既有的「移动到…」菜单保持不变）。
- 不做 per-directory 视图记忆（D4）。
- 不做缩略图生成——沿用第十一批 D3 的裁决（自定义协议 + lazy）。
- 不让 `notes/` 支持存放图片等新文件类型（那是存储层变更，单独立项）。

## 依赖

**必须在第十一批（I）之后施工**：本批 D5 要泛化的 `AssetGrid` 由第十一批建立；且第十一批已经把 `LibraryTreeSnapshot` 加字段的 mock 扩散代价付过一次，本批再加 `size`/`modifiedAt` 时同一批 spec 只需再补一次。

---

## T12.1 Rust：`LibraryTreeEntry` 补元数据

**文件**：`src-tauri/src/lib.rs`

**做什么**

1. `LibraryTreeEntry` 增加两个字段：
   ```rust
   size: u64,            // 目录为 0
   modified_at: String,  // rfc3339
   ```
   serde camelCase → 前端 `size` / `modifiedAt`。
2. `collect_library_entries`（约 `:2470`）填充：`fs::metadata` 取 `len()` 与 `modified()`；目录的 `size` 填 0（不递归求和，避免大目录扫描开销）。
3. `metadata` 读取失败时 `size: 0`、`modified_at` 用空串，**不要因单个文件失败让整树报错**（沿用既有跳过策略）。
4. 排序规则不变（目录在前、同类按名称）。

**验收**：`cargo test` 通过；新增单测见 T12.5

**禁止**：不要递归计算目录大小；不要新增 Tauri command

---

## T12.2 前端：目录成为可打开对象

**文件**：`src/types.ts`、`src/workspace/library-shell.tsx`

**做什么**

1. `src/types.ts` 的 `LibraryTreeEntry` 补 `size: number`、`modifiedAt: string`。
2. `LibrarySelection` 加 `{ kind: "directory"; path: string }`。
3. `library-shell.tsx:755-758` 的目录点击改为**同时**：展开/折叠树节点（保留既有 `toggleSetValue`）**并且** `selectDirectoryView(entry.path)`。
4. `selectDirectoryView` 与既有 `selectFragmentsView` / `selectMindMap` / `selectAssetsView` **同构**：先 `saveCurrentNote()` flush 草稿，成功才 `setSelection`，`setIsZen(false)`、`setMobilePane("editor")`；树高亮设为该目录路径。
5. 资料库头部的「资料库」根节点按钮点击 = 选中 `notes` 根目录（显示顶层内容）。
6. `selectedTreePath` 的既有语义（决定新建文件落点，`:623-628`）**保持不变**，不要与 selection 合并——两者职责不同。

**验收**：`pnpm build` 通过；UI 用例见 T12.5

**禁止**：不要移除目录的展开/折叠能力（导航与浏览并存，见 D1）；不要引入双击

---

## T12.3 第三栏目录视图（列表 + 宫格）

**文件**：新建 `src/components/shard/directory-view.tsx`（+ `.module.css`），泛化 `src/components/shard/asset-grid.tsx`

**做什么**

1. `renderSelectedViewer` 加 `directory` 分支 → `DirectoryView`，数据源为该目录的 `children`。
2. **头部工具条**：列表/宫格切换（两个 icon 按钮，`aria-pressed` 表达当前态），当前目录路径面包屑。仅在 `directory` selection 下渲染。
3. **列表形态**：表格式布局，列为 名称 / 类型 / 大小 / 修改时间。大小用既有格式化工具（若无则新建 `formatBytes` 放 `src/lib/`），时间用既有日期格式化通路，**不要新引入 date 库**。
4. **宫格形态**：从 `AssetGrid` 泛化出通用格子组件——图片格显示缩略图（`loadFragmentImageSrc`），markdown/csv/mindmap 格显示类型图标 + 名称，目录格显示文件夹图标 + `N 项`。
5. **点击行为统一**：目录 → `selectDirectoryView`（进入下一层，同时展开树）；文件 → 与树上点击同一条通路（`markdown` → 笔记编辑器、`csv` → CSV 预览、`mindmap` → 导图画布）。**复用既有分派，不要新写一套**。
6. 空目录空态：「这个目录还是空的」。
7. 视图偏好读写 localStorage（D4），读取失败或值非法时回退 `list`。
8. 尺寸、间距、圆角、图标全部消费 Kiln token，**不新造色板**。

**验收**：`pnpm build` 通过；UI 用例见 T12.5

**禁止**：不要为目录视图新增右键菜单（重命名/删除/移动仍走树上既有菜单）；不要做排序与多选；不要新造第二套宫格组件

---

## T12.4 禅模式与第四栏的处理

**文件**：`src/workspace/library-shell.tsx`

**做什么**

1. **directory 视图隐藏禅按钮**——与 fragments（第十批）、assets 网格（第十一批）一致：列表/宫格无「专注编辑」语义。
2. **第四栏对 directory 一律空态**——与 fragments / assets 一致，目录没有单一可检查对象。
3. 移动端两级导航（`mobilePane`）对 directory 视图同样生效。

**验收**：`pnpm build` 通过

**禁止**：不要为目录造新的第四栏面板

---

## T12.5 测试

**做什么**

1. **Rust 单测**：
   - `collect_library_entries` 返回的条目含 `size` 与 `modified_at`
   - 目录条目 `size` 为 0
   - metadata 读取失败的文件仍出现在列表中（size 0、时间空串），不中断整树
2. **Playwright**：
   - 点击树上的目录 → 树节点展开**且**第三栏显示该目录内容（两件事同时发生，D1）
   - 列表/宫格切换生效，刷新后偏好保持（localStorage）
   - 宫格里点子目录 → 进入下一层；点 md → 打开笔记编辑器
   - directory 视图**无禅按钮**、第四栏空态
   - 空目录显示空态文案
   - 打开笔记/导图/碎片流/图片网格的既有行为不受影响（回归保护）
3. **补齐全部 spec 文件的 mock**：`LibraryTreeEntry` 新增 `size`/`modifiedAt` 后，所有构造该结构的 mock 都要补齐（与第七批、第十一批同一个坑）。
4. 断言用 `exact` 或区域限定。

**验收命令**（三条全绿，既有用例只增不减）：

```bash
cargo test --manifest-path src-tauri/Cargo.toml
pnpm build && pnpm test:unit
pnpm test:ui
```

**禁止**：不要放宽既有断言

---

## 主要风险

- **R1 · mock 扩散**：`LibraryTreeEntry` 是嵌套结构，mock 里每个条目字面量都要补两个字段，比第七批的 snapshot 顶层加字段更零碎。这是本批最大的踩坑点。
- **R2 · 导航与浏览的双重语义**：D1 让点目录同时展开树和切换第三栏。要确认这不会让「只想展开看看子项」的用户意外丢失第三栏当前内容——第三栏若有未保存笔记草稿，`selectDirectoryView` 的 `saveCurrentNote()` 门禁必须生效（与其他 select* 同构）。
- **R3 · 宫格对纯文档目录价值有限**：`notes/` 下当前只有 md 与 csv，宫格格子里主要是类型图标。这是可接受的——列表形态才是文档目录的主力，宫格为将来的混合内容与更大点击目标准备。不要因此削减宫格实现。
- **R4 · 面包屑与树高亮的一致性**：第三栏进入下一层目录时，树上的展开与高亮要跟着走，否则两栏状态会打架。
