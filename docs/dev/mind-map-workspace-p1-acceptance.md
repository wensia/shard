# 思维导图首批工作区验收

日期：2026-09-08。最终 `pnpm build` 与 `git diff --check` 通过。范围：[分期计划](mind-map-mubu-improvement-plan.md)中的 P0 当前协议与 P1；不包含 P2–P5。

## 已交付

- 顶部使用明确的「大纲 / 思维导图」标签和当前态，替换底部视图图标；保留保存状态和资料库导航。资料库禅模式有可见的退出入口。
- 主题属性默认收起，属性与快捷键互斥显示；属性栏的树列表更名为「主题导航」。加载文档期间不显示可编辑的旧属性栏。
- 快捷键面板按当前视图、选中/文字编辑状态和通用操作分组，显示平台修饰键。帮助只列实际实现的命令。
- 同一工作区保存两种视图的临时位置：导图缩放/平移，大纲滚动/文字选区，主题选择共享。状态按文件 ID 校验，不写入文档，不进入撤销历史。定位隐藏主题时使用可见祖先，避免为了定位改写折叠。
- 工具栏、属性和帮助的 Tab 正常移动焦点；禅模式容器切换、单击画布空白结束输入后，焦点收回编辑工作区；编辑器自行处理结构键。面板关闭恢复原输入光标，编辑区 Esc 优先结束输入，不会先关旁边的面板；组合输入时禁止切换视图和面板。
- 大纲上下文菜单显示既有快捷键。大纲 Tab 仍创建子主题，Enter 仍创建同级且保留原文；本批没有暗改为幕布缩进或中段拆分。

对应：[交互契约](mind-map-interaction-contract.md)、[工作区组件](../../src/components/shard/mind-map-workspace.tsx)、[快捷键面板](../../src/components/shard/mind-map-shortcuts.tsx)。

## 浏览器行为与视觉

使用真实 React 组件，文件 API 为隔离 mock；不能将这些结果称为 Tauri 文件写入验收。

| 检查 | 结果 |
| --- | --- |
| 新增工作区 WebKit / Chromium 用例 | 18 项通过；最终焦点修复后相关 6 项再次通过；标签方向键、缩放/平移往返、长大纲滚动与光标、面板开合、帮助局部滚动、Tab、Esc、IME 合成事件、撤销和无写盘 |
| 既有大纲、检查器、键盘、文本溢出与居中回归 | 44 项通过；首轮 40 项通过，4 项修正后重验通过 |
| 完整 Library / 独立禅模式入口回归 | `shadcn-migration.spec.ts` 导图相关 9 项通过；保留节点几何、全文、Ctrl+Enter 退出与保存断言 |
| 宽/窄工作区 | 1280px、640px 双引擎实测 geometry 与 computed style；无页面横向溢出、window/document 滚动为 0 |
| 640px 正文与侧栏 | 正文 viewport 352px、输入框 224px、侧栏 288px；互不覆盖；帮助可独立滚到底部「通用」，关闭入口仍可见 |
| 字体与控件 | 消费现有 Kiln token / 控件；实际计算字体包含 Noto Sans SC；正文和帮助 13px |
| 内容与历史 | 视图、面板、平移操作前后比较完整磁盘 mock、dirty 与 writes；保持相同，已有内容撤销/重做仍可用 |

命令：

```sh
pnpm exec playwright test tests/ui/mind-map-workspace.spec.ts
pnpm exec playwright test tests/ui/mind-map-outline.spec.ts tests/ui/canvas-inspector.spec.ts tests/ui/mind-map-text-overflow.spec.ts tests/ui/canvas-keyboard.spec.ts tests/ui/canvas-text-center.spec.ts
pnpm exec playwright test tests/ui/shadcn-migration.spec.ts --grep 'mind map'
pnpm build
git diff --check
```

证据：[WebKit 640px 截图](../../tests/evidence/mind-map-workspace-webkit-640.png)、[计算几何](../../tests/evidence/mind-map-workspace-webkit-640.json)。同目录保存 1280px 和 Chromium 对照。新行为用例见 [mind-map-workspace.spec.ts](../../tests/ui/mind-map-workspace.spec.ts)。

## 隔离原生应用

使用 `/tmp/Shard Multidrag Acceptance.app`，通过既有 `127.0.0.1:1420` 开发地址加载当前前端；保留原本隔离的测试 vault，未切换真实 Shard 的资料库，也未重建 Rust。入口为「资料库 → 全部笔记 → 多选拖动验收.shardmap.json」。

本轮真实操作已观察：普通窗口默认无右侧栏；顶部视图切换；同一主题从导图到大纲；选中文字「连续」后打开帮助并按 Esc，原选区恢复；禅模式中上述帮助/选区链路同样成立；退出按钮返回原资料库大纲，主题选择仍在。最终修正后，进入与退出禅模式的焦点均为「思维导图画布」；F2 进入节点输入后，前置窗口并单击空白，输入框消失且焦点回到导图容器。原生界面通过 CUA accessibility 与截图核对。详见[原生记录](../../tests/evidence/mind-map-workspace-native.json)。

测试文件检查前后 SHA-256 为 `3a0c453e47aceef0ac0c14cb3bed6c645796c02189c40aea6f6d17bef7ea8cf0`，revision 16、主题 10 个，完整文件字节不变。本轮原生检查以视图和焦点为主，没有新增测试正文或触发内容保存。

## 边界

- IME 门禁是浏览器合成 composition / keyCode 229 的回归，本轮未重新验收原生拼音候选输入，不宣称已完成原生 IME 全链路。
- 缩放精确往返、大纲长列表滚动和选区偏移由双浏览器几何/选区测试验证；原生侧核对真实入口、显示、选择与面板焦点。
- 临时视图位置只保留当前工作区会话，关闭文件后重新打开不承诺恢复，也没有新增用户偏好持久化。
- 幕布可编辑样例仍待独立验证；大纲缩进协议、描述/引用呈现、多选剪贴板、查找聚焦、布局导出留在后续阶段。
- 本轮为前端实现与本地验收，没有提交、发布或修改幕布文档。
