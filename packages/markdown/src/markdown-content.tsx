import { Fragment, useCallback, useEffect, useRef, type MouseEvent, type ReactNode } from "react"
import type { MarkdownContentBlock, MarkdownContentLine, MarkdownContentTable } from "./parser.js"
import { useMarkdown, useRenderedBlocks } from "./use-markdown.js"

export interface MarkdownImageRenderProps {
  alt: string
  path: string
  /** Zero-based source line, before tag hiding or table aggregation. */
  lineIndex: number
}

export interface MarkdownContentProps {
  content: string
  className?: string
  hideTags?: boolean
  onTaskToggle?: (lineIndex: number) => void
  /** Omitting this adapter preserves image Markdown as source text. */
  renderImage?: (image: MarkdownImageRenderProps) => ReactNode
  /** Inline source is literal by default, preserving fragment selection semantics. */
  renderInline?: (text: string) => ReactNode
  /** Return undefined when the source line does not match an embed. */
  renderEmbed?: (line: string) => ReactNode | undefined
  loadingFallback?: ReactNode
  /** Worker errors fall back to escaped source text unless overridden. */
  errorFallback?: ReactNode
}

interface RenderedContentBlock {
  node: ReactNode
  block: boolean
  skipCount?: number
}

export function MarkdownContent({
  content, className, hideTags = false, onTaskToggle, renderImage, renderInline,
  renderEmbed, loadingFallback = "加载中…", errorFallback,
}: MarkdownContentProps) {
  const parsed = useMarkdown("content", content, hideTags, Boolean(renderImage))
  const result = parsed.result?.kind === "content" ? parsed.result : undefined
  const lastVisibleIndex = result?.lastVisibleIndex ?? -1
  const inline = renderInline ?? renderLiteralInline
  const taskToggleRef = useRef(onTaskToggle)
  useEffect(() => { taskToggleRef.current = onTaskToggle }, [onTaskToggle])
  const forwardTaskToggle = useCallback((lineIndex: number) => taskToggleRef.current?.(lineIndex), [])
  const taskToggle = onTaskToggle ? forwardTaskToggle : undefined
  const render = useCallback((block: MarkdownContentBlock): RenderedContentBlock => {
    const embed = renderEmbed?.(block.source)
    if (embed !== undefined) {
      return { block: true, node: <Fragment key={`embed-${block.lineIndex}`}>
        {embed}{block.lineIndex < lastVisibleIndex ? "\n" : null}
      </Fragment> }
    }
    if (block.type === "table") {
      return { block: true, skipCount: block.table.lineCount - 1, node: <Fragment key={`table-${block.lineIndex}`}>
        {renderTable(block.table, inline)}
        {block.lineIndex + block.table.lineCount - 1 < lastVisibleIndex ? "\n" : null}
      </Fragment> }
    }
    if (block.hidden) return { block: false, node: null }
    return { block: false, node: <Fragment key={`line-${block.lineIndex}`}>
      {renderLine(block, inline, renderImage, taskToggle)}
      {block.lineIndex < lastVisibleIndex && !block.image ? "\n" : null}
    </Fragment> }
  }, [inline, lastVisibleIndex, taskToggle, renderEmbed, renderImage])
  const rendered = useRenderedBlocks(result?.blocks, render, parsed.asynchronous, getSkippedLines)
  const error = parsed.error ?? rendered.error
  const loading = !error && !rendered.nodes
  const Root = rendered.nodes?.some((entry) => entry.block) ? "div" : "span"

  return <Root className={["md-content shard-fragment-content", className].filter(Boolean).join(" ")}
    aria-busy={(!error && (loading || rendered.pending)) || undefined} data-markdown-error={error ? "true" : undefined}>
    {error ? (errorFallback ?? content) : loading ? <span role="status">{loadingFallback}</span>
      : rendered.nodes?.map((entry) => entry.node)}
  </Root>
}

function getSkippedLines(block: RenderedContentBlock) {
  return block.skipCount ?? 0
}

function renderTable(table: MarkdownContentTable, renderInline: (text: string) => ReactNode) {
  return <table className="md-table shard-markdown-table">
    <thead><tr>{table.header.map((cell, index) => <th key={index}
      style={{ textAlign: table.align[index] ?? undefined }}>{renderInline(cell)}</th>)}</tr></thead>
    <tbody>{table.rows.slice(table.rowStart, table.rowEnd).map((row, rowIndex) => <tr key={rowIndex}>
      {table.align.map((alignment, index) => <td key={index}
        style={{ textAlign: alignment ?? undefined }}>{renderInline(row[index] ?? "")}</td>)}
    </tr>)}</tbody>
  </table>
}

function renderLine(
  line: MarkdownContentLine,
  renderInline: (text: string) => ReactNode,
  renderImage: MarkdownContentProps["renderImage"],
  onTaskToggle: MarkdownContentProps["onTaskToggle"]
) {
  if (line.image && renderImage) return renderImage({ ...line.image, lineIndex: line.lineIndex })
  if (line.rule) return <span aria-label="分割线" className="md-divider shard-fragment-divider" role="separator" />
  if (!line.task) return renderInline(line.display)
  const { indentation, listMarker, ordered, checked, body } = line.task
  return <>
    {indentation}
    {ordered ? <span className="md-task-list-marker shard-task-list-marker">{listMarker}</span> : null}
    <TaskMarker checked={checked} lineIndex={line.lineIndex} onTaskToggle={onTaskToggle} />
    <span className="md-task-body shard-task-body">{renderInline(body)}</span>
  </>
}

function TaskMarker({ checked, lineIndex, onTaskToggle }: {
  checked: boolean
  lineIndex: number
  onTaskToggle?: (lineIndex: number) => void
}) {
  const checkbox = <span className={[
    "md-task-checkbox shard-task-checkbox",
    checked && "md-task-checkbox-checked shard-task-checkbox-checked",
  ].filter(Boolean).join(" ")} />
  if (!onTaskToggle) return <span className="md-task-marker shard-task-marker" aria-hidden="true"
    data-task-line-index={lineIndex}>{checkbox}</span>
  function stopEditorSelection(event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault()
    event.stopPropagation()
  }
  return <span className="md-task-marker shard-task-marker" data-task-line-index={lineIndex}>
    <button aria-label={checked ? "标记为未完成" : "标记为完成"} aria-pressed={checked}
      className="md-task-toggle shard-task-toggle" type="button"
      onMouseDown={stopEditorSelection} onClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        onTaskToggle(lineIndex)
      }}>{checkbox}</button>
  </span>
}

function renderLiteralInline(text: string): ReactNode {
  return text.length === 0 ? <span>{"\u200b"}</span> : text
}
