# 思维导图交互差距补齐计划

背景：画布/大纲双视图已具备主流骨架（两态选择、右键菜单、框选、拖拽、实测文字几何）。
对照 XMind / MindNode 的日常编辑体验，还差四个"底线能力"。
本文档已经 council-20260804-190752 审计并按裁决修订：执行顺序 **T0 → T3 → T1 → T2 → T4**。

## T0. 视口"适应屏幕"入口

**目标**：用户平移/缩放/pin 住视口后，一键回到全局自适应视图。

**方案**：

- 画布右下角浮动按钮（ghost icon，Maximize/Focus 图标）+ 快捷键 `⌘0`/`Ctrl+0`。
- 动作即 `setViewOverride(null)`——回到 `fit` 自然自适应；画布容器 keydown 处理快捷键。
- 仅当 `viewOverride !== null` 时显示按钮。

**验收**：平移后点击按钮/⌘0 回到全图；按钮在视口未偏离时不出现。

## T3. 节点折叠 / 展开

**目标**：把数据模型里已有的 `collapsed` 接上 UI（模型/布局/大纲行已就绪，纯接线）。

**方案**：

- `mind-map-tree.ts` 新增 `toggleMindMapNodeCollapsed(file, nodeId)`；根节点禁用折叠。
- 画布：有子节点的节点右缘显示折叠钮（圆形；折叠时显示子节点计数徽标），
  hover/选中时可见；折叠钮 `pointerdown` 必须 `stopPropagation`，避免触发节点拖拽/选中切换。
- 右键菜单加"折叠/展开子节点"；快捷键 `⌘/`（不用 `/`——与 T4 type-to-edit
  冲突，且在中文输入法有歧义）。
- 边界（council 裁决）：
  - `addChild`/`addSibling` 目标节点处于折叠态时，在同一次 `onChange` 里顺带展开，
    否则新节点不可见、编辑态幽灵化。
  - 折叠时把 `selectedNodeIds` 收敛为仍可见的节点；若选中节点在被折叠子树内，
    转移到被折叠节点本身——否则不可见节点仍会被 Delete 误删。
- 折叠状态写入文件（字段已存在），重开保持。

**验收**：折叠后子树与连线正确收拢；展开恢复；计数准确；Tab 在折叠节点上自动展开；
Playwright 覆盖折叠-展开-持久化-边界。

## T1. 撤销 / 重做（⌘Z / ⇧⌘Z）

**目标**：导图内所有操作（含文本编辑）可撤销/重做。

**方案**（workspace 层快照栈 + 操作元数据）：

- `MindMapWorkspace` 维护 `past: ShardMapFile[]` / `future: ShardMapFile[]`，栈上限 100。
- `updateDraft` 签名改为 `updateDraft(file, meta?: { mergeKey?: string })`：
  画布/大纲的文本 onChange 传 `mergeKey: \`text:${nodeId}\``，结构操作不传。
  mergeKey 与上一次相同 → 只更新 draft 不入栈（连续打字合并为一条历史）；
  否则先把当前 draft 压入 `past`、清空 `future`。
- 时间戳归一化：`isDirty` 与保存判定改用剥离 `file.updatedAt`/节点 `updatedAt`
  的归一化比较；撤销回到"内容与已保存版本一致"的状态时不触发自动保存写盘。
- 编辑态 ⌘Z 也走自定义历史（画布/大纲的 ⌘Z 一律 preventDefault 后调 undo）。
  依据：受控 textarea 的原生撤销栈会被 React 重赋值破坏，WKWebView 下尤甚；
  mergeKey 机制天然支持文本撤销。开工时先做一个最小 Spike 记录实证，
  若意外可用再考虑两栈边界（不阻塞主方案）。
- 清栈时机：`mapId` 变化、`loadMap()`、冲突解决（keepDisk/keepMy）等所有
  绕过 `updateDraft` 直接 `setDraftFile` 的路径。
- 内存：导图 file 为 KB 级 JSON，100 条约几 MB，可接受（council 已确认）。

**验收**：

- 删除子树 → ⌘Z 完整恢复（含顺序）；⇧⌘Z 再次删除。
- 连续输入撤销一次回到编辑前文本；拖拽、缩进/降级、折叠均可撤销。
- 撤销回到已保存内容时状态栏显示"已自动保存"，不写盘。
- Playwright 覆盖：删除-撤销-重做、文本合并、跨视图（画布/大纲）同一栈。

## T2. 方向键导航

**目标**：画布选中态下用方向键在节点间移动焦点，键盘流闭环。

**方案**：

- 画布容器 `handleCanvasKeyDown` 增加 Arrow 键：
  `←` 父节点，`→` 第一个子节点（目标折叠时 `→` = 展开），`↑`/`↓` 上/下一个同级。
- 目标从语义树推导（`file.nodes` + `getMindMapChildren`），不从拍平的
  `layout.nodes` 反推（裁决修正）。
- 多选时先收敛为 primary 单选再导航（与主流一致）。
- 导航后复用 `revealNodeAfterInsert` 的平滑平移逻辑（缩放不变），
  保证视口外目标可见（裁决修正：视口不变是缺陷不是特性）。
- 大纲视图不改（其输入框内方向键是文本光标语义）。

**验收**：四方向行为符合空间直觉；折叠节点 `→` 展开；视口外目标平滑 reveal。

## T4. 选中态直接打字（type-to-edit）

**目标**：选中节点后直接敲字即进入编辑并用新文本覆盖。

**方案**：

- 画布容器 `handleCanvasKeyDown` 末尾分支：单字符可打印键
  （`event.key.length === 1`、无 ⌘/Ctrl/Alt、非 IME 组合）→
  `setEditingNodeId(selectedNodeId)` + `updateMindMapNodeText(file, id, key)` 覆盖原文本。
- **显式排除空格**（`" "` 是抓手语义，误触发会把文本替换成空格）。
- 进入编辑时跳过 focus effect 的 `.select()`（`skipSelectOnEditRef` 标志），
  光标置末尾；双击/F2 路径保持全选不变。
- 分支放在 Enter/Tab/Delete/F2/方向键等既有分支之后。
- 已知限制：IME 首音无法注入组合串，中文 IME 输入仍需双击/F2；不作为验收项。

**验收**：选中态敲 `a` 即覆盖为 "a" 并进入编辑；空格抓手不误触发；F2/双击路径不变。

## T5（候选，暂不实施）

子树复制/剪切/粘贴（⌘C/⌘X/⌘V）。T1 落地、误删有退路后再评估。

## 全局约束

- 每项交付都要 `tsc`、`scripts/verify-tokens.mjs`、Playwright 全量通过。
- 画布键盘处理统一走 `handleCanvasKeyDown`，与框选/空格抓手/右键菜单/IME 的既有约定兼容。
- 不做：多结构布局、主题系统、外框/概要/关系线、实时协作（与 local-first 定位不符）。

## 审计记录

- 2026-08-04 · council-20260804-190752 · 选手:antigravity,mimo,kimi(codex 超时) · 主席claude裁决 high：「方向通过；顺序调整为 T3→T1→T2→T4；T1 需加 mergeKey 元数据、updatedAt 归一化与 textarea 撤销 Spike；另补『适应屏幕』入口，复制/粘贴登记为 T5」· 报告 /Users/panyuhang/.council/shard/council-20260804-190752/viewer.html
