import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react"
import { GripVerticalIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  fitMindMapLayout,
  layoutMindMap,
  shouldUseCompactMindMapText,
  type MindMapLayoutNode,
} from "@/lib/mind-map-layout"
import {
  addMindMapChild,
  addMindMapSibling,
  canMoveMindMapNodesToTarget,
  deleteMindMapNode,
  getMovableMindMapNodeIds,
  type MindMapDropMode,
  type MindMapDropTarget,
  moveMindMapNodesToTarget,
  outdentMindMapNode,
  updateMindMapNodeText,
} from "@/lib/mind-map-tree"
import type { ShardMapFile } from "@/types"

interface MindMapCanvasEditorProps {
  file: ShardMapFile
  onChange: (file: ShardMapFile) => void
  onSave?: () => void
  onSelectNode?: (nodeId: string) => void
  onSelectNodes?: (nodeIds: string[], primaryNodeId: string | null) => void
  selectedNodeId: string | null
  selectedNodeIds: string[]
}

interface CanvasDragState {
  active: boolean
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

const CANVAS_DRAG_THRESHOLD_PX = 4
const DROP_INDICATOR_COLOR =
  "rgb(var(--shard-primary-rgb) / var(--shard-alpha-55))"

export function MindMapCanvasEditor({
  file,
  onChange,
  onSave,
  onSelectNode,
  onSelectNodes,
  selectedNodeId,
  selectedNodeIds,
}: MindMapCanvasEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const selectedInputRef = useRef<HTMLInputElement | null>(null)
  const dragStateRef = useRef<CanvasDragState | null>(null)
  const suppressNodeClickRef = useRef(false)
  const [size, setSize] = useState({ height: 720, width: 980 })
  const [dragState, setDragState] = useState<CanvasDragState | null>(null)
  const layout = useMemo(
    () =>
      layoutMindMap(file, {
        horizontalGap: 96,
        nodeHeight: 48,
        nodeWidth: 190,
        verticalGap: 22,
      }),
    [file]
  )
  const fit = useMemo(
    () => fitMindMapLayout(layout, size.width, size.height, 56),
    [layout, size.height, size.width]
  )
  const compactText = shouldUseCompactMindMapText(layout, fit.scale)
  const selectedNodeIdsSet = useMemo(
    () => new Set(selectedNodeIds.filter((nodeId) => file.nodes[nodeId])),
    [file.nodes, selectedNodeIds]
  )
  const visibleNodeIds = useMemo(
    () => layout.nodes.map((layoutNode) => layoutNode.id),
    [layout.nodes]
  )
  const selectedNode = selectedNodeId ? file.nodes[selectedNodeId] : null
  const selectedLayoutNode = selectedNodeId
    ? layout.nodes.find((node) => node.id === selectedNodeId) ?? null
    : null
  const selectedEditorRect =
    selectedLayoutNode && selectedNode
      ? getScreenNodeRect(selectedLayoutNode, fit, size)
      : null
  const hasDragSession = dragState !== null
  const isDraggingNode = dragState?.active ?? false
  const canEditSelectedNode = selectedNodeIdsSet.size <= 1

  useEffect(() => {
    const element = containerRef.current
    if (!element) return

    const observer = new ResizeObserver(([entry]) => {
      setSize({
        height: Math.max(1, entry.contentRect.height),
        width: Math.max(1, entry.contentRect.width),
      })
    })
    observer.observe(element)

    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (isDraggingNode) return
    if (!canEditSelectedNode) return

    requestAnimationFrame(() => {
      selectedInputRef.current?.focus()
      selectedInputRef.current?.select()
    })
  }, [canEditSelectedNode, isDraggingNode, selectedNodeId])

  useEffect(() => {
    if (!hasDragSession) return

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
            fit,
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
    file,
    fit,
    hasDragSession,
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

  function addChild(nodeId: string) {
    const next = addMindMapChild(file, nodeId)
    onChange(next.file)
    onSelectNode?.(next.nodeId)
  }

  function addSibling(nodeId: string) {
    const next = addMindMapSibling(file, nodeId)
    onChange(next.file)
    onSelectNode?.(next.nodeId)
  }

  function deleteSelectedNode(nodeId: string) {
    const next = deleteMindMapNode(file, nodeId)
    onChange(next.file)
    onSelectNode?.(next.focusNodeId)
  }

  function startNodeDrag(
    event: ReactPointerEvent<HTMLElement | SVGGElement>,
    nodeId: string
  ) {
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

  function handleNodeKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (!selectedNodeId || !selectedNode) return

    const nativeEvent = event.nativeEvent
    const isComposing =
      nativeEvent.isComposing ||
      event.key === "Process" ||
      nativeEvent.keyCode === 229
    if (isComposing) return

    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault()
      onSave?.()
      return
    }

    if (
      event.key === "Enter" &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.shiftKey
    ) {
      event.preventDefault()
      addSibling(selectedNodeId)
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
      deleteSelectedNode(selectedNodeId)
    }
  }

  return (
    <div
      className="relative min-h-0 flex-1 overflow-hidden bg-white"
      ref={containerRef}
    >
      <svg
        aria-label="思维导图编辑器"
        className="block size-full bg-white"
        preserveAspectRatio="xMidYMid meet"
        role="application"
        viewBox={fit.viewBox}
      >
        <g fill="none" stroke="var(--border)" strokeWidth="1.45">
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

          return (
            <g
              className={
                isRoot ? "cursor-text" : "cursor-grab active:cursor-grabbing"
              }
              key={layoutNode.id}
              onClick={(event) => {
                if (suppressNodeClickRef.current) {
                  event.preventDefault()
                  suppressNodeClickRef.current = false
                  return
                }

                selectNodeFromModifierState(event, layoutNode.id)
              }}
              onPointerDown={(event) => startNodeDrag(event, layoutNode.id)}
              opacity={dragging ? "0.45" : "1"}
            >
              {selected ? (
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
                strokeWidth="1.2"
                width={layoutNode.width}
                x={layoutNode.x}
                y={layoutNode.y}
              />
              {selected ? null : (
                <text
                  dominantBaseline="middle"
                  dy="0.08em"
                  fill={isRoot ? "var(--shard-accent-text)" : "var(--foreground)"}
                  fontSize={compactText ? "11" : "13"}
                  fontWeight={isRoot ? "600" : "500"}
                  letterSpacing="0"
                  pointerEvents="none"
                  x={layoutNode.x + 13}
                  y={layoutNode.y + layoutNode.height / 2}
                >
                  {truncateNodeText(layoutNode.node.text, compactText)}
                </text>
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
          className="absolute z-20 cursor-grab bg-white/95 text-muted-foreground shadow-sm active:cursor-grabbing"
          onPointerDown={(event) => startNodeDrag(event, selectedNode.id)}
          size="icon-xs"
          static
          style={{
            left: Math.max(8, selectedEditorRect.left - 30),
            top: selectedEditorRect.top + selectedEditorRect.height / 2 - 12,
          }}
          title="拖拽移动节点"
          type="button"
          variant="outline"
        >
          <GripVerticalIcon />
        </Button>
      ) : null}

      {selectedNode && selectedEditorRect && canEditSelectedNode && !isDraggingNode ? (
        <input
          aria-label={selectedNode.id === file.rootId ? "根节点" : "导图节点"}
          className="absolute z-10 rounded-[var(--shard-radius-card)] border border-[rgb(var(--shard-primary-rgb)/var(--shard-alpha-34))] bg-white/95 px-3 text-sm font-medium text-foreground outline-none transition-[border-color,box-shadow] duration-150 ease-out focus-visible:border-[rgb(var(--shard-primary-rgb)/var(--shard-alpha-55))]"
          onChange={(event) =>
            onChange(
              updateMindMapNodeText(file, selectedNode.id, event.target.value)
            )
          }
          onKeyDown={handleNodeKeyDown}
          placeholder={selectedNode.id === file.rootId ? "中心主题" : "输入节点"}
          ref={selectedInputRef}
          style={{
            ...selectedEditorRect,
            boxShadow:
              "0 0 0 3px rgb(var(--shard-primary-rgb) / var(--shard-alpha-8)), 0 10px 24px -20px rgb(var(--shard-ink-rgb) / var(--shard-alpha-34))",
            lineHeight: `${Math.max(1, selectedEditorRect.height - 2)}px`,
          }}
          value={selectedNode.text}
        />
      ) : null}
    </div>
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
      <rect
        fill="none"
        height={layoutNode.height + 8}
        pointerEvents="none"
        rx="9"
        stroke={DROP_INDICATOR_COLOR}
        strokeDasharray="5 5"
        strokeWidth="2"
        width={layoutNode.width + 8}
        x={layoutNode.x - 4}
        y={layoutNode.y - 4}
      />
    )
  }

  const y =
    mode === "before" ? layoutNode.y - 7 : layoutNode.y + layoutNode.height + 7

  return (
    <line
      pointerEvents="none"
      stroke={DROP_INDICATOR_COLOR}
      strokeLinecap="round"
      strokeWidth="3"
      x1={layoutNode.x + 4}
      x2={layoutNode.x + layoutNode.width - 4}
      y1={y}
      y2={y}
    />
  )
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

function getScreenNodeRect(
  node: MindMapLayoutNode,
  fit: ReturnType<typeof fitMindMapLayout>,
  size: { height: number; width: number }
) {
  const left = (node.x - fit.x) * fit.scale
  const top = (node.y - fit.y) * fit.scale
  const width = Math.max(180, node.width * fit.scale)
  const height = Math.max(38, node.height * fit.scale)
  const centerX = left + (node.width * fit.scale) / 2
  const centerY = top + (node.height * fit.scale) / 2

  return {
    height,
    left: clamp(centerX - width / 2, 12, Math.max(12, size.width - width - 12)),
    top: clamp(centerY - height / 2, 12, Math.max(12, size.height - height - 12)),
    width,
  }
}

function truncateNodeText(value: string, compact: boolean) {
  const text = value.trim() || "未命名"
  const limit = compact ? 12 : 20

  return text.length > limit ? `${text.slice(0, limit)}...` : text
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
