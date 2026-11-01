import { createElement, useCallback, type CSSProperties, type ReactNode } from "react"
import type { JSONContent } from "@tiptap/core"
import { isAllowedUri } from "@tiptap/extension-link"
import { useRenderedBlocks, type MarkdownContentProps } from "@shard/markdown"
import { Checkbox } from "@/components/ui/checkbox"
import { useShardMarkdown } from "./markdown/use-shard-markdown"
import { NESTED_LIST_TYPES } from "./schema/task-item-utils"
import "./rich-editor.css"

type Props = Pick<MarkdownContentProps, "content" | "className" | "hideTags" | "onTaskToggle" | "renderImage" | "renderInline" | "renderEmbed" | "renderFence" | "renderTaskReminder">
const searchable = { "data-markdown-search-block": "text" }

/** Read-only adapter for the same document model used by composer, inline and zen editors. */
export function ShardMarkdownContent(props: Props) {
  const { content, className, ...adapters } = props
  const parsed = useShardMarkdown(content)
  const { hideTags, onTaskToggle, renderImage, renderInline, renderEmbed, renderFence, renderTaskReminder } = adapters
  const render = useCallback((node: JSONContent, index: number) => renderNode(node, String(index), {
    hideTags, onTaskToggle, renderImage, renderInline, renderEmbed, renderFence, renderTaskReminder,
  }), [hideTags, onTaskToggle, renderImage, renderInline, renderEmbed, renderFence, renderTaskReminder])
  const rendered = useRenderedBlocks(parsed.result?.doc.content, render, parsed.asynchronous)
  const error = parsed.error ?? rendered.error
  return <div className={["shard-fragment-content shard-rich-content", className].filter(Boolean).join(" ")}
    data-markdown-search-root="true" data-markdown-error={error ? "true" : undefined}
    aria-busy={!error && (!rendered.nodes || rendered.pending) || undefined}>
    {error ? content : rendered.nodes ?? <span role="status">加载中…</span>}
  </div>
}

type Adapters = Omit<Props, "content" | "className">
function renderNode(node: JSONContent, key: string, adapters: Adapters): ReactNode {
  const attrs = node.attrs ?? {}
  const children = () => node.content?.map((child, index) => renderNode(child, `${key}.${index}`, adapters))
  switch (node.type) {
    case "text": return <span key={key}>{withMarks(node, node.text ?? "")}</span>
    case "paragraph": {
      // Hide tag-only paragraphs, but retain explicit empty paragraphs and escaped tags.
      if (adapters.hideTags && node.content?.some((child) => child.type === "tag") &&
        node.content.every((child) => child.type === "tag" || child.type === "text" && !child.text?.trim())) return null
      // Shard stores one visible row per paragraph. Native <p> selection inserts
      // an extra paragraph separator, so use a semantic row without doubling copied blank lines.
      return <div key={key} role="paragraph" data-shard-paragraph="true" {...searchable}>{children() ?? <br />}</div>
    }
    case "heading": return createElement(`h${attrs.level}`, { key, ...searchable }, children())
    case "blockquote": return <blockquote key={key}>{children()}</blockquote>
    case "bulletList": return <ul key={key}>{children()}</ul>
    case "orderedList": return <ol key={key} start={attrs.start}>{children()}</ol>
    case "listItem": return <li key={key}>{children()}</li>
    case "hardBreak": return <br key={key} />
    case "horizontalRule": return <hr key={key} aria-label="分割线" />
    case "codeBlock": return <pre key={key} data-markdown-search-exclude="codeBlock"><code>{children()}</code></pre>
    case "rawBlock": return <pre key={key} className="shard-rich-raw-block" data-markdown-search-exclude="codeBlock">{attrs.source}</pre>
    case "shardBlock": return <div key={key} data-markdown-search-exclude="embed">
      {adapters.renderFence?.({ code: attrs.source, language: attrs.lang, lineIndex: -1 }) ?? <pre><code>{attrs.source}</code></pre>}
    </div>
    case "csvEmbed": return <div key={key} data-markdown-search-exclude="embed">
      {adapters.renderEmbed?.(`![[${attrs.path}]]`) ?? `![[${attrs.path}]]`}
    </div>
    case "image": return <span key={key} data-markdown-search-exclude="embed">
      {adapters.renderImage?.({ alt: attrs.alt ?? "", path: attrs.src, lineIndex: -1 }) ?? `![${attrs.alt ?? ""}](${attrs.src})`}
    </span>
    case "tag": return adapters.hideTags ? null : <span key={key} className="shard-rich-tag">{withMarks(node, `#${attrs.name}`)}</span>
    case "wikilink": {
      const source = `[[${attrs.target}${attrs.alias ? `|${attrs.alias}` : ""}]]`
      return <span key={key}>{withMarks(node, adapters.renderInline?.(source) ?? source)}</span>
    }
    case "reminder": return <span key={key}>{adapters.renderTaskReminder?.({ at: attrs.at, checked: false }) ?? `⏰ ${attrs.at}`}</span>
    case "table": return <div key={key} className="tableWrapper"><table><tbody>{children()}</tbody></table></div>
    case "tableRow": return <tr key={key}>{children()}</tr>
    case "tableHeader":
    case "tableCell": return createElement(node.type === "tableHeader" ? "th" : "td", {
      key, colSpan: attrs.colspan, rowSpan: attrs.rowspan,
      style: { textAlign: attrs.align } as CSSProperties,
    }, children())
    case "taskList": return <ul key={key} data-type="taskList" data-ordered={attrs.ordered ? "true" : undefined}>{children()}</ul>
    case "taskItem": {
      const checked = attrs.checked === true
      const lineIndex = typeof node.sourceLine === "number" ? node.sourceLine : undefined
      const memo = node.content?.slice(1).some((child) => !NESTED_LIST_TYPES.has(child.type ?? "")) ||
        node.content?.[0]?.content?.some((child) => child.type === "hardBreak" || child.text?.includes("\n"))
      return <li key={key} data-type="taskItem" data-checked={String(checked)}>
        <div className={`shard-rich-task${memo ? " shard-rich-memo" : ""}`} data-shard-memo-card={memo ? "true" : undefined}>
          <span className="shard-rich-task-check" data-task-line-index={lineIndex}>
            <Checkbox aria-label={checked ? "标记为未完成" : "标记为完成"} checked={checked}
              disabled={!adapters.onTaskToggle || lineIndex === undefined}
              onMouseDown={(event) => { event.preventDefault(); event.stopPropagation() }}
              onClick={(event) => event.stopPropagation()}
              onCheckedChange={() => { if (lineIndex !== undefined) adapters.onTaskToggle?.(lineIndex) }} />
          </span>
          <div className="shard-rich-task-body"><div>{children()}</div></div>
          {attrs.reminder && <span className="shard-rich-task-reminder-slot">
            {adapters.renderTaskReminder?.({ at: attrs.reminder, checked }) ?? `⏰ ${attrs.reminder}`}
          </span>}
        </div>
      </li>
    }
    default: return <span key={key}>{children()}</span>
  }
}

function withMarks(node: JSONContent, content: ReactNode): ReactNode {
  return (node.marks ?? []).reduce<ReactNode>((value, mark) => {
    switch (mark.type) {
      case "bold": return <strong>{value}</strong>
      case "italic": return <em>{value}</em>
      case "strike": return <s>{value}</s>
      case "underline": return <u>{value}</u>
      case "highlight": return <mark>{value}</mark>
      case "code": return <code>{value}</code>
      case "link": return isAllowedUri(mark.attrs?.href, ["shard"])
        ? <a href={mark.attrs?.href} title={mark.attrs?.title} target="_blank" rel="noopener noreferrer">{value}</a> : value
      default: return value
    }
  }, content)
}
