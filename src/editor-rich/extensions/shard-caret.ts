import { Extension } from "@tiptap/core"
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state"
import type { EditorView } from "@tiptap/pm/view"

/** 光标高度 = 字号 × 该系数，约等于字体 content area（参见 --shard-editor-highlight-pad-y 的推导）。 */
const CARET_HEIGHT_EM = 1.2

/**
 * 自绘光标。
 *
 * WebKit（Tauri 在 macOS 上的 WKWebView）里原生光标高度等于整个行盒：编辑区行高
 * 1.8em，光标就比字高出一大截，上下都探出去。caret-color 只能改颜色，改不了高度，
 * 所以隐藏原生光标、在正文旁边画一根高度贴字形的竖线。
 *
 * - 只接管「编辑器聚焦、窗口激活、空文本选区、不在组合输入」这一种状态；
 *   其余情况（有选区、节点选区、组合输入中）都交还原生光标或不画。
 *   组合输入中拼音串由系统绘制，光标位置以 IME 为准，自绘会跟它错位。
 * - 竖线挂在编辑器 DOM 当前的父元素里、按父元素坐标绝对定位：祖先滚动时随正文一起走，
 *   不用监听滚动。
 * - 原生光标只在 view.dom 上设成透明；嵌在节点视图里的输入框靠 rich-editor.css
 *   在 contenteditable=false 子树上恢复 caret-color。
 */
class CaretView {
  private readonly caret: HTMLDivElement
  private readonly resizeObserver: ResizeObserver | null
  private composing = false
  private lastKey = ""

  constructor(private readonly view: EditorView) {
    this.caret = document.createElement("div")
    this.caret.className = "shard-rich-caret"
    this.caret.setAttribute("aria-hidden", "true")

    view.dom.addEventListener("focus", this.schedule)
    view.dom.addEventListener("blur", this.schedule)
    view.dom.addEventListener("compositionstart", this.onCompositionStart)
    view.dom.addEventListener("compositionend", this.onCompositionEnd)
    window.addEventListener("focus", this.schedule)
    window.addEventListener("blur", this.schedule)
    this.resizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(this.schedule)
    this.resizeObserver?.observe(view.dom)
    this.render()
  }

  update() {
    this.render()
  }

  destroy() {
    const { dom } = this.view
    dom.removeEventListener("focus", this.schedule)
    dom.removeEventListener("blur", this.schedule)
    dom.removeEventListener("compositionstart", this.onCompositionStart)
    dom.removeEventListener("compositionend", this.onCompositionEnd)
    window.removeEventListener("focus", this.schedule)
    window.removeEventListener("blur", this.schedule)
    this.resizeObserver?.disconnect()
    dom.style.removeProperty("caret-color")
    this.caret.remove()
  }

  private onCompositionStart = () => {
    this.composing = true
    this.render()
  }

  private onCompositionEnd = () => {
    this.composing = false
    this.schedule()
  }

  /** 焦点与布局事件发生时 DOM 选区可能还没落定，等一帧再量。 */
  private schedule = () => {
    window.requestAnimationFrame(() => {
      if (!this.view.isDestroyed) this.render()
    })
  }

  /**
   * Tiptap 先把 view 建在一个游离的 div 里，EditorContent 挂载后才把 view.dom 移进
   * 自己的容器，所以宿主不能在构造时取定：每次绘制前按 view.dom 当前的父元素对齐。
   */
  private resolveHost() {
    const host = this.view.dom.parentElement
    if (!host || !host.isConnected) return null
    if (this.caret.parentElement !== host) {
      if (getComputedStyle(host).position === "static") host.style.position = "relative"
      host.appendChild(this.caret)
    }
    return host
  }

  private hide() {
    this.caret.style.display = "none"
    this.view.dom.style.removeProperty("caret-color")
    this.lastKey = ""
  }

  private render() {
    const { view } = this
    const host = this.resolveHost()
    const { selection } = view.state
    const active =
      host &&
      view.editable &&
      !this.composing &&
      !view.composing &&
      view.hasFocus() &&
      document.hasFocus() &&
      selection instanceof TextSelection &&
      selection.empty
    if (!active) {
      this.hide()
      return
    }

    let rect: { left: number; top: number; bottom: number }
    try {
      rect = view.coordsAtPos(selection.head)
    } catch {
      this.hide()
      return
    }

    const domAt = view.domAtPos(selection.head).node
    const element = domAt instanceof Element ? domAt : domAt.parentElement
    const fontSize = parseFloat(getComputedStyle(element ?? view.dom).fontSize) || 16
    const lineHeight = rect.bottom - rect.top
    // coordsAtPos 在文本里给字形 content area，在空段落里可能给整行：
    // 两种情况都取贴字高度，在返回的矩形里垂直居中。
    const height = Math.min(lineHeight, fontSize * CARET_HEIGHT_EM)
    const hostRect = host.getBoundingClientRect()
    const left = rect.left - hostRect.left - host.clientLeft + host.scrollLeft
    const top =
      rect.top + (lineHeight - height) / 2 - hostRect.top - host.clientTop + host.scrollTop

    view.dom.style.setProperty("caret-color", "transparent")
    const style = this.caret.style
    style.display = "block"
    style.transform = `translate(${left}px, ${top}px)`
    style.height = `${height}px`

    // 位置变了就重启闪烁：移动或输入时光标保持常亮，停下来才开始闪。
    const key = `${left}:${top}:${height}`
    if (key !== this.lastKey) {
      this.lastKey = key
      this.caret.classList.remove("shard-rich-caret--blink")
      void this.caret.offsetWidth
      this.caret.classList.add("shard-rich-caret--blink")
    }
  }
}

export const ShardCaret = Extension.create({
  name: "shardCaret",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("shardCaret"),
        view: (view) => new CaretView(view),
      }),
    ]
  },
})
