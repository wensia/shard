# 幕布式大纲验收记录

日期：2026-09-08。对应用户要求「大纲的设计与操作直接照抄幕布」，实现范围见 [任务清单](mind-map-mubu-outline-tasks.md)，当前键位见 [交互契约](mind-map-interaction-contract.md)。本轮交付大纲编辑体验，导图及流程图仍使用各自的文件和操作语义。

## 最终行为

- 大纲呈现独立文档标题和紧凑正文。正常输入不显示文本框描边、整行选中色或常驻拖动把手；圆点、浅色层级线保留，三角与菜单按悬停/焦点显示。折叠后的展开入口保持可见。
- Enter 新建同级；标题 Enter 进入首主题。Tab 缩进当前主题、Shift+Tab 提升，保留文字选区；没有可缩进目标时不新增主题、不改变折叠状态。
- Shift+Enter 编辑独立描述，描述中 Enter 换行，再次 Shift+Enter 返回主题原插入点。原有多行主题文字完整保留，Alt+Enter 可在主题文字内换行。
- 单击圆点或 Mod+] 聚焦子树，面包屑或 Mod+[ 返回；拖动圆点仍能调整层级，拖放不会误触聚焦。视图范围不改变文件根节点、折叠状态或内容历史。
- Mod+Shift+↑↓ 重排，Mod/Alt+. 折叠；普通空标题退格保护已有描述、引用及子树。开关侧栏、切换视图保留描述和文字插入点。

使用既有 `node.note`、草稿和保存队列；没有新增 schema、存储实现或依赖。

## 自动验证

本轮累计通过 **71 项相关 UI 用例、16 项树模型单测**。新增末轮回归后没有重复全仓测试。

| 验证 | 结果 |
| --- | --- |
| `pnpm exec playwright test tests/ui/mind-map-mubu-outline.spec.ts` | 28 项通过，WebKit / Chromium 各 14 项；含持续录入、描述、聚焦、拖放、撤销、保护删除、组合输入门禁、跨视图和侧栏焦点 |
| `pnpm exec playwright test tests/ui/mind-map-outline.spec.ts` | 22 项通过，既有文字保留、焦点、保存等行为回归 |
| `pnpm exec playwright test tests/ui/mind-map-workspace.spec.ts` | 18 项通过，工作区视图/面板状态与保存连续性 |
| `pnpm exec playwright test tests/ui/canvas-keyboard.spec.ts` | 3 项相关 WebKit 导图键盘用例通过，导图 Tab 创建语义保留 |
| `pnpm exec vitest run src/lib/mind-map-tree.test.ts` | 16 项通过，包含独立描述字段、新旧字段与原始对象保留 |
| `pnpm build` | 通过；存在既有大包体积提示 |
| `git diff --check` | 通过 |

上述浏览器页面使用 mock 文件 API，不能替代下面的原生文件回读。末轮 4 项用例单独验证空描述开关面板，以及折叠局部范围内无效 Tab / 有效 Enter 的状态保留。

1280px / 640px 双引擎实测：正文 16px、行高 25.6px、单行主题 32px、标题 34px、层级间距 28px；正文可用宽度分别约 756px / 484px。未发现文本截断、横向溢出或 document/window 被编辑定位滚动。极窄容器会收紧缩进以保留文字宽度。

- [WebKit 计算样式与几何](../../tests/evidence/mind-map-mubu-outline-webkit.json)，[宽窗口](../../tests/evidence/mind-map-mubu-outline-webkit-1280.png)，[窄窗口](../../tests/evidence/mind-map-mubu-outline-webkit-640.png)。
- [Chromium 计算样式与几何](../../tests/evidence/mind-map-mubu-outline-chromium.json)，[宽窗口](../../tests/evidence/mind-map-mubu-outline-chromium-1280.png)，[窄窗口](../../tests/evidence/mind-map-mubu-outline-chromium-640.png)。

## 原生 Tauri

使用已有隔离应用 `/tmp/Shard Multidrag Acceptance.app` 和它原有临时 vault，前端为当前源码的 `http://127.0.0.1:1420`。没有切换主应用数据库、配置或真实资料库；没有将浏览器 fixture 充当原生验收。

从资料库新建测试文件，完成「中文标题 → Enter 进入主题 → Enter 新建同级 → Tab 缩进 → Shift+Enter 编辑两行描述 → 返回主题 → Shift+Tab 提升 → 撤销 → 保存」。磁盘回读为 3 个节点，`交互验收` 位于 `需求整理` 之下，描述精确保留为 `第一行描述\n第二行说明`。

圆点聚焦和面包屑返回后，回到资料库重开同一文件：标题、父子关系和两行描述均在原生界面恢复。最后源码复核空描述开关帮助后，原生焦点确实回到空描述；Shift+Enter 返回原主题并收起空描述。

保存后、聚焦返回/重开/空描述开关帮助后的文件 SHA-256 相同：`c1172a5a8d9bb9d76b4c05d2718397702b220b0e37454ee3153ecf5c7206a3c9`。原生操作和落盘快照见 [原生证据](../../tests/evidence/mind-map-mubu-outline-native.json)。

## 证据边界

幕布的真实页面、帮助面板及 [快捷键](https://mubu.com/help/14)、[描述](https://mubu.com/help/20)、[专注模式](https://mubu.com/help/articles/pc/advanced_skills/ef8d67388ca24fd8b81f122c957de57d/)用于确认布局和公开操作。没有编辑用户幕布原文档；主题中段 Enter 是否拆分、空主题全部删除边界仍未在幕布实测。当前普通 Enter 保留原文并新建同级，不宣称所有细节完全相同。

原生验证使用中文剪贴板输入与实际键盘操作，未执行拼音候选选字；合成组合事件的浏览器门禁测试不能替代该项。主题多选、结构剪贴板、文档内查找及完整格式工具不在本轮已交付清单。源码构建和隔离开发应用验证已完成，未提交、发布或重打安装包。
