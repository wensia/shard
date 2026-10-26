/**
 * 网页端软键盘避让。
 *
 * iOS Safari 与 Android Chrome（默认 resizes-visual）弹出键盘时只缩小 visual viewport，
 * 布局视口与 100dvh 不变：外壳是定高的，下半截（编辑区光标、底部导航）就被键盘盖住，
 * iOS 还会把整页上推去露出焦点，把顶部标题栏推出屏幕。
 *
 * 这里把键盘弹出后的可视高度写进根元素的 `--shard-viewport-height`，外壳（App.module.css）
 * 按它收缩；键盘开着时根元素挂 `data-keyboard-open`，底部导航让位。页面被推上去的位移归零，
 * 再由焦点所在的滚动容器自己把光标滚进可视区。只在网页端安装（见 main.tsx）。
 */

/** 可视区比布局视口矮出这么多才算键盘；地址栏伸缩、输入法候选条都小于它。 */
export const KEYBOARD_MIN_OVERLAP_PX = 120
/** 光标离可视区底边至少留出的空隙。 */
const CARET_MARGIN_PX = 16

/** 键盘盖住的高度；没有键盘（或用户双指放大导致可视区变小）时为 0。 */
export function keyboardOverlap(layoutHeight: number, visualHeight: number, scale: number) {
  if (scale > 1.01) return 0
  const overlap = layoutHeight - visualHeight
  return overlap >= KEYBOARD_MIN_OVERLAP_PX ? overlap : 0
}

/** 光标（或聚焦的输入框）超出滚动容器可视范围时，需要把容器滚动多少。 */
export function caretScrollDelta(
  caret: { top: number; bottom: number },
  view: { top: number; bottom: number },
  margin = CARET_MARGIN_PX,
) {
  if (caret.bottom > view.bottom - margin) return caret.bottom - view.bottom + margin
  if (caret.top < view.top + margin) return Math.min(0, caret.top - view.top - margin)
  return 0
}

function caretRect(doc: Document, active: HTMLElement) {
  if (active.isContentEditable) {
    const selection = doc.getSelection()
    if (selection && selection.rangeCount > 0) {
      const range = selection.getRangeAt(0)
      const rect = range.getClientRects()[0] ?? range.getBoundingClientRect()
      if (rect.width > 0 || rect.height > 0) return rect
      const anchor = selection.anchorNode
      const element = anchor instanceof Element ? anchor : anchor?.parentElement
      if (element) return element.getBoundingClientRect()
    }
  }
  return active.getBoundingClientRect()
}

function scrollParent(element: HTMLElement) {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node)
    if ((overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight) return node
  }
  return null
}

function revealFocusedCaret(doc: Document) {
  const active = doc.activeElement
  if (!(active instanceof HTMLElement)) return
  if (!active.isContentEditable && !active.matches("input, textarea, select")) return
  const scroller = scrollParent(active)
  if (!scroller) return
  const delta = caretScrollDelta(caretRect(doc, active), scroller.getBoundingClientRect())
  if (delta !== 0) scroller.scrollTop += delta
}

export function installVisualViewportSync(win: Window = window) {
  const viewport = win.visualViewport
  if (!viewport) return () => {}
  const root = win.document.documentElement
  let frame = 0
  let open = false

  const apply = () => {
    frame = 0
    // 布局视口高度：iOS 各版本对 innerHeight 是否随键盘变化不一致，取不随键盘变的 clientHeight 兜底。
    const layoutHeight = Math.max(win.innerHeight, root.clientHeight)
    const overlap = keyboardOverlap(layoutHeight, viewport.height, viewport.scale)
    if (overlap > 0) {
      root.style.setProperty("--shard-viewport-height", `${Math.round(viewport.height)}px`)
      root.dataset.keyboardOpen = "true"
      if (win.scrollY !== 0) win.scrollTo(0, 0)
      // 外壳收缩要等这一帧排版后才生效，下一帧再算光标位置。
      win.requestAnimationFrame(() => revealFocusedCaret(win.document))
      open = true
    } else if (open) {
      root.style.removeProperty("--shard-viewport-height")
      delete root.dataset.keyboardOpen
      open = false
    }
  }
  const schedule = () => {
    if (!frame) frame = win.requestAnimationFrame(apply)
  }
  // 键盘已经开着时在输入框之间切换，可视区不变，不会再有 resize。
  const onFocusIn = () => {
    if (open) win.requestAnimationFrame(() => revealFocusedCaret(win.document))
  }

  viewport.addEventListener("resize", schedule)
  viewport.addEventListener("scroll", schedule)
  win.document.addEventListener("focusin", onFocusIn)
  schedule()
  return () => {
    viewport.removeEventListener("resize", schedule)
    viewport.removeEventListener("scroll", schedule)
    win.document.removeEventListener("focusin", onFocusIn)
    if (frame) win.cancelAnimationFrame(frame)
  }
}
