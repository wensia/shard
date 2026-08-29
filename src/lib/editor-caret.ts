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

interface RenderedCharacter {
  offset: number
  rect: DOMRect
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

    if (isCaretInsideTextarea(textarea, frameRect, caret)) return caret
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

export function getEditorSelectionFromPoint(
  frame: HTMLElement,
  clientX: number,
  clientY: number
): number | null {
  const characters = getRenderedCharacters(frame).filter(
    ({ rect }) => clientY >= rect.top && clientY <= rect.bottom
  )
  if (characters.length === 0) return null

  characters.sort((a, b) => a.rect.left - b.rect.left)
  for (const character of characters) {
    const midpoint = character.rect.left + character.rect.width / 2
    if (clientX <= midpoint) return character.offset
  }

  const lastCharacter = characters[characters.length - 1]
  return lastCharacter ? lastCharacter.offset + 1 : null
}

/**
 * Own a primary-button selection gesture from mousedown through mouseup.
 * The visible Markdown layer is the source of truth for hit testing, so the
 * browser never places the textarea caret against hidden raw syntax first.
 */
export function startEditorPointerSelection(
  textarea: HTMLTextAreaElement,
  frame: HTMLElement,
  event: MouseEvent,
  onSelectionChange: (start: number, end: number) => void,
  onSelectionEnd?: () => void
): (() => void) | null {
  if (event.button !== 0 || event.detail > 1) return null

  const pointerPosition = getEditorSelectionFromPoint(
    frame,
    event.clientX,
    event.clientY
  )
  if (pointerPosition === null) return null

  const anchor = event.shiftKey
    ? textarea.selectionDirection === "backward"
      ? textarea.selectionEnd
      : textarea.selectionStart
    : pointerPosition
  const ownerDocument = textarea.ownerDocument
  let active = true

  function applySelection(head: number) {
    const start = Math.min(anchor, head)
    const end = Math.max(anchor, head)
    textarea.setSelectionRange(
      start,
      end,
      head < anchor ? "backward" : "forward"
    )
    onSelectionChange(start, end)
  }

  function handleMouseMove(moveEvent: MouseEvent) {
    if ((moveEvent.buttons & 1) === 0) {
      stop()
      return
    }

    const head = getEditorSelectionFromPoint(
      frame,
      moveEvent.clientX,
      moveEvent.clientY
    )
    if (head === null) return

    moveEvent.preventDefault()
    applySelection(head)
  }

  function handleMouseUp(upEvent: MouseEvent) {
    if (upEvent.button !== 0) return

    const head = getEditorSelectionFromPoint(
      frame,
      upEvent.clientX,
      upEvent.clientY
    )
    if (head !== null) applySelection(head)

    upEvent.preventDefault()
    stop()
    onSelectionEnd?.()
  }

  function stop() {
    if (!active) return
    active = false
    ownerDocument.removeEventListener("mousemove", handleMouseMove)
    ownerDocument.removeEventListener("mouseup", handleMouseUp)
  }

  event.preventDefault()
  textarea.focus({ preventScroll: true })
  applySelection(pointerPosition)
  ownerDocument.addEventListener("mousemove", handleMouseMove)
  ownerDocument.addEventListener("mouseup", handleMouseUp)

  return stop
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

function getRenderedCharacters(frame: HTMLElement): RenderedCharacter[] {
  const spans = frame.querySelectorAll<HTMLElement>(
    ".shard-editor-highlight-layer [data-text-start]"
  )
  const characters: RenderedCharacter[] = []

  for (const span of spans) {
    if (span.closest(".shard-editor-markdown-marker")) continue

    const start = Number(span.dataset.textStart)
    if (!Number.isFinite(start)) continue

    const walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT)
    let nodeOffset = 0
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const textNode = node as Text
      const length = textNode.nodeValue?.length ?? 0

      for (let offset = 0; offset < length; offset += 1) {
        const range = document.createRange()
        range.setStart(textNode, offset)
        range.setEnd(textNode, offset + 1)
        const rect = range.getClientRects()[0]
        if (rect && rect.height >= MIN_GLYPH_RECT_HEIGHT) {
          characters.push({ offset: start + nodeOffset + offset, rect })
        }
      }

      nodeOffset += length
    }
  }

  return characters
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
