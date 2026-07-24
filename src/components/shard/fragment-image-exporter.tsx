import { isTauri } from "@tauri-apps/api/core"
import { save } from "@tauri-apps/plugin-dialog"
import { CheckIcon, ImageIcon, Loader2Icon } from "lucide-react"
import { useEffect, useMemo, useState } from "react"

import { Button } from "@astryxdesign/core/Button"
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog"
import { HStack } from "@astryxdesign/core/HStack"
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout"
import { useToast } from "@astryxdesign/core/Toast"

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
  const toast = useToast()
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
        toast({
          body: `预览生成失败：${getApiErrorMessage(error)}`,
          type: "error",
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

      toast({ body: "分享图片已复制" })
    } catch (error) {
      toast({
        body: `复制分享图片失败：${getApiErrorMessage(error)}`,
        type: "error",
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
        toast({ body: "分享图片已保存" })
        onClose()
        return
      }

      downloadBlob(blob, fileName)
      toast({ body: "分享图片已下载" })
      onClose()
    } catch (error) {
      toast({
        body: `保存分享图片失败：${getApiErrorMessage(error)}`,
        type: "error",
      })
    } finally {
      setIsExporting(false)
    }
  }

  return (
    <Dialog
      isOpen={open}
      maxHeight="min(860px, calc(100dvh - 32px))"
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose()
      }}
      padding={0}
      width="min(1040px, calc(100vw - 32px))"
    >
      <Layout
        header={
          <DialogHeader
            hasDivider
            onOpenChange={(nextOpen) => {
              if (!nextOpen) onClose()
            }}
            startContent={
              <span
                style={{
                  display: "flex",
                  width: 32,
                  height: 32,
                  flexShrink: 0,
                  alignItems: "center",
                  justifyContent: "center",
                  borderRadius: "var(--shard-radius-control)",
                  border: "1px solid var(--border)",
                  background: "var(--background)",
                  color: "var(--shard-sapphire)",
                }}
              >
                <ImageIcon size={16} strokeWidth={1.75} />
              </span>
            }
            subtitle={`${activeTemplate.label} · PNG`}
            title="分享"
          />
        }
        height="fill"
        style={{ height: "min(860px, calc(100dvh - 32px))" }}
        content={
          <LayoutContent isScrollable={false} padding={0}>
            <div className={styles.body}>
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
                    <span className={styles.templateLabel}>
                      {template.label}
                    </span>
                  </button>
                ))}
              </div>

              <div aria-busy={isPreviewing} className={styles.previewArea}>
                <div className={styles.previewFrame}>
                  {isPreviewing ? (
                    <div className={styles.previewOverlay}>
                      <Loader2Icon
                        className={styles.spin}
                        size={20}
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
            </div>
          </LayoutContent>
        }
        footer={
          <LayoutFooter hasDivider padding={4}>
            <HStack hAlign="between" vAlign="center">
              <HStack gap={1}>
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
              </HStack>
              <HStack gap={2}>
                <Button
                  isDisabled={isBusy}
                  label="取消"
                  onClick={onClose}
                  variant="secondary"
                />
                <Button
                  icon={
                    isCopying ? (
                      <Loader2Icon className={styles.spin} />
                    ) : undefined
                  }
                  isDisabled={isBusy || isPreviewing || !fragment}
                  label={isCopying ? "复制中" : "复制图片"}
                  onClick={() => {
                    void handleCopy()
                  }}
                  variant="secondary"
                />
                <Button
                  isDisabled={isBusy || isPreviewing || !fragment}
                  label={isExporting ? "保存中" : "保存图片"}
                  onClick={() => {
                    void handleExport()
                  }}
                  variant="primary"
                />
              </HStack>
            </HStack>
          </LayoutFooter>
        }
      />
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
      className={styles.footerCheckbox}
      onClick={() => onChange(!checked)}
      role="checkbox"
      type="button"
    >
      <span
        aria-hidden="true"
        className={cn(
          styles.footerCheckboxBox,
          checked && styles.footerCheckboxBoxChecked
        )}
      >
        {checked ? <CheckIcon size={12} strokeWidth={2.5} /> : null}
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
