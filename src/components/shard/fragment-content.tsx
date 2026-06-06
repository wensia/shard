import { Fragment, type MouseEvent, type ReactNode } from "react"

import { getTagRanges } from "@/lib/editor-format"
import { cn } from "@/lib/utils"

interface FragmentContentProps {
  className?: string
  content: string
  highlightTags?: boolean
  onTaskToggle?: (lineIndex: number) => void
}

const TASK_MARKER_PATTERN =
  /^(\s*)((?:[-*+]|\d+[.)])\s+)(\[([ xX])\]\s*)(.*)$/

export function FragmentContent({
  className,
  content,
  highlightTags = false,
  onTaskToggle,
}: FragmentContentProps) {
  const lines = content.split("\n")

  return (
    <span className={cn("shard-fragment-content", className)}>
      {lines.map((line, index) => (
        <Fragment key={`${index}-${line}`}>
          {renderLine(line, highlightTags, index, onTaskToggle)}
          {index < lines.length - 1 ? "\n" : null}
        </Fragment>
      ))}
    </span>
  )
}

function renderLine(
  line: string,
  highlightTags: boolean,
  lineIndex: number,
  onTaskToggle: ((lineIndex: number) => void) | undefined
): ReactNode {
  const taskMatch = line.match(TASK_MARKER_PATTERN)
  if (!taskMatch) {
    return renderInlineContent(line, highlightTags, `line-${lineIndex}`)
  }

  const [, indentation, listMarker, taskMarker, checkedMarker, body = ""] =
    taskMatch
  const checked = checkedMarker.toLowerCase() === "x"
  const isOrderedTask = /^\d+[.)]\s+$/.test(listMarker)

  return (
    <>
      {indentation}
      {isOrderedTask ? (
        <span className="shard-task-list-marker">{listMarker}</span>
      ) : null}
      <TaskMarker
        checked={checked}
        lineIndex={lineIndex}
        onTaskToggle={onTaskToggle}
        rawMarker={isOrderedTask ? taskMarker : `${listMarker}${taskMarker}`}
      />
      {renderInlineContent(body, highlightTags, `task-${lineIndex}`)}
    </>
  )
}

interface TaskMarkerProps {
  checked: boolean
  lineIndex: number
  onTaskToggle?: (lineIndex: number) => void
  rawMarker: string
}

function TaskMarker({
  checked,
  lineIndex,
  onTaskToggle,
  rawMarker,
}: TaskMarkerProps) {
  const checkbox = (
    <>
      <span className="shard-task-marker-measure">{rawMarker}</span>
      <span
        className={cn(
          "shard-task-checkbox",
          checked && "shard-task-checkbox-checked"
        )}
      />
    </>
  )

  if (!onTaskToggle) {
    return (
      <span className="shard-task-marker" aria-hidden="true">
        {checkbox}
      </span>
    )
  }

  function stopEditorSelection(event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault()
    event.stopPropagation()
  }

  return (
    <button
      aria-label={checked ? "标记为未完成" : "标记为完成"}
      aria-pressed={checked}
      className="shard-task-marker shard-task-toggle"
      onClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        onTaskToggle(lineIndex)
      }}
      onMouseDown={stopEditorSelection}
      type="button"
    >
      {checkbox}
    </button>
  )
}

function renderInlineContent(
  text: string,
  highlightTags: boolean,
  keyPrefix: string
): ReactNode {
  if (text.length === 0) return "\u200b"
  if (!highlightTags) return text

  const ranges = getTagRanges(text)
  const nodes: ReactNode[] = []
  let cursor = 0

  for (const range of ranges) {
    if (range.start > cursor) {
      nodes.push(
        <Fragment key={`${keyPrefix}-text-${cursor}`}>
          {text.slice(cursor, range.start)}
        </Fragment>
      )
    }

    nodes.push(
      <span
        className="shard-editor-tag-highlight"
        key={`${keyPrefix}-tag-${range.start}`}
      >
        {range.text}
      </span>
    )
    cursor = range.end
  }

  if (cursor < text.length) {
    nodes.push(
      <Fragment key={`${keyPrefix}-text-${cursor}`}>
        {text.slice(cursor)}
      </Fragment>
    )
  }

  return nodes.length > 0 ? nodes : text
}
