import { getTagRanges, parseMarkdownImageLine } from "@/lib/editor-format"
import {
  loadFragmentImageSrc,
  toDrawableImageSource,
} from "@/lib/fragment-images"
import type { Fragment } from "@/types"

export type ExportImageTemplateId = "paper" | "focus" | "night"

interface ExportImageTemplate {
  id: ExportImageTemplateId
  label: string
  description: string
  width: number
  minHeight: number
  maxHeight: number
  cardPadding: number
  background: string
  footerBand: string
  text: string
  muted: string
  accent: string
  headerMark: string
  imageBg: string
  heatmapInactive: string
  footerText: string
}

interface MemoTextStyle {
  bodyColor: string
  bodyFontSize: number
  bodyFontWeight: number
  bodyLetterSpacing: number
  bodyLineHeight: number
  metaFontSize: number
  metaFontWeight: number
  metaLineHeight: number
}

type ExportBlock =
  | { kind: "blank" }
  | { body: string; checked: boolean; kind: "task" }
  | { kind: "image"; key: string; alt: string; path: string }
  | { kind: "text"; text: string }

type LoadedImages = Map<string, HTMLImageElement>

const FONT_STACK =
  '"Barlow", "PingFang SC", "Microsoft YaHei", ui-sans-serif, system-ui, sans-serif'
const EXPORT_MARK = "Shard"
const EXPORT_CAPTION = "LOCAL MEMO · GIT VAULT"
const MAX_IMAGE_HEIGHT = 260
const HEADER_BODY_GAP = 24
const FOOTER_HEIGHT = 86

// One refined minimal system in three moods: cool white, warm ivory, deep ink.
// Every template is full-bleed with the same breathing room, a plain-date
// header, a faint brand watermark, and a quiet footer carrying the activity
// signature. Terracotta is the single accent across all three.
export const EXPORT_IMAGE_TEMPLATES: ExportImageTemplate[] = [
  {
    id: "paper",
    label: "素白",
    description: "纯白底、克制留白、通用分享",
    width: 480,
    minHeight: 480,
    maxHeight: 1800,
    cardPadding: 28,
    background: "#ffffff",
    footerBand: "#fbfbfb",
    text: "#111315",
    muted: "#9a9a9a",
    accent: "#b6533c",
    headerMark: "#dedede",
    imageBg: "#f1f3f3",
    heatmapInactive: "#ecefed",
    footerText: "#9a9a9a",
  },
  {
    id: "focus",
    label: "暖白",
    description: "宣纸暖调、柔和呼吸、适合长文",
    width: 480,
    minHeight: 480,
    maxHeight: 1800,
    cardPadding: 28,
    background: "#faf6ef",
    footerBand: "#f4ece0",
    text: "#2c2620",
    muted: "#a99c8a",
    accent: "#b6533c",
    headerMark: "#e3d8c8",
    imageBg: "#f0e7da",
    heatmapInactive: "#ece1d2",
    footerText: "#a99c8a",
  },
  {
    id: "night",
    label: "夜读",
    description: "深墨底、低亮度、适合静读",
    width: 480,
    minHeight: 480,
    maxHeight: 1800,
    cardPadding: 28,
    background: "#15181b",
    footerBand: "#1c2023",
    text: "#e9ebea",
    muted: "#7f888b",
    accent: "#db8d72",
    headerMark: "#2e3438",
    imageBg: "#23282a",
    heatmapInactive: "#252b2f",
    footerText: "#7f888b",
  },
]

export async function drawFragmentExportImage(
  canvas: HTMLCanvasElement,
  {
    fragment,
    pixelRatio = 1,
    templateId,
    showCreatedDate = true,
    showCreatedTime = false,
    vaultPath,
  }: {
    fragment: Fragment
    pixelRatio?: number
    showCreatedDate?: boolean
    showCreatedTime?: boolean
    templateId: ExportImageTemplateId
    vaultPath?: string
  }
) {
  await document.fonts?.ready

  const template = getExportTemplate(templateId)
  const textStyle = readMemoTextStyle(template)
  const blocks = fragmentToBlocks(fragment)
  const images = await loadImages(blocks, vaultPath)
  const logicalHeight = measureImageHeight(blocks, images, template, textStyle)

  canvas.dataset.logicalWidth = String(template.width)
  canvas.dataset.logicalHeight = String(logicalHeight)
  canvas.width = template.width * pixelRatio
  canvas.height = logicalHeight * pixelRatio

  const context = canvas.getContext("2d")
  if (!context) {
    throw new Error("无法创建图片画布。")
  }

  const headerStamp = [
    showCreatedDate ? formatPlainExportDate(fragment.createdAt) : "",
    showCreatedTime ? formatPlainExportTime(fragment.createdAt) : "",
  ]
    .filter(Boolean)
    .join(" ")

  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0)
  drawTemplate(
    context,
    blocks,
    images,
    template,
    textStyle,
    logicalHeight,
    headerStamp
  )
}

export function fragmentExportFileName(
  fragment: Fragment,
  templateId: ExportImageTemplateId
) {
  const date = new Date(fragment.createdAt)
  const stamp = Number.isNaN(date.getTime())
    ? fragment.id
    : date.toISOString().slice(0, 16).replace(/[-:T]/gu, "")
  return `shard-${stamp}-${templateId}.png`
}

export function canvasToPngBlob(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("图片生成失败。"))
        return
      }
      resolve(blob)
    }, "image/png")
  })
}

export async function blobToBytes(blob: Blob) {
  const buffer = await blob.arrayBuffer()
  return Array.from(new Uint8Array(buffer))
}

function getExportTemplate(id: ExportImageTemplateId) {
  return (
    EXPORT_IMAGE_TEMPLATES.find((template) => template.id === id) ??
    EXPORT_IMAGE_TEMPLATES[0]
  )
}

function readMemoTextStyle(template: ExportImageTemplate): MemoTextStyle {
  const root = getComputedStyle(document.documentElement)
  const bodyFontSize = parseCssPx(
    root.getPropertyValue("--shard-memo-font-size"),
    14
  )
  const metaFontSize = parseCssPx(
    root.getPropertyValue("--shard-memo-meta-font-size"),
    13
  )

  return {
    bodyColor:
      template.id === "paper"
        ? resolveCssColor(
            readCssValue(root, "--shard-memo-content-color", template.text),
            template.text
          )
        : template.text,
    bodyFontSize,
    bodyFontWeight: parseCssNumber(
      root.getPropertyValue("--shard-memo-font-weight"),
      400
    ),
    bodyLetterSpacing: parseCssPx(
      root.getPropertyValue("--shard-memo-letter-spacing"),
      0
    ),
    bodyLineHeight: parseLineHeight(
      root.getPropertyValue("--shard-memo-line-height"),
      bodyFontSize,
      1.8
    ),
    metaFontSize,
    metaFontWeight: parseCssNumber(
      root.getPropertyValue("--shard-memo-meta-font-weight"),
      400
    ),
    metaLineHeight: parseLineHeight(
      root.getPropertyValue("--shard-memo-meta-line-height"),
      metaFontSize,
      20 / 13
    ),
  }
}

function measureImageHeight(
  blocks: ExportBlock[],
  images: LoadedImages,
  template: ExportImageTemplate,
  textStyle: MemoTextStyle
) {
  const canvas = document.createElement("canvas")
  const context = canvas.getContext("2d")
  if (!context) return template.minHeight

  const layout = layoutMetrics(template, textStyle)
  const bodyHeight = renderBody(
    context,
    blocks,
    images,
    template,
    textStyle,
    layout,
    {
      draw: false,
      maxY: Number.POSITIVE_INFINITY,
      y: layout.bodyTop,
    }
  ).y
  const fullHeight = bodyHeight + template.cardPadding + layout.footerHeight

  return Math.min(Math.max(template.minHeight, fullHeight), template.maxHeight)
}

function drawTemplate(
  context: CanvasRenderingContext2D,
  blocks: ExportBlock[],
  images: LoadedImages,
  template: ExportImageTemplate,
  textStyle: MemoTextStyle,
  height: number,
  headerStamp: string
) {
  context.clearRect(0, 0, template.width, height)
  context.fillStyle = template.background
  context.fillRect(0, 0, template.width, height)

  const layout = layoutMetrics(template, textStyle)
  drawHeader(context, template, textStyle, layout, headerStamp)

  const bodyMaxY = height - template.cardPadding - layout.footerHeight
  const result = renderBody(
    context,
    blocks,
    images,
    template,
    textStyle,
    layout,
    {
      draw: true,
      maxY: bodyMaxY,
      y: layout.bodyTop,
    }
  )

  if (result.truncated) {
    setFont(context, textStyle.bodyFontSize, 600, textStyle.bodyLetterSpacing)
    context.fillStyle = template.muted
    context.fillText("...", layout.contentX, bodyMaxY - textStyle.bodyLineHeight)
  }

  drawFooter(context, template, textStyle, height)
}

function layoutMetrics(
  template: ExportImageTemplate,
  textStyle: MemoTextStyle
) {
  const contentX = template.cardPadding
  const contentWidth = template.width - template.cardPadding * 2
  const headerTop = template.cardPadding
  const bodyTop = headerTop + textStyle.metaLineHeight + HEADER_BODY_GAP

  return {
    bodyTop,
    contentWidth,
    contentX,
    footerHeight: FOOTER_HEIGHT,
    headerTop,
  }
}

function drawHeader(
  context: CanvasRenderingContext2D,
  template: ExportImageTemplate,
  textStyle: MemoTextStyle,
  layout: ReturnType<typeof layoutMetrics>,
  stamp: string
) {
  if (stamp) {
    setFont(context, textStyle.metaFontSize, textStyle.metaFontWeight)
    context.fillStyle = template.muted
    context.fillText(stamp, layout.contentX, layout.headerTop)
  }

  setFont(context, textStyle.metaFontSize, 500)
  context.textAlign = "right"
  context.fillStyle = template.headerMark
  context.fillText(
    EXPORT_MARK,
    layout.contentX + layout.contentWidth,
    layout.headerTop
  )
  context.textAlign = "left"
}

function renderBody(
  context: CanvasRenderingContext2D,
  blocks: ExportBlock[],
  images: LoadedImages,
  template: ExportImageTemplate,
  textStyle: MemoTextStyle,
  layout: ReturnType<typeof layoutMetrics>,
  options: { draw: boolean; maxY: number; y: number }
) {
  let y = options.y
  let truncated = false

  for (const block of blocks) {
    if (y > options.maxY) {
      truncated = true
      break
    }

    if (block.kind === "blank") {
      y += Math.round(textStyle.bodyLineHeight * 0.62)
      continue
    }

    if (block.kind === "image") {
      const image = images.get(block.key) ?? null
      const imageWidth = Math.min(layout.contentWidth, 360)
      const imageHeight = image
        ? Math.min(
            MAX_IMAGE_HEIGHT,
            Math.round((image.height / image.width) * imageWidth)
          )
        : 160
      if (options.draw && y + imageHeight <= options.maxY) {
        drawImageBlock(
          context,
          block,
          image,
          template,
          textStyle,
          layout,
          y,
          imageWidth,
          imageHeight
        )
      }
      y += imageHeight + 24
      continue
    }

    setFont(
      context,
      textStyle.bodyFontSize,
      textStyle.bodyFontWeight,
      textStyle.bodyLetterSpacing
    )
    context.fillStyle = textStyle.bodyColor

    if (block.kind === "task") {
      const checkboxSize = Math.round(textStyle.bodyFontSize)
      const checkboxGap = 10
      const textX = layout.contentX + checkboxSize + checkboxGap
      const textWidth = layout.contentWidth - checkboxSize - checkboxGap
      const lines = wrapText(context, block.body || " ", textWidth)
      const blockHeight = lines.length * textStyle.bodyLineHeight

      if (options.draw && y + blockHeight <= options.maxY) {
        drawTaskCheckbox(
          context,
          layout.contentX,
          y + Math.round((textStyle.bodyLineHeight - checkboxSize) / 2),
          checkboxSize,
          block.checked,
          template
        )
        context.fillStyle = textStyle.bodyColor
        drawWrappedLines(context, lines, textX, y, textStyle)
      }
      y += blockHeight + 4
      continue
    }

    const lines = wrapText(context, block.text || " ", layout.contentWidth)
    const blockHeight = lines.length * textStyle.bodyLineHeight
    if (options.draw && y + blockHeight <= options.maxY) {
      drawWrappedLines(context, lines, layout.contentX, y, textStyle)
    }
    y += blockHeight + 4
  }

  return { truncated, y }
}

function drawWrappedLines(
  context: CanvasRenderingContext2D,
  lines: string[],
  x: number,
  y: number,
  textStyle: MemoTextStyle
) {
  lines.forEach((line, index) => {
    context.fillText(line, x, y + index * textStyle.bodyLineHeight)
  })
}

function drawTaskCheckbox(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  checked: boolean,
  template: ExportImageTemplate
) {
  roundedRect(context, x, y, size, size, 4)
  context.fillStyle = checked ? template.accent : "transparent"
  context.fill()
  context.strokeStyle = checked ? template.accent : template.muted
  context.lineWidth = 1.5
  context.stroke()

  if (!checked) return

  context.beginPath()
  context.strokeStyle = template.id === "night" ? template.background : "#ffffff"
  context.lineWidth = 2
  context.lineCap = "round"
  context.lineJoin = "round"
  context.moveTo(x + size * 0.28, y + size * 0.53)
  context.lineTo(x + size * 0.43, y + size * 0.68)
  context.lineTo(x + size * 0.73, y + size * 0.34)
  context.stroke()
}

function drawImageBlock(
  context: CanvasRenderingContext2D,
  block: Extract<ExportBlock, { kind: "image" }>,
  image: HTMLImageElement | null,
  template: ExportImageTemplate,
  textStyle: MemoTextStyle,
  layout: ReturnType<typeof layoutMetrics>,
  y: number,
  width: number,
  height: number
) {
  roundedRect(context, layout.contentX, y, width, height, 10)
  context.fillStyle = template.imageBg
  context.fill()
  context.strokeStyle = template.headerMark
  context.lineWidth = 1
  context.stroke()

  if (image) {
    const ratio = Math.max(width / image.width, height / image.height)
    const drawWidth = image.width * ratio
    const drawHeight = image.height * ratio
    context.save()
    roundedRect(context, layout.contentX, y, width, height, 10)
    context.clip()
    context.drawImage(
      image,
      layout.contentX + (width - drawWidth) / 2,
      y + (height - drawHeight) / 2,
      drawWidth,
      drawHeight
    )
    context.restore()
    return
  }

  setFont(context, textStyle.metaFontSize, 600)
  context.fillStyle = template.muted
  context.fillText(block.alt || "图片附件", layout.contentX + 14, y + 14)
}

function drawFooter(
  context: CanvasRenderingContext2D,
  template: ExportImageTemplate,
  textStyle: MemoTextStyle,
  height: number
) {
  const footerTop = height - FOOTER_HEIGHT
  context.fillStyle = template.footerBand
  context.fillRect(0, footerTop, template.width, FOOTER_HEIGHT)

  const x = template.cardPadding
  const brandY = footerTop + 24
  setFont(context, textStyle.metaFontSize, 600)
  context.fillStyle = template.accent
  context.fillText(EXPORT_MARK, x, brandY)

  setFont(context, 11, 500)
  context.fillStyle = template.footerText
  context.fillText(EXPORT_CAPTION, x, brandY + 22)

  drawActivityGrid(
    context,
    template.width - template.cardPadding - 40,
    footerTop + 25,
    template
  )
}

function drawActivityGrid(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  template: ExportImageTemplate
) {
  const cell = 5
  const gap = 3
  const active = new Set(["1:3", "2:3", "3:4", "4:4"])

  for (let row = 0; row < 5; row += 1) {
    for (let column = 0; column < 6; column += 1) {
      const key = `${column}:${row}`
      context.fillStyle = active.has(key) ? template.accent : template.heatmapInactive
      context.globalAlpha = active.has(key) ? 0.42 : 1
      roundedRect(
        context,
        x + column * (cell + gap),
        y + row * (cell + gap),
        cell,
        cell,
        1.5
      )
      context.fill()
    }
  }
  context.globalAlpha = 1
}

function fragmentToBlocks(fragment: Fragment): ExportBlock[] {
  return fragment.content.trimEnd().split("\n").map((line, index) => {
    const image = parseMarkdownImageLine(line)
    if (image) {
      return {
        alt: image.alt,
        key: `image-${index}`,
        kind: "image",
        path: image.path,
      }
    }

    const task = line.match(/^(\s*)((?:[-*+]|\d+[.)])\s+)(\[([ xX])\]\s*)(.*)$/u)
    if (task) {
      return {
        body: stripTagsFromLine(task[5] ?? ""),
        checked: task[4].toLowerCase() === "x",
        kind: "task",
      }
    }

    const text = stripTagsFromLine(line)
    return text.length === 0 ? { kind: "blank" } : { kind: "text", text }
  })
}

async function loadImages(blocks: ExportBlock[], vaultPath?: string) {
  const images: LoadedImages = new Map()
  const imageBlocks = blocks.filter(
    (block): block is Extract<ExportBlock, { kind: "image" }> =>
      block.kind === "image"
  )

  await Promise.all(
    imageBlocks.map(async (block) => {
      const source = await loadFragmentImageSrc(block.path, vaultPath)
      if (!source) return

      let drawable = ""
      try {
        drawable = await toDrawableImageSource(source)
        images.set(block.key, await loadImageElement(drawable))
      } catch {
        // Export still succeeds with a placeholder when an attachment is unavailable.
      } finally {
        // 图片已解码完毕，句柄可以还回去了。
        if (drawable && drawable !== source) URL.revokeObjectURL(drawable)
      }
    })
  )

  return images
}

function loadImageElement(source: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image()
    image.decoding = "async"
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error("图片附件无法载入。"))
    image.src = source
  })
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

  return result.replace(/[ \t]{2,}/gu, " ").replace(/^[ \t]+|[ \t]+$/gu, "")
}

function wrapText(
  context: CanvasRenderingContext2D,
  text: string,
  maxWidth: number
) {
  const tokens = text.match(/\s+|[^\s]+/gu) ?? [text]
  const lines: string[] = []
  let line = ""

  for (const token of tokens) {
    const next = line ? `${line}${token}` : token.trimStart()
    if (!line || context.measureText(next).width <= maxWidth) {
      line = next
      continue
    }

    lines.push(line.trimEnd())
    line = token.trimStart()

    if (context.measureText(line).width <= maxWidth) continue

    const chars = Array.from(line)
    line = ""
    for (const char of chars) {
      const charNext = `${line}${char}`
      if (!line || context.measureText(charNext).width <= maxWidth) {
        line = charNext
      } else {
        lines.push(line)
        line = char
      }
    }
  }

  if (line) lines.push(line.trimEnd())
  return lines.length > 0 ? lines : [""]
}

function setFont(
  context: CanvasRenderingContext2D,
  size: number,
  weight: number,
  letterSpacing = 0
) {
  context.font = `${weight} ${size}px ${FONT_STACK}`
  context.textBaseline = "top"
  context.textAlign = "left"
  setCanvasLetterSpacing(context, letterSpacing)
}

function setCanvasLetterSpacing(
  context: CanvasRenderingContext2D,
  letterSpacing: number
) {
  if (!("letterSpacing" in context)) return

  ;(context as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing =
    `${letterSpacing}px`
}

function roundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
) {
  const safeRadius = Math.min(radius, width / 2, height / 2)
  context.beginPath()
  context.moveTo(x + safeRadius, y)
  context.lineTo(x + width - safeRadius, y)
  context.quadraticCurveTo(x + width, y, x + width, y + safeRadius)
  context.lineTo(x + width, y + height - safeRadius)
  context.quadraticCurveTo(
    x + width,
    y + height,
    x + width - safeRadius,
    y + height
  )
  context.lineTo(x + safeRadius, y + height)
  context.quadraticCurveTo(x, y + height, x, y + height - safeRadius)
  context.lineTo(x, y + safeRadius)
  context.quadraticCurveTo(x, y, x + safeRadius, y)
  context.closePath()
}

function readCssValue(
  declaration: CSSStyleDeclaration,
  name: string,
  fallback: string
) {
  const value = declaration.getPropertyValue(name).trim()
  return value.length > 0 ? value : fallback
}

function resolveCssColor(value: string, fallback: string) {
  const probe = document.createElement("span")
  probe.style.color = fallback
  probe.style.color = value
  probe.style.position = "fixed"
  probe.style.pointerEvents = "none"
  probe.style.visibility = "hidden"
  document.body.append(probe)
  const resolved = getComputedStyle(probe).color
  probe.remove()
  return resolved || fallback
}

function parseCssPx(value: string, fallback: number) {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function parseCssNumber(value: string, fallback: number) {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function parseLineHeight(value: string, fontSize: number, fallbackRatio: number) {
  const trimmed = value.trim()
  if (trimmed.endsWith("px")) return parseCssPx(trimmed, fontSize * fallbackRatio)

  const parsed = Number.parseFloat(trimmed)
  if (!Number.isFinite(parsed)) return fontSize * fallbackRatio

  return parsed > 4 ? parsed : parsed * fontSize
}

function formatPlainExportDate(createdAt: string) {
  const date = new Date(createdAt)
  if (Number.isNaN(date.getTime())) return ""

  return date.toLocaleDateString("zh-CN", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  })
}

function formatPlainExportTime(createdAt: string) {
  const date = new Date(createdAt)
  if (Number.isNaN(date.getTime())) return ""

  return date.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
  })
}
