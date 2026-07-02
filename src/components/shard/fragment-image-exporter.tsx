import { isTauri } from "@tauri-apps/api/core"
import { save } from "@tauri-apps/plugin-dialog"
import { CheckIcon, ImageIcon, Loader2Icon } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
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
  getApiErrorMessage,
  saveExportedImage,
} from "@/lib/api"
import { cn } from "@/lib/utils"
import type { Fragment } from "@/types"

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
      .catch((error) => {
        if (cancelled) return
        toast.error("预览生成失败", {
          description: getApiErrorMessage(error),
        })
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
    showCreatedDate,
    showCreatedTime,
    templateId,
    vaultPath,
  ])

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

      toast.success("分享图片已复制")
    } catch (error) {
      toast.error("复制分享图片失败", {
        description: getApiErrorMessage(error),
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
        toast.success("分享图片已保存")
        onClose()
        return
      }

      downloadBlob(blob, fileName)
      toast.success("分享图片已下载")
      onClose()
    } catch (error) {
      toast.error("保存分享图片失败", {
        description: getApiErrorMessage(error),
      })
    } finally {
      setIsExporting(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose()
      }}
    >
      <DialogContent
        className="h-[min(860px,calc(100dvh-32px))] w-[min(1040px,calc(100vw-32px))] gap-0 p-0"
      >
        <DialogHeader className="border-b border-border px-[var(--shard-space-5)] py-[var(--shard-space-4)] pr-12">
          <div className="flex min-w-0 items-center gap-[var(--shard-space-3)]">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-[var(--shard-radius-control)] border border-border bg-background text-[color:var(--shard-sapphire)]">
              <ImageIcon className="size-4 stroke-[1.75]" />
            </span>
            <div className="min-w-0">
              <DialogTitle>分享</DialogTitle>
              <DialogDescription>
                {activeTemplate.label} · PNG
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="grid min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)] overflow-hidden md:grid-cols-[184px_minmax(0,1fr)] md:grid-rows-1">
          <div className="grid grid-cols-3 content-start gap-[var(--shard-space-2)] border-b border-border p-[var(--shard-space-3)] md:grid-cols-1 md:border-r md:border-b-0">
            {EXPORT_IMAGE_TEMPLATES.map((template) => (
              <button
                aria-label={`${template.label}，${template.description}`}
                aria-pressed={template.id === templateId}
                className={cn(
                  "grid min-w-0 content-start gap-[var(--shard-space-2)] rounded-[var(--shard-radius-control)] border bg-card p-[var(--shard-space-2)] transition-[background-color,border-color,color,scale] duration-150 ease-out active:scale-[0.96] md:grid-cols-[56px_minmax(0,1fr)] md:items-center md:gap-[var(--shard-space-3)]",
                  "hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/[var(--shard-alpha-34)] focus-visible:outline-none",
                  template.id === templateId
                    ? "border-[color:var(--shard-sapphire)] bg-[color:var(--shard-sapphire-soft)] text-[color:var(--shard-sapphire-text)]"
                    : "border-border text-foreground"
                )}
                key={template.id}
                onClick={() => setTemplateId(template.id)}
                type="button"
              >
                <TemplateThumbnail
                  active={template.id === templateId}
                  templateId={template.id}
                />
                <span className="truncate text-center text-xs leading-5 font-medium text-balance md:text-left">
                  {template.label}
                </span>
              </button>
            ))}
          </div>

          <div
            aria-busy={isPreviewing}
            className="min-h-0 overflow-auto bg-background p-[var(--shard-space-4)] md:p-[var(--shard-space-5)]"
          >
            <div className="relative flex h-full min-h-[320px] w-full items-start justify-center md:items-center">
              {isPreviewing ? (
                <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/[var(--shard-alpha-55)]">
                  <Loader2Icon className="size-5 animate-spin text-muted-foreground" />
                </div>
              ) : null}
              <canvas
                aria-label="分享图片预览"
                className="block h-auto max-h-full w-auto max-w-full rounded-[var(--shard-surface-radius)] border border-border bg-card shadow-[0_8px_20px_rgb(0_0_0/var(--shard-alpha-8))]"
                ref={setPreviewCanvas}
              />
            </div>
          </div>
        </div>

        <DialogFooter className="flex-row items-center justify-between border-t border-border p-[var(--shard-space-4)]">
          <div className="flex items-center gap-[var(--shard-space-1)]">
            <FooterCheckbox
              checked={showCreatedDate}
              label="创建日期"
              onChange={setShowCreatedDate}
            />
            <FooterCheckbox
              checked={showCreatedTime}
              label="创建时间"
              onChange={setShowCreatedTime}
            />
          </div>
          <div className="flex items-center gap-[var(--shard-space-2)]">
            <Button
              disabled={isBusy}
              onClick={onClose}
              type="button"
              variant="outline"
            >
              取消
            </Button>
            <Button
              disabled={isBusy || isPreviewing || !fragment}
              onClick={() => {
                void handleCopy()
              }}
              type="button"
              variant="outline"
            >
              {isCopying ? <Loader2Icon className="size-4 animate-spin" /> : null}
              {isCopying ? "复制中" : "复制图片"}
            </Button>
            <Button
              disabled={isBusy || isPreviewing || !fragment}
              onClick={() => {
                void handleExport()
              }}
              type="button"
            >
              {isExporting ? "保存中" : "保存图片"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function FooterCheckbox({
  checked,
  label,
  onChange,
}: {
  checked: boolean
  label: string
  onChange: (checked: boolean) => void
}) {
  return (
    <button
      aria-checked={checked}
      className="flex items-center gap-[var(--shard-space-2)] rounded-[var(--shard-radius-control)] px-[var(--shard-space-2)] py-[var(--shard-space-1)] text-sm leading-5 text-muted-foreground transition-colors duration-150 hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/[var(--shard-alpha-34)] focus-visible:outline-none"
      onClick={() => onChange(!checked)}
      role="checkbox"
      type="button"
    >
      <span
        aria-hidden="true"
        className={cn(
          "flex size-4 shrink-0 items-center justify-center rounded-[calc(var(--shard-radius-control)-2px)] border-[1.4px] transition-colors duration-150",
          checked
            ? "border-[color:var(--shard-sapphire)] bg-[color:var(--shard-sapphire)] text-white"
            : "border-muted-foreground bg-transparent"
        )}
      >
        {checked ? <CheckIcon className="size-3 stroke-[2.5]" /> : null}
      </span>
      {label}
    </button>
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
      className={cn(
        "relative mx-auto block aspect-[3/4] h-[72px] overflow-hidden rounded-[calc(var(--shard-radius-control)-2px)] border md:h-[74px]"
      )}
      style={{
        backgroundColor: palette.surface,
        borderColor: active ? "var(--shard-sapphire)" : palette.border,
      }}
    >
      <span
        className="absolute top-[10%] left-[14%] h-0.5 w-[30%] rounded-full"
        style={{ backgroundColor: palette.mark }}
      />
      <span
        className="absolute top-[10%] right-[14%] h-0.5 w-[18%] rounded-full"
        style={{ backgroundColor: palette.mark }}
      />
      <span
        className="absolute top-[28%] left-[14%] h-0.5 w-[62%] rounded-full"
        style={{ backgroundColor: palette.ink }}
      />
      <span
        className="absolute top-[39%] left-[14%] h-0.5 w-[52%] rounded-full"
        style={{ backgroundColor: palette.ink }}
      />
      <span
        className="absolute top-[50%] left-[14%] h-0.5 w-[42%] rounded-full"
        style={{ backgroundColor: palette.ink }}
      />
      <span
        className="absolute inset-x-0 bottom-0 h-[28%]"
        style={{ backgroundColor: palette.band }}
      >
        <span
          className="absolute top-[26%] left-[14%] h-0.5 w-[26%] rounded-full"
          style={{ backgroundColor: palette.accent }}
        />
        <span
          className="absolute top-[52%] left-[14%] h-px w-[36%] rounded-full opacity-70"
          style={{ backgroundColor: palette.mark }}
        />
        <span className="absolute right-[14%] bottom-[24%] grid grid-cols-3 gap-[1.5px]">
          {Array.from({ length: 9 }).map((_, index) => (
            <span
              className="size-0.5 rounded-[1px]"
              key={index}
              style={{
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
