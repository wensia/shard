import { getTextareaCaretBox } from "@/lib/textarea-caret"

export interface EditorCaretBox {
  height: number
  left: number
  top: number
}

interface CaretAnchor {
  offset: number
  span: HTMLElement
  trailing: boolean
}

interface RenderedCaretRect {
  height: number
  left: number
  top: number
}

const MIN_GLYPH_RECT_HEIGHT = 4

/**
 * Caret geometry in frame coordinates. Measured from the visible highlight
 * layer (the glyphs the user actually sees) so the caret can never drift from
 * the rendered text; falls back to textarea mirror geometry only where the
 * layer has no measurable text (empty content, image attachment lines).
 */
export function getEditorCaretBox(
  textarea: HTMLTextAreaElement,
  frame: HTMLElement,
  selectionStart: number
): EditorCaretBox | null {
  const styles = window.getComputedStyle(textarea)
  const fontSize = toPixelValue(styles.fontSize, 14)
  const heightRatio = toPixelValue(
    styles.getPropertyValue("--shard-caret-height-ratio"),
    1.22
  )
  const caretHeight = Math.round(fontSize * Math.max(1, heightRatio))

  const rendered = getRenderedCaretRect(frame, selectionStart)
  if (rendered && rendered.height >= MIN_GLYPH_RECT_HEIGHT) {
    const frameRect = frame.getBoundingClientRect()
    const height = Math.min(caretHeight, rendered.height)
    const caret = {
      height,
      left: rendered.left - frameRect.left,
      top: rendered.top - frameRect.top + (rendered.height - height) / 2,
    }

    return isCaretInsideTextarea(textarea, frameRect, caret) ? caret : null
  }

  const mirrored = getTextareaCaretBox(textarea, selectionStart)
  const glyphHeight =
    mirrored.glyphHeight >= MIN_GLYPH_RECT_HEIGHT
      ? mirrored.glyphHeight
      : mirrored.lineHeight
  const height = Math.min(caretHeight, glyphHeight)
  const caret = {
    height,
    left: mirrored.left,
    top: mirrored.lineTop + (glyphHeight - height) / 2,
  }

  return isCaretInsideTextarea(
    textarea,
    frame.getBoundingClientRect(),
    caret
  )
    ? caret
    : null
}

function isCaretInsideTextarea(
  textarea: HTMLTextAreaElement,
  frameRect: DOMRect,
  caret: EditorCaretBox
) {
  const textareaRect = textarea.getBoundingClientRect()
  const caretTop = frameRect.top + caret.top
  const caretBottom = caretTop + caret.height
  const boundaryTolerance = 0.5

  return (
    caretTop >= textareaRect.top - boundaryTolerance &&
    caretBottom <= textareaRect.bottom + boundaryTolerance
  )
}

function getRenderedCaretRect(
  frame: HTMLElement,
  selectionStart: number
): RenderedCaretRect | null {
  const spans = frame.querySelectorAll<HTMLElement>(
    ".shard-editor-highlight-layer [data-text-start]"
  )
  let endAnchor: CaretAnchor | null = null

  for (const span of spans) {
    const start = Number(span.dataset.textStart)
    const length = Number(span.dataset.textLength)
    if (!Number.isFinite(start) || !Number.isFinite(length)) continue

    if (selectionStart >= start && selectionStart < start + length) {
      return measureAnchor({
        offset: selectionStart - start,
        span,
        trailing: false,
      })
    }

    if (length === 0 && selectionStart === start) {
      return measureAnchor({ offset: 0, span, trailing: false })
    }

    if (length > 0 && selectionStart === start + length) {
      endAnchor = { offset: length, span, trailing: true }
    }
  }

  return endAnchor ? measureAnchor(endAnchor) : null
}

function measureAnchor(anchor: CaretAnchor): RenderedCaretRect | null {
  const target = resolveTextPosition(anchor.span, anchor.offset)
  if (!target) return null

  const { node, offset } = target
  const length = node.nodeValue?.length ?? 0
  const range = document.createRange()

  if (!anchor.trailing && offset < length) {
    range.setStart(node, offset)
    range.setEnd(node, offset + 1)
    const rect = range.getClientRects()[0]
    return rect
      ? { height: rect.height, left: rect.left, top: rect.top }
      : null
  }

  if (offset > 0) {
    range.setStart(node, offset - 1)
    range.setEnd(node, offset)
    const rects = range.getClientRects()
    const rect = rects[rects.length - 1]
    return rect
      ? { height: rect.height, left: rect.right, top: rect.top }
      : null
  }

  if (length > 0) {
    range.setStart(node, 0)
    range.setEnd(node, 1)
    const rect = range.getClientRects()[0]
    return rect
      ? { height: rect.height, left: rect.left, top: rect.top }
      : null
  }

  return null
}

function resolveTextPosition(root: HTMLElement, offset: number) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let remaining = offset
  let lastNode: Text | null = null

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const textNode = node as Text
    const length = textNode.nodeValue?.length ?? 0
    if (remaining < length) {
      return { node: textNode, offset: remaining }
    }

    lastNode = textNode
    remaining -= length
  }

  if (!lastNode) return null
  return { node: lastNode, offset: lastNode.nodeValue?.length ?? 0 }
}

function toPixelValue(value: string, fallback: number) {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : fallback
}
