import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react"
import { createPortal } from "react-dom"
import {
  ClockIcon,
  CopyIcon,
  DownloadIcon,
  FolderOpenIcon,
  Loader2Icon,
  XIcon,
} from "@/components/icons"
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
  MarkdownContent,
  type MarkdownFenceRenderProps,
  type MarkdownImageRenderProps,
  type MarkdownTaskReminderRenderProps,
} from "@shard/markdown"
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
import { CsvInlineLink, CsvPreview } from "@/components/shard/csv-preview"
// 副作用导入：卡片渲染同样按围栏语言查 UI 注册表，启动时先让块完成注册。
import { getBlockUI } from "@/editor-rich/blocks/registry-ui"
import { formatReminderLabel } from "@/lib/reminders"
import { useReminderDue } from "@/lib/use-reminder-due"
import { isCsvWikilinkTarget, parseWikilinks } from "@/lib/wikilink"

import styles from "./fragment-content.module.css"

interface ContextMenuPosition {
  left: number
  top: number
}

interface FragmentContentProps {
  className?: string
  content: string
  downloadableImages?: boolean
  hideTags?: boolean
  onTaskToggle?: (lineIndex: number) => void
  previewImages?: boolean
  renderImages?: boolean
  vaultPath?: string
}

// Compatibility export for consumers of the historical fallback renderer.
export { INLINE_HIGHLIGHT_FALLBACK_PATTERN } from "@shard/markdown"

/** Shard integration: the portable renderer does not know about vaults or CSV. */
export function FragmentContent({
  className,
  content,
  downloadableImages = false,
  hideTags = false,
  onTaskToggle,
  previewImages = true,
  renderImages = false,
  vaultPath,
}: FragmentContentProps) {
  const renderImage = useCallback(({ alt, path }: MarkdownImageRenderProps) => (
    <FragmentImageAttachment
      alt={alt}
      downloadable={downloadableImages}
      path={path}
      previewable={previewImages}
      vaultPath={vaultPath}
    />
  ), [downloadableImages, previewImages, vaultPath])

  return (
    <MarkdownContent
      className={className}
      content={content}
      hideTags={hideTags}
      onTaskToggle={onTaskToggle}
      renderEmbed={renderCsvEmbed}
      renderFence={renderRegisteredFence}
      renderInline={renderInlineContent}
      renderImage={renderImages ? renderImage : undefined}
      renderTaskReminder={renderTaskReminder}
    />
  )
}

function renderTaskReminder({ at, checked }: MarkdownTaskReminderRenderProps) {
  return <TaskReminderMark at={at} checked={checked} />
}

/**
 * 任务行尾的提醒标记：时钟图标 + 「明天 10:30」，替代正文里的 `⏰ YYYY-MM-DD HH:mm` 原文。
 * 未到点是 muted，已到点且未完成转 kiln 警示色（与 Dock 角标同一口径），完成后退回 muted。
 */
function TaskReminderMark({ at, checked }: MarkdownTaskReminderRenderProps) {
  const due = useReminderDue(at)
  const state = checked ? "done" : due ? "due" : "upcoming"
  return (
    <span
      className="shard-task-reminder-mark"
      data-state={state}
      title={state === "due" ? `提醒已到点：${at}` : `提醒：${at}`}
    >
      <ClockIcon />
      <span>{formatReminderLabel(at)}</span>
    </span>
  )
}

function renderCsvEmbed(line: string): ReactNode | undefined {
  const link = parseStandaloneCsvEmbed(line)
  return link ? <CsvPreview maxRows={10} path={link.target} /> : undefined
}

/**
 * 围栏块的卡片渲染：查 UI 注册表拿 `Preview`（技术方案 §4.4）。
 * 这里不认识任何具体语言，新增一个围栏块只需要注册，不用改卡片渲染。
 */
function renderRegisteredFence({
  code,
  language,
}: MarkdownFenceRenderProps): ReactNode | undefined {
  const ui = getBlockUI(language)
  return ui ? <ui.Preview source={code} /> : undefined
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

function renderInlineContent(text: string): ReactNode {
  if (text.length === 0) {
    return <span>{"\u200b"}</span>
  }
  const csvLinks = parseWikilinks(text).filter(
    (link) => !link.embed && isCsvWikilinkTarget(link.target)
  )
  if (csvLinks.length === 0) return text

  const nodes: ReactNode[] = []
  let cursor = 0
  for (const link of csvLinks) {
    if (link.from > cursor) nodes.push(text.slice(cursor, link.from))
    nodes.push(
      <CsvInlineLink
        key={`${link.from}-${link.target}`}
        label={link.alias || link.target}
        path={link.target}
      />
    )
    cursor = link.to
  }
  if (cursor < text.length) nodes.push(text.slice(cursor))
  return nodes
}

function parseStandaloneCsvEmbed(line: string) {
  const trimmed = line.trim()
  const links = parseWikilinks(trimmed)
  const link = links.length === 1 ? links[0] : null
  return link?.embed && link.from === 0 && link.to === trimmed.length ? link : null
}
