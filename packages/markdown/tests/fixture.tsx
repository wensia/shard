import { createRoot, type Root } from "react-dom/client"
import { MarkdownContent, MarkdownDocument } from "@shard/markdown"
import "@shard/markdown/styles.css"

type FixtureOptions = {
  hideTags?: boolean
  adapters?: boolean
  callbackId?: string
  defaultErrorFallback?: boolean
}
type Fixture = {
  render(kind: "content" | "document", content: string, options?: FixtureOptions): void
  unmount(): void
  toggles: number[]
  callbackIds: string[]
}

const container = document.getElementById("root")!
let root: Root | undefined = createRoot(container)

const fixture: Fixture = {
  toggles: [],
  callbackIds: [],
  render(kind, content, options = {}) {
    root ??= createRoot(container)
    const renderInline = options.adapters
      ? (text: string) => text.includes("[[local]]")
        ? <a href="#local" data-adapter-inline="true" data-callback-id={options.callbackId}>本地链接</a>
        : text
      : undefined
    const loadingFallback = <span data-testid="loading">后台解析中</span>
    const errorFallback = <span data-testid="error">解析失败</span>
    root.render(
      <section data-testid="consumer">
        {kind === "document" ? (
          <MarkdownDocument
            content={content}
            renderInline={renderInline}
            loadingFallback={loadingFallback}
            errorFallback={options.defaultErrorFallback ? undefined : errorFallback}
          />
        ) : (
          <MarkdownContent
            content={content}
            hideTags={options.hideTags}
            onTaskToggle={lineIndex => {
              fixture.toggles.push(lineIndex)
              fixture.callbackIds.push(options.callbackId ?? "default")
            }}
            renderInline={renderInline}
            renderImage={options.adapters ? image => (
              <img
                alt={image.alt}
                data-adapter-image={image.path}
                data-line-index={image.lineIndex}
                data-callback-id={options.callbackId}
                src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='48' height='32'%3E%3Cpath fill='gray' d='M0 0h48v32H0z'/%3E%3C/svg%3E"
              />
            ) : undefined}
            renderEmbed={options.adapters ? line => /^!\[\[data\.csv(?:\|预览)?\]\]$/.test(line)
              ? <div data-adapter-embed="data.csv">宿主数据预览</div>
              : undefined
              : undefined}
            loadingFallback={loadingFallback}
            errorFallback={options.defaultErrorFallback ? undefined : errorFallback}
          />
        )}
      </section>,
    )
  },
  unmount() {
    root?.unmount()
    root = undefined
  },
}

Object.assign(window, { __markdownFixture: fixture })
fixture.render("document", "# Independent Markdown consumer\n\nReady.")
