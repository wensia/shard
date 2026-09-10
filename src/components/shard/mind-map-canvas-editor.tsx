import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react"
import { Maximize2Icon, MoveIcon } from "@/components/icons"

import { setCanvasGrabCursor } from "@/lib/api"
import { Button } from "@/components/ui/button"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import type { ContextMenuRootChangeEventDetails } from "@base-ui/react/context-menu"
import {
  fitMindMapLayout,
  layoutMindMap,
  shouldUseCompactMindMapText,
  type MindMapLayoutNode,
} from "@/lib/mind-map-layout"
import {
  measureMindMapInkBaselineOffset,
  useMindMapFontStyle,
} from "@/lib/mind-map-text-metrics"
import {
  addMindMapChild,
  addMindMapParent,
  addMindMapSibling,
  canMoveMindMapNodesToTarget,
  deleteMindMapNode,
  deleteMindMapNodeOnly,
  getMindMapChildren,
  getMovableMindMapNodeIds,
  type MindMapChangeMeta,
  type MindMapDropMode,
  type MindMapDropTarget,
  moveMindMapNodesToTarget,
  moveMindMapNode,
  outdentMindMapNode,
  toggleMindMapNodeCollapsed,
  updateMindMapNodeText,
} from "@/lib/mind-map-tree"
import type { ShardMapFile } from "@/types"

import styles from "./mind-map-canvas-editor.module.css"

interface MindMapCanvasEditorProps {
  file: ShardMapFile
  onChange: (file: ShardMapFile, meta?: MindMapChangeMeta) => void
  onSave?: () => void
  onSelectNode?: (nodeId: string) => void
  onSelectNodes?: (nodeIds: string[], primaryNodeId: string | null) => void
  selectedNodeId: string | null
  selectedNodeIds: string[]
  inspectorVisible?: boolean
  sessionStateRef?: RefObject<MindMapCanvasSessionState | null>
}

export interface MindMapCanvasSessionState {
  fileId: string
  scale: number
  x: number
  y: number
}

interface CanvasDragState {
  active: boolean
  clientX: number
  clientY: number
  dropTarget: MindMapDropTarget | null
  nodeIds: string[]
  pointerId: number
  sourceNodeId: string
  startClientX: number
  startClientY: number
}

interface MindMapPoint {
  x: number
  y: number
}

interface CanvasViewState {
  scale: number
  x: number
  y: number
}

interface CanvasPanState {
  active: boolean
  pointerId: number
  startClientX: number
  startClientY: number
  startViewScale: number
  startViewX: number
  startViewY: number
}

interface CanvasMarqueeState {
  active: boolean
  additive: boolean
  clientX: number
  clientY: number
  containerLeft: number
  containerTop: number
  pointerId: number
  startClientX: number
  startClientY: number
}

// Safari/WebKit(macOS 触控板双指捏合)专有事件，标准 DOM lib 里没有类型定义。
interface WebKitGestureEvent extends Event {
  clientX: number
  clientY: number
  scale: number
}

const CANVAS_DRAG_THRESHOLD_PX = 4
const DROP_INDICATOR_COLOR =
  "rgb(var(--shard-primary-rgb) / var(--shard-alpha-55))"
const MIN_CANVAS_SCALE = 0.05
const MAX_CANVAS_SCALE = 4
const WHEEL_ZOOM_INTENSITY = 0.0018
const CANVAS_REVEAL_MARGIN_PX = 48
const CANVAS_REVEAL_DURATION_MS = 180
const MIND_MAP_LAYOUT_OPTIONS = {
  // 三行省略仅适用于卡片预览，文档节点与输入框必须容纳完整正文。
  maxNodeLines: Number.POSITIVE_INFINITY,
  horizontalGap: 96,
  nodeHeight: 48,
  nodeVerticalPadding: 13,
  nodeWidth: 190,
  verticalGap: 22,
} as const

export function MindMapCanvasEditor({
  file,
  onChange,
  onSave,
  onSelectNode,
  onSelectNodes,
  selectedNodeId,
  selectedNodeIds,
  inspectorVisible = false,
  sessionStateRef,
}: MindMapCanvasEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const selectedInputRef = useRef<HTMLTextAreaElement | null>(null)
  const dragStateRef = useRef<CanvasDragState | null>(null)
  const canvasPanStateRef = useRef<CanvasPanState | null>(null)
  const marqueeStateRef = useRef<CanvasMarqueeState | null>(null)
  const spaceHeldRef = useRef(false)
  const suppressNodeClickRef = useRef(false)
  const skipSelectOnEditRef = useRef(false)
  const exitNodeEditingRef = useRef<() => void>(() => {})
  const fitRef = useRef<ReturnType<typeof fitMindMapLayout> | null>(null)
  const sizeRef = useRef({ height: 720, width: 980 })
  const viewOverrideRef = useRef<CanvasViewState | null>(null)
  const revealAnimationRef = useRef<number | null>(null)
  const [size, setSize] = useState({ height: 720, width: 980 })
  const [dragState, setDragState] = useState<CanvasDragState | null>(null)
  const [viewOverride, setViewOverride] = useState<CanvasViewState | null>(() =>
    readCanvasSession(sessionStateRef?.current, file.id)
  )
  const viewFileIdRef = useRef(file.id)
  const [hasPanSession, setHasPanSession] = useState(false)
  const [canvasPanActive, setCanvasPanActive] = useState(false)
  const [marqueeState, setMarqueeState] = useState<CanvasMarqueeState | null>(
    null
  )
  const [hasMarqueeSession, setHasMarqueeSession] = useState(false)
  const [spaceHeld, setSpaceHeld] = useState(false)
  // 画布区分两态：单击 = 选中（可直接 Delete 删节点），双击/F2/新建 = 编辑文本。
  const [editingNodeId, setEditingNodeId] = useState<string | null>(null)
  const [editorMeasurement, setEditorMeasurement] = useState<{
    nodeId: string
    text: string
    contentHeight: number
  } | null>(null)
  const [contextMenuOpen, setContextMenuOpen] = useState(false)
  const measuredEditorContentHeight =
    editorMeasurement?.nodeId === editingNodeId &&
    editorMeasurement?.text === file.nodes[editingNodeId ?? ""]?.text
      ? editorMeasurement?.contentHeight ?? 0
      : 0
  const layoutOptions = useMemo(() => ({
    ...MIND_MAP_LAYOUT_OPTIONS,
    nodeMinHeights: editingNodeId && measuredEditorContentHeight
      ? new Map([[editingNodeId, measuredEditorContentHeight + MIND_MAP_LAYOUT_OPTIONS.nodeVerticalPadding * 2]])
      : undefined,
  }), [editingNodeId, measuredEditorContentHeight])
  const layout = useMemo(
    () => layoutMindMap(file, layoutOptions),
    [file, layoutOptions]
  )
  const fit = useMemo(
    () => fitMindMapLayout(layout, size.width, size.height, 56),
    [layout, size.height, size.width]
  )
  const effectiveFit = useMemo(
    () => (viewOverride ? viewStateToFit(viewOverride, size) : fit),
    [fit, size, viewOverride]
  )
  fitRef.current = fit
  sizeRef.current = size
  viewOverrideRef.current = viewOverride
  const compactText = shouldUseCompactMindMapText(layout, effectiveFit.scale)
  // 节点文字的实际字体（挂载后读取，字体加载完成自动复测）。
  const nodeFontStyle = useMindMapFontStyle(containerRef)
  const nodeFontFamily = nodeFontStyle?.fontFamily ?? null
  const selectedNodeIdsSet = useMemo(
    () => new Set(selectedNodeIds.filter((nodeId) => file.nodes[nodeId])),
    [file.nodes, selectedNodeIds]
  )
  const visibleNodeIds = useMemo(
    () => layout.nodes.map((layoutNode) => layoutNode.id),
    [layout.nodes]
  )
  // 每个节点的子节点数（含折叠时不可见的），驱动折叠钮显隐和计数。
  const childCountById = useMemo(() => {
    const counts = new Map<string, number>()
    for (const node of Object.values(file.nodes)) {
      if (node.parentId) {
        counts.set(node.parentId, (counts.get(node.parentId) ?? 0) + 1)
      }
    }
    return counts
  }, [file.nodes])
  const selectedNode = selectedNodeId ? file.nodes[selectedNodeId] : null
  const selectedLayoutNode = selectedNodeId
    ? layout.nodes.find((node) => node.id === selectedNodeId) ?? null
    : null
  const selectedEditorRect =
    selectedLayoutNode && selectedNode
      ? getScreenNodeRect(selectedLayoutNode, effectiveFit)
      : null
  const editorScale = effectiveFit.scale
  const editorBorderWidth = Math.max(0.75, editorScale)
  // 编辑态字号/行高与渲染态（含紧凑模式）保持一致，避免进出编辑时文字跳动。
  const editorFontSize = compactText ? 11 : 13
  const editorLineHeight = (compactText ? 14 : 18) * editorScale
  const editorLineCount = Math.max(
    1,
    selectedLayoutNode?.textLines.length ?? 1
  )
  const editorPaddingBlock = selectedEditorRect
    ? Math.max(
        0,
        (selectedEditorRect.height -
          editorBorderWidth * 2 -
          (measuredEditorContentHeight
            ? measuredEditorContentHeight * editorScale
            : editorLineHeight * editorLineCount)) /
          2
      )
    : 0
  const isDraggingNode = dragState?.active ?? false
  const canEditSelectedNode = selectedNodeIdsSet.size <= 1
  const isEditingSelected =
    editingNodeId !== null &&
    editingNodeId === selectedNodeId &&
    canEditSelectedNode &&
    !isDraggingNode
  const contextMenuMovableCount = getMovableMindMapNodeIds(
    file,
    selectedNodeIds
  ).length
  // 菜单文案按用户实际选中的节点数展示（不含根节点），与多选直觉一致；
  // 实际删除仍按 movable 集合去重（祖先已选中时后代不重复执行）。
  const contextMenuSelectionCount = selectedNodeIds.filter(
    (nodeId) => nodeId !== file.rootId && file.nodes[nodeId]
  ).length

  useLayoutEffect(() => {
    const element = containerRef.current
    if (!element) return

    // 首帧使用真实画布尺寸，避免先按占位尺寸固定视口，再恢复时偏移。
    const rect = element.getBoundingClientRect()
    setSize({ height: Math.max(1, rect.height), width: Math.max(1, rect.width) })
    const observer = new ResizeObserver(([entry]) => {
      const nextSize = {
        height: Math.max(1, entry.contentRect.height),
        width: Math.max(1, entry.contentRect.width),
      }
      // 面板开关只改变可用范围，保留操作中的实际比例和视口原点。
      const current = viewOverrideRef.current ?? fitRef.current
      if (current) setViewOverride({ scale: current.scale, x: current.x, y: current.y })
      setSize(currentSize => currentSize.height === nextSize.height && currentSize.width === nextSize.width ? currentSize : nextSize)
    })
    observer.observe(element)

    return () => observer.disconnect()
  }, [])

  useLayoutEffect(() => {
    if (viewFileIdRef.current === file.id) return
    viewFileIdRef.current = file.id
    const restored = readCanvasSession(sessionStateRef?.current, file.id)
    viewOverrideRef.current = restored
    setViewOverride(restored)
    setEditingNodeId(null)
  }, [file.id, sessionStateRef])

  useLayoutEffect(() => {
    if (!sessionStateRef) return
    const current = viewOverrideRef.current ?? fitRef.current
    if (current) sessionStateRef.current = { fileId: file.id, scale: current.scale, x: current.x, y: current.y }
  })

  // Photoshop 式交互：默认是选择工具（点选/框选），按住空格临时切换为抓手工具平移画布。
  // 输入框/输入法组合中的空格不拦截。
  useEffect(() => {
    function isTextInputTarget(target: EventTarget | null) {
      return (
        target instanceof HTMLElement &&
        target.closest("input, textarea, [contenteditable='true']") !== null
      )
    }

    function handleKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key !== " " || event.repeat || event.isComposing) return
      if (event.defaultPrevented || !(event.target instanceof Node) || !containerRef.current?.contains(event.target)) return
      if (isTextInputTarget(event.target)) return

      event.preventDefault()
      spaceHeldRef.current = true
      setSpaceHeld(true)
      // 抓手必须在按下的瞬间就可见，不能等鼠标移动，所以直接设原生光标。
      void setCanvasGrabCursor(true).catch(() => {})
    }

    function handleKeyUp(event: globalThis.KeyboardEvent) {
      if (event.key !== " ") return
      spaceHeldRef.current = false
      setSpaceHeld(false)
      void setCanvasGrabCursor(false).catch(() => {})
    }

    function handleWindowBlur() {
      spaceHeldRef.current = false
      setSpaceHeld(false)
      void setCanvasGrabCursor(false).catch(() => {})
    }

    window.addEventListener("keydown", handleKeyDown)
    window.addEventListener("keyup", handleKeyUp)
    window.addEventListener("blur", handleWindowBlur)

    return () => {
      window.removeEventListener("keydown", handleKeyDown)
      window.removeEventListener("keyup", handleKeyUp)
      window.removeEventListener("blur", handleWindowBlur)
      spaceHeldRef.current = false
      dragStateRef.current = null
      canvasPanStateRef.current = null
      marqueeStateRef.current = null
      void setCanvasGrabCursor(false).catch(() => {})
    }
  }, [])

  // 选中态被外部改变时（大纲视图点击、多选、删除后的焦点转移）退出编辑态。
  useEffect(() => {
    if (editingNodeId !== null && editingNodeId !== selectedNodeId) {
      setEditingNodeId(null)
    }
  }, [editingNodeId, selectedNodeId])

  useLayoutEffect(() => {
    if (!selectedNodeId || viewOverrideRef.current) return
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect || Math.abs(rect.width - size.width) > 0.5 || Math.abs(rect.height - size.height) > 0.5) return

    const currentFit = fitRef.current
    if (!currentFit) return

    // 选中/编辑期间固定当前视口，避免节点随文字增长时整张导图反复缩放或跳动。
    setViewOverride({
      scale: currentFit.scale,
      x: currentFit.x,
      y: currentFit.y,
    })
  }, [selectedNodeId, size.height, size.width])

  useEffect(() => {
    return () => {
      if (revealAnimationRef.current !== null) {
        cancelAnimationFrame(revealAnimationRef.current)
      }
    }
  }, [])

  useEffect(() => {
    const element = containerRef.current
    if (!element) return

    function getCurrentView(): CanvasViewState {
      const override = viewOverrideRef.current
      if (override) return override
      const currentFit = fitRef.current
      return currentFit
        ? { scale: currentFit.scale, x: currentFit.x, y: currentFit.y }
        : { scale: 1, x: 0, y: 0 }
    }

    function zoomAtClientPoint(
      clientX: number,
      clientY: number,
      baseView: CanvasViewState,
      nextScale: number
    ) {
      const container = containerRef.current
      if (!container) return

      const rect = container.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return

      const currentSize = sizeRef.current
      const mouseOffsetX = ((clientX - rect.left) / rect.width) * currentSize.width
      const mouseOffsetY = ((clientY - rect.top) / rect.height) * currentSize.height
      const pointX = baseView.x + mouseOffsetX / baseView.scale
      const pointY = baseView.y + mouseOffsetY / baseView.scale
      const clampedScale = clamp(nextScale, MIN_CANVAS_SCALE, MAX_CANVAS_SCALE)

      setViewOverride({
        scale: clampedScale,
        x: pointX - mouseOffsetX / clampedScale,
        y: pointY - mouseOffsetY / clampedScale,
      })
    }

    // 约定与常见白板/设计工具一致：触控板双指滑动或裸滚轮 = 平移画布；
    // 按住 ctrl/cmd 滚动，或触控板双指捏合(通过下方 gesture* 事件) = 缩放。
    // Chrome 会把触控板捏合手势转换成带 ctrlKey 的 wheel 事件，
    // 但 macOS 上 Tauri 用的 WKWebView 不会——捏合手势走 gesturestart/change/end。
    function handleWheel(event: WheelEvent) {
      event.preventDefault()
      cancelRevealAnimation()

      const currentView = getCurrentView()

      if (event.ctrlKey || event.metaKey) {
        const zoomFactor = Math.exp(-event.deltaY * WHEEL_ZOOM_INTENSITY)
        zoomAtClientPoint(
          event.clientX,
          event.clientY,
          currentView,
          currentView.scale * zoomFactor
        )
        return
      }

      setViewOverride({
        scale: currentView.scale,
        x: currentView.x + event.deltaX / currentView.scale,
        y: currentView.y + event.deltaY / currentView.scale,
      })
    }

    let gestureStartView: CanvasViewState | null = null
    let gestureStartScale = 1

    function handleGestureStart(event: Event) {
      event.preventDefault()
      const gestureEvent = event as WebKitGestureEvent
      gestureStartView = getCurrentView()
      gestureStartScale = gestureEvent.scale || 1
    }

    function handleGestureChange(event: Event) {
      event.preventDefault()
      if (!gestureStartView) return

      const gestureEvent = event as WebKitGestureEvent
      const relativeScale = (gestureEvent.scale || 1) / gestureStartScale
      zoomAtClientPoint(
        gestureEvent.clientX,
        gestureEvent.clientY,
        gestureStartView,
        gestureStartView.scale * relativeScale
      )
    }

    function handleGestureEnd(event: Event) {
      event.preventDefault()
      gestureStartView = null
    }

    element.addEventListener("wheel", handleWheel, { passive: false })
    element.addEventListener("gesturestart", handleGestureStart)
    element.addEventListener("gesturechange", handleGestureChange)
    element.addEventListener("gestureend", handleGestureEnd)

    return () => {
      element.removeEventListener("wheel", handleWheel)
      element.removeEventListener("gesturestart", handleGestureStart)
      element.removeEventListener("gesturechange", handleGestureChange)
      element.removeEventListener("gestureend", handleGestureEnd)
    }
  }, [])

  useEffect(() => {
    if (!hasPanSession) return

    function handlePointerMove(event: PointerEvent) {
      const current = canvasPanStateRef.current
      if (!current || event.pointerId !== current.pointerId) return

      const deltaClientX = event.clientX - current.startClientX
      const deltaClientY = event.clientY - current.startClientY
      const active =
        current.active ||
        Math.hypot(deltaClientX, deltaClientY) >= CANVAS_DRAG_THRESHOLD_PX
      if (!active) return

      if (!current.active) {
        suppressNodeClickRef.current = true
        setCanvasPanActive(true)
      }
      canvasPanStateRef.current = { ...current, active: true }
      setViewOverride({
        scale: current.startViewScale,
        x: current.startViewX - deltaClientX / current.startViewScale,
        y: current.startViewY - deltaClientY / current.startViewScale,
      })
    }

    function endPan(event: PointerEvent) {
      const current = canvasPanStateRef.current
      if (!current || event.pointerId !== current.pointerId) return

      if (current.active) {
        window.setTimeout(() => {
          suppressNodeClickRef.current = false
        }, 0)
      }
      canvasPanStateRef.current = null
      setCanvasPanActive(false)
      setHasPanSession(false)
    }

    window.addEventListener("pointermove", handlePointerMove)
    window.addEventListener("pointerup", endPan)
    window.addEventListener("pointercancel", endPan)

    return () => {
      window.removeEventListener("pointermove", handlePointerMove)
      window.removeEventListener("pointerup", endPan)
      window.removeEventListener("pointercancel", endPan)
    }
  }, [hasPanSession])

  // 框选会话：默认选择工具下，在空白画布按下并拖出选框，松开后选中与选框相交的节点。
  useEffect(() => {
    if (!hasMarqueeSession) return

    function handlePointerMove(event: PointerEvent) {
      const current = marqueeStateRef.current
      if (!current || event.pointerId !== current.pointerId) return

      const active =
        current.active ||
        Math.hypot(
          event.clientX - current.startClientX,
          event.clientY - current.startClientY
        ) >= CANVAS_DRAG_THRESHOLD_PX
      if (active && !current.active) {
        suppressNodeClickRef.current = true
      }

      const next = {
        ...current,
        active,
        clientX: event.clientX,
        clientY: event.clientY,
      }
      marqueeStateRef.current = next
      setMarqueeState(next)
    }

    function endMarquee(event: PointerEvent) {
      const current = marqueeStateRef.current
      if (!current || event.pointerId !== current.pointerId) return

      if (current.active) {
        const container = containerRef.current
        const currentFit = getCurrentEffectiveFit()
        if (container && currentFit) {
          const rect = container.getBoundingClientRect()
          const marqueeRect = {
            bottom: Math.max(current.startClientY, current.clientY) - rect.top,
            left: Math.min(current.startClientX, current.clientX) - rect.left,
            right: Math.max(current.startClientX, current.clientX) - rect.left,
            top: Math.min(current.startClientY, current.clientY) - rect.top,
          }
          const hitNodeIds = layout.nodes
            .filter((layoutNode) => {
              const nodeRect = getScreenNodeRect(layoutNode, currentFit)
              return (
                nodeRect.left < marqueeRect.right &&
                nodeRect.left + nodeRect.width > marqueeRect.left &&
                nodeRect.top < marqueeRect.bottom &&
                nodeRect.top + nodeRect.height > marqueeRect.top
              )
            })
            .map((layoutNode) => layoutNode.id)

          // 按下时按住 Shift/⌘/Ctrl = 加选，否则替换整个选中集合。
          if (current.additive) {
            selectCanvasNodes(
              [...selectedNodeIds, ...hitNodeIds],
              hitNodeIds[0] ?? selectedNodeId
            )
          } else {
            selectCanvasNodes(hitNodeIds, hitNodeIds[0] ?? null)
          }
          container.focus({ preventScroll: true })
        }
        window.setTimeout(() => {
          suppressNodeClickRef.current = false
        }, 0)
      } else {
        // 背景单击（未拖出选框）：提交正在编辑的节点文本并退出编辑/选中态。
        exitNodeEditingRef.current()
      }
      marqueeStateRef.current = null
      setMarqueeState(null)
      setHasMarqueeSession(false)
    }

    window.addEventListener("pointermove", handlePointerMove)
    window.addEventListener("pointerup", endMarquee)
    window.addEventListener("pointercancel", endMarquee)

    return () => {
      window.removeEventListener("pointermove", handlePointerMove)
      window.removeEventListener("pointerup", endMarquee)
      window.removeEventListener("pointercancel", endMarquee)
    }
  }, [hasMarqueeSession, layout.nodes, selectedNodeId, selectedNodeIds])

  // WKWebView 防御层：框选/平移会话期间拦截原生选区生成（capture 阶段）。
  useEffect(() => {
    function preventNativeSelection(event: Event) {
      if (marqueeStateRef.current || canvasPanStateRef.current) {
        event.preventDefault()
      }
    }

    document.addEventListener("selectstart", preventNativeSelection, true)
    return () => {
      document.removeEventListener("selectstart", preventNativeSelection, true)
    }
  }, [])

  useLayoutEffect(() => {
    const input = selectedInputRef.current
    if (!isEditingSelected || !input || !selectedNode) return

    // 只测量当前输入框。临时移除高度与纵向留白，读取浏览器实际排出的全部行；
    // 不以旧框高度作基准，文字删除后也能收缩，并避免居中留白反复叠加。
    const previousHeight = input.style.height
    const previousPadding = input.style.paddingBlock
    input.style.height = "0px"
    input.style.paddingBlock = "0px"
    const contentHeight = Math.ceil(input.scrollHeight / editorScale)
    input.style.height = previousHeight
    input.style.paddingBlock = previousPadding
    input.scrollTop = 0
    setEditorMeasurement(current =>
      current?.nodeId === selectedNode.id && current.text === selectedNode.text &&
      current.contentHeight === contentHeight
        ? current
        : { nodeId: selectedNode.id, text: selectedNode.text, contentHeight }
    )
  }, [isEditingSelected, selectedNode?.id, selectedNode?.text, selectedEditorRect?.width,
    editorScale, editorFontSize, editorLineHeight, nodeFontStyle])

  useLayoutEffect(() => {
    if (!isEditingSelected) return
      const input = selectedInputRef.current
      if (!input) return
      input.focus()
      // type-to-edit 进入时首字符已是全文，全选会被下一键替换——光标置末尾。
      if (skipSelectOnEditRef.current) {
        skipSelectOnEditRef.current = false
        input.setSelectionRange(input.value.length, input.value.length)
      } else {
        input.select()
      }
  }, [isEditingSelected, selectedNodeId])

  useEffect(() => {
    function handlePointerMove(event: PointerEvent) {
      const current = dragStateRef.current
      if (!current || event.pointerId !== current.pointerId) return

      const deltaX = event.clientX - current.startClientX
      const deltaY = event.clientY - current.startClientY
      const active =
        current.active ||
        Math.hypot(deltaX, deltaY) >= CANVAS_DRAG_THRESHOLD_PX
      const dropTarget = active
        ? getCanvasDropTarget(
            file,
            layout.nodes,
            effectiveFit,
            containerRef.current,
            current.nodeIds,
            event.clientX,
            event.clientY
          )
        : null
      if (active) {
        suppressNodeClickRef.current = true
      }

      const next = {
        ...current,
        active,
        clientX: event.clientX,
        clientY: event.clientY,
        dropTarget,
      }
      dragStateRef.current = next
      setDragState(next)
    }

    function handlePointerUp(event: PointerEvent) {
      const current = dragStateRef.current
      if (!current || event.pointerId !== current.pointerId) return

      if (current.active && current.dropTarget) {
        onChange(
          moveMindMapNodesToTarget(file, current.nodeIds, current.dropTarget)
        )
        selectCanvasNodes(current.nodeIds, current.nodeIds[0] ?? null)
      } else if (!current.active) {
        selectNodeFromModifierState(event, current.sourceNodeId)
        suppressNodeClickRef.current = true
        window.setTimeout(() => {
          suppressNodeClickRef.current = false
        }, 0)
      }

      if (current.active) {
        window.setTimeout(() => {
          suppressNodeClickRef.current = false
        }, 0)
      }
      dragStateRef.current = null
      setDragState(null)
    }

    function handlePointerCancel(event: PointerEvent) {
      const current = dragStateRef.current
      if (!current || event.pointerId !== current.pointerId) return
      suppressNodeClickRef.current = false
      dragStateRef.current = null
      setDragState(null)
    }

    window.addEventListener("pointermove", handlePointerMove)
    window.addEventListener("pointerup", handlePointerUp)
    window.addEventListener("pointercancel", handlePointerCancel)

    return () => {
      window.removeEventListener("pointermove", handlePointerMove)
      window.removeEventListener("pointerup", handlePointerUp)
      window.removeEventListener("pointercancel", handlePointerCancel)
    }
  }, [
    effectiveFit,
    file,
    layout.nodes,
    onChange,
    onSelectNode,
    onSelectNodes,
    selectedNodeIds,
  ])

  function selectCanvasNodes(nodeIds: string[], primaryNodeId: string | null) {
    const nextNodeIds = getUniqueExistingNodeIds(file, nodeIds)
    const nextPrimaryNodeId =
      primaryNodeId && nextNodeIds.includes(primaryNodeId)
        ? primaryNodeId
        : nextNodeIds[0] ?? null

    onSelectNodes?.(nextNodeIds, nextPrimaryNodeId)
    if (nextPrimaryNodeId && nextNodeIds.length === 1) {
      onSelectNode?.(nextPrimaryNodeId)
    }
  }

  function selectNodeFromModifierState(
    event: Pick<ReactMouseEvent<SVGGElement> | PointerEvent, "ctrlKey" | "metaKey" | "shiftKey">,
    nodeId: string
  ) {
    // 点击/框选只是选中节点（焦点给画布容器，保证 Delete 等按键可用），不进入编辑态。
    setEditingNodeId(null)
    containerRef.current?.focus()

    if (nodeId === file.rootId) {
      selectCanvasNodes([nodeId], nodeId)
      return
    }

    if (event.shiftKey && selectedNodeId) {
      selectCanvasNodes(
        getRangeNodeIds(visibleNodeIds, selectedNodeId, nodeId),
        nodeId
      )
      return
    }

    if (event.metaKey || event.ctrlKey) {
      const nextNodeIds = selectedNodeIdsSet.has(nodeId)
        ? selectedNodeIds.filter((selectedId) => selectedId !== nodeId)
        : [...selectedNodeIds, nodeId]
      selectCanvasNodes(nextNodeIds, nodeId)
      return
    }

    selectCanvasNodes([nodeId], nodeId)
  }

  function cancelRevealAnimation() {
    if (revealAnimationRef.current === null) return
    cancelAnimationFrame(revealAnimationRef.current)
    revealAnimationRef.current = null
  }

  function animateViewTo(target: CanvasViewState) {
    cancelRevealAnimation()

    const start = viewOverrideRef.current
    if (!start) {
      setViewOverride(target)
      return
    }

    const startTime = performance.now()
    const step = (now: number) => {
      const progress = Math.min(1, (now - startTime) / CANVAS_REVEAL_DURATION_MS)
      const eased = 1 - Math.pow(1 - progress, 3)
      setViewOverride({
        scale: target.scale,
        x: start.x + (target.x - start.x) * eased,
        y: start.y + (target.y - start.y) * eased,
      })
      revealAnimationRef.current =
        progress < 1 ? requestAnimationFrame(step) : null
    }
    revealAnimationRef.current = requestAnimationFrame(step)
  }

  // Tab/Enter 新增节点、方向键导航后，编辑态的视口是锁定的，目标节点可能落在画布外；
  // 这里按当前文件布局，把视口平滑平移到刚好容纳目标节点的位置（缩放不变）。
  function revealNodeOnCanvas(nextFile: ShardMapFile, nodeId: string, animate = true) {
    const currentView = viewOverrideRef.current ?? fitRef.current
    if (!currentView) return

    const nextLayout = nextFile === file ? layout : layoutMindMap(nextFile, MIND_MAP_LAYOUT_OPTIONS)
    // 另一视图可能选择了折叠分支内的主题，只显露最近可见祖先，不改动折叠数据。
    let visibleNodeId: string | null | undefined = nodeId
    let layoutNode = nextLayout.nodes.find((node) => node.id === visibleNodeId)
    while (!layoutNode && visibleNodeId) {
      visibleNodeId = nextFile.nodes[visibleNodeId]?.parentId
      layoutNode = nextLayout.nodes.find((node) => node.id === visibleNodeId)
    }
    if (!layoutNode) return

    const { height } = sizeRef.current
    let { width } = sizeRef.current
    const containerRect = containerRef.current?.getBoundingClientRect()
    const inspectorRect = containerRef.current?.closest('[aria-label="思维导图画布"]')
      ?.querySelector("[data-mind-map-side-panel], [data-mind-map-inspector]")?.getBoundingClientRect()
    if (containerRect && inspectorRect && inspectorRect.left < containerRect.right &&
      inspectorRect.right > containerRect.left && inspectorRect.bottom > containerRect.top && inspectorRect.top < containerRect.bottom) {
      width = Math.max(1, inspectorRect.left - containerRect.left)
    }
    const { scale } = currentView
    const left = (layoutNode.x - currentView.x) * scale
    const right = (layoutNode.x + layoutNode.width - currentView.x) * scale
    const top = (layoutNode.y - currentView.y) * scale
    const bottom = (layoutNode.y + layoutNode.height - currentView.y) * scale
    const marginX = Math.min(CANVAS_REVEAL_MARGIN_PX, Math.max(0, (width - layoutNode.width * scale) / 2))

    let deltaX = 0
    if (right > width - marginX) {
      deltaX = right - (width - marginX)
    } else if (left < marginX) {
      deltaX = left - marginX
    }

    let deltaY = 0
    if (bottom > height - CANVAS_REVEAL_MARGIN_PX) {
      deltaY = bottom - (height - CANVAS_REVEAL_MARGIN_PX)
    } else if (top < CANVAS_REVEAL_MARGIN_PX) {
      deltaY = top - CANVAS_REVEAL_MARGIN_PX
    }

    if (deltaX === 0 && deltaY === 0) return

    const target = {
      scale,
      x: currentView.x + deltaX / scale,
      y: currentView.y + deltaY / scale,
    }
    if (animate) animateViewTo(target)
    else {
      cancelRevealAnimation()
      viewOverrideRef.current = target
      setViewOverride(target)
    }
  }

  // Text growth and the inspector changing geometry can hide an already selected topic.
  // Recalculate against its final layout before paint; only this SVG viewport moves.
  useLayoutEffect(() => {
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect || Math.abs(rect.width - size.width) > 0.5 || Math.abs(rect.height - size.height) > 0.5) return
    if (selectedNodeId && selectedNodeIds.length === 1) revealNodeOnCanvas(file, selectedNodeId, false)
  }, [file, layout, selectedNodeId, selectedNodeIds.length, size.width, size.height, inspectorVisible])

  function addChild(nodeId: string) {
    // 目标处于折叠态时顺带展开，否则新节点不可见、编辑态幽灵化。
    const base = file.nodes[nodeId]?.collapsed
      ? toggleMindMapNodeCollapsed(file, nodeId)
      : file
    const next = addMindMapChild(base, nodeId)
    onChange(next.file)
    setEditingNodeId(next.nodeId)
    onSelectNode?.(next.nodeId)
    revealNodeOnCanvas(next.file, next.nodeId)
  }

  function addSibling(nodeId: string, placement: "before" | "after" = "after") {
    const parentId = file.nodes[nodeId]?.parentId
    const base =
      parentId && file.nodes[parentId]?.collapsed
        ? toggleMindMapNodeCollapsed(file, parentId)
        : file
    const next = addMindMapSibling(base, nodeId, placement)
    onChange(next.file)
    setEditingNodeId(next.nodeId)
    onSelectNode?.(next.nodeId)
    revealNodeOnCanvas(next.file, next.nodeId)
  }

  function toggleCollapsed(nodeId: string) {
    const node = file.nodes[nodeId]
    if (!node || nodeId === file.rootId) return
    if (!node.collapsed && (childCountById.get(nodeId) ?? 0) === 0) return

    const nextFile = toggleMindMapNodeCollapsed(file, nodeId)
    onChange(nextFile)

    // 折叠后把选中收敛到仍可见的节点，避免不可见节点被 Delete 误删；
    // 全部被隐藏时转移到被折叠节点本身。
    if (!node.collapsed) {
      const visibleIds = new Set(
        layoutMindMap(nextFile, MIND_MAP_LAYOUT_OPTIONS).nodes.map(
          (layoutNode) => layoutNode.id
        )
      )
      const nextSelected = selectedNodeIds.filter((id) => visibleIds.has(id))
      if (nextSelected.length !== selectedNodeIds.length) {
        const fallback = nextSelected.length > 0 ? nextSelected : [nodeId]
        selectCanvasNodes(fallback, fallback[0])
      }
    }
  }

  // 删除当前选中的全部节点（根节点除外），焦点落回邻近节点并保持画布焦点，
  // 之后可以继续按 Delete 连删。deleteOnlySingleNode = 只删节点本身、子节点上提。
  function deleteSelectedNodes(deleteOnlySingleNode: boolean) {
    const nodeIds = getMovableMindMapNodeIds(
      file,
      selectedNodeIds.length > 0
        ? selectedNodeIds
        : selectedNodeId
          ? [selectedNodeId]
          : []
    )
    if (nodeIds.length === 0) return

    let nextFile = file
    let focusNodeId = file.rootId
    for (const nodeId of nodeIds) {
      const next = deleteOnlySingleNode
        ? deleteMindMapNodeOnly(nextFile, nodeId)
        : deleteMindMapNode(nextFile, nodeId)
      nextFile = next.file
      focusNodeId = next.focusNodeId
    }

    setEditingNodeId(null)
    onChange(nextFile)
    onSelectNode?.(focusNodeId)
    containerRef.current?.focus()
  }

  function startNodeDrag(
    event: ReactPointerEvent<HTMLElement | SVGGElement>,
    nodeId: string
  ) {
    // 空格按住时是抓手工具：节点上的拖拽也让位给画布平移（事件冒泡到 svg 处理）。
    if (spaceHeldRef.current) return
    if (nodeId === file.rootId || event.button !== 0) return

    event.preventDefault()
    event.stopPropagation()
    selectedInputRef.current?.blur()

    const selectedMovableNodeIds =
      selectedNodeIdsSet.has(nodeId) && selectedNodeIds.length > 1
        ? selectedNodeIds
        : [nodeId]
    const nodeIds = getMovableMindMapNodeIds(file, selectedMovableNodeIds)
    if (nodeIds.length === 0) return

    const next = {
      active: false,
      clientX: event.clientX,
      clientY: event.clientY,
      dropTarget: null,
      nodeIds,
      pointerId: event.pointerId,
      sourceNodeId: nodeId,
      startClientX: event.clientX,
      startClientY: event.clientY,
    }
    dragStateRef.current = next
    setDragState(next)
  }

  // 通过 ref 暴露给平移监听器，避免为了拿到最新的选中状态而重新绑定 pointer 事件。
  function exitNodeEditing() {
    if (selectedNodeId || selectedNodeIds.length > 0) {
      // 先 blur：结束可能进行中的输入法组合，让最后一段文本通过 onChange 写入草稿。
      selectedInputRef.current?.blur()
      setEditingNodeId(null)
      onSelectNodes?.([], null)
    }
    // 仅由画布空白单击和画布 Escape 调用；工具栏/侧栏点击保留各自焦点。
    // 输入框卸载后仍需留在工作区内，才能继续使用保存、关闭等快捷键。
    containerRef.current?.focus({ preventScroll: true })
  }
  exitNodeEditingRef.current = exitNodeEditing

  function getCurrentEffectiveFit() {
    const override = viewOverrideRef.current
    if (override) return viewStateToFit(override, sizeRef.current)
    return fitRef.current
  }

  // WKWebView 下仅靠 CSS 的 user-select 挡不住拖拽产生的 SVG 文本选区，
  // 必须在起始 pointerdown 同步 preventDefault，并清掉可能已存在的选区。
  function suppressNativeCanvasSelection(
    event: ReactPointerEvent<SVGSVGElement>
  ) {
    event.preventDefault()
    window.getSelection()?.removeAllRanges()
  }

  function startCanvasPointer(event: ReactPointerEvent<SVGSVGElement>) {
    if (event.button !== 0 || dragStateRef.current) return

    cancelRevealAnimation()
    suppressNativeCanvasSelection(event)

    // 空格按住 = 抓手工具：任意位置（包括节点上方）按下都进入平移。
    if (spaceHeldRef.current) {
      containerRef.current?.focus({ preventScroll: true })
      const currentView: CanvasViewState = viewOverride ?? {
        scale: fit.scale,
        x: fit.x,
        y: fit.y,
      }
      canvasPanStateRef.current = {
        active: false,
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startViewScale: currentView.scale,
        startViewX: currentView.x,
        startViewY: currentView.y,
      }
      setHasPanSession(true)
      return
    }

    // 默认选择工具：只有落在空白画布（含连线）上的按下才开始框选，
    // 节点上的按下由节点自身的拖拽/点击逻辑处理。
    if (!isCanvasBackgroundTarget(event.target)) return

    const containerRect = containerRef.current?.getBoundingClientRect()
    const next: CanvasMarqueeState = {
      active: false,
      additive: event.shiftKey || event.metaKey || event.ctrlKey,
      clientX: event.clientX,
      clientY: event.clientY,
      containerLeft: containerRect?.left ?? 0,
      containerTop: containerRect?.top ?? 0,
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
    }
    marqueeStateRef.current = next
    setMarqueeState(next)
    setHasMarqueeSession(true)
  }

  function handleNodeKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (!selectedNodeId || !selectedNode) return

    const nativeEvent = event.nativeEvent
    const isComposing =
      nativeEvent.isComposing ||
      event.key === "Process" ||
      nativeEvent.keyCode === 229
    if (isComposing) return

    if (event.key === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      // 只退出编辑态、保留选中；焦点还给画布容器，之后可直接 Delete 删节点。
      setEditingNodeId(null)
      containerRef.current?.focus()
      return
    }

    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault()
      onSave?.()
      return
    }

    if (event.key === "Enter") {
      if (event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) return
      event.preventDefault()
      event.stopPropagation()
      if (event.metaKey || event.ctrlKey) {
        setEditingNodeId(null)
        containerRef.current?.focus()
        return
      }
      if (
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.shiftKey
      ) {
        addSibling(selectedNodeId)
      }
      return
    }

    if (event.key === "Tab") {
      event.preventDefault()
      if (event.shiftKey) {
        onChange(outdentMindMapNode(file, selectedNodeId))
        onSelectNode?.(selectedNodeId)
        return
      }

      addChild(selectedNodeId)
      return
    }

    if (
      (event.key === "Backspace" || event.key === "Delete") &&
      selectedNode.id !== file.rootId &&
      event.currentTarget.value === ""
    ) {
      event.preventDefault()
      deleteSelectedNodes(false)
    }
  }

  // 右键（或触屏长按）打开节点菜单：右键已在选中集合内的节点时保留多选，
  // 否则改为单选该节点；右键空白画布不打开菜单。
  function handleContextMenuOpenChange(
    open: boolean,
    details: ContextMenuRootChangeEventDetails
  ) {
    if (!open) {
      setContextMenuOpen(false)
      if (details.event instanceof globalThis.KeyboardEvent && details.event.key === "Escape") {
        containerRef.current?.focus({ preventScroll: true })
      }
      return
    }

    const target = details.event.target
    const nodeElement =
      target instanceof Element
        ? target.closest("[data-mind-map-node]")
        : null
    const nodeId = nodeElement?.getAttribute("data-mind-map-node") ?? null
    if (!nodeId || !file.nodes[nodeId]) return

    setEditingNodeId(null)
    if (!selectedNodeIdsSet.has(nodeId)) {
      selectCanvasNodes([nodeId], nodeId)
    }
    setContextMenuOpen(true)
  }

  // 方向键导航：← 父节点，→ 第一个子节点（折叠时展开），↑/↓ 同级。
  // 目标从语义树推导；多选先收敛为单选；目标在视口外时平滑 reveal。
  function navigateSelection(key: string) {
    if (!selectedNodeId) return
    const node = file.nodes[selectedNodeId]
    if (!node) return

    let targetNodeId: string | null = null
    if (key === "ArrowLeft") {
      targetNodeId = node.parentId
    } else if (key === "ArrowRight") {
      if (node.collapsed) {
        toggleCollapsed(selectedNodeId)
        return
      }
      targetNodeId = getMindMapChildren(file, selectedNodeId)[0]?.id ?? null
    } else {
      if (!node.parentId) return
      const siblings = getMindMapChildren(file, node.parentId)
      const index = siblings.findIndex(
        (sibling) => sibling.id === selectedNodeId
      )
      targetNodeId =
        siblings[index + (key === "ArrowUp" ? -1 : 1)]?.id ?? null
    }

    if (!targetNodeId) return
    selectCanvasNodes([targetNodeId], targetNodeId)
    revealNodeOnCanvas(file, targetNodeId)
  }

  // 选中态（未进入文本编辑）下的键盘操作，绑定在画布容器上；
  // textarea / 拖拽按钮等子元素的按键事件不在这里处理。
  function handleCanvasKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget || isDraggingNode) return
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || event.key === "Process") return

    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault()
      onSave?.()
      return
    }

    // ⌘0：放弃 pin/平移/缩放状态，回到全图自适应视图。
    if ((event.metaKey || event.ctrlKey) && event.key === "0") {
      event.preventDefault()
      setViewOverride(null)
      return
    }

    if (!selectedNodeId) return

    // ⌘/：折叠/展开当前节点的子树（不用裸 "/"，避免与 type-to-edit 和输入法冲突）。
    if ((event.metaKey || event.ctrlKey) && event.key === "/") {
      event.preventDefault()
      if (
        selectedNodeId !== file.rootId &&
        (childCountById.get(selectedNodeId) ?? 0) > 0
      ) {
        toggleCollapsed(selectedNodeId)
      }
      return
    }

    if (event.key === "Escape") {
      event.preventDefault()
      exitNodeEditing()
      return
    }

    if (event.key === "F2" || event.key === " ") {
      if (!canEditSelectedNode) return
      event.preventDefault()
      event.stopPropagation()
      setEditingNodeId(selectedNodeId)
      return
    }

    if (event.key.startsWith("Arrow")) {
      event.preventDefault()
      if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
        onChange(moveMindMapNode(file, selectedNodeId, event.key === "ArrowUp" ? "up" : "down"))
      } else navigateSelection(event.key)
      return
    }

    if (event.key === "Enter") {
      event.preventDefault()
      if (event.metaKey || event.ctrlKey) {
        if (selectedNodeId === file.rootId) return
        const next = addMindMapParent(file, selectedNodeId)
        onChange(next.file)
        setEditingNodeId(next.nodeId)
        onSelectNode?.(next.nodeId)
        revealNodeOnCanvas(next.file, next.nodeId)
      } else if (!event.altKey) {
        addSibling(selectedNodeId, event.shiftKey ? "before" : "after")
      }
      return
    }

    if (event.key === "Tab") {
      event.preventDefault()
      if (event.shiftKey) {
        onChange(outdentMindMapNode(file, selectedNodeId))
        onSelectNode?.(selectedNodeId)
        return
      }

      addChild(selectedNodeId)
      return
    }

    if (event.key === "Backspace" || event.key === "Delete") {
      event.preventDefault()
      // ⌘/Ctrl+Delete：只删节点本身，子节点上提（对齐 XMind / MindNode）。
      deleteSelectedNodes(event.metaKey || event.ctrlKey)
      return
    }

    // type-to-edit：选中态直接敲可打印字符 = 用该字符覆盖文本并进入编辑。
    // 显式排除空格（抓手语义）；修饰键组合已在上方各自 return；IME 不会在
    // 非可编辑容器上起组合，无需额外判断。分支保持在所有具名键之后。
    if (
      event.key.length === 1 &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      event.key !== " " &&
      canEditSelectedNode
    ) {
      event.preventDefault()
      skipSelectOnEditRef.current = true
      onChange(updateMindMapNodeText(file, selectedNodeId, event.key))
      setEditingNodeId(selectedNodeId)
    }
  }

  return (
    <ContextMenu
      onOpenChange={handleContextMenuOpenChange}
      open={contextMenuOpen}
    >
      <ContextMenuTrigger
        className={
          isDraggingNode
            ? `${styles.canvasRoot} ${styles.canvasRootDragging}`
            : styles.canvasRoot
        }
        data-mind-map-context-menu="true"
        onKeyDown={handleCanvasKeyDown}
        ref={containerRef}
        tabIndex={-1}
      >
      <svg
        aria-label="思维导图编辑器"
        className={
          canvasPanActive
            ? `${styles.canvasSvg} ${styles.canvasSvgPanning}`
            : spaceHeld
              ? `${styles.canvasSvg} ${styles.canvasSvgSpacePan}`
              : isDraggingNode
                ? `${styles.canvasSvg} ${styles.canvasSvgDragging}`
                : styles.canvasSvg
        }
        onPointerDown={startCanvasPointer}
        preserveAspectRatio="xMidYMid meet"
        role="application"
        viewBox={effectiveFit.viewBox}
      >
        {/* design-exempt: 导图画布连线是数据图形，不吃图标描边 token。 */}
        <g fill="none" stroke="var(--border-visible)" strokeWidth="1.6">
          {layout.edges.map((edge) => {
            const midX = (edge.x1 + edge.x2) / 2

            return (
              <path
                d={`M ${edge.x1} ${edge.y1} C ${midX} ${edge.y1}, ${midX} ${edge.y2}, ${edge.x2} ${edge.y2}`}
                key={edge.id}
              />
            )
          })}
        </g>

        {layout.nodes.map((layoutNode) => {
          const isRoot = layoutNode.id === file.rootId
          const selected = selectedNodeIdsSet.has(layoutNode.id)
          const dragging =
            isDraggingNode && (dragState?.nodeIds.includes(layoutNode.id) ?? false)
          const editing = isEditingSelected && layoutNode.id === selectedNodeId

          return (
            <g
              className={isRoot ? styles.textCursor : styles.grabbable}
              data-mind-map-node={layoutNode.id}
              data-tone={layoutNode.node.style?.tone ?? "default"}
              role="button"
              aria-label={`导图节点：${layoutNode.node.text || "未命名"}`}
              aria-pressed={selected}
              key={layoutNode.id}
              onClick={(event) => {
                if (suppressNodeClickRef.current) {
                  event.preventDefault()
                  suppressNodeClickRef.current = false
                  return
                }

                selectNodeFromModifierState(event, layoutNode.id)
              }}
              onDoubleClick={(event) => {
                if (suppressNodeClickRef.current) return
                event.preventDefault()
                selectCanvasNodes([layoutNode.id], layoutNode.id)
                setEditingNodeId(layoutNode.id)
              }}
              onPointerDown={(event) => startNodeDrag(event, layoutNode.id)}
              opacity={dragging ? "0.45" : "1"}
            >
              {editing ? null : (
                <>
                  {selected ? (
                    /* design-exempt: 导图画布数据图形，不吃图标描边 token。 */
                    <rect
                      fill="none"
                      height={layoutNode.height}
                      rx="8"
                      stroke="rgb(var(--shard-primary-rgb) / var(--shard-alpha-8))"
                      strokeWidth="5"
                      width={layoutNode.width}
                      x={layoutNode.x}
                      y={layoutNode.y}
                    />
                  ) : null}
                  <rect
                    className={styles.nodeShape}
                    fill={
                      isRoot
                        ? "var(--shard-accent-soft)"
                        : selected
                          ? "rgb(var(--shard-primary-rgb) / var(--shard-alpha-5))"
                          : "var(--card)"
                    }
                    height={layoutNode.height}
                    rx="6"
                    stroke={
                      selected
                        ? "rgb(var(--shard-primary-rgb) / var(--shard-alpha-34))"
                        : isRoot
                          ? "rgb(var(--shard-primary-rgb) / var(--shard-alpha-34))"
                          : "var(--border)"
                    }
                    /* design-exempt: 导图节点框是数据图形。 */
                    strokeWidth="1.2"
                    width={layoutNode.width}
                    x={layoutNode.x}
                    y={layoutNode.y}
                  />
                  {editing ? null : (
                    <MindMapCanvasNodeText
                      compact={compactText}
                      fontFamily={nodeFontFamily}
                      fill={
                        isRoot
                          ? "var(--shard-accent-text)"
                          : "var(--foreground)"
                      }
                      fontWeight={isRoot ? "600" : "500"}
                      layoutNode={layoutNode}
                    />
                  )}
                  {!isRoot && (childCountById.get(layoutNode.id) ?? 0) > 0 ? (
                    <g
                      className={styles.collapseToggle}
                      data-mind-map-collapse-toggle={layoutNode.id}
                      onClick={(event) => {
                        event.stopPropagation()
                        toggleCollapsed(layoutNode.id)
                      }}
                      onPointerDown={(event) => {
                        event.preventDefault()
                        event.stopPropagation()
                      }}
                    >
                      <title>
                        {layoutNode.node.collapsed ? "展开子节点" : "折叠子节点"}
                      </title>
                      <circle
                        className={styles.collapseToggleCircle}
                        cx={layoutNode.x + layoutNode.width}
                        cy={layoutNode.y + layoutNode.height / 2}
                        r="7"
                      />
                      {layoutNode.node.collapsed ? (
                        <text
                          className={styles.collapseToggleText}
                          fontSize="9"
                          fontWeight="600"
                          textAnchor="middle"
                          x={layoutNode.x + layoutNode.width}
                          y={
                            layoutNode.y +
                            layoutNode.height / 2 +
                            measureMindMapInkBaselineOffset(
                              nodeFontFamily ?? "",
                              9,
                              "600",
                              String(childCountById.get(layoutNode.id) ?? 0)
                            )
                          }
                        >
                          {childCountById.get(layoutNode.id) ?? 0}
                        </text>
                      ) : (
                        <line
                          className={styles.collapseToggleMinus}
                          x1={layoutNode.x + layoutNode.width - 3}
                          x2={layoutNode.x + layoutNode.width + 3}
                          y1={layoutNode.y + layoutNode.height / 2}
                          y2={layoutNode.y + layoutNode.height / 2}
                        />
                      )}
                    </g>
                  ) : null}
                </>
              )}
            </g>
          )
        })}

        {isDraggingNode && dragState?.dropTarget ? (
          <CanvasDropIndicator
            layoutNode={
              layout.nodes.find(
                (layoutNode) => layoutNode.id === dragState.dropTarget?.nodeId
              ) ?? null
            }
            mode={dragState.dropTarget.mode}
          />
        ) : null}
      </svg>

      {selectedNode &&
      selectedEditorRect &&
      selectedNode.id !== file.rootId &&
      canEditSelectedNode &&
      !isDraggingNode ? (
        <Button
          aria-label="拖拽移动节点"
          className={styles.dragHandleButton}
          onPointerDown={(event) => startNodeDrag(event, selectedNode.id)}
          size="icon-sm"
          style={{
            left: Math.max(
              8,
              selectedEditorRect.left - (32 + 6) * editorScale
            ),
            top:
              selectedEditorRect.top +
              selectedEditorRect.height / 2 -
              16 * editorScale,
            width: 32 * editorScale,
            height: 32 * editorScale,
            minWidth: 32 * editorScale,
            borderRadius: `calc(var(--shard-radius-control) * ${editorScale})`,
          }}
          title="拖拽移动节点"
          type="button"
          variant="ghost"
        >
          <MoveIcon aria-hidden="true" />
          <span className="sr-only">拖拽移动节点</span>
        </Button>
      ) : null}

      {isDraggingNode && dragState ? (
        <div
          aria-hidden="true"
          className={styles.dragPreview}
          style={{
            left: dragState.clientX,
            top: dragState.clientY,
          }}
        >
          <MoveIcon />
          <span>
            {dragState.nodeIds.length > 1
              ? `移动 ${dragState.nodeIds.length} 个节点`
              : "移动节点"}
          </span>
        </div>
      ) : null}

      {marqueeState?.active ? (
        <div
          aria-hidden="true"
          className={styles.marquee}
          data-mind-map-marquee="true"
          style={{
            height: Math.abs(marqueeState.clientY - marqueeState.startClientY),
            left:
              Math.min(marqueeState.startClientX, marqueeState.clientX) -
              marqueeState.containerLeft,
            top:
              Math.min(marqueeState.startClientY, marqueeState.clientY) -
              marqueeState.containerTop,
            width: Math.abs(marqueeState.clientX - marqueeState.startClientX),
          }}
        />
      ) : null}

      {viewOverride ? (
        <Button
          aria-label="适应屏幕"
          className={styles.fitViewButton}
          onClick={() => {
            setViewOverride(null)
            containerRef.current?.focus()
          }}
          size="icon-sm"
          title="适应屏幕（⌘0）"
          type="button"
          variant="ghost"
        >
          <Maximize2Icon aria-hidden="true" />
        </Button>
      ) : null}

      {selectedNode && selectedEditorRect && isEditingSelected ? (
        <textarea
          aria-label={selectedNode.id === file.rootId ? "根节点" : "导图节点"}
          className={styles.nodeInput}
          onChange={(event) =>
            onChange(
              updateMindMapNodeText(
                file,
                selectedNode.id,
                event.target.value
              ),
              { mergeKey: `text:${selectedNode.id}` }
            )
          }
          onKeyDown={handleNodeKeyDown}
          placeholder={selectedNode.id === file.rootId ? "中心主题" : "输入节点"}
          ref={selectedInputRef}
          rows={1}
          style={{
            ...selectedEditorRect,
            borderRadius: `calc(var(--shard-radius-card) * ${editorScale})`,
            borderWidth: `${editorBorderWidth}px`,
            fontSize: `${editorFontSize * editorScale}px`,
            lineHeight: `${editorLineHeight}px`,
            paddingBlock: `${editorPaddingBlock}px`,
            paddingInline: `${Math.max(
              0,
              13 * editorScale - editorBorderWidth
            )}px`,
          }}
          value={selectedNode.text}
        />
      ) : null}
      </ContextMenuTrigger>

      <ContextMenuContent>
        <ContextMenuItem
          disabled={!selectedNodeId || !canEditSelectedNode}
          onClick={() => {
            if (!selectedNodeId) return
            containerRef.current?.focus()
            setEditingNodeId(selectedNodeId)
          }}
        >
          编辑节点
          <ContextMenuShortcut>F2</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem
          disabled={!selectedNodeId || !canEditSelectedNode}
          onClick={() => {
            if (selectedNodeId) addChild(selectedNodeId)
          }}
        >
          添加子节点
          <ContextMenuShortcut>Tab</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem
          disabled={!selectedNodeId || !canEditSelectedNode}
          onClick={() => {
            if (selectedNodeId) addSibling(selectedNodeId)
          }}
        >
          添加同级节点
          <ContextMenuShortcut>Enter</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem
          disabled={
            !selectedNodeId ||
            selectedNodeId === file.rootId ||
            (childCountById.get(selectedNodeId ?? "") ?? 0) === 0
          }
          onClick={() => {
            if (selectedNodeId) toggleCollapsed(selectedNodeId)
          }}
        >
          {selectedNodeId && file.nodes[selectedNodeId]?.collapsed
            ? "展开子节点"
            : "折叠子节点"}
          <ContextMenuShortcut>⌘/</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          disabled={contextMenuMovableCount === 0}
          onClick={() => deleteSelectedNodes(true)}
        >
          {contextMenuSelectionCount > 1
            ? `仅删除 ${contextMenuSelectionCount} 个节点（子节点上提）`
            : "仅删除节点（子节点上提）"}
          <ContextMenuShortcut>⌘⌫</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem
          disabled={contextMenuMovableCount === 0}
          onClick={() => deleteSelectedNodes(false)}
          variant="destructive"
        >
          {contextMenuSelectionCount > 1
            ? `删除 ${contextMenuSelectionCount} 个节点及子节点`
            : "删除节点及子节点"}
          <ContextMenuShortcut>Delete</ContextMenuShortcut>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

function MindMapCanvasNodeText({
  compact,
  fill,
  fontFamily,
  fontWeight,
  layoutNode,
}: {
  compact: boolean
  fill: string
  fontFamily: string | null
  fontWeight: string
  layoutNode: MindMapLayoutNode
}) {
  const fontSize = compact ? 11 : 13
  const lineHeight = compact ? 14 : 18
  const lines =
    layoutNode.textLines.length > 0 ? layoutNode.textLines : ["未命名"]
  const startY =
    layoutNode.y +
    layoutNode.height / 2 -
    ((lines.length - 1) * lineHeight) / 2

  // 不依赖 dominant-baseline（WKWebView 不生效）：每行 tspan 直接给出基线 y，
  // 基线 = 行中心 + 该行文本的实测墨盒偏移，保证所有节点垂直居中方式一致。
  return (
    <text
      fill={fill}
      fontSize={fontSize}
      fontWeight={fontWeight}
      letterSpacing="0"
      pointerEvents="none"
    >
      {lines.map((line, index) => (
        <tspan
          key={`${line}-${index}`}
          x={layoutNode.x + 13}
          y={
            startY +
            index * lineHeight +
            measureMindMapInkBaselineOffset(
              fontFamily ?? "",
              fontSize,
              fontWeight,
              line
            )
          }
        >
          {line}
        </tspan>
      ))}
    </text>
  )
}

function CanvasDropIndicator({
  layoutNode,
  mode,
}: {
  layoutNode: MindMapLayoutNode | null
  mode: MindMapDropMode
}) {
  if (!layoutNode) return null

  if (mode === "inside") {
    return (
      <g pointerEvents="none">
        {/* design-exempt: 导图画布数据图形，不吃图标描边 token。 */}
        <rect
          fill="rgb(var(--shard-primary-rgb) / var(--shard-alpha-8))"
          height={layoutNode.height + 8}
          rx="9"
          stroke={DROP_INDICATOR_COLOR}
          strokeWidth="2"
          width={layoutNode.width + 8}
          x={layoutNode.x - 4}
          y={layoutNode.y - 4}
        />
        <circle
          cx={layoutNode.x - 4}
          cy={layoutNode.y + layoutNode.height / 2}
          fill={DROP_INDICATOR_COLOR}
          r="3"
        />
      </g>
    )
  }

  const y =
    mode === "before" ? layoutNode.y - 7 : layoutNode.y + layoutNode.height + 7

  return (
    <g pointerEvents="none">
      {/* design-exempt: 导图画布数据图形，不吃图标描边 token。 */}
      <line
        stroke={DROP_INDICATOR_COLOR}
        strokeLinecap="round"
        strokeWidth="3"
        x1={layoutNode.x + 4}
        x2={layoutNode.x + layoutNode.width - 4}
        y1={y}
        y2={y}
      />
      <circle
        cx={layoutNode.x + 4}
        cy={y}
        fill={DROP_INDICATOR_COLOR}
        r="3"
      />
      <circle
        cx={layoutNode.x + layoutNode.width - 4}
        cy={y}
        fill={DROP_INDICATOR_COLOR}
        r="3"
      />
    </g>
  )
}

// 非根节点的 pointerdown 已在节点上 stopPropagation，但根节点和连线会冒泡到 svg，
// 所以这里按节点标记判断这次按下是否真的落在空白画布上。
function isCanvasBackgroundTarget(target: EventTarget | null) {
  if (!(target instanceof Element)) return false
  return target.closest("[data-mind-map-node]") === null
}

function getCanvasDropTarget(
  file: ShardMapFile,
  layoutNodes: MindMapLayoutNode[],
  fit: ReturnType<typeof fitMindMapLayout>,
  container: HTMLDivElement | null,
  sourceNodeIds: string[],
  clientX: number,
  clientY: number
): MindMapDropTarget | null {
  const point = getMindMapPointFromClient(container, fit, clientX, clientY)
  if (!point) return null

  const targetNode = findCanvasTargetNode(layoutNodes, point)
  if (!targetNode) return null

  const target = {
    mode: getCanvasDropMode(targetNode, point.y, file.rootId),
    nodeId: targetNode.id,
  }

  return canMoveMindMapNodesToTarget(file, sourceNodeIds, target) ? target : null
}

function getMindMapPointFromClient(
  container: HTMLDivElement | null,
  fit: ReturnType<typeof fitMindMapLayout>,
  clientX: number,
  clientY: number
): MindMapPoint | null {
  if (!container) return null

  const rect = container.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return null

  return {
    x: fit.x + ((clientX - rect.left) / rect.width) * fit.width,
    y: fit.y + ((clientY - rect.top) / rect.height) * fit.height,
  }
}

function findCanvasTargetNode(
  layoutNodes: MindMapLayoutNode[],
  point: MindMapPoint
) {
  for (let index = layoutNodes.length - 1; index >= 0; index -= 1) {
    const layoutNode = layoutNodes[index]
    if (
      point.x >= layoutNode.x &&
      point.x <= layoutNode.x + layoutNode.width &&
      point.y >= layoutNode.y &&
      point.y <= layoutNode.y + layoutNode.height
    ) {
      return layoutNode
    }
  }

  return null
}

function getCanvasDropMode(
  layoutNode: MindMapLayoutNode,
  pointerY: number,
  rootId: string
): MindMapDropMode {
  if (layoutNode.id === rootId) return "inside"

  const offsetY = pointerY - layoutNode.y
  if (offsetY < layoutNode.height * 0.28) return "before"
  if (offsetY > layoutNode.height * 0.72) return "after"
  return "inside"
}

function readCanvasSession(
  saved: MindMapCanvasSessionState | null | undefined,
  fileId: string
): CanvasViewState | null {
  if (!saved || saved.fileId !== fileId || !Number.isFinite(saved.scale) ||
    !Number.isFinite(saved.x) || !Number.isFinite(saved.y) || saved.scale <= 0) return null
  // 自动适应大型导图的比例可小于手动缩放下限，恢复时不能把它放大。
  return { scale: saved.scale, x: saved.x, y: saved.y }
}

function viewStateToFit(
  view: CanvasViewState,
  size: { height: number; width: number }
): ReturnType<typeof fitMindMapLayout> {
  const width = size.width / view.scale
  const height = size.height / view.scale

  return {
    height,
    scale: view.scale,
    viewBox: `${view.x} ${view.y} ${width} ${height}`,
    width,
    x: view.x,
    y: view.y,
  }
}

function getScreenNodeRect(
  node: MindMapLayoutNode,
  fit: ReturnType<typeof fitMindMapLayout>
) {
  const left = (node.x - fit.x) * fit.scale
  const top = (node.y - fit.y) * fit.scale
  const width = node.width * fit.scale
  const height = node.height * fit.scale

  return {
    height,
    left,
    top,
    width,
  }
}

function getRangeNodeIds(
  visibleNodeIds: string[],
  anchorNodeId: string,
  targetNodeId: string
) {
  const anchorIndex = visibleNodeIds.indexOf(anchorNodeId)
  const targetIndex = visibleNodeIds.indexOf(targetNodeId)
  if (anchorIndex < 0 || targetIndex < 0) return [targetNodeId]

  const start = Math.min(anchorIndex, targetIndex)
  const end = Math.max(anchorIndex, targetIndex)
  return visibleNodeIds.slice(start, end + 1)
}

function getUniqueExistingNodeIds(file: ShardMapFile, nodeIds: string[]) {
  const nextNodeIds: string[] = []
  const seen = new Set<string>()

  for (const nodeId of nodeIds) {
    if (seen.has(nodeId) || !file.nodes[nodeId]) continue
    seen.add(nodeId)
    nextNodeIds.push(nodeId)
  }

  return nextNodeIds
}

function clamp(value: number, min: number, max: number) {
  if (max < min) return min
  return Math.min(Math.max(value, min), max)
}
