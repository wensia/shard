export interface TextareaCaretBox {
  height: number
  left: number
  lineHeight: number
  lineTop: number
  top: number
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
  const caretHeightRatio = toPixelValue(
    styles.getPropertyValue("--shard-caret-height-ratio"),
    1.22
  )
  const browserCaretGap = toPixelValue(
    styles.getPropertyValue("--shard-caret-gap"),
    1
  )
  const desktopCaretGap = toPixelValue(
    styles.getPropertyValue("--shard-caret-desktop-gap"),
    3
  )
  const browserCaretYAdjust = toPixelValue(
    styles.getPropertyValue("--shard-caret-y-adjust"),
    0
  )
  const desktopCaretYAdjust = toPixelValue(
    styles.getPropertyValue("--shard-caret-desktop-y-adjust"),
    -2
  )
  const isDesktop = isTauriRuntime()
  const caretGap = isDesktop ? desktopCaretGap : browserCaretGap
  const caretYAdjust = isDesktop ? desktopCaretYAdjust : browserCaretYAdjust
  const borderLeft = toPixelValue(styles.borderLeftWidth, 0)
  const borderTop = toPixelValue(styles.borderTopWidth, 0)
  const lineTop = marker.offsetTop + borderTop - textarea.scrollTop
  const caretHeight = Math.round(fontSize * Math.max(1, caretHeightRatio))
  const top = lineTop + caretYAdjust
  const previousChar = textarea.value[selectionStart - 1]
  const glyphGap = previousChar && previousChar !== "\n" ? caretGap : 0

  const position = {
    height: caretHeight,
    left: marker.offsetLeft + borderLeft + glyphGap - textarea.scrollLeft,
    lineHeight,
    lineTop,
    top,
  }

  mirror.remove()
  return position
}

function toPixelValue(value: string, fallback: number) {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function isTauriRuntime() {
  const tauriWindow = window as Window & {
    __TAURI__?: unknown
    __TAURI_INTERNALS__?: unknown
  }

  return Boolean(tauriWindow.__TAURI__ || tauriWindow.__TAURI_INTERNALS__)
}
