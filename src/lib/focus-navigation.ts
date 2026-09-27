// managed-navigation 焦点方案（kiln SKILL.md「Declare one focus policy per product」）：
// - Tab 归编辑器：编辑区内未被处理的 Tab 在边界兜底，不让焦点逃出编辑器；
//   编辑区以外恢复浏览器原生 Tab 控件轮转。
// - F6 / Shift+F6 在可见的 `data-focus-region` 区域间循环；有模态框时只在最上层模态框内循环。
// - `<html data-focus-mode="pointer|keyboard">` 决定焦点装饰，样式见 src/index.css。

export type FocusMode = "pointer" | "keyboard"

const REGION_SELECTOR = "[data-focus-region]"
// 编辑区：正文 contenteditable，以及用 data-focus-editor 声明的表格单元格、导图、画布编辑器。
const EDITOR_SELECTOR = '[contenteditable]:not([contenteditable="false"]), [data-focus-editor]'
// 模态框与全屏覆盖层（禅模式用 data-focus-scope 声明）：打开时 F6 只在最上层内循环。
const MODAL_SELECTOR = [
  "[data-focus-scope]",
  '[role="dialog"][aria-modal="true"]',
  '[role="alertdialog"][aria-modal="true"]',
  '[data-slot="dialog-content"]',
  '[data-slot="alert-dialog-content"]',
  '[data-slot="sheet-content"]',
].join(", ")
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  'input:not([disabled]):not([type="hidden"])',
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[contenteditable]:not([contenteditable="false"])',
  '[tabindex]:not([tabindex="-1"])',
].join(", ")

type TiptapHost = HTMLElement & {
  editor?: {
    isDestroyed?: boolean
    // domObserver 是 ProseMirror 内部对象，flush() 把尚未处理的 DOM 选区变化同步写回状态。
    view: { focus: () => void; domObserver?: { flush?: () => void } }
  }
}

const regionEntries = new Map<string, () => boolean>()
// 按区域元素记忆最后一次有效焦点；区域卸载后随元素回收。
const lastFocus = new WeakMap<Element, HTMLElement>()

/** 注册区域的自定义进入函数（例如编辑器用自己的 focus API 保留选区），返回注销函数。 */
export function registerFocusRegionEntry(id: string, enter: () => boolean) {
  regionEntries.set(id, enter)
  return () => {
    if (regionEntries.get(id) === enter) regionEntries.delete(id)
  }
}

export function setFocusMode(mode: FocusMode) {
  const root = document.documentElement
  if (root.dataset.focusMode !== mode) root.dataset.focusMode = mode
}

export function isEditorTarget(target: EventTarget | null) {
  if (!(target instanceof Element)) return false
  const editor = target.closest(EDITOR_SELECTOR)
  if (!editor) return false
  // 编辑区里浮着的按钮、链接是普通控件，保留原生 Tab。
  const control = target.closest("button, a[href]")
  return !control || !editor.contains(control)
}

function isVisible(element: Element) {
  if (element.closest('[inert], [aria-hidden="true"]')) return false
  return element.getClientRects().length > 0
}

function isFocusTarget(element: HTMLElement) {
  if (!element.isConnected || !isVisible(element)) return false
  if (element.matches(":disabled") || element.closest("fieldset:disabled")) return false
  return true
}

function focusables(root: Element) {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(isFocusTarget)
}

/** 区域自身的第一个可聚焦元素，不含嵌套子区域里的元素。 */
function firstOwnFocusable(region: Element) {
  for (const element of region.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)) {
    if (element.closest(REGION_SELECTOR) === region && isFocusTarget(element)) return element
  }
  return null
}

function rememberedFocus(region: Element) {
  const element = lastFocus.get(region)
  return element && region.contains(element) && isFocusTarget(element) ? element : null
}

function canEnter(region: HTMLElement) {
  const id = region.dataset.focusRegion ?? ""
  return Boolean(rememberedFocus(region) || regionEntries.has(id) || firstOwnFocusable(region))
}

function focusElement(element: HTMLElement) {
  // Tiptap 把 editor 挂在 view.dom 上；ProseMirror 的 view.focus() 同步聚焦并写回
  // 原选区（commands.focus 会推迟到下一帧，区域切换需要同步结果）。
  const host = element.closest<TiptapHost>(".ProseMirror")
  if (host?.editor && !host.editor.isDestroyed) {
    host.editor.view.focus()
    return
  }
  // 壳层 overflow 为 hidden，焦点滚动会推动布局容器，统一禁止。
  element.focus({ preventScroll: true })
}

/** 方向键移动光标后，ProseMirror 要等异步的 selectionchange 才更新状态；离开编辑器前
 *  先同步一次，否则回来时 view.focus() 恢复的是旧选区。 */
function flushEditorSelection() {
  const active = document.activeElement
  const host = active instanceof Element ? active.closest<TiptapHost>(".ProseMirror") : null
  if (host?.editor && !host.editor.isDestroyed) host.editor.view.domObserver?.flush?.()
}

function enterRegion(region: HTMLElement) {
  const remembered = rememberedFocus(region)
  if (remembered) {
    focusElement(remembered)
  } else {
    const entry = regionEntries.get(region.dataset.focusRegion ?? "")
    if (!entry?.()) {
      const first = firstOwnFocusable(region)
      if (!first) return false
      focusElement(first)
    }
  }
  return region.contains(document.activeElement)
}

function topmostModal() {
  const modals = Array.from(document.querySelectorAll<HTMLElement>(MODAL_SELECTOR))
    .filter(modal => modal.getClientRects().length > 0 && !modal.closest("[inert]"))
  return modals[modals.length - 1] ?? null
}

/** 模态框内没有声明区域时，在其可聚焦元素之间移动。 */
function moveWithin(root: HTMLElement, step: 1 | -1) {
  const items = focusables(root)
  if (items.length === 0) return false
  const active = document.activeElement
  const index = items.findIndex(item => item === active || item.contains(active))
  const next = index === -1
    ? items[step === 1 ? 0 : items.length - 1]
    : items[(index + step + items.length) % items.length]
  focusElement(next)
  return root.contains(document.activeElement)
}

export function moveFocusRegion(step: 1 | -1) {
  flushEditorSelection()
  const modal = topmostModal()
  const scope: ParentNode = modal ?? document
  const stops = Array.from(scope.querySelectorAll<HTMLElement>(REGION_SELECTOR))
    .filter(region => isVisible(region) && canEnter(region))
  if (stops.length === 0) return modal ? moveWithin(modal, step) : false

  const active = document.activeElement
  const current = active instanceof Element ? active.closest<HTMLElement>(REGION_SELECTOR) : null
  const index = current ? stops.indexOf(current) : -1
  const start = index === -1 ? (step === 1 ? -1 : stops.length) : index
  // 从下一个区域开始依次尝试，跳过进入失败的区域。
  for (let offset = 1; offset <= stops.length; offset += 1) {
    const region = stops[(start + step * offset + stops.length * 2) % stops.length]
    if (enterRegion(region)) return true
  }
  return false
}

function handleFocusIn(event: FocusEvent) {
  const target = event.target
  if (!(target instanceof HTMLElement)) return
  const region = target.closest(REGION_SELECTOR)
  if (region) lastFocus.set(region, target)
}

function handleRegionKeyDown(event: KeyboardEvent) {
  if (event.key !== "F6" || event.isComposing || event.keyCode === 229) return
  // Ctrl+F6 等组合键留给系统；macOS 上 F6 可能需要配合 Fn。
  if (event.ctrlKey || event.metaKey || event.altKey) return
  event.preventDefault()
  event.stopPropagation()
  const previousMode = document.documentElement.dataset.focusMode
  // 先切到 keyboard，让新焦点立即按键盘模式绘制。
  setFocusMode("keyboard")
  if (!moveFocusRegion(event.shiftKey ? -1 : 1) && previousMode === "pointer") setFocusMode("pointer")
}

function handleTabKeyDown(event: KeyboardEvent) {
  if (event.key !== "Tab" || event.defaultPrevented) return
  // 编辑器没有处理的 Tab 在边界兜底，焦点不逃出编辑区。
  if (isEditorTarget(event.target)) {
    event.preventDefault()
    return
  }
  if (!event.ctrlKey && !event.metaKey && !event.altKey) setFocusMode("keyboard")
}

function handlePointerDown() {
  setFocusMode("pointer")
}

export function installFocusNavigation() {
  setFocusMode("pointer")
  document.addEventListener("focusin", handleFocusIn, true)
  // F6 在捕获阶段处理，编辑器不会把它当成普通按键。
  document.addEventListener("keydown", handleRegionKeyDown, true)
  // Tab 在冒泡阶段兜底：编辑器和组件先处理，未处理的才由这里决定。
  document.addEventListener("keydown", handleTabKeyDown)
  document.addEventListener("pointerdown", handlePointerDown, true)
  return () => {
    document.removeEventListener("focusin", handleFocusIn, true)
    document.removeEventListener("keydown", handleRegionKeyDown, true)
    document.removeEventListener("keydown", handleTabKeyDown)
    document.removeEventListener("pointerdown", handlePointerDown, true)
  }
}
