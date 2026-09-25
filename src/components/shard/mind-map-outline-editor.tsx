import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type ComponentProps,
  type RefObject,
} from "react"
import {
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowUpIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  FileTextIcon,
  Maximize2Icon,
  MoreHorizontalIcon,
  MoveIcon,
  PencilLineIcon,
  PlusIcon,
  Trash2Icon,
} from "@/components/icons"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

import { cn } from "@/lib/utils"
import styles from "./mind-map-outline-editor.module.css"
import {
  addMindMapChild,
  addMindMapSibling,
  canMoveMindMapNodeToTarget,
  deleteMindMapNode,
  getMindMapChildren,
  getMindMapRows,
  indentMindMapNode,
  type MindMapChangeMeta,
  type MindMapDropMode,
  type MindMapDropTarget,
  moveMindMapNode,
  moveMindMapNodeToTarget,
  outdentMindMapNode,
  toggleMindMapNodeCollapsed,
  updateMindMapNodeText,
  updateMindMapNodeNote,
} from "@/lib/mind-map-tree"
import type { ShardMapFile } from "@/types"

export interface MindMapOutlineEditorProps {
  /** 紧凑档：嵌在编辑器围栏 widget 里，去掉全高滚动与文档级排版，并禁用描述入口。 */
  compact?: boolean
  file: ShardMapFile
  focusNodeId?: string | null
  onChange: (file: ShardMapFile, meta?: MindMapChangeMeta) => void
  /** 紧凑档下 Escape 的去处：把焦点交还给宿主编辑器。 */
  onExit?: () => void
  onFocusHandled?: () => void
  onSave?: () => void
  onSelectNode?: (nodeId: string) => void
  selectedNodeId?: string | null
  sessionStateRef?: RefObject<MindMapOutlineSessionState | null>
}

export interface MindMapOutlineSessionState {
  fileId: string
  scrollTop: number
  selectedNodeId: string | null
  focusedNodeId: string | null
  selectionStart: number
  selectionEnd: number
  selectionDirection: "forward" | "backward" | "none"
  focusRootId?: string
  focusedField?: "text" | "note"
}

type OutlineFocusRequest = { nodeId: string; atStart: boolean; field?: "text" | "note";
  start?: number; end?: number; direction?: "forward" | "backward" | "none" }

const NODE_DRAG_MIME_TYPE = "application/x-shard-mind-map-node"
const DROP_INDICATOR_COLOR =
  "rgb(var(--shard-primary-rgb) / var(--shard-alpha-55))"

export function MindMapOutlineEditor({
  compact = false,
  file,
  focusNodeId = null,
  onChange,
  onExit,
  onFocusHandled,
  onSave,
  onSelectNode,
  selectedNodeId = null,
  sessionStateRef,
}: MindMapOutlineEditorProps) {
  const inputRefs = useRef<Record<string, HTMLTextAreaElement | null>>({})
  const noteRefs = useRef<Record<string, HTMLTextAreaElement | null>>({})
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const outlineId = useId()
  const [focusRequest, setFocusRequest] = useState<OutlineFocusRequest | null>(null)
  const [editingNoteId, setEditingNoteId] = useState<string | null>(() => sessionStateRef?.current?.fileId === file.id
    && sessionStateRef.current.focusedField === "note" ? sessionStateRef.current.focusedNodeId : null)
  const [subtreeRootId, setSubtreeRootId] = useState(() => {
    const savedRoot = sessionStateRef?.current?.fileId === file.id ? sessionStateRef.current.focusRootId : null
    return savedRoot && file.nodes[savedRoot] && (!selectedNodeId || isInOutlineScope(file, selectedNodeId, savedRoot)) ? savedRoot : file.rootId
  })
  const focusRootId = file.nodes[subtreeRootId] ? subtreeRootId : file.rootId
  const subtreeScrollRef = useRef<Record<string, number>>({})
  const pendingSubtreeScrollRef = useRef<number | null>(null)
  const suppressBulletClickRef = useRef(false)
  const draggingNodeIdRef = useRef<string | null>(null)
  const [draggingNodeId, setDraggingNodeId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<MindMapDropTarget | null>(null)
  const [openMenuNodeId, setOpenMenuNodeId] = useState<string | null>(null)
  const menuSessionRef = useRef<{
    nodeId: string; input: HTMLTextAreaElement | null; start: number; end: number;
    direction: "forward" | "backward" | "none"; closeReason?: string
    focusRootOnClose?: string
  } | null>(null)
  const rows = useMemo(() => getMindMapRows({ ...file, rootId: focusRootId }), [file, focusRootId])
  const ancestors = useMemo(() => {
    const result = []
    let parentId = file.nodes[focusRootId]?.parentId
    while (parentId && file.nodes[parentId]) { result.unshift(file.nodes[parentId]); parentId = file.nodes[parentId].parentId }
    return result
  }, [file, focusRootId])
  const previousRowsRef = useRef(rows)
  const lastFocusedNodeRef = useRef<string | null>(null)
  const lastFocusedFieldRef = useRef<"text" | "note">("text")
  const restoredFileIdRef = useRef<string | null>(null)

  useEffect(() => {
    if (openMenuNodeId && !rows.some(row => row.node.id === openMenuNodeId)) {
      menuSessionRef.current = null
      setOpenMenuNodeId(null)
    }
  }, [openMenuNodeId, rows])

  function saveSession() {
    const viewport = viewportRef.current
    if (!sessionStateRef || !viewport || restoredFileIdRef.current !== file.id) return
    const focusedNodeId = lastFocusedNodeRef.current
    const input = focusedNodeId ? (lastFocusedFieldRef.current === "note" ? noteRefs : inputRefs).current[focusedNodeId] : null
    sessionStateRef.current = {
      fileId: file.id,
      scrollTop: viewport.scrollTop,
      selectedNodeId,
      focusedNodeId,
      selectionStart: input?.selectionStart ?? 0,
      selectionEnd: input?.selectionEnd ?? 0,
      selectionDirection: input?.selectionDirection ?? "none",
      focusRootId,
      focusedField: lastFocusedFieldRef.current,
    }
  }

  useLayoutEffect(() => {
    if (restoredFileIdRef.current === file.id) return
    restoredFileIdRef.current = file.id
    const viewport = viewportRef.current
    if (!viewport) return
    const saved = sessionStateRef?.current?.fileId === file.id ? sessionStateRef.current : null
    const sameSelection = saved?.selectedNodeId === selectedNodeId
    lastFocusedFieldRef.current = saved?.focusedField ?? "text"
    viewport.scrollTop = saved && Number.isFinite(saved.scrollTop) ? Math.max(0, saved.scrollTop) : 0
    lastFocusedNodeRef.current = sameSelection && saved?.focusedNodeId && inputRefs.current[saved.focusedNodeId]
      ? saved.focusedNodeId
      : null
    if (sameSelection && saved?.focusedNodeId) {
      const input = (saved.focusedField === "note" ? noteRefs : inputRefs).current[saved.focusedNodeId]
      if (input) {
        // 恢复插入点但不抢夺视图切换按钮的键盘焦点。
        input.setSelectionRange(saved.selectionStart, saved.selectionEnd, saved.selectionDirection)
      }
    } else if (selectedNodeId) {
      const visibleNodeId = getVisibleOutlineNodeId(file, selectedNodeId, inputRefs.current)
      const input = visibleNodeId ? inputRefs.current[visibleNodeId] : null
      if (input) revealOutlineInput(input)
    }
  }, [file, selectedNodeId, sessionStateRef])

  useLayoutEffect(saveSession)

  useLayoutEffect(() => {
    if (pendingSubtreeScrollRef.current === null || !viewportRef.current) return
    viewportRef.current.scrollTop = pendingSubtreeScrollRef.current
    pendingSubtreeScrollRef.current = null
  }, [focusRootId])

  useLayoutEffect(() => {
    const nodeId = focusRequest?.nodeId ?? focusNodeId
    if (!nodeId) return
    if (!isInOutlineScope(file, nodeId, focusRootId)) {
      setSubtreeRootId(file.rootId)
      return
    }
    const input = (focusRequest?.field === "note" ? noteRefs : inputRefs).current[nodeId]
    if (!input) return
    input.focus({ preventScroll: true })
    // 新建/方向导航有明确插入点；外部定位保留该输入框已有的光标位置。
    if (focusRequest) {
      const cursor = focusRequest.start ?? (focusRequest.atStart ? 0 : input.value.length)
      input.setSelectionRange(cursor, focusRequest.end ?? cursor, focusRequest.direction)
    }
    revealOutlineInput(input)
    if (focusRequest) setFocusRequest(null)
    if (focusNodeId) onFocusHandled?.()
  }, [file, focusRootId, focusRequest, focusNodeId, onFocusHandled, rows])

  useLayoutEffect(() => {
    const previousRows = previousRowsRef.current
    previousRowsRef.current = rows
    const lastFocusedNodeId = lastFocusedNodeRef.current
    if (!lastFocusedNodeId || focusRequest || focusNodeId || rows.some(row => row.node.id === lastFocusedNodeId)) return
    // 撤销或外部删除可能直接卸载当前输入框，浏览器会把焦点丢到 body。
    // 在工作区的通用 focus 效果之前恢复到仍可见的邻近主题。
    const index = previousRows.findIndex(row => row.node.id === lastFocusedNodeId)
    const visibleIds = new Set(rows.map(row => row.node.id))
    const next = previousRows.slice(index + 1).find(row => visibleIds.has(row.node.id))
      ?? previousRows.slice(0, index).reverse().find(row => visibleIds.has(row.node.id))
      ?? rows[0]
    if (next) focusNode(next.node.id)
  }, [rows, focusRequest, focusNodeId])

  function focusNode(nodeId: string, atStart = false, selection?: Partial<OutlineFocusRequest>) {
    onSelectNode?.(nodeId)
    setFocusRequest({ nodeId, atStart, ...selection })
  }

  function changeStructure(nextFile: ShardMapFile, nodeId: string, selection?: Partial<OutlineFocusRequest>) {
    // 只有真实结构变化才展开可见范围内的祖先；聚焦根的折叠状态属于完整树。
    let next = nextFile
    if (nextFile !== file && nodeId !== focusRootId) {
      let parentId = next.nodes[nodeId]?.parentId
      while (parentId && parentId !== focusRootId) {
        if (next.nodes[parentId]?.collapsed) next = toggleMindMapNodeCollapsed(next, parentId)
        parentId = next.nodes[parentId]?.parentId
      }
    }
    if (next !== file) onChange(next)
    // 提升当前聚焦根后仍回到完整树，避免新同级藏在局部范围之外。
    if (!getMindMapRows({ ...next, rootId: focusRootId }).some(row => row.node.id === nodeId)) changeFocusRoot(next.rootId)
    focusNode(nodeId, false, selection)
  }

  function changeFocusRoot(nodeId: string) {
    if (!file.nodes[nodeId] || nodeId === focusRootId) return
    subtreeScrollRef.current[focusRootId] = viewportRef.current?.scrollTop ?? 0
    pendingSubtreeScrollRef.current = subtreeScrollRef.current[nodeId] ?? 0
    lastFocusedNodeRef.current = null
    setFocusRequest(null)
    setEditingNoteId(null)
    setSubtreeRootId(nodeId)
    onSelectNode?.(nodeId)
    viewportRef.current?.focus({ preventScroll: true })
  }

  function editNote(nodeId: string) {
    // 围栏文本承载不了描述：紧凑档直接关掉这个入口。
    if (compact) return
    setEditingNoteId(nodeId)
    focusNode(nodeId, false, { field: "note" })
  }

  function addChild(nodeId: string) {
    const next = addMindMapChild(file, nodeId)
    changeStructure(next.file, next.nodeId)
  }

  function addSibling(nodeId: string) {
    const next = addMindMapSibling(file, nodeId)
    changeStructure(next.file, next.nodeId)
  }

  function deleteNode(nodeId: string) {
    const next = deleteMindMapNode(file, nodeId)
    changeStructure(next.file, next.focusNodeId)
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
    suppressBulletClickRef.current = true
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
    changeStructure(moveMindMapNodeToTarget(file, sourceNodeId, target), sourceNodeId)
    clearDragState()
  }

  function caret(input: HTMLTextAreaElement) {
    return { start: input.selectionStart, end: input.selectionEnd, direction: input.selectionDirection }
  }

  function openTopicMenu(nodeId: string) {
    const fieldRefs = lastFocusedNodeRef.current === nodeId && lastFocusedFieldRef.current === "note" ? noteRefs : inputRefs
    const input = fieldRefs.current[nodeId] ?? inputRefs.current[nodeId]
    menuSessionRef.current = { nodeId, input, start: input?.selectionStart ?? 0,
      end: input?.selectionEnd ?? 0, direction: input?.selectionDirection ?? "none" }
    setOpenMenuNodeId(nodeId)
    onSelectNode?.(nodeId)
  }

  function restoreTopicMenuFocus(nodeId: string) {
    const session = menuSessionRef.current
    // 点击其他主题、侧栏或另一个菜单时，焦点交给新的目标。
    if (session?.nodeId !== nodeId || ["item-press", "outside-press", "focus-out", "sibling-open"].includes(session.closeReason ?? "")) return false
    const active = document.activeElement
    if (active instanceof HTMLTextAreaElement) return active
    if (session.input?.isConnected) {
      session.input.setSelectionRange(session.start, session.end, session.direction)
      return session.input
    }
    return inputRefs.current[nodeId] ?? viewportRef.current
  }

  function handleTopicShortcut(event: KeyboardEvent, nodeId: string, selection?: Partial<OutlineFocusRequest>) {
    const mod = event.metaKey || event.ctrlKey
    if ((mod || event.altKey) && event.key === ".") {
      event.preventDefault()
      event.stopPropagation()
      if (nodeId !== focusRootId && getMindMapChildren(file, nodeId).length) onChange(toggleMindMapNodeCollapsed(file, nodeId))
      return true
    }
    if (mod && (event.key === "]" || event.key === "[")) {
      event.preventDefault()
      event.stopPropagation()
      changeFocusRoot(event.key === "]" ? nodeId : file.nodes[focusRootId]?.parentId ?? file.rootId)
      return true
    }
    if ((event.key === "ArrowUp" || event.key === "ArrowDown") && ((mod && event.shiftKey) || event.altKey)) {
      event.preventDefault()
      event.stopPropagation()
      changeStructure(moveMindMapNode(file, nodeId, event.key === "ArrowUp" ? "up" : "down"), nodeId, selection)
      return true
    }
    if (mod && event.shiftKey && event.key === "Backspace") {
      event.preventDefault()
      event.stopPropagation()
      deleteNode(nodeId)
      return true
    }
    return false
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>, nodeId: string) {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || event.key === "Process") return
    const input = event.currentTarget
    if (handleTopicShortcut(event, nodeId, caret(input))) return
    if (event.key === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      if (compact && onExit) onExit()
      else viewportRef.current?.focus({ preventScroll: true })
      return
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault()
      onSave?.()
      return
    }
    if (event.key === "Enter") {
      event.preventDefault()
      event.stopPropagation()
      if (event.metaKey || event.ctrlKey) {
        viewportRef.current?.focus({ preventScroll: true })
      } else if (event.shiftKey) {
        editNote(nodeId)
      } else if (event.altKey) {
        // 保留旧主题的多行能力，描述使用单独的 Shift+Enter 入口。
        const start = input.selectionStart
        onChange(updateMindMapNodeText(file, nodeId, input.value.slice(0, start) + "\n" + input.value.slice(input.selectionEnd)), { mergeKey: `text:${nodeId}` })
        focusNode(nodeId, false, { start: start + 1 })
      } else if (nodeId === focusRootId) {
        const first = getMindMapChildren(file, nodeId)[0]
        if (first) focusNode(first.id, true)
        else addChild(nodeId)
      } else {
        addSibling(nodeId)
      }
      return
    }
    if (event.key === "Tab") {
      event.preventDefault()
      event.stopPropagation()
      changeStructure(event.shiftKey ? outdentMindMapNode(file, nodeId) : indentMindMapNode(file, nodeId), nodeId, caret(input))
      return
    }
    if ((event.key === "ArrowUp" || event.key === "ArrowDown") && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const atBoundary = event.key === "ArrowUp" ? input.selectionStart === 0 : input.selectionEnd === input.value.length
      if (input.selectionStart === input.selectionEnd && atBoundary) {
        const index = rows.findIndex(row => row.node.id === nodeId)
        const next = rows[index + (event.key === "ArrowUp" ? -1 : 1)]
        if (next) {
          event.preventDefault()
          focusNode(next.node.id, event.key === "ArrowDown")
        }
      }
    }
    if (event.key === "Backspace" && !input.value && nodeId !== file.rootId) {
      event.preventDefault()
      const node = file.nodes[nodeId]
      // 空标题仍可能带有描述、链接或子树，普通退格不能递归丢弃它们。
      if (!getMindMapChildren(file, nodeId).length && !node.note && !node.links?.length) deleteNode(nodeId)
      else changeStructure(outdentMindMapNode(file, nodeId), nodeId, caret(input))
    }
  }

  function handleNoteKeyDown(event: KeyboardEvent<HTMLTextAreaElement>, nodeId: string) {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || event.key === "Process") return
    if (event.key === "Escape" || (event.key === "Enter" && (event.shiftKey || event.metaKey || event.ctrlKey))) {
      event.preventDefault()
      event.stopPropagation()
      setEditingNoteId(null)
      // 描述返回主题时保留主题原来的插入点。
      const input = inputRefs.current[nodeId]
      focusNode(nodeId, false, input ? caret(input) : undefined)
    }
  }

  function handleOutlineKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || event.key === "Process") return
    const nodeId = selectedNodeId && rows.some(row => row.node.id === selectedNodeId) ? selectedNodeId : focusRootId
    if (handleTopicShortcut(event, nodeId)) return
    if (event.key === "Enter" && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault()
      if (event.shiftKey) editNote(nodeId)
      else if (nodeId === focusRootId) addChild(nodeId)
      else addSibling(nodeId)
    } else if (event.key === "Tab") {
      event.preventDefault()
      changeStructure(event.shiftKey ? outdentMindMapNode(file, nodeId) : indentMindMapNode(file, nodeId), nodeId)
    } else if (event.key === "F2" || event.key === " ") {
      event.preventDefault()
      focusNode(nodeId)
    } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault()
      const index = rows.findIndex(row => row.node.id === nodeId)
      focusNode(rows[index + (event.key === "ArrowUp" ? -1 : 1)]?.node.id ?? nodeId)
    } else if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault()
      deleteNode(nodeId)
    }
  }

  return (
    <div
      aria-label="思维导图大纲编辑器"
      className={styles.viewport}
      data-compact={compact ? "true" : undefined}
      data-mind-map-outline
      id={outlineId}
      onFocusCapture={event => {
        if (!(event.target instanceof HTMLTextAreaElement)) return
        const row = (event.target as HTMLElement).closest<HTMLElement>("[data-outline-node]")
        if (row) {
          lastFocusedNodeRef.current = row.dataset.outlineNode ?? null
          lastFocusedFieldRef.current = (event.target as HTMLElement).dataset.outlineField === "note" ? "note" : "text"
        }
      }}
      onBlurCapture={saveSession}
      onScroll={saveSession}
      onKeyDown={handleOutlineKeyDown}
      ref={viewportRef}
      tabIndex={-1}
    >
      <div className={styles.outline}>
        {focusRootId !== file.rootId && <nav aria-label="大纲当前位置" className={styles.breadcrumbs}>
          {ancestors.map((node, index) => <span key={node.id}>
            {index > 0 && <ChevronRightIcon aria-hidden />}
            <Button className={styles.breadcrumbButton} size="sm" variant="ghost"
              aria-label={node.id === file.rootId ? "返回完整大纲" : `返回主题：${node.text || "未命名"}`}
              onClick={() => changeFocusRoot(node.id)}>{node.text || "未命名"}</Button>
          </span>)}
          <ChevronRightIcon aria-hidden /><span aria-current="page">{file.nodes[focusRootId].text || "未命名"}</span>
        </nav>}
        {rows.map(({ node, depth }) => {
          const isRoot = node.id === file.rootId
          const isTitle = node.id === focusRootId
          const selected = selectedNodeId === node.id
          const indentDepth = Math.min(Math.max(depth - 1, 0), 10)
          const guideAncestors: string[] = []
          let parentId = isTitle ? null : node.parentId
          while (parentId && parentId !== focusRootId && file.nodes[parentId]) {
            guideAncestors.unshift(parentId)
            parentId = file.nodes[parentId].parentId
          }
          const hasChildren = getMindMapChildren(file, node.id).length > 0
          const menuSiblings = openMenuNodeId === node.id && node.parentId ? getMindMapChildren(file, node.parentId) : []
          const menuSiblingIndex = menuSiblings.findIndex(sibling => sibling.id === node.id)
          const activeDropMode =
            dropTarget?.nodeId === node.id ? dropTarget.mode : null

          return (
            <div
              className={cn(
                styles.row,
                isTitle && styles.titleRow,
                (activeDropMode === "inside" || selected) && styles.rowActive,
                draggingNodeId === node.id && styles.rowDragging
              )}
              key={node.id}
              data-outline-node={node.id}
              data-root={isTitle}
              data-selected={selected}
              data-topic-selected={!isTitle && openMenuNodeId === node.id}
              data-collapsed={hasChildren && !!node.collapsed}
              data-has-children={hasChildren}
              data-drop={activeDropMode ?? undefined}
              onDragLeave={(event) => handleDragLeave(event, node.id)}
              onDragOver={(event) => handleDragOver(event, node.id)}
              onDrop={(event) => handleDrop(event, node.id)}
              style={{
                boxShadow: getOutlineDropShadow(activeDropMode),
                marginLeft: `calc(${indentDepth} * var(--outline-indent))`,
              }}
            >
              {guideAncestors.slice(0, 10).map((ancestorId, level) => <span
                aria-hidden="true" className={styles.guideLine} key={ancestorId} data-outline-guide={ancestorId}
                data-outline-guide-menu={level === indentDepth - 1}
                style={{ height: "100%", left: `calc(${level - indentDepth} * var(--outline-indent) + var(--outline-bullet-center))` }}
              />)}
              <div className={styles.rowMain}>
                {!isTitle && <Button
                  aria-grabbed={draggingNodeId === node.id}
                  aria-label={`聚焦主题：${node.text || "未命名"}`}
                  className={styles.dragHandle} draggable
                  onClick={() => { if (!suppressBulletClickRef.current) changeFocusRoot(node.id) }}
                  onPointerDown={() => { suppressBulletClickRef.current = false }}
                  onDragEnd={clearDragState}
                  onDragStart={event => handleDragStart(event, node.id)}
                  size="icon-sm" title="单击聚焦主题，拖动调整层级与顺序" type="button" variant="ghost">
                  <span aria-hidden className={styles.bullet} />
                </Button>}
                {!isTitle && hasChildren && <button
                  aria-label={`${node.collapsed ? "展开" : "折叠"} ${node.text || "未命名"}`}
                  aria-expanded={!node.collapsed} className={styles.branchToggle}
                  onClick={() => { onChange(toggleMindMapNodeCollapsed(file, node.id)); onSelectNode?.(node.id) }} type="button">
                  {node.collapsed ? <ChevronRightIcon /> : <ChevronDownIcon />}
                </button>}
                <div className={styles.inputWrap}>
                  <OutlineNodeInput
                    aria-label={isRoot ? "根节点" : "导图节点"}
                    className={cn(styles.nodeInput, isTitle && styles.titleInput)}
                    data-outline-field="text"
                    onChange={(event) =>
                      onChange(
                        updateMindMapNodeText(
                          file,
                          node.id,
                          event.currentTarget.value
                        ),
                        { mergeKey: `text:${node.id}` }
                      )
                    }
                    onFocus={() => { setEditingNoteId(null); onSelectNode?.(node.id) }}
                    onKeyDown={(event) => handleKeyDown(event, node.id)}
                    onSelect={saveSession}
                    placeholder={isTitle ? (compact ? "中心主题" : "无标题") : ""}
                    registerInput={(element) => {
                      inputRefs.current[node.id] = element
                    }}
                    value={node.text}
                  />
                  {(node.note || editingNoteId === node.id) && <OutlineNodeInput
                    aria-label="主题描述" data-outline-field="note" className={styles.noteInput}
                    placeholder="输入描述" value={node.note ?? ""}
                    registerInput={element => { noteRefs.current[node.id] = element }}
                    onFocus={() => { setEditingNoteId(node.id); onSelectNode?.(node.id) }}
                    onSelect={saveSession} onKeyDown={event => handleNoteKeyDown(event, node.id)}
                    onChange={event => onChange(updateMindMapNodeNote(file, node.id, event.currentTarget.value), { mergeKey: `note:${node.id}` })}
                  />}
                </div>
              </div>
              <div className={styles.actionsRow}>
                <DropdownMenu modal={false} open={openMenuNodeId === node.id} onOpenChangeComplete={open => {
                  const session = menuSessionRef.current
                  if (!open && !openMenuNodeId && session?.nodeId === node.id && session.focusRootOnClose) {
                    // 等菜单解除焦点管理后再切换子树，避免当前菜单项卸载时把焦点拉回弹层。
                    const nextRootId = session.focusRootOnClose
                    session.focusRootOnClose = undefined
                    changeFocusRoot(nextRootId)
                  }
                }} onOpenChange={(open, details) => {
                  if (open) openTopicMenu(node.id)
                  else {
                    if (menuSessionRef.current?.nodeId === node.id) menuSessionRef.current.closeReason = details.reason
                    setOpenMenuNodeId(current => current === node.id ? null : current)
                  }
                }}>
                  <DropdownMenuTrigger render={<Button aria-label={`主题操作：${node.text || "未命名"}`} size="icon-sm" variant="ghost" />}>
                    <MoreHorizontalIcon aria-hidden="true" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent side="left" align="start" sideOffset={4} className={styles.menuContent} aria-label="主题操作"
                    data-mind-map-menu-owner={outlineId}
                    finalFocus={() => restoreTopicMenuFocus(node.id)}>
                    <DropdownMenuGroup>
                      <DropdownMenuLabel className={styles.menuSectionLabel}>主题</DropdownMenuLabel>
                      <DropdownMenuItem onClick={() => focusNode(node.id, false, inputRefs.current[node.id] ? caret(inputRefs.current[node.id]!) : undefined)}><PencilLineIcon />编辑主题</DropdownMenuItem>
                      {!compact && <DropdownMenuItem onClick={() => editNote(node.id)}><FileTextIcon />编辑描述<DropdownMenuShortcut aria-hidden>Shift+Enter</DropdownMenuShortcut></DropdownMenuItem>}
                      {!isTitle && hasChildren && <DropdownMenuItem onClick={() => {
                        onChange(toggleMindMapNodeCollapsed(file, node.id))
                        focusNode(node.id, false, inputRefs.current[node.id] ? caret(inputRefs.current[node.id]!) : undefined)
                      }}>{node.collapsed ? <ChevronRightIcon /> : <ChevronDownIcon />}{node.collapsed ? "展开子主题" : "折叠子主题"}</DropdownMenuItem>}
                      {!isTitle && <DropdownMenuItem onClick={() => {
                        if (menuSessionRef.current?.nodeId === node.id) menuSessionRef.current.focusRootOnClose = node.id
                      }}><Maximize2Icon />聚焦主题</DropdownMenuItem>}
                    </DropdownMenuGroup>
                    <DropdownMenuSeparator />
                    <DropdownMenuGroup>
                      <DropdownMenuLabel className={styles.menuSectionLabel}>结构</DropdownMenuLabel>
                      <DropdownMenuItem onClick={() => addChild(node.id)}><PlusIcon />添加子节点</DropdownMenuItem>
                      <DropdownMenuItem onClick={() => addSibling(node.id)}><PlusIcon />添加同级节点<DropdownMenuShortcut aria-hidden>Enter</DropdownMenuShortcut></DropdownMenuItem>
                      <DropdownMenuSub>
                        <DropdownMenuSubTrigger disabled={isRoot}><MoveIcon />移动主题</DropdownMenuSubTrigger>
                        <DropdownMenuSubContent className={styles.menuContent} data-mind-map-menu-owner={outlineId}>
                          <DropdownMenuItem disabled={isRoot || menuSiblingIndex <= 0} onClick={() => changeStructure(moveMindMapNode(file, node.id, "up"), node.id)}><ArrowUpIcon />上移<DropdownMenuShortcut aria-hidden>Alt+↑</DropdownMenuShortcut></DropdownMenuItem>
                          <DropdownMenuItem disabled={isRoot || menuSiblingIndex < 0 || menuSiblingIndex === menuSiblings.length - 1} onClick={() => changeStructure(moveMindMapNode(file, node.id, "down"), node.id)}><ArrowDownIcon />下移<DropdownMenuShortcut aria-hidden>Alt+↓</DropdownMenuShortcut></DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem disabled={isRoot || menuSiblingIndex <= 0} onClick={() => changeStructure(indentMindMapNode(file, node.id), node.id)}><ArrowRightIcon />缩进<DropdownMenuShortcut aria-hidden>Tab</DropdownMenuShortcut></DropdownMenuItem>
                          <DropdownMenuItem disabled={isRoot || node.parentId === file.rootId} onClick={() => changeStructure(outdentMindMapNode(file, node.id), node.id)}><ArrowLeftIcon />反缩进<DropdownMenuShortcut aria-hidden>Shift+Tab</DropdownMenuShortcut></DropdownMenuItem>
                        </DropdownMenuSubContent>
                      </DropdownMenuSub>
                    </DropdownMenuGroup>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" disabled={isRoot} onClick={() => deleteNode(node.id)}><Trash2Icon />删除节点及子节点</DropdownMenuItem>
                    {openMenuNodeId === node.id && <div className={styles.menuFooter} data-outline-menu-meta>
                      <span className={styles.menuMetaLine}><span>编辑于</span><time dateTime={node.updatedAt}>{formatOutlineEditedAt(node.updatedAt)}</time></span>
                      <span className={styles.menuMetaLine}><span>主题字数</span><span>{Array.from(node.text.replace(/\s/g, "")).length}</span></span>
                    </div>}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function formatOutlineEditedAt(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "—"
  return date.toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })
}

function isInOutlineScope(file: ShardMapFile, nodeId: string, rootId: string) {
  let current: string | null | undefined = nodeId
  while (current) {
    if (current === rootId) return true
    current = file.nodes[current]?.parentId
  }
  return false
}

function getVisibleOutlineNodeId(
  file: ShardMapFile,
  nodeId: string,
  inputs: Record<string, HTMLTextAreaElement | null>
) {
  let current: string | null | undefined = nodeId
  while (current) {
    if (inputs[current]) return current
    current = file.nodes[current]?.parentId
  }
  return null
}

function revealOutlineInput(input: HTMLTextAreaElement) {
  const viewport = input.closest<HTMLElement>("[data-mind-map-outline]")
  if (!viewport) return
  const rect = input.getBoundingClientRect()
  const bounds = viewport.getBoundingClientRect()
  const margin = parseFloat(getComputedStyle(viewport).paddingTop)
  if (rect.bottom > bounds.bottom - margin) viewport.scrollTop += rect.bottom - bounds.bottom + margin
  else if (rect.top < bounds.top + margin) viewport.scrollTop += rect.top - bounds.top - margin
}

function OutlineNodeInput({ registerInput, ...props }: ComponentProps<"textarea"> & {
  registerInput: (input: HTMLTextAreaElement | null) => void
}) {
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  function resizeInput(reveal = false) {
    const input = inputRef.current
    if (!input) return
    const viewport = input.closest<HTMLElement>("[data-mind-map-outline]")
    const scrollTop = viewport?.scrollTop ?? 0
    input.style.height = "0px"
    input.style.height = `${input.scrollHeight}px`
    // 临时高度归零会收缩滚动范围，尤其在底部；测量后补回原位置。
    if (viewport) viewport.scrollTop = scrollTop
    if (reveal && document.activeElement === input) revealOutlineInput(input)
  }
  useLayoutEffect(() => resizeInput(true), [props.value])
  useEffect(() => {
    const input = inputRef.current
    if (!input) return
    let previousWidth = 0
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width === previousWidth) return
      previousWidth = entry.contentRect.width
      resizeInput()
    })
    observer.observe(input)
    let cancelled = false
    const refresh = () => { if (!cancelled) resizeInput() }
    void document.fonts?.ready.then(refresh)
    document.fonts?.addEventListener("loadingdone", refresh)
    return () => {
      cancelled = true
      observer.disconnect()
      document.fonts?.removeEventListener("loadingdone", refresh)
    }
  }, [])
  return <textarea {...props} className={cn(styles.nodeInput, props.className)} rows={1} ref={input => {
    inputRef.current = input
    registerInput(input)
  }} />
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
