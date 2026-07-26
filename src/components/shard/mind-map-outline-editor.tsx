import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
} from "react"
import {
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowUpIcon,
  GripVerticalIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react"

import { Button } from "@astryxdesign/core/Button"
import { Stack } from "@astryxdesign/core/Stack"
import { TextInput } from "@astryxdesign/core/TextInput"

import { cn } from "@/lib/utils"
import styles from "./mind-map-outline-editor.module.css"
import {
  addMindMapChild,
  addMindMapSibling,
  canMoveMindMapNodeToTarget,
  deleteMindMapNode,
  getMindMapRows,
  indentMindMapNode,
  type MindMapDropMode,
  type MindMapDropTarget,
  moveMindMapNode,
  moveMindMapNodeToTarget,
  outdentMindMapNode,
  updateMindMapNodeText,
} from "@/lib/mind-map-tree"
import type { ShardMapFile } from "@/types"

interface MindMapOutlineEditorProps {
  file: ShardMapFile
  focusNodeId?: string | null
  onChange: (file: ShardMapFile) => void
  onFocusHandled?: () => void
  onSave?: () => void
  onSelectNode?: (nodeId: string) => void
  selectedNodeId?: string | null
}

const NODE_DRAG_MIME_TYPE = "application/x-shard-mind-map-node"
const DROP_INDICATOR_COLOR =
  "rgb(var(--shard-primary-rgb) / var(--shard-alpha-55))"
const OUTLINE_INDENT_PX = 22
// 与实测的 bullet 圆点水平中心对齐(拖拽把手宽度 + gap + 半个圆点直径)。
const OUTLINE_GUIDE_LINE_OFFSET_PX = 35

export function MindMapOutlineEditor({
  file,
  focusNodeId = null,
  onChange,
  onFocusHandled,
  onSave,
  onSelectNode,
  selectedNodeId = null,
}: MindMapOutlineEditorProps) {
  const inputRefs = useRef<Record<string, HTMLInputElement | null>>({})
  const draggingNodeIdRef = useRef<string | null>(null)
  const [draggingNodeId, setDraggingNodeId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<MindMapDropTarget | null>(null)
  const rows = useMemo(() => getMindMapRows(file), [file])

  useEffect(() => {
    if (!focusNodeId) return

    requestAnimationFrame(() => {
      inputRefs.current[focusNodeId]?.focus()
      inputRefs.current[focusNodeId]?.select()
      onFocusHandled?.()
    })
  }, [focusNodeId, onFocusHandled, rows])

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

  function deleteNode(nodeId: string) {
    const next = deleteMindMapNode(file, nodeId)
    onChange(next.file)
    onSelectNode?.(next.focusNodeId)
  }

  function clearDragState() {
    draggingNodeIdRef.current = null
    setDraggingNodeId(null)
    setDropTarget(null)
  }

  function handleDragStart(
    event: DragEvent<HTMLButtonElement>,
    nodeId: string
  ) {
    if (nodeId === file.rootId) {
      event.preventDefault()
      return
    }

    draggingNodeIdRef.current = nodeId
    setDraggingNodeId(nodeId)
    event.dataTransfer.effectAllowed = "move"
    event.dataTransfer.setData(NODE_DRAG_MIME_TYPE, nodeId)
    event.dataTransfer.setData("text/plain", nodeId)
  }

  function handleDragOver(event: DragEvent<HTMLDivElement>, targetNodeId: string) {
    const sourceNodeId = draggingNodeIdRef.current
    if (!sourceNodeId) return

    const target = getOutlineDropTarget(event, targetNodeId, file.rootId)
    if (!canMoveMindMapNodeToTarget(file, sourceNodeId, target)) {
      if (dropTarget?.nodeId === targetNodeId) {
        setDropTarget(null)
      }
      return
    }

    event.preventDefault()
    event.dataTransfer.dropEffect = "move"
    setDropTarget(target)
  }

  function handleDragLeave(
    event: DragEvent<HTMLDivElement>,
    targetNodeId: string
  ) {
    const relatedTarget = event.relatedTarget
    if (relatedTarget instanceof Node && event.currentTarget.contains(relatedTarget)) {
      return
    }

    if (dropTarget?.nodeId === targetNodeId) {
      setDropTarget(null)
    }
  }

  function handleDrop(event: DragEvent<HTMLDivElement>, targetNodeId: string) {
    const sourceNodeId =
      draggingNodeIdRef.current ||
      event.dataTransfer.getData(NODE_DRAG_MIME_TYPE) ||
      event.dataTransfer.getData("text/plain")
    if (!sourceNodeId) return

    const target = getOutlineDropTarget(event, targetNodeId, file.rootId)
    if (!canMoveMindMapNodeToTarget(file, sourceNodeId, target)) {
      clearDragState()
      return
    }

    event.preventDefault()
    onChange(moveMindMapNodeToTarget(file, sourceNodeId, target))
    onSelectNode?.(sourceNodeId)
    clearDragState()
  }

  function handleKeyDown(
    event: KeyboardEvent<HTMLInputElement>,
    nodeId: string
  ) {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault()
      onSave?.()
      return
    }

    if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      event.preventDefault()
      addSibling(nodeId)
      return
    }

    if (event.key === "Tab") {
      event.preventDefault()
      if (event.shiftKey) {
        onChange(outdentMindMapNode(file, nodeId))
        onSelectNode?.(nodeId)
        return
      }

      addChild(nodeId)
      return
    }

    if (
      event.key === "Backspace" &&
      event.currentTarget.value === "" &&
      nodeId !== file.rootId
    ) {
      event.preventDefault()
      deleteNode(nodeId)
    }
  }

  return (
    <div
      style={{
        minHeight: 0,
        flex: "1 1 auto",
        overflowY: "auto",
        background: "var(--background)",
        padding: "var(--shard-space-5)",
      }}
    >
      <Stack gap={1} maxWidth={896} style={{ marginInline: "auto" }}>
        {rows.map(({ node, depth }, index) => {
          const isRoot = node.id === file.rootId
          const selected = selectedNodeId === node.id
          const activeDropMode =
            dropTarget?.nodeId === node.id ? dropTarget.mode : null

          return (
            <div
              className={cn(
                styles.row,
                (activeDropMode === "inside" || selected) && styles.rowActive,
                draggingNodeId === node.id && styles.rowDragging
              )}
              key={node.id}
              onDragLeave={(event) => handleDragLeave(event, node.id)}
              onDragOver={(event) => handleDragOver(event, node.id)}
              onDrop={(event) => handleDrop(event, node.id)}
              style={{
                boxShadow: getOutlineDropShadow(activeDropMode),
                paddingLeft: `${Math.min(depth, 10) * 22}px`,
              }}
            >
              {Array.from({ length: Math.min(depth, 10) }, (_, level) => {
                const guideDepth = level + 1
                const isOwnDepth = guideDepth === depth
                const branchActive = isOutlineBranchActiveAtDepth(
                  rows,
                  index,
                  guideDepth
                )

                return (
                  <span
                    aria-hidden="true"
                    className={styles.guideLine}
                    key={guideDepth}
                    style={{
                      height: isOwnDepth && !branchActive ? "50%" : "100%",
                      left: `${guideDepth * OUTLINE_INDENT_PX + OUTLINE_GUIDE_LINE_OFFSET_PX}px`,
                    }}
                  />
                )
              })}
              <div className={styles.rowMain}>
                {isRoot ? (
                  <span aria-hidden="true" style={{ width: 24, height: 24, flexShrink: 0 }} />
                ) : (
                  <Button
                    aria-grabbed={draggingNodeId === node.id}
                    className={styles.dragHandle}
                    draggable
                    icon={<GripVerticalIcon />}
                    isIconOnly
                    label="拖拽移动节点"
                    onDragEnd={clearDragState}
                    onDragStart={(event) => handleDragStart(event, node.id)}
                    size="sm"
                    tooltip="拖拽移动节点"
                    type="button"
                    variant="ghost"
                  />
                )}
                <span
                  aria-hidden="true"
                  style={{
                    width: 6,
                    height: 6,
                    flexShrink: 0,
                    borderRadius: 9999,
                    background: isRoot
                      ? "var(--primary)"
                      : "color-mix(in oklab, var(--muted-foreground) 45%, transparent)",
                  }}
                />
                <div style={{ minWidth: 0, flex: "1 1 auto" }}>
                  <TextInput
                    className={styles.nodeInputFocusRing}
                    isLabelHidden
                    label={isRoot ? "根节点" : "导图节点"}
                    onChange={(value) =>
                      onChange(updateMindMapNodeText(file, node.id, value))
                    }
                    onFocus={() => onSelectNode?.(node.id)}
                    onKeyDown={(event) => handleKeyDown(event, node.id)}
                    placeholder={isRoot ? "根节点" : "输入分支"}
                    ref={(element) => {
                      inputRefs.current[node.id] = element
                    }}
                    style={{
                      borderColor: "transparent",
                      background: "transparent",
                      boxShadow: "none",
                    }}
                    value={node.text}
                  />
                </div>
              </div>
              <div className={styles.actionsRow}>
                <Button
                  icon={<PlusIcon />}
                  isIconOnly
                  label="添加子节点"
                  onClick={() => addChild(node.id)}
                  size="sm"
                  type="button"
                  variant="ghost"
                />
                <Button
                  icon={<ArrowUpIcon />}
                  isDisabled={isRoot}
                  isIconOnly
                  label="上移"
                  onClick={() => onChange(moveMindMapNode(file, node.id, "up"))}
                  size="sm"
                  type="button"
                  variant="ghost"
                />
                <Button
                  icon={<ArrowDownIcon />}
                  isDisabled={isRoot}
                  isIconOnly
                  label="下移"
                  onClick={() => onChange(moveMindMapNode(file, node.id, "down"))}
                  size="sm"
                  type="button"
                  variant="ghost"
                />
                <Button
                  icon={<ArrowRightIcon />}
                  isDisabled={isRoot}
                  isIconOnly
                  label="缩进"
                  onClick={() => {
                    onChange(indentMindMapNode(file, node.id))
                    onSelectNode?.(node.id)
                  }}
                  size="sm"
                  type="button"
                  variant="ghost"
                />
                <Button
                  icon={<ArrowLeftIcon />}
                  isDisabled={isRoot}
                  isIconOnly
                  label="反缩进"
                  onClick={() => {
                    onChange(outdentMindMapNode(file, node.id))
                    onSelectNode?.(node.id)
                  }}
                  size="sm"
                  type="button"
                  variant="ghost"
                />
                <Button
                  icon={<Trash2Icon />}
                  isDisabled={isRoot}
                  isIconOnly
                  label="删除节点"
                  onClick={() => deleteNode(node.id)}
                  size="sm"
                  type="button"
                  variant="ghost"
                />
              </div>
            </div>
          )
        })}
      </Stack>
    </div>
  )
}

function isOutlineBranchActiveAtDepth(
  rows: { depth: number }[],
  index: number,
  depth: number
) {
  for (let cursor = index + 1; cursor < rows.length; cursor += 1) {
    if (rows[cursor].depth <= depth) {
      return rows[cursor].depth === depth
    }
  }

  return false
}

function getOutlineDropTarget(
  event: DragEvent<HTMLDivElement>,
  nodeId: string,
  rootId: string
): MindMapDropTarget {
  return {
    mode: getOutlineDropMode(event, nodeId, rootId),
    nodeId,
  }
}

function getOutlineDropMode(
  event: DragEvent<HTMLDivElement>,
  nodeId: string,
  rootId: string
): MindMapDropMode {
  if (nodeId === rootId) return "inside"

  const rect = event.currentTarget.getBoundingClientRect()
  const offsetY = event.clientY - rect.top

  if (offsetY < rect.height * 0.28) return "before"
  if (offsetY > rect.height * 0.72) return "after"
  return "inside"
}

function getOutlineDropShadow(mode: MindMapDropMode | null) {
  if (mode === "before") return `inset 0 2px 0 ${DROP_INDICATOR_COLOR}`
  if (mode === "after") return `inset 0 -2px 0 ${DROP_INDICATOR_COLOR}`
  return undefined
}
