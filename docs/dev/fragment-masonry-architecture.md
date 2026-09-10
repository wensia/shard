# 碎片流实测瀑布流架构

日期：2026-09-07。范围：`FragmentTimeline` 的布局与局部滚动；资料库、捕捉页和密匣共用。保留现有正文、置顶排序、编辑、关系 worker 和 Kiln token。

## 问题与完成门

原实现按 `index % columnCount` 固定分列，长内容累积在同一列后另一列提前结束；列数取决于整个窗口的 `96rem` 断点，忽略侧栏和实际阅读宽度。

| 阶段 | 产物 | 完成门 |
| --- | --- | --- |
| 诊断 | 确认分列、高度变化、滚动与编辑生命周期 | 不靠裁剪正文消除空白，不改变资料库信息架构 |
| 实现 | 独立布局组件、纯坐标算法、容器断点 | 按实测最短列摆放；所有卡片保持同一 React 父节点 |
| 验证 | 几何、编辑、导航、缩放回归 | 构建、单测、相关 UI；浏览器证据与原生证据分开 |

## 职责

- `FragmentTimeline`：按置顶与创建时间排序，管理业务操作和显式导航。导航在布局完成后启动，滚动结束后消费目标；平滑动画超时会先按最新几何完成定位，再确认完成。
- `FragmentMasonry`：一个 `ResizeObserver` 观察容器及卡片的 border-box（与实际高度测量一致），合并到一个动画帧；先批量读取实际宽高，再写坐标和总高度。测量不更新 React state，不触发整条时间线重新解析 Markdown。
- `layoutMasonry`：按当前最短列分配位置，同高时先左列；给出每张卡的列、顶部和整体高度。DOM 顺序始终保留业务排序。
- CSS：以 `.shard-content-measure` 实际宽度决定列数；达到 `48rem` 用两列，否则单列。`flat` 变体保留正常单列与条目分隔线。间距、表面与字体沿用 Kiln/Shard 现有语义 token。

双列卡片只改位置，不换父节点；单列恢复正常文档流。初始化尚未测量时有 CSS Grid 文档流兜底。图片、字体、关联区、编辑器高度变化都进入同一测量过程。

## 滚动协议

1. 每次重排从上次位置中选取仍存在且最接近 viewport 顶部的可见卡片，保留其相对偏移。
2. 所有模式都保留上次实测总高度作为 `min-height`。这避免单列切双列时，CSS 提前缩短滚动范围、在测量前丢掉原来的 `scrollTop`。单列自然内容仍可增高。
3. 写入新几何后，显式导航优先重新对齐目标；没有导航时恢复阅读锚点。
4. 只改时间线 ScrollArea viewport。布局修正与导航均标记为程序化滚动，不触发 composer 折叠，也不调用全局 `scrollIntoView()`。

## 验证

- `pnpm build`：类型检查、215 个 token 契约与生产构建。
- `pnpm test:unit`：269 项通过，包含 3 项布局算法测试。
- `pnpm test:ui tests/ui/shadcn-migration.spec.ts tests/ui/wikilink.spec.ts tests/ui/organize-fragments.spec.ts tests/ui/csv-preview.spec.ts`：67 项通过。
- `pnpm test:ui tests/ui/fragment-masonry.spec.ts`：6 项通过；覆盖长短卡几何、实际容器断点、编辑增高、DOM/草稿/选区保留、阅读锚点、过滤与搜索导航，以及导航过程中延迟增高。
- Playwright WebKit：同一新增 spec 6 项通过；使用临时 WebKit 配置和相同的本地 Vite 服务。
- `git diff --check`：通过。
- [资料库实际页面截图，使用测试数据](../../tests/evidence/fragment-masonry-wide.png)。测试页面运行真实 React/布局/编辑器，Tauri IPC 为 mock。

本次不引入虚拟化，不裁剪长文。最后一张卡本身极长时，仍可能有由内容长度决定的尾部高度差；固定奇偶分列导致的累积失衡已移除。原生桌面工具当前命中了旧的 `tauri://localhost` 安装版，不能据此声称最新源码已通过原生 WKWebView 验收。
