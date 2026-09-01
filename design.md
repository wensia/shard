# Shard 图标设计语言

> 2026-09-02 定稿。决策背景与三套候选对比见预览页（Artifact `bc0b7afb`）；
> 参考系 Tolaria（refactoringhq/tolaria）配方经源码实测提取。
> 本文是图标系统的唯一产品侧真相源；kiln 上游同步项见文末。

## 决策记录

- **套系：C「原地修缮」** —— 保留 lucide-react，集中定制细线参数。零改名、零新依赖；网格 24px。
- **菜单图标：14px**（维持现状；kiln 上游"15–16px"条目按此修订）。
- **描边策略：比例描边 + 光学补偿**（替代 absoluteStrokeWidth 二选一）：
  基准 `stroke-width: 1.5`（16px 下物理 1.0px，与 Tolaria regular 同档）；
  ≤14px 场景补偿为 `1.75`（14px 下物理 ≈1.02px）。全尺寸光学线宽稳定在 0.9–1.15px。
- 参考实测（勿再估算）：Phosphor 256 网格描边 regular=16 / light=12 / bold=24 单位，
  即 16px 渲染下 1.0 / 0.75 / 1.5px；lucide sw1.5@16px 同为 1.0px。

## 规范

### 库与描边

- 唯一图标库 **lucide-react**，一律 outline、`currentColor`、round caps/joins。
- 描边由 **CSS token 集中控制**，禁止在组件里传 `strokeWidth`：
  - `--shard-icon-stroke: 1.5`（基准）
  - `--shard-icon-stroke-sm: 1.75`（≤14px 光学补偿档）
  - 全局唯一一条规则 `svg.lucide { stroke-width: var(--shard-icon-stroke) }`
    （CSS property 覆盖 lucide 输出的 SVG 属性）；
    小尺寸容器（下拉/右键菜单、状态条等）只覆盖变量
    `--shard-icon-stroke: var(--shard-icon-stroke-sm)`，不得新写 `stroke-width` 规则。

### 尺寸阶梯（token 化，六档）

| token | 值 | 用途 |
|---|---|---|
| `--shard-icon-size-xs` | 12px | 极特殊小控件（标签内优先跟随 `1em`） |
| `--shard-icon-size-sm` | 14px | 菜单项、状态栏、行内辅助 |
| `--shard-icon-size-md` | 16px | 默认：工具栏、按钮、对话框 |
| `--shard-icon-size-nav` | 18px | 侧栏一级导航 |
| `--shard-icon-size-lg` | 20px | 底部标签、空态提示 |
| `--shard-icon-size-xl` | 32px | 品牌标 |

尺寸只允许来自 token（Tailwind `size-(--shard-icon-size-*)` 或 CSS `var()`）；
禁止数字 `size={n}` prop 与 CSS 裸 px。

### 颜色与状态

- 图标一律继承文本色（`currentColor`），默认 muted，激活 clay 导航板上呈 canvas 色。
- 禁止图标自带颜色、多色、半透明填充。
- **激活态不变形**：仅以颜色/背景表达（C 套特性；不做 fill 权重切换）。

### 导入与语义

- 应用代码只从 **`@/components/icons`**（注册表）导入，禁止直接 `from "lucide-react"`。
- 注册表负责：默认 `aria-hidden`、语义别名、未来换库的唯一切面。
- **一个概念一个字形**：
  - 警告双字形模型：`TriangleAlert` = 毁灭性确认；`CircleAlert` = 行内提示 / 错误 toast（`OctagonX` 废除）。
  - `Link` = 相关片段（废除 `Link2`）；`Paperclip` = 关联到片段的动作；`Maximize2`（废除 `Maximize`）。
  - `GitBranch` 专属导图；漫步一律 `Route`（此前 bottom-tabs 误用 GitBranch）。

### 签名图标

Shard 核心概念用手绘签名图标（唯一允许的自绘 SVG）：碎片、禅、密匣、传送门、漫步。

- 规范：24 viewBox、`stroke-width: 1.5`（走同一 CSS token 管道）、round caps/joins、
  整数网格吸附、最少路径、纯 `currentColor`。
- 位置：`src/components/icons/signature/`，经注册表导出，与库图标同 prop 面。
- 现 `ShardZenIcon`（双色 + 半透明填充 + 1.4/1.6 混合描边）按上述规范重绘。
- 其余四枚（碎片/密匣/传送门/漫步）待禅图标落地效果确认后按同规范补齐。

## 落地架构

- **注册表** `src/components/icons/index.ts`：curated re-export（保 tree-shaking 与类型收窄），
  `withIconDefaults()` 工厂注入 `aria-hidden`；导出 `ShardIcon` 类型替代 `LucideIcon`。
- **Token** 定义于 `src/index.css` `:root` 并注册进 `contract/tokens.json`。
- 五套竞争尺寸机制全部收编为 token 消费者：`button.tsx` CVA、
  dropdown/context-menu 的 `[&_svg]:size-3.5`（加 `:not([class*='size-'])` 守卫）、
  CSS module 裸 px、散装 `size={n}`、`frontend-rules.css` 特例。
- **Lint**（`scripts/verify-tokens.mjs`）：`iconImport`（注册表外禁直连 lucide）、
  `iconStroke`（禁 `strokeWidth=` prop 与 Tailwind `stroke-[n]` 任意值类）、
  `iconSize`（禁数字 `size={n}`）、`iconStrokeCss`（CSS 里只允许消费
  `--shard-icon-stroke` 的那一条全局规则；数据图形挂 `design-exempt`）。

## kiln 上游待同步（wensia/kiln → references/tokens.md Icons 节）

1. "~1.8px stroke" → 集中 token 化 1.5（≤14px 补偿 1.75）。
2. "Menu item icon: 15-16px" → 14px。
3. "No hand-drawn decorative SVG" → 增补：核心产品名词的**签名图标**属于图标系统的一部分，
   须遵守套系网格/描边/线帽约定；装饰性插画仍然禁止。
4. 尺寸 bullet 改为引用 `--shard-icon-size-*` token 名，避免第三真相源。

## 验证

- `npm run build`（verify-tokens + tsc + vite）；
- grep 门禁：`from "lucide-react"` 仅注册表；`strokeWidth=` 为零；
- `tests/ui/icon-system.spec.ts` 断言各场景图标计算尺寸 = token 值、渲染描边 = token 值；
- 六大界面双主题截图签收（`shard-icons-*.png`）。
