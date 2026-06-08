import {
  Fragment,
  useEffect,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react"
import { XIcon } from "lucide-react"

import { getTagRanges, parseMarkdownImageLine } from "@/lib/editor-format"
import { loadFragmentImageSrc } from "@/lib/fragment-images"
import { cn } from "@/lib/utils"

interface FragmentContentProps {
  className?: string
  content: string
  highlightTags?: boolean
  onTaskToggle?: (lineIndex: number) => void
  renderImages?: boolean
  selectionEnd?: number
  selectionStart?: number
  vaultPath?: string
}

const TASK_MARKER_PATTERN =
  /^(\s*)((?:[-*+]|\d+[.)])\s+)(\[([ xX])\]\s*)(.*)$/

export function FragmentContent({
  className,
  content,
  highlightTags = false,
  onTaskToggle,
  renderImages = false,
  selectionEnd,
  selectionStart,
  vaultPath,
}: FragmentContentProps) {
  const lines = content.split("\n")
  const selectionRange = getSelectionRange(selectionStart, selectionEnd)
  let lineStart = 0

  return (
    <span className={cn("shard-fragment-content", className)}>
      {lines.map((line, index) => {
        const currentLineStart = lineStart
        const isImageLine =
          renderImages && parseMarkdownImageLine(line) !== null
        lineStart += line.length + 1

        return (
          <Fragment key={`${index}-${line}`}>
            {renderLine(
              line,
              highlightTags,
              index,
              currentLineStart,
              selectionRange,
              onTaskToggle,
              renderImages,
              vaultPath
            )}
            {index < lines.length - 1 && !isImageLine ? "\n" : null}
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
  onTaskToggle: ((lineIndex: number) => void) | undefined,
  renderImages: boolean,
  vaultPath: string | undefined
): ReactNode {
  const image = renderImages ? parseMarkdownImageLine(line) : null
  if (image) {
    return (
      <FragmentImageAttachment
        alt={image.alt}
        path={image.path}
        vaultPath={vaultPath}
      />
    )
  }

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

interface FragmentImageAttachmentProps {
  alt: string
  onRemove?: () => void
  path: string
  src?: string
  vaultPath?: string
  wrapped?: boolean
}

export function FragmentImageAttachment({
  alt,
  onRemove,
  path,
  src,
  vaultPath,
  wrapped = true,
}: FragmentImageAttachmentProps) {
  const label = alt ? `图片附件：${alt}` : "图片附件"
  const [imageSrc, setImageSrc] = useState(src ?? "")

  useEffect(() => {
    let isMounted = true
    setImageSrc(src ?? "")

    if (src) return

    loadFragmentImageSrc(path, vaultPath)
      .then((loadedSrc) => {
        if (isMounted) setImageSrc(loadedSrc)
      })
      .catch(() => {
        if (isMounted) setImageSrc("")
      })

    return () => {
      isMounted = false
    }
  }, [path, src, vaultPath])

  const attachment = (
    <span className="shard-image-attachment" title={label}>
      {imageSrc ? (
        <img alt={label} data-source-path={path} loading="lazy" src={imageSrc} />
      ) : (
        <span aria-hidden="true" className="shard-image-attachment-placeholder" />
      )}
      {onRemove ? (
        <button
          aria-label="移除图片附件"
          className="shard-image-attachment-remove"
          onClick={onRemove}
          type="button"
        >
          <XIcon data-icon="inline-start" />
        </button>
      ) : null}
    </span>
  )

  return wrapped ? (
    <span className="shard-image-attachment-row">{attachment}</span>
  ) : (
    attachment
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
    <span
      className={cn(
        "shard-task-checkbox",
        checked && "shard-task-checkbox-checked"
      )}
    />
  )

  if (!onTaskToggle) {
    return (
      <span className="shard-task-marker" aria-hidden="true">
        <span className="shard-task-marker-measure">{rawMarker}</span>
        {checkbox}
      </span>
    )
  }

  function stopEditorSelection(event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault()
    event.stopPropagation()
  }

  return (
    <span className="shard-task-marker">
      <span className="shard-task-marker-measure">{rawMarker}</span>
      <button
        aria-label={checked ? "标记为未完成" : "标记为完成"}
        aria-pressed={checked}
        className="shard-task-toggle"
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
    </span>
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
