import {
  Fragment,
  useEffect,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react"
import { DownloadIcon, Loader2Icon, XIcon } from "lucide-react"
import { toast } from "sonner"

import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { getTagRanges, parseMarkdownImageLine } from "@/lib/editor-format"
import {
  downloadFragmentImageAttachment,
  loadFragmentImageSrc,
} from "@/lib/fragment-images"
import { getApiErrorMessage } from "@/lib/api"
import { cn } from "@/lib/utils"

interface FragmentContentProps {
  caretAligned?: boolean
  className?: string
  content: string
  downloadableImages?: boolean
  hideTags?: boolean
  highlightTags?: boolean
  onTaskToggle?: (lineIndex: number) => void
  previewImages?: boolean
  renderImages?: boolean
  selectionEnd?: number
  selectionStart?: number
  vaultPath?: string
}

const TASK_MARKER_PATTERN =
  /^(\s*)((?:[-*+]|\d+[.)])\s+)(\[([ xX])\]\s*)(.*)$/

export function FragmentContent({
  caretAligned = false,
  className,
  content,
  downloadableImages = false,
  hideTags = false,
  highlightTags = false,
  onTaskToggle,
  previewImages = true,
  renderImages = false,
  selectionEnd,
  selectionStart,
  vaultPath,
}: FragmentContentProps) {
  const lines = content.split("\n")
  const selectionRange = getSelectionRange(selectionStart, selectionEnd)
  const displayLines = lines.map((line) => {
    const isImageLine = renderImages && parseMarkdownImageLine(line) !== null
    if (!hideTags || isImageLine) {
      return { display: line, hidden: false, isImageLine }
    }
    const stripped = stripTagsFromLine(line)
    return {
      display: stripped,
      hidden: stripped.length === 0 && line.length > 0,
      isImageLine,
    }
  })
  let lastVisibleIndex = -1
  displayLines.forEach((entry, index) => {
    if (!entry.hidden) lastVisibleIndex = index
  })
  let lineStart = 0

  return (
    <span className={cn("shard-fragment-content", className)}>
      {lines.map((line, index) => {
        const entry = displayLines[index]
        const currentLineStart = lineStart
        lineStart += line.length + 1

        if (entry.hidden) return null

        return (
          <Fragment key={`${index}-${line}`}>
            {renderLine(
              entry.display,
              highlightTags,
              index,
              currentLineStart,
              selectionRange,
              onTaskToggle,
              previewImages,
              renderImages,
              vaultPath,
              caretAligned,
              downloadableImages
            )}
            {index < lastVisibleIndex && !entry.isImageLine ? "\n" : null}
          </Fragment>
        )
      })}
    </span>
  )
}

function stripTagsFromLine(line: string): string {
  const ranges = getTagRanges(line)
  if (ranges.length === 0) return line

  let result = ""
  let cursor = 0
  for (const range of ranges) {
    result += line.slice(cursor, range.start)
    cursor = range.end
  }
  result += line.slice(cursor)

  return result.replace(/[ \t]{2,}/g, " ").replace(/^[ \t]+|[ \t]+$/g, "")
}

function renderLine(
  line: string,
  highlightTags: boolean,
  lineIndex: number,
  lineStart: number,
  selectionRange: SelectionRange | null,
  onTaskToggle: ((lineIndex: number) => void) | undefined,
  previewImages: boolean,
  renderImages: boolean,
  vaultPath: string | undefined,
  caretAligned: boolean,
  downloadableImages: boolean
): ReactNode {
  const image = renderImages ? parseMarkdownImageLine(line) : null
  if (image) {
    return (
      <FragmentImageAttachment
        alt={image.alt}
        downloadable={downloadableImages}
        path={image.path}
        previewable={previewImages}
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
        caretAligned={caretAligned}
        checked={checked}
        lineIndex={lineIndex}
        markerStart={isOrderedTask ? taskMarkerStart : listMarkerStart}
        onTaskToggle={onTaskToggle}
        rawMarker={isOrderedTask ? taskMarker : `${listMarker}${taskMarker}`}
      />
      <span className="shard-task-body">
        {renderInlineContent(
          body,
          highlightTags,
          `task-${lineIndex}`,
          bodyStart,
          selectionRange
        )}
      </span>
    </>
  )
}

interface FragmentImageAttachmentProps {
  alt: string
  downloadable?: boolean
  onRemove?: () => void
  path: string
  previewable?: boolean
  src?: string
  vaultPath?: string
  wrapped?: boolean
}

export function FragmentImageAttachment({
  alt,
  downloadable = false,
  onRemove,
  path,
  previewable = true,
  src,
  vaultPath,
  wrapped = true,
}: FragmentImageAttachmentProps) {
  const label = alt ? `图片附件：${alt}` : "图片附件"
  const previewLabel = alt ? `放大查看图片附件：${alt}` : "放大查看图片附件"
  const [imageSrc, setImageSrc] = useState(src ?? "")
  const [isDownloading, setIsDownloading] = useState(false)
  const [isPreviewOpen, setIsPreviewOpen] = useState(false)

  useEffect(() => {
    let isMounted = true
    setImageSrc(src ?? "")
    if (!src) setIsPreviewOpen(false)

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

  useEffect(() => {
    if (!imageSrc) setIsPreviewOpen(false)
  }, [imageSrc])

  async function downloadImage() {
    if (isDownloading) return

    setIsDownloading(true)
    try {
      const saved = await downloadFragmentImageAttachment(path, alt, vaultPath)
      if (saved) {
        toast.success("图片附件已下载")
      }
    } catch (error) {
      toast.error("图片附件下载失败", {
        description: getApiErrorMessage(error),
      })
    } finally {
      setIsDownloading(false)
    }
  }

  const attachment = (
    <>
      <span className="shard-image-attachment" title={label}>
        {imageSrc && previewable ? (
          <button
            aria-label={previewLabel}
            className="shard-image-attachment-preview"
            onClick={(event) => {
              event.preventDefault()
              event.stopPropagation()
              setIsPreviewOpen(true)
            }}
            type="button"
          >
            <img
              alt={label}
              data-source-path={path}
              loading="lazy"
              src={imageSrc}
            />
          </button>
        ) : imageSrc ? (
          <span className="shard-image-attachment-preview shard-image-attachment-preview-readonly">
            <img
              alt={label}
              data-source-path={path}
              loading="lazy"
              src={imageSrc}
            />
          </span>
        ) : (
          <span
            aria-hidden="true"
            className="shard-image-attachment-placeholder"
          />
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
      {imageSrc && previewable ? (
        <Dialog open={isPreviewOpen} onOpenChange={setIsPreviewOpen}>
          <DialogContent className="shard-image-preview-dialog gap-[var(--shard-space-3)] p-3">
            <DialogTitle className="sr-only">{label}</DialogTitle>
            <div className="shard-image-preview-frame">
              <img
                alt={label}
                className="shard-image-preview-image"
                data-source-path={path}
                src={imageSrc}
              />
            </div>
            {downloadable ? (
              <DialogFooter className="shard-image-preview-actions">
                <Button
                  disabled={isDownloading}
                  onClick={() => {
                    void downloadImage()
                  }}
                  type="button"
                  variant="outline"
                >
                  {isDownloading ? (
                    <Loader2Icon
                      className="animate-spin"
                      data-icon="inline-start"
                    />
                  ) : (
                    <DownloadIcon data-icon="inline-start" />
                  )}
                  {isDownloading ? "下载中" : "下载图片"}
                </Button>
              </DialogFooter>
            ) : null}
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  )

  return wrapped ? (
    <span className="shard-image-attachment-row">{attachment}</span>
  ) : (
    attachment
  )
}

interface TaskMarkerProps {
  caretAligned: boolean
  checked: boolean
  lineIndex: number
  markerStart: number
  onTaskToggle?: (lineIndex: number) => void
  rawMarker: string
}

function TaskMarker({
  caretAligned,
  checked,
  lineIndex,
  markerStart,
  onTaskToggle,
  rawMarker,
}: TaskMarkerProps) {
  // The hidden measure reserves the horizontal space the body text starts
  // after. Editor overlays must mirror the textarea exactly for caret
  // alignment, so they keep the raw marker. Standalone renders normalize the
  // checkbox glyph (space vs "x") so checked/unchecked share the same gap.
  const measureMarker = caretAligned
    ? rawMarker
    : rawMarker.replace(/\[[ xX]\]/, "[ ]")
  const checkbox = (
    <span
      className={cn(
        "shard-task-checkbox",
        checked && "shard-task-checkbox-checked"
      )}
    />
  )
  const measure = (
    <span
      className="shard-task-marker-measure"
      data-text-length={rawMarker.length}
      data-text-start={markerStart}
    >
      {measureMarker}
    </span>
  )

  if (!onTaskToggle) {
    return (
      <span
        className="shard-task-marker"
        aria-hidden="true"
        data-task-line-index={lineIndex}
      >
        {measure}
        {checkbox}
      </span>
    )
  }

  function stopEditorSelection(event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault()
    event.stopPropagation()
  }

  return (
    <span className="shard-task-marker" data-task-line-index={lineIndex}>
      {measure}
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
  if (text.length === 0) {
    return (
      <span data-text-length={0} data-text-start={textStart}>
        {"\u200b"}
      </span>
    )
  }
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
  return (
    <span
      data-text-length={text.length}
      data-text-start={textStart}
      key={keyPrefix}
    >
      {renderSelectionRuns(text, textStart, keyPrefix, selectionRange)}
    </span>
  )
}

function renderSelectionRuns(
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
