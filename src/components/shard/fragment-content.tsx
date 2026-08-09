import {
  Fragment,
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react"
import { createPortal } from "react-dom"
import {
  CopyIcon,
  DownloadIcon,
  FolderOpenIcon,
  Loader2Icon,
  XIcon,
} from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

import {
  getTagRanges,
  isMarkdownHorizontalRuleLine,
  parseMarkdownImageLine,
} from "@/lib/editor-format"
import {
  attachmentHash,
  downloadFragmentImageAttachment,
  loadFragmentImageSrc,
} from "@/lib/fragment-images"
import {
  getApiErrorMessage,
  getFragmentImageFilePath,
  revealFragmentImageInDir,
} from "@/lib/api"
import { cn } from "@/lib/utils"

import styles from "./fragment-content.module.css"

interface ContextMenuPosition {
  left: number
  top: number
}

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

  if (isMarkdownHorizontalRuleLine(line)) {
    return (
      <FragmentDivider
        caretAligned={caretAligned}
        keyPrefix={`rule-${lineIndex}`}
        line={line}
        lineStart={lineStart}
        selectionRange={selectionRange}
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
  const [contextMenuPosition, setContextMenuPosition] =
    useState<ContextMenuPosition | null>(null)
  const [isDownloading, setIsDownloading] = useState(false)
  const [isPreviewOpen, setIsPreviewOpen] = useState(false)
  const contextMenuRef = useRef<HTMLDivElement>(null)
  const previewButtonRef = useRef<HTMLButtonElement>(null)
  const canUseFileActions =
    Boolean(imageSrc) &&
    isLocalImageAttachmentPath(path) &&
    (downloadable || Boolean(vaultPath))

  useEffect(() => {
    let cancelled = false

    if (src) {
      setImageSrc(src)
      return () => {
        cancelled = true
      }
    }

    setIsPreviewOpen(false)
    setImageSrc("")
    loadFragmentImageSrc(path, vaultPath)
      .then((loadedSrc) => {
        if (!cancelled) setImageSrc(loadedSrc)
      })
      .catch(() => {
        if (!cancelled) setImageSrc("")
      })

    return () => {
      cancelled = true
    }
  }, [path, src, vaultPath])

  useEffect(() => {
    if (!imageSrc) setIsPreviewOpen(false)
  }, [imageSrc])

  useEffect(() => {
    if (!canUseFileActions) setContextMenuPosition(null)
  }, [canUseFileActions])

  useEffect(() => {
    if (!contextMenuPosition) return

    function closeContextMenu() {
      setContextMenuPosition(null)
    }

    function handlePointerDown(event: PointerEvent) {
      const target = event.target
      if (
        target instanceof Node &&
        contextMenuRef.current?.contains(target)
      ) {
        return
      }

      closeContextMenu()
    }

    function handleKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") closeContextMenu()
    }

    requestAnimationFrame(() => {
      contextMenuRef.current?.focus()
    })
    document.addEventListener("pointerdown", handlePointerDown)
    document.addEventListener("keydown", handleKeyDown)
    window.addEventListener("blur", closeContextMenu)
    window.addEventListener("resize", closeContextMenu)
    window.addEventListener("scroll", closeContextMenu, true)

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown)
      document.removeEventListener("keydown", handleKeyDown)
      window.removeEventListener("blur", closeContextMenu)
      window.removeEventListener("resize", closeContextMenu)
      window.removeEventListener("scroll", closeContextMenu, true)
    }
  }, [contextMenuPosition])

  async function downloadImage() {
    if (isDownloading) return

    setIsDownloading(true)
    try {
      const saved = await downloadFragmentImageAttachment(path, alt, vaultPath)
      if (saved) {
        toast("图片附件已下载")
      }
    } catch (error) {
      toast.error(`图片附件下载失败：${getApiErrorMessage(error)}`, {
        duration: Infinity,
      })
    } finally {
      setIsDownloading(false)
    }
  }

  function openImageContextMenu(event: MouseEvent) {
    if (!canUseFileActions) return

    event.preventDefault()
    event.stopPropagation()
    setContextMenuPosition(
      getContextMenuPosition(event.clientX, event.clientY)
    )
  }

  function closeImageContextMenu() {
    setContextMenuPosition(null)
  }

  async function copyImageFilePath() {
    try {
      const filePath =
        getLocalImageFilePath(path, vaultPath) ??
        (await getFragmentImageFilePath(path))
      const clipboard = navigator.clipboard
      if (!clipboard) {
        throw new Error("当前环境不支持复制到剪贴板")
      }

      await clipboard.writeText(filePath)
      toast(`已复制图片文件路径：${filePath}`)
    } catch (error) {
      toast.error(`图片路径复制失败：${getApiErrorMessage(error)}`, {
        duration: Infinity,
      })
    }
  }

  async function revealImageInDir() {
    try {
      await revealFragmentImageInDir(path)
      toast("已打开图片所在目录")
    } catch (error) {
      toast.error(`图片所在目录打开失败：${getApiErrorMessage(error)}`, {
        duration: Infinity,
      })
    }
  }

  const attachmentNode = (
    <span
      className="shard-image-attachment"
      data-image-attachment-context-menu={
        canUseFileActions ? "true" : undefined
      }
      onContextMenu={openImageContextMenu}
      title={label}
    >
      {imageSrc && previewable ? (
        <button
          aria-label={previewLabel}
          className="shard-image-attachment-preview"
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            setIsPreviewOpen(true)
          }}
          ref={previewButtonRef}
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
  )
  const contextMenu =
    contextMenuPosition && canUseFileActions
      ? createPortal(
          <div
            className={styles.contextMenu}
            onContextMenu={(event) => {
              event.preventDefault()
            }}
            ref={contextMenuRef}
            role="menu"
            style={{
              left: contextMenuPosition.left,
              top: contextMenuPosition.top,
            }}
            tabIndex={-1}
          >
            <ImageAttachmentMenuItem
              disabled={isDownloading}
              icon={
                isDownloading ? (
                  <Loader2Icon
                    className={styles.spin}
                    data-icon="inline-start"
                  />
                ) : (
                  <DownloadIcon data-icon="inline-start" />
                )
              }
              label={isDownloading ? "下载中" : "下载图片"}
              onClick={() => {
                closeImageContextMenu()
                void downloadImage()
              }}
            />
            <ImageAttachmentMenuItem
              icon={<FolderOpenIcon data-icon="inline-start" />}
              label="打开所在目录"
              onClick={() => {
                closeImageContextMenu()
                void revealImageInDir()
              }}
            />
            <ImageAttachmentMenuItem
              icon={<CopyIcon data-icon="inline-start" />}
              label="复制文件路径"
              onClick={() => {
                closeImageContextMenu()
                void copyImageFilePath()
              }}
            />
          </div>,
          document.body
        )
      : null
  const attachment = (
    <>
      {attachmentNode}
      {contextMenu}
      {imageSrc && previewable ? (
        <Dialog open={isPreviewOpen} onOpenChange={setIsPreviewOpen}>
          <DialogContent
            className="shard-image-preview-dialog gap-3 p-3"
            finalFocus={previewButtonRef}
          >
            <DialogHeader className="sr-only">
              <DialogTitle>{label}</DialogTitle>
              <DialogDescription>放大查看图片附件。</DialogDescription>
            </DialogHeader>
            <div className="shard-image-preview-frame">
              <img
                alt={label}
                className="shard-image-preview-image"
                data-source-path={path}
                src={imageSrc}
              />
            </div>
            {downloadable ? (
              <div className="shard-image-preview-actions flex">
                <Button
                  disabled={isDownloading}
                  onClick={() => {
                    void downloadImage()
                  }}
                  variant="default"
                >
                  {isDownloading ? (
                    <Loader2Icon aria-hidden="true" className={styles.spin} />
                  ) : (
                    <DownloadIcon aria-hidden="true" />
                  )}
                  {isDownloading ? "下载中" : "下载图片"}
                </Button>
              </div>
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

interface ImageAttachmentMenuItemProps {
  disabled?: boolean
  icon: ReactNode
  label: string
  onClick: () => void
}

function ImageAttachmentMenuItem({
  disabled = false,
  icon,
  label,
  onClick,
}: ImageAttachmentMenuItemProps) {
  return (
    <button
      className={styles.menuItem}
      disabled={disabled}
      onClick={onClick}
      role="menuitem"
      type="button"
    >
      {icon}
      <span>{label}</span>
    </button>
  )
}

function getContextMenuPosition(clientX: number, clientY: number) {
  const menuWidth = 192
  const menuHeight = 112
  const inset = 8

  return {
    left: Math.max(inset, Math.min(clientX, window.innerWidth - menuWidth)),
    top: Math.max(inset, Math.min(clientY, window.innerHeight - menuHeight)),
  }
}

function isLocalImageAttachmentPath(path: string) {
  const normalizedPath = path.trim()
  if (attachmentHash(normalizedPath)) return true

  return Boolean(
    normalizedPath &&
      !/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(normalizedPath)
  )
}

function getLocalImageFilePath(path: string, vaultPath?: string) {
  const normalizedPath = path.trim()
  // 附件的真实位置只有后端知道（缓存目录里按 hash 分桶），前端拼不出来。
  if (attachmentHash(normalizedPath)) return null
  if (!isLocalImageAttachmentPath(normalizedPath)) return null
  if (isAbsolutePath(normalizedPath)) return normalizedPath
  if (!vaultPath) return null

  const base = vaultPath.replace(/[\\/]+$/u, "")
  const relative = normalizedPath.replace(/^\.?[\\/]+/u, "")
  return `${base}/${relative}`
}

function isAbsolutePath(path: string) {
  return path.startsWith("/") || /^[a-z]:[\\/]/i.test(path)
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

interface FragmentDividerProps {
  caretAligned: boolean
  keyPrefix: string
  line: string
  lineStart: number
  selectionRange: SelectionRange | null
}

function FragmentDivider({
  caretAligned,
  keyPrefix,
  line,
  lineStart,
  selectionRange,
}: FragmentDividerProps) {
  if (caretAligned) {
    return (
      <span className="shard-fragment-divider-editor">
        <span className="shard-fragment-divider-editor-measure">
          {renderSelectedText(line, lineStart, keyPrefix, selectionRange)}
        </span>
        <span
          aria-hidden="true"
          className="shard-fragment-divider-editor-line"
        />
      </span>
    )
  }

  return (
    <span
      aria-label="分割线"
      className="shard-fragment-divider"
      role="separator"
    />
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
