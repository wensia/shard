import { Fragment, type ReactNode } from "react"

import { cn } from "@/lib/utils"

interface MarkdownDocumentProps {
  className?: string
  content: string
}

type MarkdownBlock =
  | { level: number; text: string; type: "heading" }
  | { items: string[]; ordered: boolean; type: "list" }
  | { text: string; type: "paragraph" }
  | { text: string; type: "quote" }
  | { code: string; language: string; type: "code" }
  | { type: "rule" }

const HEADING_PATTERN = /^(#{1,6})\s+(.+)$/
const ORDERED_LIST_PATTERN = /^\s*\d+[.)]\s+(.+)$/
const UNORDERED_LIST_PATTERN = /^\s*[-*+]\s+(.+)$/
const QUOTE_PATTERN = /^>\s?(.*)$/
const FENCE_PATTERN = /^```(\S*)\s*$/
const RULE_PATTERN = /^\s*(?:---|\*\*\*|___)\s*$/
const INLINE_PATTERN =
  /(\[[^\]]+\]\((?:https?:\/\/|mailto:)[^)]+\)|`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*|_[^_]+_)/g

export function MarkdownDocument({ className, content }: MarkdownDocumentProps) {
  const blocks = parseMarkdownBlocks(content)

  return (
    <div className={cn("shard-markdown-document", className)}>
      {blocks.map((block, index) => renderBlock(block, index))}
    </div>
  )
}

function parseMarkdownBlocks(content: string) {
  const lines = content.replace(/\r\n?/g, "\n").split("\n")
  const blocks: MarkdownBlock[] = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index]
    const trimmed = line.trim()

    if (trimmed.length === 0) {
      index += 1
      continue
    }

    const fenceMatch = line.match(FENCE_PATTERN)
    if (fenceMatch) {
      const codeLines: string[] = []
      index += 1

      while (index < lines.length && !FENCE_PATTERN.test(lines[index])) {
        codeLines.push(lines[index])
        index += 1
      }

      if (index < lines.length) index += 1
      blocks.push({
        code: codeLines.join("\n"),
        language: fenceMatch[1] ?? "",
        type: "code",
      })
      continue
    }

    const headingMatch = line.match(HEADING_PATTERN)
    if (headingMatch) {
      blocks.push({
        level: Math.min(headingMatch[1].length, 4),
        text: headingMatch[2].trim(),
        type: "heading",
      })
      index += 1
      continue
    }

    if (RULE_PATTERN.test(line)) {
      blocks.push({ type: "rule" })
      index += 1
      continue
    }

    const quoteMatch = line.match(QUOTE_PATTERN)
    if (quoteMatch) {
      const quoteLines = [quoteMatch[1]]
      index += 1

      while (index < lines.length) {
        const nextQuote = lines[index].match(QUOTE_PATTERN)
        if (!nextQuote) break
        quoteLines.push(nextQuote[1])
        index += 1
      }

      blocks.push({ text: quoteLines.join(" "), type: "quote" })
      continue
    }

    const orderedMatch = line.match(ORDERED_LIST_PATTERN)
    const unorderedMatch = line.match(UNORDERED_LIST_PATTERN)
    if (orderedMatch || unorderedMatch) {
      const ordered = Boolean(orderedMatch)
      const pattern = ordered ? ORDERED_LIST_PATTERN : UNORDERED_LIST_PATTERN
      const items: string[] = []

      while (index < lines.length) {
        const itemMatch = lines[index].match(pattern)
        if (!itemMatch) break
        items.push(itemMatch[1].trim())
        index += 1
      }

      blocks.push({ items, ordered, type: "list" })
      continue
    }

    const paragraphLines = [trimmed]
    index += 1

    while (index < lines.length && isParagraphContinuation(lines[index])) {
      paragraphLines.push(lines[index].trim())
      index += 1
    }

    blocks.push({ text: paragraphLines.join(" "), type: "paragraph" })
  }

  return blocks
}

function isParagraphContinuation(line: string) {
  const trimmed = line.trim()
  return (
    trimmed.length > 0 &&
    !FENCE_PATTERN.test(line) &&
    !HEADING_PATTERN.test(line) &&
    !ORDERED_LIST_PATTERN.test(line) &&
    !UNORDERED_LIST_PATTERN.test(line) &&
    !QUOTE_PATTERN.test(line) &&
    !RULE_PATTERN.test(line)
  )
}

function renderBlock(block: MarkdownBlock, index: number) {
  switch (block.type) {
    case "heading": {
      return renderHeading(block.level, block.text, index)
    }
    case "list": {
      const List = block.ordered ? "ol" : "ul"
      return (
        <List className="shard-markdown-list" key={index}>
          {block.items.map((item, itemIndex) => (
            <li key={`${index}-${itemIndex}`}>
              {renderInline(item, `list-${index}-${itemIndex}`)}
            </li>
          ))}
        </List>
      )
    }
    case "quote":
      return (
        <blockquote className="shard-markdown-quote" key={index}>
          {renderInline(block.text, `quote-${index}`)}
        </blockquote>
      )
    case "code":
      return (
        <pre className="shard-markdown-code" key={index}>
          <code>{block.code}</code>
        </pre>
      )
    case "rule":
      return <hr className="shard-markdown-rule" key={index} />
    case "paragraph":
    default:
      return (
        <p className="shard-markdown-paragraph" key={index}>
          {renderInline(block.text, `paragraph-${index}`)}
        </p>
      )
  }
}

function renderHeading(level: number, text: string, index: number) {
  const children = renderInline(text, `heading-${index}`)

  if (level === 1) {
    return (
      <h1 className="shard-markdown-heading" key={index}>
        {children}
      </h1>
    )
  }

  if (level === 2) {
    return (
      <h2 className="shard-markdown-heading" key={index}>
        {children}
      </h2>
    )
  }

  if (level === 3) {
    return (
      <h3 className="shard-markdown-heading" key={index}>
        {children}
      </h3>
    )
  }

  return (
    <h4 className="shard-markdown-heading" key={index}>
      {children}
    </h4>
  )
}

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = []
  let cursor = 0

  for (const match of text.matchAll(INLINE_PATTERN)) {
    const token = match[0]
    const start = match.index ?? 0

    if (start > cursor) {
      nodes.push(
        <Fragment key={`${keyPrefix}-text-${cursor}`}>
          {text.slice(cursor, start)}
        </Fragment>
      )
    }

    nodes.push(renderInlineToken(token, `${keyPrefix}-token-${start}`))
    cursor = start + token.length
  }

  if (cursor < text.length) {
    nodes.push(
      <Fragment key={`${keyPrefix}-text-${cursor}`}>{text.slice(cursor)}</Fragment>
    )
  }

  return nodes
}

function renderInlineToken(token: string, key: string) {
  if (token.startsWith("`") && token.endsWith("`")) {
    return <code key={key}>{token.slice(1, -1)}</code>
  }

  if (
    (token.startsWith("**") && token.endsWith("**")) ||
    (token.startsWith("__") && token.endsWith("__"))
  ) {
    return <strong key={key}>{token.slice(2, -2)}</strong>
  }

  if (
    (token.startsWith("*") && token.endsWith("*")) ||
    (token.startsWith("_") && token.endsWith("_"))
  ) {
    return <em key={key}>{token.slice(1, -1)}</em>
  }

  const linkMatch = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/)
  if (linkMatch) {
    return (
      <a href={linkMatch[2]} key={key} rel="noreferrer" target="_blank">
        {linkMatch[1]}
      </a>
    )
  }

  return <Fragment key={key}>{token}</Fragment>
}
