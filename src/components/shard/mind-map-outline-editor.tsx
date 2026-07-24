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
import { TextInput } from "@astryxdesign/core/TextInput"
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
    <div className="min-h-0 flex-1 overflow-y-auto bg-background p-[var(--shard-space-5)]">
      <div className="mx-auto flex max-w-4xl flex-col gap-[var(--shard-space-1)]">
        {rows.map(({ node, depth }) => {
          const isRoot = node.id === file.rootId
          const selected = selectedNodeId === node.id
          const activeDropMode =
            dropTarget?.nodeId === node.id ? dropTarget.mode : null

          return (
            <div
              className={[
                "group grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-[var(--shard-space-2)] rounded-[var(--shard-radius-control)] py-1 pr-1 transition-colors",
                activeDropMode === "inside" || selected
                  ? "bg-[var(--shard-accent-soft)]"
                  : "hover:bg-muted/70",
                draggingNodeId === node.id ? "opacity-50" : "",
              ].join(" ")}
              key={node.id}
              onDragLeave={(event) => handleDragLeave(event, node.id)}
              onDragOver={(event) => handleDragOver(event, node.id)}
              onDrop={(event) => handleDrop(event, node.id)}
              style={{
                boxShadow: getOutlineDropShadow(activeDropMode),
                paddingLeft: `${Math.min(depth, 10) * 22}px`,
              }}
            >
              <div className="flex min-w-0 items-center gap-[var(--shard-space-2)]">
                {isRoot ? (
                  <span aria-hidden="true" className="size-6 shrink-0" />
                ) : (
                  <Button
                    aria-grabbed={draggingNodeId === node.id}
                    className="-ml-1 cursor-grab text-muted-foreground opacity-0 active:cursor-grabbing group-focus-within:opacity-100 group-hover:opacity-100"
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
                  className={[
                    "size-1.5 shrink-0 rounded-full",
                    isRoot ? "bg-primary" : "bg-muted-foreground/45",
                  ].join(" ")}
                />
                <div className="min-w-0 flex-1">
                  <TextInput
                    className="border-transparent bg-transparent shadow-none focus-visible:border-border"
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
                    value={node.text}
                  />
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
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
      </div>
    </div>
  )
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
