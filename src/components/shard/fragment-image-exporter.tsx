import { isTauri } from "@tauri-apps/api/core"
import { save } from "@tauri-apps/plugin-dialog"
import { DownloadIcon, ImageIcon, Loader2Icon } from "lucide-react"
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
import { getApiErrorMessage, saveExportedImage } from "@/lib/api"
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
  const [isPreviewing, setIsPreviewing] = useState(false)
  const [isExporting, setIsExporting] = useState(false)
  const [previewCanvas, setPreviewCanvas] = useState<HTMLCanvasElement | null>(
    null
  )
  const activeTemplate = useMemo(
    () =>
      EXPORT_IMAGE_TEMPLATES.find((template) => template.id === templateId) ??
      EXPORT_IMAGE_TEMPLATES[0],
    [templateId]
  )

  useEffect(() => {
    if (!open || !fragment || !previewCanvas) return

    let cancelled = false

    setIsPreviewing(true)
    nextPaint()
      .then(() =>
        drawFragmentExportImage(previewCanvas, {
          fragment,
          pixelRatio: getCanvasPixelRatio(),
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
  }, [fragment, open, previewCanvas, templateId, vaultPath])

  async function handleExport() {
    if (!fragment) return

    setIsExporting(true)
    try {
      await nextPaint()
      const canvas = document.createElement("canvas")
      await drawFragmentExportImage(canvas, {
        fragment,
        pixelRatio: 2,
        templateId,
        vaultPath,
      })
      const blob = await canvasToPngBlob(canvas)
      const fileName = fragmentExportFileName(fragment, templateId)

      if (isTauri()) {
        const path = await save({
          defaultPath: fileName,
          filters: [{ name: "PNG", extensions: ["png"] }],
          title: "保存分享图片",
        })

        if (!path) return

        await saveExportedImage(path, await blobToBytes(blob))
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
        className="w-[min(880px,calc(100vw-32px))] gap-0 p-0"
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

        <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)]">
          <div className="grid grid-cols-3 gap-[var(--shard-space-2)] border-b border-border p-[var(--shard-space-4)]">
            {EXPORT_IMAGE_TEMPLATES.map((template) => (
              <button
                aria-label={`${template.label}，${template.description}`}
                aria-pressed={template.id === templateId}
                className={cn(
                  "grid min-w-0 content-start gap-[var(--shard-space-2)] rounded-[var(--shard-radius-control)] border bg-card p-[var(--shard-space-2)] transition-colors",
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
                <span className="truncate text-center text-xs leading-5 font-medium">
                  {template.label}
                </span>
              </button>
            ))}
          </div>

          <div
            aria-busy={isPreviewing}
            className="max-h-[calc(100dvh-296px)] min-h-[560px] overflow-auto bg-background p-[var(--shard-space-5)]"
          >
            <div className="relative mx-auto w-full max-w-[480px]">
              {isPreviewing ? (
                <div className="absolute inset-0 z-10 flex items-center justify-center rounded-[var(--shard-surface-radius)] bg-background/[var(--shard-alpha-55)]">
                  <Loader2Icon className="size-5 animate-spin text-muted-foreground" />
                </div>
              ) : null}
              <canvas
                aria-label="分享图片预览"
                className="block h-auto w-full rounded-[var(--shard-surface-radius)] border border-border bg-card shadow-[0_8px_20px_rgb(0_0_0/var(--shard-alpha-8))]"
                ref={setPreviewCanvas}
              />
            </div>
          </div>
        </div>

        <DialogFooter className="flex-row justify-end border-t border-border p-[var(--shard-space-4)]">
          <Button
            disabled={isExporting}
            onClick={onClose}
            type="button"
            variant="outline"
          >
            取消
          </Button>
          <Button
            disabled={isExporting || isPreviewing || !fragment}
            onClick={() => {
              void handleExport()
            }}
            type="button"
          >
            {isExporting ? (
              <Loader2Icon className="animate-spin" data-icon="inline-start" />
            ) : (
              <DownloadIcon data-icon="inline-start" />
            )}
            {isExporting ? "保存中" : "保存图片"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function TemplateThumbnail({
  active,
  templateId,
}: {
  active: boolean
  templateId: ExportImageTemplateId
}) {
  if (templateId === "night") {
    return (
      <span
        aria-hidden
        className={cn(
          "relative block h-24 w-full overflow-hidden rounded-[calc(var(--shard-radius-control)-2px)] border bg-[#111315]",
          active ? "border-[color:var(--shard-sapphire)]" : "border-[#343a3d]"
        )}
      >
        <span className="absolute inset-[12%] rounded-[6px] border border-[#343a3d] bg-[#191d1f]">
          <span className="absolute top-[13%] left-[12%] h-1 w-[28%] rounded-full bg-[#aeb7b7]" />
          <span className="absolute top-[27%] left-[12%] h-1 w-[60%] rounded-full bg-[#f7f8f8]" />
          <span className="absolute top-[39%] left-[12%] h-1 w-[52%] rounded-full bg-[#f7f8f8]" />
          <span className="absolute top-[51%] left-[12%] h-1 w-[44%] rounded-full bg-[#f7f8f8]" />
          <span className="absolute right-[12%] bottom-[13%] h-1 w-[18%] rounded-full bg-[#de9681]" />
        </span>
      </span>
    )
  }

  if (templateId === "focus") {
    return (
      <span
        aria-hidden
        className={cn(
          "relative block h-24 w-full overflow-hidden rounded-[calc(var(--shard-radius-control)-2px)] border bg-[#eef1f0]",
          active ? "border-[color:var(--shard-sapphire)]" : "border-[#cbd2d2]"
        )}
      >
        <span className="absolute inset-[10%] rounded-[6px] border border-[#cbd2d2] bg-[#fbfcfc]">
          <span className="absolute inset-y-0 left-0 w-1 rounded-l-[6px] bg-[#b6533c]" />
          <span className="absolute top-[13%] left-[13%] h-1 w-[26%] rounded-full bg-[#596364]" />
          <span className="absolute top-[28%] left-[13%] h-[10%] w-[22%] rounded-full bg-white" />
          <span className="absolute top-[46%] left-[13%] h-1 w-[62%] rounded-full bg-[#171a1c]" />
          <span className="absolute top-[58%] left-[13%] h-1 w-[48%] rounded-full bg-[#171a1c]" />
        </span>
      </span>
    )
  }

  return (
    <span
      aria-hidden
      className={cn(
        "relative block h-24 w-full overflow-hidden rounded-[calc(var(--shard-radius-control)-2px)] border bg-white",
        active ? "border-[color:var(--shard-sapphire)]" : "border-[#d8dddd]"
      )}
    >
      <span className="absolute top-[12%] left-[13%] h-1 w-[30%] rounded-full bg-[#9a9a9a]" />
      <span className="absolute top-[12%] right-[13%] h-1 w-[18%] rounded-full bg-[#dedede]" />
      <span className="absolute top-[28%] left-[13%] h-1 w-[58%] rounded-full bg-[#323232]" />
      <span className="absolute top-[40%] left-[13%] h-1 w-[52%] rounded-full bg-[#323232]" />
      <span className="absolute top-[52%] left-[13%] h-1 w-[44%] rounded-full bg-[#323232]" />
      <span className="absolute inset-x-0 bottom-0 h-[24%] bg-[#fbfbfb]">
        <span className="absolute top-[28%] left-[13%] h-1 w-[22%] rounded-full bg-[#b6533c]" />
        <span className="absolute top-[50%] left-[13%] h-1 w-[32%] rounded-full bg-[#9a9a9a]" />
        <span className="absolute right-[13%] bottom-[24%] grid grid-cols-4 gap-[2px]">
          {Array.from({ length: 12 }).map((_, index) => (
            <span
              className={cn(
                "size-1 rounded-[1px]",
                index === 6 || index === 9
                  ? "bg-[#b6533c]/40"
                  : "bg-[#ecefed]"
              )}
              key={index}
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
