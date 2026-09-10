# @shard/markdown

从 Shard 抽取的 Markdown React 组件与纯解析工具。可独立构建、打包并安装到其他产品，不依赖 Tauri、CodeMirror、Tailwind、Kiln、Shard 路由或文件 API。

## 在其他产品使用

在 Shard 仓库根目录生成安装包：

```sh
pnpm pack:markdown
```

将 `dist/packages/shard-markdown-0.1.0.tgz` 复制到目标项目，再安装：

```sh
pnpm add ./shard-markdown-0.1.0.tgz
```

React 组件需要目标产品提供 React 18 或 19。只使用 `@shard/markdown/core` 时不需要 React。当前交付为 ESM 和 TypeScript 声明；没有发布到 npm。

**Vite 接入需要将包加入 `optimizeDeps.exclude`**，保留模块 Worker 相对路径。将下面配置合并到目标产品已有的 `vite.config.ts`，保留原有 plugins 等设置：

```ts
export default defineConfig({
  optimizeDeps: {
    exclude: ["@shard/markdown"],
    include: ["react", "react/jsx-runtime"],
  },
})
```

安装后的依赖与 workspace 链接的默认预构建行为不同，不能只用链接开发验证替代安装验收。此项配置同时经过安装包开发服务和生产构建检查；选项含义见 [Vite 官方文档](https://vite.dev/config/dep-optimization-options.html#optimizedeps-exclude)。

```tsx
import { MarkdownDocument, MarkdownContent } from "@shard/markdown"
import "@shard/markdown/styles.css"

export function Article({ content }: { content: string }) {
  return <MarkdownDocument content={content} />
}

export function Note({ content }: { content: string }) {
  return <MarkdownContent content={content} />
}
```

两种组件有意保留原有展示规则：

| 入口 | 用途与行为 |
| --- | --- |
| `MarkdownDocument` | 文档排版：标题、段落、列表、引用、代码块、分割线，及基础强调、代码和安全协议链接。沿用原文档渲染器的语法子集，不声称完整 CommonMark 支持。 |
| `MarkdownContent` | 碎片的逐行展示：保留普通 Markdown 源码和换行，渲染 GFM 表格、任务与分割线，可隐藏标签、注入图片及嵌入内容。 |
| `@shard/markdown/core` | 无 DOM 的表格解析／序列化／结构操作、预览摘要、标签／图片／分割线识别、Lezer GFM 与高亮语法树、任务范围识别。 |

React 文档组件的基础语法子集与编辑器使用的 Lezer GFM 语法树是不同接口。编辑器继续通过 `markdownParser.configure(...)` 添加自己的语言元数据，选区、输入法、撤销和文件写入由宿主负责。

## 接入产品能力

```tsx
<MarkdownContent
  content={content}
  hideTags
  onTaskToggle={(lineIndex) => updateTaskAtSourceLine(lineIndex)}
  renderImage={({ alt, path }) => <ProductImage alt={alt} path={path} />}
  renderInline={(text) => <ProductInlineText text={text} />}
  renderEmbed={(line) => matchesProductEmbed(line)
    ? <ProductEmbed source={line} />
    : undefined}
/>
```

- `lineIndex` 为原始内容的零基行号，隐藏标签或聚合表格后仍然指向原文。
- 组件不修改 `content`。任务点击通知宿主，由宿主保存并回传新内容。
- 不传 `onTaskToggle` 时任务只读。不传 `renderImage` 时图片语法保留原文。
- `renderEmbed` 返回 `undefined` 表示不匹配；`null` 表示匹配但不显示内容。
- `renderInline` 接管整段行内文本；宿主必须自己保证其输出的链接／图片安全，库不会注入原始 HTML。
- 文件读取、网络加载和存储写入在宿主组件的异步 effect／事件流程中完成；不要在 render hooks 内执行重操作。

Shard 的适配入口是 `src/components/shard/fragment-content.tsx`，负责图片附件菜单／预览／下载以及 CSV 链接和嵌入。旧的 `src/lib/markdown-*.ts` 路径只做兼容转发，不保留解析副本。

## 样式

样式单独导入，不含全局 reset、字体下载或禁用键盘焦点策略。保留历史 `shard-*` CSS hooks 以兼容现有编辑器 widget，同时组件提供 `md-content`／`md-document` 根类。其他产品不需要定义任何 `--shard-*` 变量。

通过父容器或组件 `className` 覆盖以下变量：

```css
.article {
  --md-accent: var(--brand-color);
  --md-border: var(--border-color);
  --md-muted: var(--surface-muted);
  --md-muted-foreground: var(--text-secondary);
  --md-foreground: var(--text-color);
  --md-on-accent: var(--text-on-brand);
}
```

几何与状态变量还包括 `--md-space-2`、`--md-space-3`、`--md-radius`、`--md-font-size`、`--md-line-height`、`--md-border-visible`、`--md-divider-opacity`、`--md-divider-extension` 和 `--md-focus-shadow`。默认值集中在本包 `styles.css`，Shard 在 `frontend-rules.css` 将它们映射到已有 Kiln token。

## 大文档与运行环境

短文本按内容缓存解析结果；超过 32,000 个 UTF-16 字符时使用模块 Web Worker 异步解析，并通过局部 `aria-busy` 显示加载状态。发布产物保留 worker 文件和相对 URL，需支持 `new Worker(new URL(..., import.meta.url), { type: "module" })` 的构建环境（已验证 Vite）。不要单独复制入口 JS 而漏掉 `dist` 中的 worker 和解析模块。

SSR 不创建 Worker。异步内容在客户端完成；加载／失败展示可以用 `loadingFallback`／`errorFallback` 覆盖。该机制负责解析调度，不是大型文档 DOM 虚拟列表。

## 开发与验证

```sh
pnpm build:markdown
pnpm test:markdown
pnpm test:unit
pnpm test:ui tests/ui/markdown-package.spec.ts
pnpm pack:markdown
```

主项目 `dev`、`build` 和测试命令会先构建库。修改库源码时，可另开终端运行 `pnpm --filter @shard/markdown dev` 持续更新 `dist`，让 Vite 读取最新产物。
