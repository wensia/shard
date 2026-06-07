import { Fragment, type MouseEvent, type ReactNode } from "react"

import { getTagRanges } from "@/lib/editor-format"
import { cn } from "@/lib/utils"

interface FragmentContentProps {
  className?: string
  content: string
  highlightTags?: boolean
  onTaskToggle?: (lineIndex: number) => void
  selectionEnd?: number
  selectionStart?: number
}

const TASK_MARKER_PATTERN =
  /^(\s*)((?:[-*+]|\d+[.)])\s+)(\[([ xX])\]\s*)(.*)$/

export function FragmentContent({
  className,
  content,
  highlightTags = false,
  onTaskToggle,
  selectionEnd,
  selectionStart,
}: FragmentContentProps) {
  const lines = content.split("\n")
  const selectionRange = getSelectionRange(selectionStart, selectionEnd)
  let lineStart = 0

  return (
    <span className={cn("shard-fragment-content", className)}>
      {lines.map((line, index) => {
        const currentLineStart = lineStart
        lineStart += line.length + 1

        return (
          <Fragment key={`${index}-${line}`}>
            {renderLine(
              line,
              highlightTags,
              index,
              currentLineStart,
              selectionRange,
              onTaskToggle
            )}
            {index < lines.length - 1 ? "\n" : null}
          </Fragment>
        )
      })}
    </span>
  )
}

function renderLine(
  line: string,
  highlightTags: boolean,
  lineIndex: number,
  lineStart: number,
  selectionRange: SelectionRange | null,
  onTaskToggle: ((lineIndex: number) => void) | undefined
): ReactNode {
  const taskMatch = line.match(TASK_MARKER_PATTERN)
  if (!taskMatch) {
    return renderInlineContent(
      line,
      highlightTags,
      `line-${lineIndex}`,
      lineStart,
      selectionRange
    )
  }

  const [, indentation, listMarker, taskMarker, checkedMarker, body = ""] =
    taskMatch
  const checked = checkedMarker.toLowerCase() === "x"
  const isOrderedTask = /^\d+[.)]\s+$/.test(listMarker)
  const listMarkerStart = lineStart + indentation.length
  const taskMarkerStart = listMarkerStart + listMarker.length
  const bodyStart = taskMarkerStart + taskMarker.length

  return (
    <>
      {renderSelectedText(
        indentation,
        lineStart,
        `task-indent-${lineIndex}`,
        selectionRange
      )}
      {isOrderedTask ? (
        <span className="shard-task-list-marker">
          {renderSelectedText(
            listMarker,
            listMarkerStart,
            `task-list-${lineIndex}`,
            selectionRange
          )}
        </span>
      ) : null}
      <TaskMarker
        checked={checked}
        lineIndex={lineIndex}
        onTaskToggle={onTaskToggle}
        rawMarker={isOrderedTask ? taskMarker : `${listMarker}${taskMarker}`}
      />
      {renderInlineContent(
        body,
        highlightTags,
        `task-${lineIndex}`,
        bodyStart,
        selectionRange
      )}
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
  keyPrefix: string,
  textStart: number,
  selectionRange: SelectionRange | null
): ReactNode {
  if (text.length === 0) return "\u200b"
  if (!highlightTags) {
    return renderSelectedText(text, textStart, keyPrefix, selectionRange)
  }

  const ranges = getTagRanges(text)
  const nodes: ReactNode[] = []
  let cursor = 0

  for (const range of ranges) {
    if (range.start > cursor) {
      nodes.push(
        renderSelectedText(
          text.slice(cursor, range.start),
          textStart + cursor,
          `${keyPrefix}-text-${cursor}`,
          selectionRange
        )
      )
    }

    nodes.push(
      <span
        className="shard-editor-tag-highlight"
        key={`${keyPrefix}-tag-${range.start}`}
      >
        {renderSelectedText(
          range.text,
          textStart + range.start,
          `${keyPrefix}-tag-text-${range.start}`,
          selectionRange
        )}
      </span>
    )
    cursor = range.end
  }

  if (cursor < text.length) {
    nodes.push(
      renderSelectedText(
        text.slice(cursor),
        textStart + cursor,
        `${keyPrefix}-text-${cursor}`,
        selectionRange
      )
    )
  }

  return nodes.length > 0 ? nodes : text
}

interface SelectionRange {
  end: number
  start: number
}

function getSelectionRange(
  selectionStart: number | undefined,
  selectionEnd: number | undefined
): SelectionRange | null {
  if (
    selectionStart === undefined ||
    selectionEnd === undefined ||
    selectionStart === selectionEnd
  ) {
    return null
  }

  return {
    end: Math.max(selectionStart, selectionEnd),
    start: Math.min(selectionStart, selectionEnd),
  }
}

function renderSelectedText(
  text: string,
  textStart: number,
  keyPrefix: string,
  selectionRange: SelectionRange | null
): ReactNode {
  if (
    !selectionRange ||
    !doesSelectionIntersectText(text, textStart, selectionRange)
  ) {
    return text
  }

  const selectionStart = Math.max(0, selectionRange.start - textStart)
  const selectionEnd = Math.min(text.length, selectionRange.end - textStart)
  const nodes: ReactNode[] = []

  if (selectionStart > 0) {
    nodes.push(
      <Fragment key={`${keyPrefix}-before`}>
        {text.slice(0, selectionStart)}
      </Fragment>
    )
  }

  nodes.push(
    <span
      className="shard-editor-selection-highlight"
      key={`${keyPrefix}-selection`}
    >
      {text.slice(selectionStart, selectionEnd)}
    </span>
  )

  if (selectionEnd < text.length) {
    nodes.push(
      <Fragment key={`${keyPrefix}-after`}>
        {text.slice(selectionEnd)}
      </Fragment>
    )
  }

  return nodes
}

function doesSelectionIntersectText(
  text: string,
  textStart: number,
  selectionRange: SelectionRange
) {
  const textEnd = textStart + text.length
  return selectionRange.start < textEnd && selectionRange.end > textStart
}
