export interface TextareaCaretBox {
  glyphHeight: number
  left: number
  lineHeight: number
  lineTop: number
}

const TEXTAREA_MIRROR_PROPERTIES = [
  "box-sizing",
  "border-bottom-width",
  "border-left-width",
  "border-right-width",
  "border-top-width",
  "font-family",
  "font-size",
  "font-style",
  "font-variant",
  "font-weight",
  "letter-spacing",
  "line-height",
  "padding-bottom",
  "padding-left",
  "padding-right",
  "padding-top",
  "tab-size",
  "text-align",
  "text-indent",
  "text-transform",
  "white-space",
  "word-break",
  "word-spacing",
  "overflow-wrap",
] as const

export function getTextareaCaretBox(
  textarea: HTMLTextAreaElement,
  selectionStart: number
): TextareaCaretBox {
  const styles = window.getComputedStyle(textarea)
  const mirror = document.createElement("div")
  const marker = document.createElement("span")

  for (const property of TEXTAREA_MIRROR_PROPERTIES) {
    mirror.style.setProperty(property, styles.getPropertyValue(property))
  }

  mirror.style.position = "absolute"
  mirror.style.visibility = "hidden"
  mirror.style.top = "0"
  mirror.style.left = "-9999px"
  mirror.style.width = `${textarea.getBoundingClientRect().width}px`
  mirror.style.height = "auto"
  mirror.style.minHeight = "0"
  mirror.style.maxHeight = "none"
  mirror.style.overflow = "hidden"
  mirror.style.whiteSpace = "pre-wrap"
  mirror.style.overflowWrap = "break-word"

  mirror.textContent = textarea.value.slice(0, selectionStart)
  marker.textContent = "\u200b"
  mirror.appendChild(marker)
  document.body.appendChild(mirror)

  const fontSize = toPixelValue(styles.fontSize, 14)
  const lineHeight = toPixelValue(styles.lineHeight, fontSize * 1.58)
  const borderLeft = toPixelValue(styles.borderLeftWidth, 0)
  const borderTop = toPixelValue(styles.borderTopWidth, 0)

  // marker is an inline span, so offsetTop/offsetHeight describe the glyph
  // inline box (below the line box's half-leading), not the full line box
  const position = {
    glyphHeight: marker.offsetHeight,
    left: marker.offsetLeft + borderLeft - textarea.scrollLeft,
    lineHeight,
    lineTop: marker.offsetTop + borderTop - textarea.scrollTop,
  }

  mirror.remove()
  return position
}

function toPixelValue(value: string, fallback: number) {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : fallback
}
