export interface SelectionFragment {
  left: number
  right: number
  top: number
  bottom: number
  lineHeight: number
}

export interface SelectionLine extends SelectionFragment {
  center: number
}

export function selectionLineHeight(computed: string, fragmentHeight: number): number {
  const height = computed.endsWith("px") ? Number.parseFloat(computed) : NaN
  return Number.isFinite(height) && height > 0 ? height : fragmentHeight
}

export function mergeSelectionFragments(fragments: SelectionFragment[]): SelectionLine[] {
  const lines: SelectionLine[] = []
  for (const fragment of fragments.sort((a, b) => a.top - b.top || a.left - b.left)) {
    if (fragment.right - fragment.left < 0.5) continue
    const center = (fragment.top + fragment.bottom) / 2
    const line = lines.find((candidate) => Math.abs(candidate.center - center) <= 2)
    if (line) {
      line.left = Math.min(line.left, fragment.left)
      line.right = Math.max(line.right, fragment.right)
      line.top = Math.min(line.top, fragment.top)
      line.bottom = Math.max(line.bottom, fragment.bottom)
      line.lineHeight = Math.max(line.lineHeight, fragment.lineHeight)
    } else {
      lines.push({ ...fragment, center })
    }
  }
  return lines
}

export function selectionBandPosition(
  line: SelectionLine,
  host: Pick<DOMRect, "left" | "top">,
  offset: { clientLeft: number; clientTop: number; scrollLeft: number; scrollTop: number },
) {
  return {
    left: line.left - host.left - offset.clientLeft + offset.scrollLeft,
    top: line.center - line.lineHeight / 2 - host.top - offset.clientTop + offset.scrollTop,
    width: line.right - line.left,
    height: line.lineHeight,
  }
}

/** Draw only selected text; leave the browser Selection, focus and clipboard untouched. */
export function attachSelectionBand(root: HTMLElement, host: HTMLElement): () => void {
  const layer = document.createElement("span")
  layer.className = "shard-selection-band-layer"
  layer.setAttribute("aria-hidden", "true")
  const previousPosition = host.style.position
  const previousIsolation = host.style.isolation
  const changedPosition = getComputedStyle(host).position === "static"
  const changedIsolation = getComputedStyle(host).isolation !== "isolate"
  if (changedPosition) host.style.position = "relative"
  if (changedIsolation) host.style.isolation = "isolate"
  host.appendChild(layer)
  root.setAttribute("data-shard-selection-band", "")

  let frame = 0
  let composing = false
  let disposed = false

  const clear = () => layer.replaceChildren()
  const render = () => {
    frame = 0
    if (disposed || !root.isConnected || !host.isConnected || composing) {
      clear()
      return
    }
    const selection = document.getSelection()
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      clear()
      return
    }

    const fragments: SelectionFragment[] = []
    for (let index = 0; index < selection.rangeCount; index += 1) {
      const range = selection.getRangeAt(index)
      if (!range.intersectsNode(root)) continue
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      let node: Node | null
      while ((node = walker.nextNode())) {
        const textNode = node as Text
        const length = textNode.length
        if (!length || !range.intersectsNode(textNode)) continue
        const start = range.startContainer === textNode ? range.startOffset : 0
        const end = range.endContainer === textNode ? range.endOffset : length
        if (start >= end) continue
        const textRange = document.createRange()
        textRange.setStart(textNode, start)
        textRange.setEnd(textNode, end)
        const element = textNode.parentElement ?? root
        const computedLineHeight = getComputedStyle(element).lineHeight
        for (const rect of textRange.getClientRects()) {
          fragments.push({
            left: rect.left,
            right: rect.right,
            top: rect.top,
            bottom: rect.bottom,
            lineHeight: selectionLineHeight(computedLineHeight, rect.height),
          })
        }
      }
    }

    const hostRect = host.getBoundingClientRect()
    const bands = mergeSelectionFragments(fragments).map((line) => {
      const position = selectionBandPosition(line, hostRect, host)
      const band = document.createElement("span")
      band.setAttribute("data-shard-selection-band-rect", "")
      band.style.left = `${position.left}px`
      band.style.top = `${position.top}px`
      band.style.width = `${position.width}px`
      band.style.height = `${position.height}px`
      return band
    })
    layer.replaceChildren(...bands)
  }

  const schedule = () => {
    if (!disposed && !frame) frame = requestAnimationFrame(render)
  }
  const onCompositionStart = () => {
    composing = true
    clear()
  }
  const onCompositionEnd = () => {
    composing = false
    schedule()
  }
  const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule)
  resizeObserver?.observe(root)
  document.addEventListener("selectionchange", schedule)
  root.addEventListener("compositionstart", onCompositionStart)
  root.addEventListener("compositionend", onCompositionEnd)
  void document.fonts?.ready.then(schedule)
  schedule()

  return () => {
    disposed = true
    if (frame) cancelAnimationFrame(frame)
    resizeObserver?.disconnect()
    document.removeEventListener("selectionchange", schedule)
    root.removeEventListener("compositionstart", onCompositionStart)
    root.removeEventListener("compositionend", onCompositionEnd)
    root.removeAttribute("data-shard-selection-band")
    layer.remove()
    if (changedPosition && host.style.position === "relative") host.style.position = previousPosition
    if (changedIsolation && host.style.isolation === "isolate") host.style.isolation = previousIsolation
  }
}
