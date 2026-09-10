# 大纲下级主题设计验收

日期：2026-09-08。依据用户本轮提供的幕布截图，进一步调整上一轮大纲的下级排版和结构控件。本记录替代上一轮验收中菜单位置、圆点颜色及正文可用宽度的描述；保存和键位协议不变。

## 已实现

- 灰色圆点保持 6px，每级缩进 28px。祖先线与父级圆点中心对齐，从第一个子主题开始贯穿最后一个可见后代，覆盖多行文字和描述；返回无关同级时停止。
- 折叠主题显示 18px 浅灰外圈，展开/折叠与聚焦仍为独立操作。
- 圆形菜单移到圆点左侧 28px，不再占用正文右侧宽度。菜单、折叠按钮、圆点的点击区域互不重叠。
- 打开菜单或进入主题选择时显示当前行浅色底，普通文字输入无整行底色；底色从本级行开始，不覆盖祖先引导线区域。
- 标题与首级行起始边界对齐。颜色、字体和圆角继续使用 Kiln；窄屏保留左控件空间，深层正文保留最小可读宽度，只允许大纲 viewport 自身承接必要横向滚动。

产品变更位于大纲 TSX、局部 CSS 与快捷键帮助文案；未修改树模型、保存或文件 schema。

## 验证结果

- 8 项定向 UI 用例通过：WebKit / Chromium 各覆盖宽窄几何、祖先线多行范围及折叠聚焦、左菜单状态与命中、已有拖动操作。首轮测试发现 1px 按钮点击区域交集，修正后重跑对应用例通过。
- 1280px / 640px 实测正文宽度为 792px / 516px；圆点 6px、缩进 28px、菜单中心偏移 -28px，正文右侧仅余 4px。普通多行样例无截断、横向溢出或 document/window 滚动。
- `pnpm build`、`git diff --check` 通过；构建仍有既有大包体积提示。
- 在已有隔离 `Shard Multidrag Acceptance.app` 中，从资料库重开上一轮测试文件，核对父子圆点、引导线与描述排版。左菜单真实打开，Esc 关闭后原生焦点返回对应主题正文。精确命中边界及折叠外圈由上面的双引擎测量验证。

截图来自明确标识浏览器模拟存储的实际组件测试页面，不冒充原生落盘证据：

- [WebKit 宽窗口](../../tests/evidence/mind-map-outline-children-webkit.png)、[窄窗口](../../tests/evidence/mind-map-outline-children-webkit-narrow.png)、[计算样式和几何](../../tests/evidence/mind-map-outline-children-webkit.json)。
- [Chromium 宽窗口](../../tests/evidence/mind-map-outline-children-chromium.png)、[窄窗口](../../tests/evidence/mind-map-outline-children-chromium-narrow.png)、[计算样式和几何](../../tests/evidence/mind-map-outline-children-chromium.json)。

本次没有把上一轮 71 项回归当作本轮重跑结果，也未新增外部幕布文档、修改用户真实资料库、提交或发布。

## 后续校准：圆点、竖线与留白

按用户后续截图要求，修正了 1px 竖线中心比圆点偏右 0.5px 的问题。圆点、祖先线和位于该轴上的菜单共用中轴；父级圆点和子树线之间保留间隙。

18px 圆形菜单出现时，所在竖线在菜单外缘上、下各断开 4px，位置固定在首行，不随多行主题或描述高度移动。断口由透明背景渐变形成，不用背景色遮块，也不额外叠加遮罩降低整段线的透明度。菜单隐藏后恢复连续；键盘焦点、菜单浮层打开和触屏常显使用相同规则。

本次校准的 6 项定向双引擎用例通过，构建与差异检查通过。1280px / 640px 实测圆点、菜单、竖线中轴偏差均为 0px；单行父主题圆点至子树线保留 13px（多行父主题按内容自然增大）。截图取样确认菜单上下各 4px 留白区无残线；远端线段显示前后亮度差小于 1，没有整段变淡。多行首行锚点、折叠/聚焦范围和菜单命中保持正确。

- [WebKit 对齐截图](../../tests/evidence/mind-map-outline-axis-webkit-1280.png)、[窄窗口](../../tests/evidence/mind-map-outline-axis-webkit-640.png)、[逐像素数据](../../tests/evidence/mind-map-outline-axis-webkit.json)。
- [Chromium 对齐截图](../../tests/evidence/mind-map-outline-axis-chromium-1280.png)、[窄窗口](../../tests/evidence/mind-map-outline-axis-chromium-640.png)、[逐像素数据](../../tests/evidence/mind-map-outline-axis-chromium.json)。

本次为浏览器中真实组件的计算几何和绘制像素验收，未重新执行原生输入/落盘链路。
