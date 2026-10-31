import { useLayoutEffect, useRef, useState } from "react"
import { GridCellKind, type CustomCell, type CustomRenderer, type ProvideEditorComponent } from "@glideapps/glide-data-grid"
import { open as openFileDialog } from "@tauri-apps/plugin-dialog"

import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { saveFragmentImage, saveImageAttachmentFromPath } from "@/lib/api"
import { vaultImageUrl } from "@/lib/fragment-images"
import { notify } from "@/lib/notify"
import { parseCellImageRefs } from "@/lib/cell-image-refs"
import { isWebRuntime } from "@/lib/transport"
import { fileBytes, IMAGE_FILE_ACCEPT, pickFiles } from "@/lib/web-files"

import "./image-cell.css"

/**
 * CSV 单元格里的图片：格里写的是图片引用（识别规则见 `@/lib/cell-image-refs`），表格只是
 * 把它画成缩略图——原文始终是这段文字，用 Excel 打开仍是路径。
 */
export { isLocalImageRef, isRemoteImageRef, parseCellImageRefs } from "@/lib/cell-image-refs"

export const IMAGE_CELL_KIND = "shard-image-cell"
/** 含图片的行加高到能看清缩略图。 */
export const IMAGE_ROW_HEIGHT = 88

export type ImageCellData = { kind: typeof IMAGE_CELL_KIND; raw: string; refs: string[] }
export type ImageCell = CustomCell<ImageCellData>

export function isImageCell(cell: { kind: GridCellKind; data?: unknown }): cell is ImageCell {
  return cell.kind === GridCellKind.Custom && (cell.data as { kind?: string } | undefined)?.kind === IMAGE_CELL_KIND
}

export function imageCell(raw: string, refs: string[], readonly: boolean): ImageCell {
  return {
    kind: GridCellKind.Custom,
    allowOverlay: true,
    copyData: raw,
    readonly,
    data: { kind: IMAGE_CELL_KIND, raw, refs },
  }
}

/** 往格里放新图：原来就是图片格就接在后面，否则替换（撤销可还原）。 */
export function withAddedImages(current: string, added: string[]) {
  const existing = parseCellImageRefs(current)
  return [...(existing ?? []), ...added].join("\n")
}

const GAP = 4

export const imageCellRenderer: CustomRenderer<ImageCell> = {
  kind: GridCellKind.Custom,
  isMatch: (cell): cell is ImageCell => isImageCell(cell),
  needsHover: false,
  draw: (args, cell) => {
    const { ctx, rect, theme, imageLoader, col, row } = args
    const padding = theme.cellHorizontalPadding
    const top = rect.y + GAP
    const maxHeight = rect.height - GAP * 2
    const right = rect.x + rect.width - padding
    let x = rect.x + padding
    let drew = false
    for (const ref of cell.data.refs) {
      const url = vaultImageUrl(ref)
      const image = url ? imageLoader.loadOrGetImage(url, col, row) : undefined
      if (!image || !image.width || !image.height) continue
      const available = right - x
      if (available < 12) break
      let height = maxHeight
      let width = (image.width / image.height) * height
      if (width > available) {
        width = available
        height = (image.height / image.width) * width
      }
      ctx.save()
      ctx.beginPath()
      ctx.roundRect(x, top + (maxHeight - height) / 2, width, height, theme.roundingRadius ?? 4)
      ctx.clip()
      ctx.drawImage(image, x, top + (maxHeight - height) / 2, width, height)
      ctx.restore()
      x += width + GAP
      drew = true
    }
    if (!drew) {
      // 还在加载或加载不了（远程地址失效、格式 webview 不支持）：先显示原文。
      ctx.fillStyle = theme.textLight
      ctx.font = theme.baseFontFull
      ctx.textBaseline = "middle"
      ctx.fillText(cell.data.raw.split("\n")[0] ?? "", rect.x + padding, rect.y + rect.height / 2, rect.width - padding * 2)
    }
    return true
  },
  provideEditor: () => ({ editor: ImageCellEditor, disablePadding: true }),
  onPaste: (value, data) => {
    const refs = parseCellImageRefs(value)
    return refs ? { ...data, raw: value, refs } : undefined
  },
}

/** 双击图片格：看大图、改路径、从访达选图片追加进来。 */
const ImageCellEditor: ProvideEditorComponent<ImageCell> = ({ value, onChange, onFinishedEditing }) => {
  const [raw, setRaw] = useState(value.data.raw)
  const rawRef = useRef(value.data.raw)
  const [busy, setBusy] = useState(false)
  const latest = useRef(value)
  const input = useRef<HTMLTextAreaElement>(null)
  const refs = parseCellImageRefs(raw) ?? []
  const readonly = Boolean(value.readonly)

  useLayoutEffect(() => {
    // 指针激活时 Glide 随后会把焦点还给画布；挂载后把焦点放进编辑框。
    const frame = requestAnimationFrame(() => input.current?.focus({ preventScroll: true }))
    return () => cancelAnimationFrame(frame)
  }, [])

  function update(next: string) {
    rawRef.current = next
    setRaw(next)
    const cell = { ...value, copyData: next, data: { ...value.data, raw: next, refs: parseCellImageRefs(next) ?? [] } }
    latest.current = cell
    onChange(cell)
  }

  /** 网页：浏览器选图片，按字节存进附件；桌面：系统对话框给本机路径。返回每张图的保存动作。 */
  async function chooseImageSaves(): Promise<Array<() => Promise<string>>> {
    if (isWebRuntime()) {
      const files = await pickFiles({ accept: IMAGE_FILE_ACCEPT, multiple: true })
      return files.map((file) => async () => saveFragmentImage(file.name, await fileBytes(file)))
    }
    const chosen = await openFileDialog({
      title: "选择图片",
      multiple: true,
      directory: false,
      filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg", "heic", "heif", "avif"] }],
    })
    const paths = Array.isArray(chosen) ? chosen : typeof chosen === "string" ? [chosen] : []
    return paths.map((path) => () => saveImageAttachmentFromPath(path))
  }

  async function pickImages() {
    const saves = await chooseImageSaves()
    if (saves.length === 0) return
    setBusy(true)
    try {
      const saved: string[] = []
      for (const save of saves) saved.push(await save())
      // 保存期间用户可能改了文本框：接在最新内容后面。
      update(withAddedImages(rawRef.current, saved))
    } catch (error) {
      notify.failure("图片保存失败", error)
    } finally {
      setBusy(false)
      input.current?.focus({ preventScroll: true })
    }
  }

  return (
    <div className="dataset-image-editor" role="dialog" aria-label="图片单元格">
      <div className="dataset-image-editor__previews">
        {refs.length === 0 ? (
          <p className="dataset-image-editor__empty">这些文字不是图片路径，保存后按普通文字显示。</p>
        ) : (
          refs.map((ref) => (
            <img key={ref} alt={ref.split("/").pop() ?? ref} className="dataset-image-editor__image" src={vaultImageUrl(ref)} />
          ))
        )}
      </div>
      <Textarea
        ref={input}
        aria-label="图片路径"
        className="gdg-input dataset-image-editor__paths"
        readOnly={readonly}
        rows={Math.min(4, Math.max(1, raw.split("\n").length))}
        value={raw}
        onChange={(event) => update(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) { event.stopPropagation(); return }
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onFinishedEditing(undefined, [0, 0]) }
          else if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.stopPropagation(); onFinishedEditing(readonly ? undefined : latest.current, [0, 1]) }
        }}
      />
      <div className="dataset-image-editor__actions">
        {readonly ? null : (
          <Button disabled={busy} size="sm" variant="outline" onClick={() => void pickImages()}>
            {busy ? "保存中…" : "选择图片…"}
          </Button>
        )}
        <Button size="sm" onClick={() => onFinishedEditing(readonly ? undefined : latest.current, [0, 0])}>
          {readonly ? "关闭" : "完成"}
        </Button>
      </div>
    </div>
  )
}
