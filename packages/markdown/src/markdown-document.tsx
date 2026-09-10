import { Fragment, useCallback, type ReactNode } from "react"
import type { MarkdownDocumentBlock, MarkdownInlineText } from "./parser.js"
import { useMarkdown, useRenderedBlocks } from "./use-markdown.js"

export interface MarkdownDocumentProps {
  className?: string
  content: string
  /** Override inline rendering while retaining the document's block structure. */
  renderInline?: (text: string) => ReactNode
  loadingFallback?: ReactNode
  /** Worker errors fall back to escaped source text unless overridden. */
  errorFallback?: ReactNode
}

export function MarkdownDocument({ className, content, renderInline,
  loadingFallback = "加载中…", errorFallback }: MarkdownDocumentProps) {
  const parsed = useMarkdown("document", content)
  const result = parsed.result?.kind === "document" ? parsed.result : undefined
  const render = useCallback((block: MarkdownDocumentBlock, index: number) => {
    const inline = (value: MarkdownInlineText) => renderInline ? renderInline(value.text) : renderInlineTokens(value)
    switch (block.type) {
      case "heading": {
        const Heading = headingElements[block.level - 1] ?? "h4"
        return <Heading className="md-heading shard-markdown-heading" key={index}>{inline(block.inline)}</Heading>
      }
      case "list": {
        const List = block.ordered ? "ol" : "ul"
        return <List className="md-list shard-markdown-list" key={index}>
          {block.items.map((item, itemIndex) => <li key={itemIndex}>{inline(item)}</li>)}
        </List>
      }
      case "quote":
        return <blockquote className="md-quote shard-markdown-quote" key={index}>{inline(block.inline)}</blockquote>
      case "code":
        return <pre className="md-code shard-markdown-code" key={index}><code>{block.code}</code></pre>
      case "rule":
        return <hr className="md-rule shard-markdown-rule" key={index} />
      case "paragraph":
        return <p className="md-paragraph shard-markdown-paragraph" key={index}>{inline(block.inline)}</p>
    }
  }, [renderInline])
  const rendered = useRenderedBlocks(result?.blocks, render, parsed.asynchronous)
  const error = parsed.error ?? rendered.error
  const loading = !error && !rendered.nodes
  return <div className={["md-document shard-markdown-document", className].filter(Boolean).join(" ")}
    aria-busy={(!error && (loading || rendered.pending)) || undefined} data-markdown-error={error ? "true" : undefined}>
    {error ? (errorFallback ?? content) : loading ? <span role="status">{loadingFallback}</span> : rendered.nodes}
  </div>
}

const headingElements = ["h1", "h2", "h3", "h4"] as const

function renderInlineTokens(inline: MarkdownInlineText): ReactNode {
  return inline.tokens.map((token, index) => {
    switch (token.type) {
      case "text": return <Fragment key={index}>{token.text}</Fragment>
      case "code": return <code key={index}>{token.text}</code>
      case "strong": return <strong key={index}>{token.text}</strong>
      case "em": return <em key={index}>{token.text}</em>
      case "link": return <a href={token.href} key={index} rel="noreferrer" target="_blank">{token.text}</a>
    }
  })
}
