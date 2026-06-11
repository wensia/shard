import { getTagRanges, parseMarkdownImageLine } from "@/lib/editor-format"
import { loadFragmentImageSrc } from "@/lib/fragment-images"
import type { Fragment } from "@/types"

export type ExportImageTemplateId = "paper" | "focus" | "night"

interface ExportImageTemplate {
  id: ExportImageTemplateId
  label: string
  description: string
  width: number
  minHeight: number
  maxHeight: number
  outerPadding: number
  cardPadding: number
  cardRadius: number
  background: string
  card: string
  border: string
  text: string
  muted: string
  accent: string
  tagBackground: string
  tagText: string
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
  tagFontSize: number
  tagHeight: number
  tagPaddingX: number
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
const MAX_IMAGE_HEIGHT = 260
const TAG_GAP = 8
const TAG_ROW_GAP = 8
const TAG_TOP_GAP = 8
const TAG_BODY_GAP = 12
const HEADER_BODY_GAP = 22
const PAPER_FOOTER_HEIGHT = 86

export const EXPORT_IMAGE_TEMPLATES: ExportImageTemplate[] = [
  {
    id: "paper",
    label: "素白",
    description: "纯白卡片、浅底脚注、适合分享",
    width: 480,
    minHeight: 480,
    maxHeight: 1800,
    outerPadding: 0,
    cardPadding: 28,
    cardRadius: 0,
    background: "#ffffff",
    card: "#ffffff",
    border: "transparent",
    text: "#111315",
    muted: "#9a9a9a",
    accent: "#b6533c",
    tagBackground: "#f8f1ef",
    tagText: "#743225",
    footerText: "#9a9a9a",
  },
  {
    id: "focus",
    label: "索引卡",
    description: "紧凑结构、左侧色条、适合任务",
    width: 480,
    minHeight: 520,
    maxHeight: 1800,
    outerPadding: 24,
    cardPadding: 20,
    cardRadius: 12,
    background: "#eef1f0",
    card: "#fbfcfc",
    border: "#cbd2d2",
    text: "#171a1c",
    muted: "#596364",
    accent: "#b6533c",
    tagBackground: "#ffffff",
    tagText: "#743225",
    footerText: "#747f80",
  },
  {
    id: "night",
    label: "夜读",
    description: "深色底、低亮度、适合长句",
    width: 480,
    minHeight: 520,
    maxHeight: 1800,
    outerPadding: 24,
    cardPadding: 20,
    cardRadius: 12,
    background: "#111315",
    card: "#191d1f",
    border: "#343a3d",
    text: "#f7f8f8",
    muted: "#aeb7b7",
    accent: "#de9681",
    tagBackground: "#2a2220",
    tagText: "#f1c0b2",
    footerText: "#899194",
  },
]

export async function drawFragmentExportImage(
  canvas: HTMLCanvasElement,
  {
    fragment,
    pixelRatio = 1,
    templateId,
    vaultPath,
  }: {
    fragment: Fragment
    pixelRatio?: number
    templateId: ExportImageTemplateId
    vaultPath?: string
  }
) {
  await document.fonts?.ready

  const template = getExportTemplate(templateId)
  const textStyle = readMemoTextStyle(template)
  const blocks = fragmentToBlocks(fragment)
  const images = await loadImages(blocks, vaultPath)
  const logicalHeight = measureImageHeight(
    fragment,
    blocks,
    images,
    template,
    textStyle
  )

  canvas.width = template.width * pixelRatio
  canvas.height = logicalHeight * pixelRatio
  canvas.style.aspectRatio = `${template.width} / ${logicalHeight}`

  const context = canvas.getContext("2d")
  if (!context) {
    throw new Error("无法创建图片画布。")
  }

  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0)
  drawTemplate(
    context,
    fragment,
    blocks,
    images,
    template,
    textStyle,
    logicalHeight
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
      template.id === "night"
        ? template.text
        : readCssValue(root, "--shard-memo-content-color", template.text),
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
    tagFontSize: parseCssPx(root.getPropertyValue("--shard-tag-font-size"), 13),
    tagHeight: parseCssPx(root.getPropertyValue("--shard-tag-height"), 28),
    tagPaddingX: parseCssPx(root.getPropertyValue("--shard-tag-padding-x"), 11),
  }
}

function measureImageHeight(
  fragment: Fragment,
  blocks: ExportBlock[],
  images: LoadedImages,
  template: ExportImageTemplate,
  textStyle: MemoTextStyle
) {
  const canvas = document.createElement("canvas")
  const context = canvas.getContext("2d")
  if (!context) return template.minHeight

  const layout = layoutMetrics(context, fragment, template, textStyle)
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
  const fullHeight =
    bodyHeight +
    template.cardPadding +
    layout.footerHeight +
    template.outerPadding

  return Math.min(Math.max(template.minHeight, fullHeight), template.maxHeight)
}

function drawTemplate(
  context: CanvasRenderingContext2D,
  fragment: Fragment,
  blocks: ExportBlock[],
  images: LoadedImages,
  template: ExportImageTemplate,
  textStyle: MemoTextStyle,
  height: number
) {
  context.clearRect(0, 0, template.width, height)
  context.fillStyle = template.background
  context.fillRect(0, 0, template.width, height)

  const cardX = template.outerPadding
  const cardY = template.outerPadding
  const cardWidth = template.width - template.outerPadding * 2
  const cardHeight = height - template.outerPadding * 2

  roundedRect(context, cardX, cardY, cardWidth, cardHeight, template.cardRadius)
  context.fillStyle = template.card
  context.fill()
  if (template.border !== "transparent") {
    context.strokeStyle = template.border
    context.lineWidth = 2
    context.stroke()
  }

  if (template.id === "focus") {
    roundedRect(context, cardX, cardY, 4, cardHeight, 2)
    context.fillStyle = template.accent
    context.fill()
  }

  const layout = layoutMetrics(context, fragment, template, textStyle)
  drawHeader(context, fragment, template, textStyle, layout)

  const bodyMaxY =
    height - template.outerPadding - template.cardPadding - layout.footerHeight
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
    setFont(
      context,
      textStyle.bodyFontSize,
      600,
      textStyle.bodyLetterSpacing
    )
    context.fillStyle = template.muted
    context.fillText("...", layout.contentX, bodyMaxY - textStyle.bodyLineHeight)
  }

  drawFooter(context, fragment, template, textStyle, height)
}

function layoutMetrics(
  context: CanvasRenderingContext2D,
  fragment: Fragment,
  template: ExportImageTemplate,
  textStyle: MemoTextStyle
) {
  const cardX = template.outerPadding
  const contentX = cardX + template.cardPadding
  const contentWidth =
    template.width - (template.outerPadding + template.cardPadding) * 2
  const headerTop = template.outerPadding + template.cardPadding
  const tagRows = measureTagRows(
    context,
    template.id === "paper" ? [] : exportDisplayTags(fragment),
    contentWidth,
    textStyle
  )
  const tagsHeight =
    tagRows.length > 0
      ? TAG_TOP_GAP +
        tagRows.length * textStyle.tagHeight +
        (tagRows.length - 1) * TAG_ROW_GAP +
        TAG_BODY_GAP
      : 0
  const bodyTop =
    headerTop +
    textStyle.metaLineHeight +
    (tagsHeight > 0 ? tagsHeight : HEADER_BODY_GAP)

  return {
    bodyTop,
    contentWidth,
    contentX,
    footerHeight: template.id === "paper" ? PAPER_FOOTER_HEIGHT : 44,
    headerTop,
    tagRows,
  }
}

function drawHeader(
  context: CanvasRenderingContext2D,
  fragment: Fragment,
  template: ExportImageTemplate,
  textStyle: MemoTextStyle,
  layout: ReturnType<typeof layoutMetrics>
) {
  setFont(context, textStyle.metaFontSize, textStyle.metaFontWeight)
  context.fillStyle = template.muted
  context.fillText(
    template.id === "paper"
      ? formatPlainExportDate(fragment.createdAt)
      : formatExportDate(fragment.createdAt),
    layout.contentX,
    layout.headerTop
  )

  if (template.id === "paper") {
    setFont(context, textStyle.metaFontSize, 500)
    context.textAlign = "right"
    context.fillStyle = "#dedede"
    context.fillText(
      EXPORT_MARK,
      layout.contentX + layout.contentWidth,
      layout.headerTop
    )
    context.textAlign = "left"
    return
  }

  drawTagRows(
    context,
    layout.tagRows,
    layout.contentX,
    layout.headerTop + textStyle.metaLineHeight + TAG_TOP_GAP,
    template,
    textStyle
  )
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
  context.strokeStyle = template.id === "night" ? "#111315" : "#ffffff"
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
  context.fillStyle = template.id === "night" ? "#23282a" : "#f1f3f3"
  context.fill()
  context.strokeStyle = template.border
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
  fragment: Fragment,
  template: ExportImageTemplate,
  textStyle: MemoTextStyle,
  height: number
) {
  if (template.id === "paper") {
    drawPaperFooter(context, template, textStyle, height)
    return
  }

  const x = template.outerPadding + template.cardPadding
  const top =
    height - template.outerPadding - template.cardPadding - textStyle.metaLineHeight
  const contentWidth =
    template.width - (template.outerPadding + template.cardPadding) * 2

  const dividerY = top - 12
  context.beginPath()
  context.moveTo(x, dividerY)
  context.lineTo(x + contentWidth, dividerY)
  context.strokeStyle = template.border
  context.lineWidth = 1
  context.stroke()

  const glyphSize = Math.round(textStyle.metaLineHeight)
  drawBrandMark(context, x, top, glyphSize, template)
  setFont(context, textStyle.metaFontSize, 600)
  context.fillStyle = template.footerText
  context.fillText(EXPORT_MARK, x + glyphSize + 8, top + 1)
  const brandWidth =
    glyphSize + 8 + Math.ceil(context.measureText(EXPORT_MARK).width)

  const labels = exportDisplayTags(fragment).map((tag) => `#${tag}`)
  if (labels.length === 0) return

  const gap = 12
  const available = contentWidth - brandWidth - 32
  const widths = labels.map((label) =>
    Math.ceil(context.measureText(label).width)
  )

  let visible = labels.length
  let total = sumWithGaps(widths, gap, visible)
  while (visible > 1 && total > available) {
    visible -= 1
    total = sumWithGaps(widths, gap, visible)
  }

  context.fillStyle = template.accent
  let cursor = x + contentWidth - total
  for (let index = labels.length - visible; index < labels.length; index += 1) {
    context.fillText(labels[index], cursor, top + 1)
    cursor += widths[index] + gap
  }
}

function drawPaperFooter(
  context: CanvasRenderingContext2D,
  template: ExportImageTemplate,
  textStyle: MemoTextStyle,
  height: number
) {
  const footerTop = height - PAPER_FOOTER_HEIGHT
  context.fillStyle = "#fbfbfb"
  context.fillRect(0, footerTop, template.width, PAPER_FOOTER_HEIGHT)

  const x = template.cardPadding
  const brandY = footerTop + 24
  setFont(context, textStyle.metaFontSize, 600)
  context.fillStyle = template.accent
  context.fillText(EXPORT_MARK, x, brandY)

  setFont(context, 11, 500)
  context.fillStyle = template.footerText
  context.fillText("LOCAL MEMO · GIT VAULT", x, brandY + 22)

  drawPaperHeatmap(
    context,
    template.width - template.cardPadding - 40,
    footerTop + 25,
    template
  )
}

function drawPaperHeatmap(
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
      context.fillStyle = active.has(key) ? template.accent : "#ecefed"
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

function sumWithGaps(widths: number[], gap: number, count: number) {
  if (count <= 0) return 0
  const slice = widths.slice(widths.length - count)
  return slice.reduce((sum, width) => sum + width, 0) + gap * (count - 1)
}

function drawBrandMark(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  template: ExportImageTemplate
) {
  roundedRect(context, x, y, size, size, 7)
  context.fillStyle = template.id === "night" ? "#23282a" : "#ffffff"
  context.fill()
  context.strokeStyle = template.footerText
  context.lineWidth = 1
  context.stroke()

  context.beginPath()
  context.moveTo(x + size * 0.52, y + 4)
  context.lineTo(x + size - 4, y + 4)
  context.lineTo(x + size - 4, y + size * 0.48)
  context.closePath()
  context.fillStyle = template.accent
  context.fill()
}

function measureTagRows(
  context: CanvasRenderingContext2D,
  tags: string[],
  maxWidth: number,
  textStyle: MemoTextStyle
) {
  if (tags.length === 0) return []

  setFont(context, textStyle.tagFontSize, 500)
  const rows: string[][] = []
  let row: string[] = []
  let rowWidth = 0

  for (const tag of tags) {
    const tagWidth = measureTagWidth(context, tag, textStyle)
    const nextWidth = row.length === 0 ? tagWidth : rowWidth + TAG_GAP + tagWidth

    if (row.length > 0 && nextWidth > maxWidth) {
      rows.push(row)
      row = [tag]
      rowWidth = tagWidth
      continue
    }

    row.push(tag)
    rowWidth = nextWidth
  }

  if (row.length > 0) rows.push(row)
  return rows
}

function drawTagRows(
  context: CanvasRenderingContext2D,
  rows: string[][],
  x: number,
  y: number,
  template: ExportImageTemplate,
  textStyle: MemoTextStyle
) {
  if (rows.length === 0) return

  setFont(context, textStyle.tagFontSize, 500)
  let rowY = y
  for (const row of rows) {
    let cursor = x
    for (const tag of row) {
      const width = measureTagWidth(context, tag, textStyle)
      roundedRect(context, cursor, rowY, width, textStyle.tagHeight, 8)
      context.fillStyle = template.tagBackground
      context.fill()
      context.fillStyle = template.tagText
      context.fillText(
        tag,
        cursor + textStyle.tagPaddingX,
        rowY + Math.round((textStyle.tagHeight - textStyle.tagFontSize) / 2) - 1
      )
      cursor += width + TAG_GAP
    }
    rowY += textStyle.tagHeight + TAG_ROW_GAP
  }
}

function measureTagWidth(
  context: CanvasRenderingContext2D,
  tag: string,
  textStyle: MemoTextStyle
) {
  return Math.ceil(context.measureText(tag).width) + textStyle.tagPaddingX * 2
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
      try {
        const source = await loadFragmentImageSrc(block.path, vaultPath)
        if (!canDrawImageSource(source)) return
        const image = await loadImageElement(source)
        images.set(block.key, image)
      } catch {
        // Export still succeeds with a placeholder when an attachment is unavailable.
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

function canDrawImageSource(source: string) {
  return source.startsWith("data:") || source.startsWith("blob:")
}

function exportDisplayTags(fragment: Fragment) {
  const labels: string[] = []
  if (fragment.pinned) labels.push("置顶")
  if (fragment.lockbox) labels.push("密匣")

  const visibleTags = fragment.tags.filter((tag) => tag !== "inbox")
  for (const tag of visibleTags) {
    if (!labels.includes(tag)) labels.push(tag)
  }

  return labels
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

function formatExportDate(createdAt: string) {
  const date = new Date(createdAt)
  if (Number.isNaN(date.getTime())) return ""

  const day = date.toLocaleDateString("zh-CN", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  })
  const weekday = date.toLocaleDateString("zh-CN", { weekday: "short" })
  const time = date.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
  })

  return `${day} ${weekday} · ${time}`
}
