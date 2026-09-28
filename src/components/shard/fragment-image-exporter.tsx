import { isTauri } from "@tauri-apps/api/core"
import { save } from "@tauri-apps/plugin-dialog"
import {
  CopyIcon,
  DownloadIcon,
  ImageIcon,
  Loader2Icon,
  XIcon,
} from "@/components/icons"
import { useEffect, useMemo, useState } from "react"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

import {
  EXPORT_IMAGE_TEMPLATES,
  blobToBytes,
  canvasToPngBlob,
  drawFragmentExportImage,
  fragmentExportFileName,
  type ExportImageTemplateId,
} from "@/lib/fragment-export-image"
import {
  copyExportedImage,
  saveExportedImage,
} from "@/lib/api"
import { notify } from "@/lib/notify"
import { cn } from "@/lib/utils"
import type { Fragment } from "@/types"
import styles from "@/components/shard/fragment-image-exporter.module.css"

interface FragmentImageExporterProps {
  fragment: Fragment | null
  onClose: () => void
  open: boolean
  vaultPath?: string
}

export function FragmentImageExporter({
  fragment,
  onClose,
  open,
  vaultPath,
}: FragmentImageExporterProps) {
  const [templateId, setTemplateId] = useState<ExportImageTemplateId>("paper")
  const [showCreatedDate, setShowCreatedDate] = useState(true)
  const [showCreatedTime, setShowCreatedTime] = useState(false)
  const [isPreviewing, setIsPreviewing] = useState(false)
  const [isExporting, setIsExporting] = useState(false)
  const [isCopying, setIsCopying] = useState(false)
  const [previewCanvas, setPreviewCanvas] = useState<HTMLCanvasElement | null>(
    null
  )
  const [previewFrame, setPreviewFrame] = useState<HTMLDivElement | null>(
    null
  )
  const activeTemplate = useMemo(
    () =>
      EXPORT_IMAGE_TEMPLATES.find((template) => template.id === templateId) ??
      EXPORT_IMAGE_TEMPLATES[0],
    [templateId]
  )
  const isBusy = isExporting || isCopying

  useEffect(() => {
    if (!open || !fragment || !previewCanvas) return

    let cancelled = false

    setIsPreviewing(true)
    nextPaint()
      .then(() =>
        drawFragmentExportImage(previewCanvas, {
          fragment,
          pixelRatio: getCanvasPixelRatio(),
          showCreatedDate,
          showCreatedTime,
          templateId,
          vaultPath,
        })
      )
      .then(() => {
        if (!cancelled) fitCanvasToContainer(previewCanvas, previewFrame)
      })
      .catch((error) => {
        if (cancelled) return
        notify.failure("分享图片预览生成失败", error)
      })
      .finally(() => {
        if (!cancelled) setIsPreviewing(false)
      })

    return () => {
      cancelled = true
    }
  }, [
    fragment,
    open,
    previewCanvas,
    previewFrame,
    showCreatedDate,
    showCreatedTime,
    templateId,
    vaultPath,
  ])

  // 预览只按可用宽度缩小，不再强制塞进可用高度。长图保持导出图片的真实比例，
  // 由右侧预览区负责滚动；否则内容越长，整张图会被压成截图里的细长缩略条。
  useEffect(() => {
    if (!previewCanvas || !previewFrame) return

    const observer = new ResizeObserver(() => {
      fitCanvasToContainer(previewCanvas, previewFrame)
    })
    observer.observe(previewFrame)

    return () => observer.disconnect()
  }, [previewCanvas, previewFrame])

  async function renderExportBlob(targetFragment: Fragment) {
    const canvas = document.createElement("canvas")
    await drawFragmentExportImage(canvas, {
      fragment: targetFragment,
      pixelRatio: 2,
      showCreatedDate,
      showCreatedTime,
      templateId,
      vaultPath,
    })
    return canvasToPngBlob(canvas)
  }

  async function handleCopy() {
    if (!fragment) return

    setIsCopying(true)
    try {
      await nextPaint()
      const blob = await renderExportBlob(fragment)
      const bytes = await blobToBytes(blob)

      if (isTauri()) {
        await copyExportedImage(bytes)
      } else {
        await copyBlobImage(blob)
      }

      notify.success("分享图片已复制")
    } catch (error) {
      notify.failure("分享图片复制失败", error, {
        action: { label: "重试", onClick: () => void handleCopy() },
      })
    } finally {
      setIsCopying(false)
    }
  }

  async function handleExport() {
    if (!fragment) return

    setIsExporting(true)
    try {
      await nextPaint()
      const blob = await renderExportBlob(fragment)
      const fileName = fragmentExportFileName(fragment, templateId)

      if (isTauri()) {
        const path = await save({
          defaultPath: fileName,
          filters: [{ name: "PNG", extensions: ["png"] }],
          title: "保存分享图片",
        })

        if (!path) return

        const bytes = await blobToBytes(blob)
        await saveExportedImage(path, bytes)
        notify.success("分享图片已保存")
        onClose()
        return
      }

      downloadBlob(blob, fileName)
      notify.success("分享图片已下载")
      onClose()
    } catch (error) {
      notify.failure("分享图片保存失败", error, {
        action: { label: "重试", onClick: () => void handleExport() },
      })
    } finally {
      setIsExporting(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !isBusy) onClose()
      }}
    >
      <DialogContent
        aria-busy={isBusy}
        className="flex flex-col gap-0 overflow-hidden p-0"
        showCloseButton={false}
        style={{
          width: "min(960px, calc(100vw - 32px))",
          maxWidth: "none",
          height: "min(760px, calc(100dvh - 32px))",
          maxHeight: "min(760px, calc(100dvh - 32px))",
        }}
      >
        <DialogHeader className="shrink-0 gap-0 border-b border-border p-4">
          <div className={styles.header}>
            <span className={styles.headerIcon} aria-hidden="true">
              <ImageIcon className="size-(--shard-icon-size-md)" />
            </span>
            <div className={styles.headerText}>
              <DialogTitle className={styles.headerTitle}>
                导出分享图片
              </DialogTitle>
              <DialogDescription className={styles.headerSubtitle}>
                PNG · {activeTemplate.width}px 宽 · 高度随内容
              </DialogDescription>
            </div>
            <Button
              aria-label="关闭分享图片对话框"
              className={styles.headerClose}
              disabled={isBusy}
              onClick={onClose}
              size="icon-sm"
              type="button"
              variant="ghost"
            >
              <XIcon aria-hidden="true" />
              <span className="sr-only">关闭分享图片对话框</span>
            </Button>
          </div>
        </DialogHeader>
        <div
          className="grid min-h-0 flex-1"
          style={{
            gridTemplateColumns: "240px minmax(0, 1fr)",
          }}
        >
          <aside
            className="min-h-0 overflow-y-auto border-r border-border p-4"
            style={{ width: "240px" }}
          >
            <div className={styles.settingsPanel}>
              <section className={styles.settingsSection}>
                <div>
                  <h2 className={styles.sectionTitle}>样式</h2>
                  <p className={styles.sectionDescription}>
                    选择分享图片的纸张与阅读氛围。
                  </p>
                </div>
                <div className={styles.templateList}>
                  {EXPORT_IMAGE_TEMPLATES.map((template) => (
                    <button
                      aria-label={`${template.label}，${template.description}`}
                      aria-pressed={template.id === templateId}
                      className={cn(
                        styles.templateButton,
                        template.id === templateId && styles.templateButtonActive
                      )}
                      key={template.id}
                      onClick={() => setTemplateId(template.id)}
                      type="button"
                    >
                      <TemplateThumbnail
                        active={template.id === templateId}
                        templateId={template.id}
                      />
                      <span className={styles.templateCopy}>
                        <span className={styles.templateLabel}>
                          {template.label}
                        </span>
                        <span className={styles.templateDescription}>
                          {template.description}
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              </section>

              <section className={styles.settingsSection}>
                <div>
                  <h2 className={styles.sectionTitle}>信息</h2>
                  <p className={styles.sectionDescription}>
                    控制图片顶部显示的时间信息。
                  </p>
                </div>
                <div className={styles.checkboxList}>
                  <label
                    className="flex items-center gap-2 text-sm"
                    htmlFor="export-show-created-date"
                  >
                    <Checkbox
                      checked={showCreatedDate}
                      id="export-show-created-date"
                      onCheckedChange={setShowCreatedDate}
                    />
                    创建日期
                  </label>
                  <label
                    className="flex items-center gap-2 text-sm"
                    htmlFor="export-show-created-time"
                  >
                    <Checkbox
                      checked={showCreatedTime}
                      id="export-show-created-time"
                      onCheckedChange={setShowCreatedTime}
                    />
                    创建时间
                  </label>
                </div>
              </section>
            </div>
          </aside>
          <main className="min-h-0 overflow-hidden">
            <div aria-busy={isPreviewing} className={styles.previewArea}>
              <div className={styles.previewFrame} ref={setPreviewFrame}>
                {isPreviewing ? (
                  <div className={styles.previewOverlay}>
                    <Loader2Icon
                      className={`${styles.spin} size-(--shard-icon-size-lg)`}
                      style={{ color: "var(--muted-foreground)" }}
                    />
                  </div>
                ) : null}
                <canvas
                  aria-label="分享图片预览"
                  className={styles.previewCanvas}
                  ref={setPreviewCanvas}
                />
              </div>
            </div>
          </main>
        </div>
        <footer className="shrink-0 border-t border-border p-4">
          <div className="flex items-center justify-end gap-2">
            <Button disabled={isBusy} onClick={onClose} variant="secondary">
              取消
            </Button>
            {/*
              忙碌态只换图标、不换文案：换成「复制中」会少一个字，按钮跟着
              收缩十几像素。这一步紧接着是原生保存/剪贴板交互，WKWebView 在
              原生模态期间不重绘，收缩前后的两帧就叠在一起，看着像文字重影
              加边框错位。状态由 spinner 与 aria-busy 表达，几何保持不动。
            */}
            <Button
              aria-busy={isCopying || undefined}
              disabled={isBusy || isPreviewing || !fragment}
              onClick={() => {
                void handleCopy()
              }}
              variant="secondary"
            >
              {isCopying ? (
                <Loader2Icon aria-hidden="true" className={styles.spin} />
              ) : (
                <CopyIcon aria-hidden="true" />
              )}
              复制图片
            </Button>
            <Button
              aria-busy={isExporting || undefined}
              disabled={isBusy || isPreviewing || !fragment}
              onClick={() => {
                void handleExport()
              }}
              variant="default"
            >
              {isExporting ? (
                <Loader2Icon aria-hidden="true" className={styles.spin} />
              ) : (
                <DownloadIcon aria-hidden="true" />
              )}
              保存图片
            </Button>
          </div>
        </footer>
      </DialogContent>
    </Dialog>
  )
}

async function copyBlobImage(blob: Blob) {
  const clipboard = navigator.clipboard
  if (!clipboard?.write || typeof ClipboardItem === "undefined") {
    throw new Error("当前环境不支持复制图片。")
  }

  await clipboard.write([
    new ClipboardItem({
      [blob.type || "image/png"]: blob,
    }),
  ])
}

const TEMPLATE_PREVIEWS: Record<
  ExportImageTemplateId,
  {
    surface: string
    band: string
    border: string
    ink: string
    mark: string
    accent: string
    grid: string
  }
> = {
  paper: {
    surface: "#ffffff",
    band: "#fbfbfb",
    border: "#d8dddd",
    ink: "#323232",
    mark: "#dedede",
    accent: "#b6533c",
    grid: "#ecefed",
  },
  focus: {
    surface: "#faf6ef",
    band: "#f4ece0",
    border: "#e3d8c8",
    ink: "#2c2620",
    mark: "#e3d8c8",
    accent: "#b6533c",
    grid: "#ece1d2",
  },
  night: {
    surface: "#15181b",
    band: "#1c2023",
    border: "#2e3438",
    ink: "#e9ebea",
    mark: "#2e3438",
    accent: "#db8d72",
    grid: "#252b2f",
  },
}

function TemplateThumbnail({
  active,
  templateId,
}: {
  active: boolean
  templateId: ExportImageTemplateId
}) {
  const palette = TEMPLATE_PREVIEWS[templateId]

  return (
    <span
      aria-hidden
      className={styles.thumbnail}
      style={{
        backgroundColor: palette.surface,
        borderColor: active ? "var(--shard-sapphire)" : palette.border,
      }}
    >
      <span
        style={{
          position: "absolute",
          top: "10%",
          left: "14%",
          height: 2,
          width: "30%",
          borderRadius: 9999,
          backgroundColor: palette.mark,
        }}
      />
      <span
        style={{
          position: "absolute",
          top: "10%",
          right: "14%",
          height: 2,
          width: "18%",
          borderRadius: 9999,
          backgroundColor: palette.mark,
        }}
      />
      <span
        style={{
          position: "absolute",
          top: "28%",
          left: "14%",
          height: 2,
          width: "62%",
          borderRadius: 9999,
          backgroundColor: palette.ink,
        }}
      />
      <span
        style={{
          position: "absolute",
          top: "39%",
          left: "14%",
          height: 2,
          width: "52%",
          borderRadius: 9999,
          backgroundColor: palette.ink,
        }}
      />
      <span
        style={{
          position: "absolute",
          top: "50%",
          left: "14%",
          height: 2,
          width: "42%",
          borderRadius: 9999,
          backgroundColor: palette.ink,
        }}
      />
      <span
        style={{
          position: "absolute",
          insetInline: 0,
          bottom: 0,
          height: "28%",
          backgroundColor: palette.band,
        }}
      >
        <span
          style={{
            position: "absolute",
            top: "26%",
            left: "14%",
            height: 2,
            width: "26%",
            borderRadius: 9999,
            backgroundColor: palette.accent,
          }}
        />
        <span
          style={{
            position: "absolute",
            top: "52%",
            left: "14%",
            height: 1,
            width: "36%",
            borderRadius: 9999,
            opacity: 0.7,
            backgroundColor: palette.mark,
          }}
        />
        <span
          style={{
            position: "absolute",
            right: "14%",
            bottom: "24%",
            display: "grid",
            gridTemplateColumns: "repeat(3, 1fr)",
            gap: "1.5px",
          }}
        >
          {Array.from({ length: 9 }).map((_, index) => (
            <span
              key={index}
              style={{
                height: 2,
                width: 2,
                borderRadius: 1,
                backgroundColor:
                  index === 4 || index === 7 ? palette.accent : palette.grid,
                opacity: index === 4 || index === 7 ? 0.42 : 1,
              }}
            />
          ))}
        </span>
      </span>
    </span>
  )
}

function nextPaint() {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve())
    })
  })
}

function getCanvasPixelRatio() {
  return Math.min(Math.max(window.devicePixelRatio || 1, 1), 3)
}

function fitCanvasToContainer(
  canvas: HTMLCanvasElement,
  container: HTMLElement | null
) {
  if (!container) return

  const canvasWidth = Number(canvas.dataset.logicalWidth) || canvas.width
  const canvasHeight = Number(canvas.dataset.logicalHeight) || canvas.height
  const availableWidth = container.clientWidth
  if (!canvasWidth || !canvasHeight || !availableWidth) {
    return
  }

  const scale = Math.min(1, availableWidth / canvasWidth)
  canvas.style.width = `${Math.round(canvasWidth * scale)}px`
  canvas.style.height = `${Math.round(canvasHeight * scale)}px`
}

function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = fileName
  anchor.rel = "noreferrer"
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}
