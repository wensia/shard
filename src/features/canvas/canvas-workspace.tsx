import { SelectControl } from "@/components/ui/select"
import {
  forwardRef, memo, useCallback, useEffect, useId, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState,
  type KeyboardEvent,
} from "react"
import {
  Background, BackgroundVariant, ConnectionMode, Handle, MarkerType, Position, ReactFlow,
  SelectionMode, type Connection, type Dimensions, type Edge, type EdgeChange, type Node, type NodeChange, type NodePositionChange,
  type NodeProps, type ReactFlowInstance,
} from "@xyflow/react"
import "@xyflow/react/dist/style.css"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { CheckIcon, ChevronDownIcon, ChevronRightIcon, MoreHorizontalIcon, XIcon } from "@/components/icons"
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { getApiErrorMessage, listDiagramDocuments } from "@/lib/api"
import { deriveKind } from "@/lib/content-kind"
import type { MindMapLayout } from "@/lib/mind-map-layout"
import { measureMindMapInkBaselineOffset, useMindMapFontStyle } from "@/lib/mind-map-text-metrics"
import {
  addMindMapChild, addMindMapParent, addMindMapSibling, deleteMindMapNode, deleteMindMapNodeOnly,
  getMindMapChildren, getMindMapRows, moveMindMapNode, toggleMindMapNodeCollapsed, updateMindMapNodeText,
} from "@/lib/mind-map-tree"
import type { DiagramDocumentSummary, Fragment, ShardDocumentLink, ShardMapFile, ShardMapNode } from "@/types"
import { createCanvas, readCanvas, splitCanvas, writeCanvas, type CanvasSplitResult } from "./api"
import { CanvasHistory } from "./history"
import { cloneCanvasFile, createCanvasFile, createCanvasId, createCanvasNode, type CanvasFile, type CanvasNode, type CanvasNodeKind, type CanvasReadResult } from "./model"
import {
  addCanvasEdge, addCanvasNode, removeCanvasEdges, removeCanvasNodes, updateCanvasEdge,
  updateCanvasNode,
} from "./mutations"
import { CanvasSaveQueue, type CanvasSaveState } from "./save-queue"
import "./canvas-workspace.css"

export interface CanvasWorkspaceHandle {
  flush: () => Promise<boolean>
  isDirty: () => boolean
  setInteractionBlocked: (blocked: boolean) => void
}

export interface CanvasWorkspaceProps {
  path: string
  initialRead?: CanvasReadResult | null
  fragments: Fragment[]
  onOpenLink: (link: ShardDocumentLink) => void | Promise<void>
  onSaved?: () => void
  onRecovered?: (path: string) => void | Promise<void>
  onSplit?: (result: CanvasSplitResult) => void | Promise<void>
  onSaveStateChange?: (state: "dirty" | "error" | "saved" | "saving") => void
  onReady?: (revision: string) => void
  onLoadError?: (error: unknown) => void
  readOnly?: boolean
}

type TreeSelection = { nodeId: string; treeNodeId: string }
type TreeAction = "child" | "sibling" | "before" | "parent" | "collapse" | "delete" | "delete-only" | "up" | "down"
type PendingText = { kind: "node" | "tree" | "edge"; id: string; treeNodeId?: string; text: string }
type RecoveryAttempt = {
  sourceId: string
  request: { parentPath: string; title: string; file: CanvasFile }
  queue?: CanvasSaveQueue
}
type ReferencePreview = { title: string; excerpt: string; missing: boolean; isFragment?: boolean }
type LayoutRequest = { nodeId: string; map: ShardMapFile } | { resolve: (layout: MindMapLayout) => void; reject: (error: Error) => void }
type FlowNodeData = Record<string, unknown> & {
  item: CanvasNode
  editing: boolean
  blocked: boolean
  preview?: ReferencePreview
  layout?: MindMapLayout
  layoutError?: string
  treeSelection: TreeSelection | null
  onEdit: (id: string | null) => void
  onText: (id: string, text: string) => void
  onTextEnd: () => void
  onTreeSelect: (nodeId: string, treeNodeId: string, edit: boolean) => void
  onOpen: (link: ShardDocumentLink) => void
}
type FlowNode = Node<FlowNodeData, "shardCanvas">
const NODE_LABELS: Record<CanvasNodeKind, string> = {
  process: "流程", decision: "判断", terminal: "起止", text: "文本", reference: "资料引用", mindmap: "思维导图",
}
const HANDLES = [Position.Top, Position.Right, Position.Bottom, Position.Left] as const
const HANDLE_LABELS = { top: "上方", right: "右侧", bottom: "下方", left: "左侧" }
const MIN_ZOOM = 0.1
const MAX_ZOOM = 2.5
const AUTO_SAVE_DELAY = 1200
const REFERENCE_DRAG_TYPE = "application/x-shard-canvas-reference"
const TOPIC_TONES = { default: "默认", accent: "强调", success: "完成", warning: "提醒" } as const

function sourcePreview(link: ShardDocumentLink | undefined, fragments: Fragment[], documents: DiagramDocumentSummary[]): ReferencePreview {
  if (link?.targetType === "map" || link?.targetType === "flow") {
    const document = documents.find(item => item.id === link.targetId && item.kind === (link.targetType === "map" ? "mindmap" : "flowchart"))
    return document ? { title: document.title, excerpt: `${document.kind === "mindmap" ? "思维导图" : "流程图"} · ${document.nodeCount} 个节点`, missing: false }
      : { title: "关联文档不可用", excerpt: "文档已删除或当前不可访问。", missing: true }
  }
  const fragment = fragments.find((item) => !item.lockbox && !item.archived && (
    link?.targetType === "fragment" ? item.id === link.targetId :
      link?.targetType === "markdownPath" ? item.path === link.path : false
  ))
  if (!fragment) return { title: "原文不可用", excerpt: "原文已移动、删除或当前不可访问。", missing: true }
  const lines = fragment.content.slice(0, 800).trim().split("\n")
  if (deriveKind(fragment.tags) === "fragment") return {
    title: lines[0]?.replace(/^#+\s*/, "").slice(0, 64) || "未命名碎片",
    excerpt: "碎片来源 · 在碎片中查看完整内容",
    missing: false,
    isFragment: true,
  }
  return {
    title: lines[0]?.replace(/^#+\s*/, "").slice(0, 100) || "未命名资料",
    excerpt: lines.slice(1).join("\n").slice(0, 280) || fragment.content.slice(0, 280),
    missing: false,
  }
}

const CanvasObject = memo(function CanvasObject({ data, selected }: NodeProps<FlowNode>) {
  const { item, editing, layout } = data
  const objectRef = useRef<HTMLDivElement>(null)
  const fontStyle = useMindMapFontStyle(objectRef, item.kind === "mindmap")
  const baselineOffset = (text: string) => measureMindMapInkBaselineOffset(
    fontStyle?.fontFamily ?? "", fontStyle?.fontSize ?? 13, fontStyle?.fontWeight ?? "400", text,
  )
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    if (editing) { textareaRef.current?.focus(); textareaRef.current?.select() }
  }, [editing])
  useLayoutEffect(() => {
    const editor = textareaRef.current
    if (!editing || !editor) return
    // The label below owns the node geometry; the editor only sizes its text layer.
    editor.style.height = "0"
    editor.style.height = `${editor.scrollHeight}px`
  }, [editing, item.text, item.width])

  return (
    <div ref={objectRef} className={`shard-canvas-object shard-canvas-object-${item.kind}${selected ? " is-selected" : ""}${editing ? " is-editing" : ""}`}
      data-canvas-kind={item.kind} data-canvas-node-id={item.id}
      onDoubleClick={(event) => {
        if (item.kind === "reference" || item.kind === "mindmap" || data.blocked) return
        event.stopPropagation(); data.onEdit(item.id)
      }}>
      {item.kind === "decision" && <svg className="shard-canvas-shape" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        <polygon points="50,1 99,50 50,99 1,50" vectorEffect="non-scaling-stroke" />
      </svg>}
      {HANDLES.map((position) => <Handle key={position} id={position} type="source" position={position}
        isConnectable={!data.blocked} aria-label={`${NODE_LABELS[item.kind]}${HANDLE_LABELS[position]}连接点`} />)}
      {item.kind === "reference" ? (
        <div className="shard-canvas-reference">
          <span className="shard-canvas-object-kind">资料引用</span>
          <strong>{data.preview?.title ?? item.text}</strong>
          <p className={data.preview?.missing ? "shard-canvas-error-text" : ""}>{data.preview?.excerpt}</p>
          <Button size="sm" variant="outline" className="nodrag nopan" disabled={data.blocked || data.preview?.missing}
            onClick={() => item.link && data.onOpen(item.link)}>{data.preview?.isFragment ? "在碎片中打开" : "打开原文"}</Button>
        </div>
      ) : item.kind === "mindmap" ? (
        <div className="shard-canvas-tree">
          <div className="shard-canvas-tree-title">{item.mindMap?.title || "思维导图"}</div>
          {layout ? <svg className="shard-canvas-tree-svg" width={layout.bounds.width} height={layout.bounds.height}
            viewBox={`${layout.bounds.x} ${layout.bounds.y} ${layout.bounds.width} ${layout.bounds.height}`} aria-label="内嵌思维导图">
            <g className="shard-canvas-tree-edges">{layout.edges.map((edge) => <path key={edge.id}
              d={`M ${edge.x1} ${edge.y1} C ${(edge.x1 + edge.x2) / 2} ${edge.y1}, ${(edge.x1 + edge.x2) / 2} ${edge.y2}, ${edge.x2} ${edge.y2}`} />)}</g>
            {layout.nodes.map((node) => {
              const active = data.treeSelection?.nodeId === item.id && data.treeSelection.treeNodeId === node.id
              return <g key={node.id} className={`shard-canvas-tree-node nodrag nopan${active ? " is-selected" : ""}`}
                role="button" tabIndex={data.blocked || (!active && node.id !== item.mindMap?.rootId) ? -1 : 0}
                data-tree-node-id={node.id} data-tone={node.node.style?.tone ?? "default"} aria-label={`导图节点：${node.node.text || "新主题"}`} aria-pressed={active}
                onFocus={() => { if (!data.blocked && !active) data.onTreeSelect(item.id, node.id, false) }}
                onClick={(event) => { event.stopPropagation(); if (!data.blocked) data.onTreeSelect(item.id, node.id, false) }}
                onDoubleClick={(event) => { event.stopPropagation(); if (!data.blocked) data.onTreeSelect(item.id, node.id, true) }}>
                <rect x={node.x} y={node.y} width={node.width} height={node.height} rx={4} />
                <text textAnchor="middle" pointerEvents="none">
                  {node.textLines.map((line, index) => <tspan key={index} x={node.x + node.width / 2}
                    y={node.y + node.height / 2 + (index - (node.textLines.length - 1) / 2) * 18 + baselineOffset(line || "新主题")}>{line || "新主题"}</tspan>)}
                </text>
                {node.node.collapsed && <text className="shard-canvas-tree-collapsed" x={node.x + node.width + 9}
                  y={node.y + node.height / 2 + baselineOffset("+")} pointerEvents="none">+</text>}
              </g>
            })}
          </svg> : <p role="status" className={data.layoutError ? "shard-canvas-error-text" : ""}>
            {data.layoutError || "正在布局思维导图…"}</p>}
        </div>
      ) : <div className="shard-canvas-node-content">
        <div className="shard-canvas-node-label" aria-hidden={editing || undefined}>{item.text.length > 1000 ? `${item.text.slice(0, 1000)}…` : item.text || NODE_LABELS[item.kind]}</div>
        {editing && <textarea ref={textareaRef} aria-label="节点文字" rows={1} className="shard-canvas-node-editor nodrag nopan nowheel"
          value={item.text} disabled={data.blocked} onChange={(event) => data.onText(item.id, event.target.value)}
          onBlur={(event) => {
            data.onTextEnd()
            // Window focus loss has no destination. Keep the active editor through
            // native IPC / focus changes; explicit canvas clicks and Escape end it.
            if (event.relatedTarget) data.onEdit(null)
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) return
            if (event.key === "Escape" || ((event.metaKey || event.ctrlKey) && event.key === "Enter")) {
              event.preventDefault(); data.onTextEnd(); data.onEdit(null)
              event.currentTarget.closest<HTMLElement>(".react-flow__node")?.focus({ preventScroll: true })
            }
          }} />}
      </div>}
    </div>
  )
})
const NODE_TYPES = { shardCanvas: CanvasObject }

export const CanvasWorkspace = forwardRef<CanvasWorkspaceHandle, CanvasWorkspaceProps>(function CanvasWorkspace({
  path, initialRead = null, fragments, onOpenLink, onSaved, onRecovered,
  onSaveStateChange, onSplit, onReady, onLoadError,
  readOnly = false,
}, ref) {
  const [draft, setDraft] = useState<CanvasFile | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [saveState, setSaveState] = useState<CanvasSaveState | null>(null)
  const [blocked, setBlocked] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [selectedNodes, setSelectedNodes] = useState<string[]>([])
  const [selectedEdges, setSelectedEdges] = useState<string[]>([])
  const [editing, setEditing] = useState<string | null>(null)
  const [treeSelection, setTreeSelection] = useState<TreeSelection | null>(null)
  const [picker, setPicker] = useState<"reference" | null>(null)
  const [inspectorOpen, setInspectorOpen] = useState(true)
  const [inspectorPinned, setInspectorPinned] = useState(false)
  const [inspectorTab, setInspectorTab] = useState<"properties" | "outline">("properties")
  const inspectorId = useId()
  const [query, setQuery] = useState("")
  const [documents, setDocuments] = useState<DiagramDocumentSummary[]>([])
  const [splitResult, setSplitResult] = useState<CanvasSplitResult | null>(null)
  const [pickerLoading, setPickerLoading] = useState(false)
  const [zoomPercent, setZoomPercent] = useState(100)
  const [connecting, setConnecting] = useState(false)
  const [layoutResults, setLayoutResults] = useState<Record<string, { map: ShardMapFile; layout?: MindMapLayout; error?: string }>>({})
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>({})
  // Controlled React Flow nodes must retain measured geometry across projections.
  // Keep it out of the document, history and save queue.
  const [measurements, setMeasurements] = useState<Record<string, Dimensions>>({})
  const [pendingText, setPendingText] = useState<PendingText | null>(null)
  const [composing, setComposing] = useState(false)
  const [recovering, setRecovering] = useState(false)
  const [recoveryError, setRecoveryError] = useState<string | null>(null)
  const recoveryAttemptRef = useRef<RecoveryAttempt | null>(null)
  const recoveringRef = useRef(false)
  const externalBlockedRef = useRef(false)
  const pendingTextRef = useRef<PendingText | null>(null)
  const composingRef = useRef(false)
  const finalizeTextRef = useRef<() => boolean>(() => true)
  const draftRef = useRef<CanvasFile | null>(null)
  const queueRef = useRef<CanvasSaveQueue | null>(null)
  const historyRef = useRef<CanvasHistory | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const inspectorRef = useRef<HTMLElement>(null)
  const treeEditorRef = useRef<HTMLTextAreaElement>(null)
  const treeFocusRef = useRef<(TreeSelection & { mode: "canvas" | "editor"; selectText: boolean }) | null>(null)
  const treeRevealRef = useRef<TreeSelection | null>(null)
  const skipMenuFocusRef = useRef(false)
  const menuActionRef = useRef<(() => void) | null>(null)
  const deferMenuFocusRef = useRef(false)
  const flowRef = useRef<ReactFlowInstance<FlowNode, Edge> | null>(null)
  const initialReadRef = useRef(initialRead)
  const [flowReady, setFlowReady] = useState(false)
  const blockedRef = useRef(false)
  const draggingRef = useRef(false)
  const callbacksRef = useRef({ onSaved, onRecovered, onSaveStateChange, onOpenLink, onReady, onLoadError })
  callbacksRef.current = { onSaved, onRecovered, onSaveStateChange, onOpenLink, onReady, onLoadError }

  useEffect(() => {
    externalBlockedRef.current = readOnly
    blockedRef.current = readOnly || recoveringRef.current
    setBlocked(blockedRef.current)
  }, [readOnly])
  const workerRef = useRef<Worker | null>(null)
  const requestIdRef = useRef(0)
  const layoutPendingRef = useRef(new Map<number, LayoutRequest>())
  const layoutRequestedRef = useRef(new Map<string, ShardMapFile>())

  useEffect(() => {
    let active = true
    setLoading(true); setLoadError(null); setDraft(null); draftRef.current = null; setFlowReady(false)
    queueRef.current = null; historyRef.current = null
    setSelectedNodes([]); setSelectedEdges([]); setEditing(null); setTreeSelection(null); setPositions({})
    setMeasurements({})
    setSaveState(null); setActionError(null); setPicker(null); setPendingText(null); pendingTextRef.current = null
    setInspectorPinned(false); setInspectorTab("properties")
    recoveryAttemptRef.current = null; setRecoveryError(null); setSplitResult(null)
    const initial = initialReadRef.current?.path === path ? initialReadRef.current : null
    initialReadRef.current = null
    void (initial ? Promise.resolve(initial) : readCanvas(path)).then((result) => {
      if (!active) return
      const queue = new CanvasSaveQueue(result, writeCanvas, (state) => {
        if (!active) return
        setSaveState(state); callbacksRef.current.onSaveStateChange?.(state.status === "error" ? "error" : pendingTextRef.current ? "dirty" : state.status)
      })
      queueRef.current = queue
      historyRef.current = new CanvasHistory(result.file)
      draftRef.current = result.file; setDraft(result.file); setSaveState(queue.getState())
      callbacksRef.current.onSaveStateChange?.("saved")
    }).catch((error) => { if (active) { setLoadError(getApiErrorMessage(error)); callbacksRef.current.onLoadError?.(error) } })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [path, loadAttempt])

  useEffect(() => {
    if (!draft || !flowReady) return
    callbacksRef.current.onReady?.(String(draft.revision))
  }, [draft, flowReady])

  useEffect(() => {
    let active = true
    setPickerLoading(true)
    void listDiagramDocuments().then(result => { if (active) setDocuments(result) }, error => { if (active) setActionError(getApiErrorMessage(error)) })
      .finally(() => { if (active) setPickerLoading(false) })
    return () => { active = false }
  }, [path])

  useEffect(() => {
    const liveIds = new Set(draft?.nodes.map((node) => node.id))
    setMeasurements((current) => Object.keys(current).every((id) => liveIds.has(id)) ? current :
      Object.fromEntries(Object.entries(current).filter(([id]) => liveIds.has(id))))
  }, [draft])

  useEffect(() => {
    const worker = new Worker(new URL("./layout.worker.ts", import.meta.url), { type: "module" })
    workerRef.current = worker
    worker.onmessage = (event: MessageEvent<{ requestId: number; layout?: MindMapLayout; error?: string }>) => {
      const request = layoutPendingRef.current.get(event.data.requestId)
      layoutPendingRef.current.delete(event.data.requestId)
      if (!request) return
      if ("resolve" in request) {
        if (event.data.layout) request.resolve(event.data.layout)
        else request.reject(new Error(event.data.error || "思维导图布局失败"))
        return
      }
      if (layoutRequestedRef.current.get(request.nodeId) !== request.map) return
      setLayoutResults((current) => ({ ...current, [request.nodeId]: { map: request.map, layout: event.data.layout, error: event.data.error } }))
    }
    const rejectPending = () => {
      for (const request of layoutPendingRef.current.values()) {
        if ("reject" in request) request.reject(new Error("思维导图布局中断，请重新打开画布后重试。"))
      }
      layoutPendingRef.current.clear()
    }
    worker.onerror = () => { rejectPending(); setActionError("思维导图布局失败，请重新打开画布后重试。") }
    return () => { worker.terminate(); workerRef.current = null; rejectPending(); layoutRequestedRef.current.clear() }
  }, [])

  useEffect(() => {
    if (!draft || draft.kind === "shard.canvas" || !workerRef.current) return
    const liveMaps = new Set(draft.nodes.filter((node) => node.mindMap).map((node) => node.id))
    let removed = false
    for (const id of layoutRequestedRef.current.keys()) {
      if (!liveMaps.has(id)) { layoutRequestedRef.current.delete(id); removed = true }
    }
    if (removed) setLayoutResults((current) => Object.fromEntries(Object.entries(current).filter(([id]) => liveMaps.has(id))))
    for (const node of draft.nodes) {
      if (!node.mindMap || layoutRequestedRef.current.get(node.id) === node.mindMap) continue
      const requestId = ++requestIdRef.current
      layoutRequestedRef.current.set(node.id, node.mindMap)
      layoutPendingRef.current.set(requestId, { nodeId: node.id, map: node.mindMap })
      workerRef.current.postMessage({ requestId, map: node.mindMap })
    }
  }, [draft])

  const flush = useCallback(async () => {
    const queue = queueRef.current
    if (!queue) return !draftRef.current && !pendingTextRef.current
    if (recoveringRef.current || draggingRef.current || composingRef.current || !finalizeTextRef.current()) return false
    historyRef.current?.breakMerge()
    const wasDirty = queue.getState().dirty
    const result = await queue.flush()
    if (result && wasDirty) callbacksRef.current.onSaved?.()
    return result
  }, [])

  useImperativeHandle(ref, () => ({
    flush,
    isDirty: () => !!queueRef.current?.getState().dirty || !!pendingTextRef.current || draggingRef.current || recoveringRef.current,
    setInteractionBlocked(value) {
      externalBlockedRef.current = readOnly || value
      blockedRef.current = readOnly || value || recoveringRef.current
      setBlocked(blockedRef.current)
    },
  }), [flush, readOnly])

  useEffect(() => {
    if (readOnly || (!saveState?.dirty && !pendingText) || saveState?.saving || saveState?.status === "error" || draggingRef.current || composing) return
    const timer = window.setTimeout(() => { void flush() }, AUTO_SAVE_DELAY)
    return () => window.clearTimeout(timer)
  }, [draft, flush, readOnly, saveState, pendingText, composing])

  const commit = useCallback((change: (file: CanvasFile) => CanvasFile, mergeKey?: string) => {
    const current = draftRef.current
    if (!current || current.kind !== "shard.flow" || blockedRef.current || !historyRef.current || !queueRef.current) return
    try {
      const next = historyRef.current.commit(change(current), mergeKey ? { mergeKey } : undefined)
      queueRef.current.update(next)
      draftRef.current = next; setDraft(next); setActionError(null)
    } catch (error) { setActionError(getApiErrorMessage(error)) }
  }, [])

  const undo = useCallback((redo = false) => {
    if (blockedRef.current || draggingRef.current) return
    if (!finalizeTextRef.current()) return
    const next = redo ? historyRef.current?.redo() : historyRef.current?.undo()
    if (next && queueRef.current) {
      queueRef.current.update(next); draftRef.current = next; setDraft(next); setPositions({}); setActionError(null)
    }
  }, [])

  const openLink = useCallback(async (link: ShardDocumentLink) => {
    if (blockedRef.current) return
    if (!(await flush())) return
    try { await callbacksRef.current.onOpenLink(link) } catch (error) { setActionError(getApiErrorMessage(error)) }
  }, [flush])

  const stageText = useCallback((pending: PendingText) => {
    if (blockedRef.current) return
    const previous = pendingTextRef.current
    if (previous && (previous.kind !== pending.kind || previous.id !== pending.id || previous.treeNodeId !== pending.treeNodeId) && !finalizeTextRef.current()) return
    pendingTextRef.current = pending; setPendingText(pending)
    callbacksRef.current.onSaveStateChange?.("dirty")
  }, [])
  const finalizeText = useCallback(() => {
    const pending = pendingTextRef.current
    const file = draftRef.current
    if (!pending) return true
    if (composingRef.current || !file || !historyRef.current || !queueRef.current) return false
    try {
      let next = file
      if (pending.kind === "node") next = updateCanvasNode(file, pending.id, { text: pending.text })
      else if (pending.kind === "edge") next = updateCanvasEdge(file, pending.id, { label: pending.text })
      else {
        const node = file.nodes.find((item) => item.id === pending.id)
        if (node?.mindMap && pending.treeNodeId) {
          const map = updateMindMapNodeText(node.mindMap, pending.treeNodeId, pending.text)
          next = updateCanvasNode(file, node.id, { mindMap: map, text: map.title })
        }
      }
      next = historyRef.current.commit(next, { mergeKey: `${pending.kind}-text:${pending.id}:${pending.treeNodeId || ""}` })
      queueRef.current.update(next); draftRef.current = next; setDraft(next)
      pendingTextRef.current = null; setPendingText(null); setActionError(null)
      return true
    } catch (error) { setActionError(getApiErrorMessage(error)); callbacksRef.current.onSaveStateChange?.("error"); return false }
  }, [])
  finalizeTextRef.current = finalizeText

  async function recoverAsCopy() {
    if (recoveringRef.current || externalBlockedRef.current || draggingRef.current || !finalizeText()) return
    const current = draftRef.current
    const original = queueRef.current
    if (!current || !original) return
    recoveringRef.current = true; blockedRef.current = true; setRecovering(true); setBlocked(true); setRecoveryError(null)
    try {
      let attempt = recoveryAttemptRef.current
      if (!attempt) {
        const title = `${current.title.slice(0, 480)}（副本）`
        const content = cloneCanvasFile(current)
        const copy = { ...createCanvasFile(title), nodes: content.nodes, edges: content.edges }
        const sourcePath = original.getBaseline().path
        attempt = { sourceId: current.id, request: { parentPath: sourcePath.slice(0, sourcePath.lastIndexOf("/")), title, file: copy } }
        // Freeze the create identity even when its result is lost. Subsequent clicks
        // first reconcile this same create, then save any edits made since that try.
        recoveryAttemptRef.current = attempt
      }
      if (attempt.sourceId !== current.id) throw new Error("当前画布已切换，请在原画布恢复草稿。")
      if (!attempt.queue) {
        const created = await createCanvas(attempt.request.parentPath, attempt.request.title, attempt.request.file)
        const recoveredQueue: CanvasSaveQueue = new CanvasSaveQueue(created, writeCanvas, (state) => {
          if (queueRef.current !== recoveredQueue) return
          setSaveState(state)
          callbacksRef.current.onSaveStateChange?.(state.status === "error" ? "error" : pendingTextRef.current ? "dirty" : state.status)
        })
        attempt.queue = recoveredQueue
      }
      if (draftRef.current?.id !== attempt.sourceId) throw new Error("画布已经切换；已创建的副本保留在原目录。")
      const target = attempt.queue.getBaseline()
      const latest = cloneCanvasFile(draftRef.current)
      attempt.queue.update({ ...latest, id: target.file.id, title: attempt.request.title,
        createdAt: target.file.createdAt, revision: target.file.revision })
      const saved = attempt.queue.getState().status === "error" ? await attempt.queue.retry() : await attempt.queue.flush()
      if (!saved) throw new Error(attempt.queue.getState().error || "副本保存失败，当前草稿仍已保留。")
      const recovered = attempt.queue.getBaseline()
      queueRef.current = attempt.queue
      draftRef.current = recovered.file; setDraft(recovered.file)
      historyRef.current = new CanvasHistory(recovered.file)
      setSaveState(attempt.queue.getState()); setActionError(null)
      recoveryAttemptRef.current = null
      callbacksRef.current.onSaveStateChange?.("saved")
      callbacksRef.current.onSaved?.()
      try { await callbacksRef.current.onRecovered?.(recovered.path) }
      catch (error) { setActionError(`副本已保存在 ${recovered.path}，资料库刷新失败：${getApiErrorMessage(error)}`) }
    } catch (error) {
      setRecoveryError(getApiErrorMessage(error))
    } finally {
      recoveringRef.current = false; setRecovering(false)
      blockedRef.current = externalBlockedRef.current; setBlocked(externalBlockedRef.current)
    }
  }
  const onText = useCallback((id: string, text: string) => stageText({ kind: "node", id, text }), [stageText])
  const editNode = useCallback((id: string | null) => {
    // A real editing gesture supersedes a pending focus from the insertion menu.
    menuActionRef.current = null
    setEditing(id)
  }, [])
  const breakMerge = useCallback(() => { finalizeTextRef.current(); historyRef.current?.breakMerge() }, [])
  const selectTree = useCallback((nodeId: string, treeNodeId: string, edit: boolean) => {
    if (!finalizeTextRef.current()) return
    menuActionRef.current = null
    const text = draftRef.current?.nodes.find((node) => node.id === nodeId)?.mindMap?.nodes[treeNodeId]?.text ?? ""
    treeFocusRef.current = { nodeId, treeNodeId, mode: edit ? "editor" : "canvas", selectText: ["", "未命名", "新主题", "中心主题"].includes(text) }
    treeRevealRef.current = { nodeId, treeNodeId }
    setSelectedNodes([nodeId]); setSelectedEdges([]); setEditing(null); setTreeSelection({ nodeId, treeNodeId }); setPicker(null)
    if (edit) { setInspectorOpen(true); setInspectorTab("properties") }
  }, [])

  const cancelDeferredFocus = useCallback(() => {
    menuActionRef.current = null
    treeFocusRef.current = null
    treeRevealRef.current = null
  }, [])

  const selectedNode = selectedNodes.length === 1 && !selectedEdges.length ? draft?.nodes.find((node) => node.id === selectedNodes[0]) : undefined
  const selectedEdge = selectedEdges.length === 1 && !selectedNodes.length ? draft?.edges.find((edge) => edge.id === selectedEdges[0]) : undefined
  const selectedMap = selectedNode?.kind === "mindmap" ? selectedNode.mindMap : undefined
  const selectedTreeNode = selectedMap && treeSelection && treeSelection.nodeId === selectedNode?.id
    ? selectedMap.nodes[treeSelection.treeNodeId] : undefined
  const treeRows = useMemo(() => selectedMap ? getMindMapRows(selectedMap) : [], [selectedMap])
  const inspectorVisible = !!(picker || (inspectorOpen && (selectedNode || selectedEdge || inspectorPinned)))

  function closeInspector() {
    if (composingRef.current || !finalizeText()) return
    cancelDeferredFocus()
    setPicker(null); setInspectorOpen(false); setInspectorPinned(false)
    rootRef.current?.focus({ preventScroll: true })
  }

  function changeInspectorTab(tab: typeof inspectorTab) {
    if (composingRef.current || !finalizeText()) return
    cancelDeferredFocus(); historyRef.current?.breakMerge(); setInspectorTab(tab)
  }

  function updateTopicProperties(patch: Pick<ShardMapNode, "width"> | Pick<ShardMapNode, "style">) {
    if (!selectedNode || !selectedTreeNode || !finalizeText()) return
    if ("width" in patch && patch.width === selectedTreeNode.width) return
    if ("style" in patch && (patch.style?.tone ?? "default") === (selectedTreeNode.style?.tone ?? "default")) return
    commit((file) => {
      const node = file.nodes.find((item) => item.id === selectedNode.id)
      const map = node?.mindMap
      const topic = map?.nodes[selectedTreeNode.id]
      if (!map || !topic) return file
      const updatedAt = new Date().toISOString()
      return updateCanvasNode(file, selectedNode.id, { mindMap: { ...map, updatedAt,
        nodes: { ...map.nodes, [topic.id]: { ...topic, ...patch, updatedAt } } } })
    })
  }

  function toggleOutlineBranch(treeNodeId: string) {
    if (!selectedNode || !finalizeText()) return
    commit((file) => {
      const node = file.nodes.find((item) => item.id === selectedNode.id)
      return node?.mindMap ? updateCanvasNode(file, node.id, { mindMap: toggleMindMapNodeCollapsed(node.mindMap, treeNodeId) }) : file
    })
    selectTree(selectedNode.id, treeNodeId, false)
  }

  useEffect(() => {
    const request = treeFocusRef.current
    const editor = treeEditorRef.current
    if (!request || blockedRef.current || request.nodeId !== treeSelection?.nodeId || request.treeNodeId !== selectedTreeNode?.id) return
    if (request.mode === "canvas") {
      treeFocusRef.current = null
      rootRef.current?.focus({ preventScroll: true })
      return
    }
    if (!editor) return
    treeFocusRef.current = null
    editor.focus({ preventScroll: true })
    if (request.selectText) editor.select()
    else editor.setSelectionRange(editor.value.length, editor.value.length)
  }, [treeSelection, selectedTreeNode?.id, inspectorVisible, inspectorTab])

  useEffect(() => {
    const request = treeRevealRef.current
    const viewport = viewportRef.current
    const flow = flowRef.current
    if (!request || !viewport || !flow) return
    const element = viewport.querySelector(`[data-canvas-node-id="${CSS.escape(request.nodeId)}"] [data-tree-node-id="${CSS.escape(request.treeNodeId)}"]`)
    if (!element) return
    treeRevealRef.current = null
    const box = element.getBoundingClientRect()
    const bounds = viewport.getBoundingClientRect()
    const panelLeft = inspectorRef.current?.getBoundingClientRect().left ?? bounds.right
    const visibleRight = Math.min(bounds.right, panelLeft)
    const inset = 24
    const dx = box.width > visibleRight - bounds.left - inset * 2 ? bounds.left + inset - box.left :
      box.left < bounds.left + inset ? bounds.left + inset - box.left : box.right > visibleRight - inset ? visibleRight - inset - box.right : 0
    const dy = box.top < bounds.top + inset ? bounds.top + inset - box.top : box.bottom > bounds.bottom - inset ? bounds.bottom - inset - box.bottom : 0
    if (dx || dy) {
      const view = flow.getViewport()
      void flow.setViewport({ ...view, x: view.x + dx, y: view.y + dy })
    }
  }, [treeSelection, layoutResults, inspectorVisible, inspectorTab])

  function editTree(action: TreeAction) {
    cancelDeferredFocus()
    if (!finalizeText()) return
    if (!selectedNode || !selectedMap) return
    const treeNodeId = selectedTreeNode?.id || selectedMap.rootId
    let nextSelection = treeNodeId
    commit((file) => {
      const node = file.nodes.find((item) => item.id === selectedNode.id)
      if (!node?.mindMap) return file
      let map = node.mindMap
      if (action === "child" || action === "sibling" || action === "before" || action === "parent") {
        if (action === "child" && map.nodes[treeNodeId]?.collapsed) map = toggleMindMapNodeCollapsed(map, treeNodeId)
        const result = action === "child" ? addMindMapChild(map, treeNodeId) : action === "parent" ? addMindMapParent(map, treeNodeId) :
          addMindMapSibling(map, treeNodeId, action === "before" ? "before" : "after")
        map = result.file; nextSelection = result.nodeId
      } else if (action === "collapse") map = toggleMindMapNodeCollapsed(map, treeNodeId)
      else if (action === "up" || action === "down") map = moveMindMapNode(map, treeNodeId, action)
      else {
        const result = action === "delete-only" ? deleteMindMapNodeOnly(map, treeNodeId) : deleteMindMapNode(map, treeNodeId)
        map = result.file; nextSelection = result.focusNodeId
      }
      return updateCanvasNode(file, node.id, { mindMap: map, text: map.title })
    })
    const inserted = ["child", "sibling", "before", "parent"].includes(action) && nextSelection !== treeNodeId
    if (inserted) { setInspectorOpen(true); setInspectorTab("properties") }
    treeFocusRef.current = { nodeId: selectedNode.id, treeNodeId: nextSelection, mode: inserted ? "editor" : "canvas", selectText: inserted }
    treeRevealRef.current = { nodeId: selectedNode.id, treeNodeId: nextSelection }
    setTreeSelection({ nodeId: selectedNode.id, treeNodeId: nextSelection })
  }

  function navigateTree(key: string) {
    if (!selectedNode || !selectedMap || !selectedTreeNode) return
    let nextId: string | undefined
    if (key === "ArrowLeft") nextId = selectedTreeNode.parentId ?? undefined
    else if (key === "ArrowRight") {
      if (selectedTreeNode.collapsed) { editTree("collapse"); return }
      nextId = getMindMapChildren(selectedMap, selectedTreeNode.id)[0]?.id
    } else if (selectedTreeNode.parentId) {
      const siblings = getMindMapChildren(selectedMap, selectedTreeNode.parentId)
      const index = siblings.findIndex((node) => node.id === selectedTreeNode.id)
      nextId = siblings[index + (key === "ArrowUp" ? -1 : 1)]?.id
    }
    if (nextId) {
      selectTree(selectedNode.id, nextId, false)
      treeRevealRef.current = { nodeId: selectedNode.id, treeNodeId: nextId }
    }
  }

  const deleteSelection = useCallback(() => {
    if (!finalizeTextRef.current()) return
    commit((file) => removeCanvasEdges(removeCanvasNodes(file, selectedNodes), selectedEdges))
    setSelectedNodes([]); setSelectedEdges([]); setEditing(null); setTreeSelection(null)
  }, [commit, selectedEdges, selectedNodes])

  function handleShortcut(event: KeyboardEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement
    // Portalled menus keep React ancestry but own their keyboard interaction.
    if (!event.currentTarget.contains(target)) return
    if (blocked || composingRef.current || event.nativeEvent.isComposing || event.keyCode === 229) return
    cancelDeferredFocus()
    const modifier = event.metaKey || event.ctrlKey
    if (modifier && event.key.toLowerCase() === "s") { event.preventDefault(); void flush(); return }
    if (modifier && event.key.toLowerCase() === "z") { event.preventDefault(); undo(event.shiftKey); return }
    if (modifier && event.key.toLowerCase() === "y") { event.preventDefault(); undo(true); return }
    if (target.closest("input, textarea, select, [contenteditable=true], [role=combobox]")) return
    // Native controls retain Enter/Space/Tab. Diagram commands have one authority,
    // shared by the canvas and outline; they must not bubble into React Flow movement.
    if (target.closest("button, a, [role=button]") && !target.closest(".shard-canvas-tree-node, .shard-canvas-outline-row")) return
    const consume = () => { event.preventDefault(); event.stopPropagation() }
    if (modifier && event.key === "0") { consume(); void flowRef.current?.zoomTo(1); return }
    if (modifier && ["+", "=", "-"].includes(event.key)) {
      consume(); if (event.key === "-") void flowRef.current?.zoomOut(); else void flowRef.current?.zoomIn(); return
    }
    if (selectedNode && selectedMap && selectedTreeNode) {
      if (event.key === "Enter" && !event.altKey) { consume(); editTree(modifier ? "parent" : event.shiftKey ? "before" : "sibling"); return }
      if (event.key === "Tab" && !event.shiftKey && !modifier && !event.altKey) { consume(); editTree("child"); return }
      if (modifier && event.key === "/") { consume(); editTree("collapse"); return }
      if (modifier && event.key.toLowerCase() === "r") {
        consume(); selectTree(selectedNode.id, selectedMap.rootId, false)
        treeRevealRef.current = { nodeId: selectedNode.id, treeNodeId: selectedMap.rootId }; return
      }
      if (event.altKey && !modifier && ["ArrowUp", "ArrowDown"].includes(event.key)) { consume(); editTree(event.key === "ArrowUp" ? "up" : "down"); return }
      if (!modifier && !event.altKey && !event.shiftKey && event.key.startsWith("Arrow")) { consume(); navigateTree(event.key); return }
      if (!modifier && !event.altKey && (event.key === " " || event.key === "F2")) {
        consume(); selectTree(selectedNode.id, selectedTreeNode.id, true); return
      }
      if (!modifier && !event.altKey && event.key.length === 1) {
        consume(); selectTree(selectedNode.id, selectedTreeNode.id, true)
        stageText({ kind: "tree", id: selectedNode.id, treeNodeId: selectedTreeNode.id, text: event.key })
        treeFocusRef.current = { nodeId: selectedNode.id, treeNodeId: selectedTreeNode.id, mode: "editor", selectText: false }; return
      }
    }
    if (event.key === "Delete" || event.key === "Backspace") {
      consume()
      if (selectedTreeNode) { if (selectedTreeNode.id !== selectedMap?.rootId) editTree(modifier ? "delete-only" : "delete") }
      else deleteSelection()
    }
    if (event.key === "Escape") {
      consume()
      setSelectedNodes([]); setSelectedEdges([]); setTreeSelection(null); setEditing(null); setPicker(null)
      rootRef.current?.focus({ preventScroll: true })
    }
  }

  function newPosition(kind: CanvasNodeKind, dimensions?: Dimensions) {
    const rect = viewportRef.current?.getBoundingClientRect()
    const flow = flowRef.current
    if (!rect || !flow) return { x: 80, y: 80 }
    const center = flow.screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 })
    const size = (type: CanvasNodeKind) => ({ width: type === "mindmap" ? 300 : type === "reference" ? 280 : 180,
      height: type === "mindmap" || type === "reference" ? 160 : type === "decision" ? 108 : 72 })
    const { width, height } = dimensions ?? size(kind)
    const origin = { x: center.x - width / 2, y: center.y - height / 2 }
    const occupied = (draftRef.current?.nodes ?? []).map((node) => {
      const measured = flow.getNode(node.id)?.measured
      return { x: node.x, y: node.y, width: measured?.width ?? node.width ?? size(node.kind).width,
        height: measured?.height ?? node.height ?? size(node.kind).height }
    })
    const distance = (point: { x: number; y: number }) => (point.x - origin.x) ** 2 + (point.y - origin.y) ** 2
    const gap = 24 // Canvas coordinates, independent of UI density and viewport zoom.
    // Bound the search to nearby geometry; never scan/parse documents to place an object.
    const nearby = [...occupied].sort((a, b) => distance(a) - distance(b)).slice(0, 32)
    const candidates = [origin, ...nearby.flatMap((node) => [
      { x: node.x + node.width + gap, y: node.y }, { x: node.x, y: node.y + node.height + gap },
      { x: node.x - width - gap, y: node.y }, { x: node.x, y: node.y - height - gap },
    ])].sort((a, b) => distance(a) - distance(b))
    const vacant = (point: { x: number; y: number }) => !occupied.some((node) =>
      point.x < node.x + node.width + gap && point.x + width + gap > node.x &&
      point.y < node.y + node.height + gap && point.y + height + gap > node.y)
    const topLeft = flow.screenToFlowPosition({ x: rect.left + gap, y: rect.top + gap })
    const bottomRight = flow.screenToFlowPosition({ x: rect.right - gap, y: rect.bottom - gap })
    const visible = (point: { x: number; y: number }) => point.x >= topLeft.x && point.y >= topLeft.y &&
      point.x + width <= bottomRight.x && point.y + height <= bottomRight.y
    const point = candidates.find((candidate) => visible(candidate) && vacant(candidate)) ?? candidates.find(vacant) ??
      { x: Math.max(origin.x, ...occupied.map((node) => node.x + node.width + gap)), y: origin.y }
    if (!visible(point)) void flow.setCenter(point.x + width / 2, point.y + height / 2, { zoom: flow.getZoom() })
    return point
  }

  function insertNode(kind: CanvasNodeKind, options: Parameters<typeof createCanvasNode>[2] = {}, position?: { x: number; y: number }, initialLayout?: MindMapLayout) {
    if (blockedRef.current || !finalizeText()) return
    skipMenuFocusRef.current = true
    const dimensions = initialLayout ? { width: Math.max(300, initialLayout.bounds.width + 32), height: initialLayout.bounds.height + 64 } : undefined
    const node = createCanvasNode(kind, position ?? newPosition(kind, dimensions), options)
    commit((file) => addCanvasNode(file, node))
    const inserted = draftRef.current?.nodes.find((item) => item.id === node.id)
    if (!inserted) return
    if (initialLayout && inserted.mindMap) {
      layoutRequestedRef.current.set(node.id, inserted.mindMap)
      setLayoutResults((current) => ({ ...current, [node.id]: { map: inserted.mindMap!, layout: initialLayout } }))
    }
    setSelectedNodes([node.id]); setSelectedEdges([]); setPicker(null); setTreeSelection(null)
    const focusInserted = () => {
      if (blockedRef.current || !draftRef.current?.nodes.some((item) => item.id === node.id)) return
      if (kind === "mindmap" && node.mindMap) selectTree(node.id, node.mindMap.rootId, true)
      else if (kind !== "reference") setEditing(node.id)
    }
    if (deferMenuFocusRef.current) menuActionRef.current = focusInserted
    else focusInserted()
  }

  function runMenuAction(action: () => void) {
    skipMenuFocusRef.current = true
    deferMenuFocusRef.current = true
    try { action() } finally { deferMenuFocusRef.current = false }
  }

  async function splitLegacy() {
    const baseline = queueRef.current?.getBaseline()
    if (!baseline || recoveringRef.current || externalBlockedRef.current) return
    recoveringRef.current = true; blockedRef.current = true; setRecovering(true); setBlocked(true); setActionError(null)
    try {
      const result = splitResult ?? await splitCanvas(baseline.path, baseline.file.revision, baseline.lastSavedHash)
      setSplitResult(result)
      // Navigation performs its own save gate, so release our operation before opening the index.
      recoveringRef.current = false
      await onSplit?.(result)
    } catch (error) { setActionError(getApiErrorMessage(error)) }
    finally {
      recoveringRef.current = false; blockedRef.current = externalBlockedRef.current
      setRecovering(false); setBlocked(externalBlockedRef.current)
    }
  }

  const flowNodes = useMemo<FlowNode[]>(() => draft?.nodes.map((item) => {
    const result = layoutResults[item.id]
    const layout = result?.layout
    return {
      id: item.id, type: "shardCanvas", position: positions[item.id] || { x: item.x, y: item.y }, selected: selectedNodes.includes(item.id),
      measured: measurements[item.id],
      style: { width: item.kind === "mindmap" ? Math.max(300, (layout?.bounds.width ?? 300) + 32) : item.width ?? (item.kind === "reference" ? 280 : 180),
        ...(item.height ? { minHeight: item.height } : {}) },
      data: { item: pendingText?.kind === "node" && pendingText.id === item.id ? { ...item, text: pendingText.text } : item,
        editing: editing === item.id, blocked, preview: item.kind === "reference" ? sourcePreview(item.link, fragments, documents) : undefined,
        layout, layoutError: result?.error, treeSelection, onEdit: editNode, onText, onTextEnd: breakMerge,
        onTreeSelect: selectTree, onOpen: (link) => { void openLink(link) } },
    }
  }) || [], [draft, positions, measurements, selectedNodes, layoutResults, editing, blocked, fragments, documents, treeSelection, onText, editNode, breakMerge, selectTree, openLink, pendingText])
  const flowEdges = useMemo<Edge[]>(() => draft?.edges.map((edge) => ({
    id: edge.id, source: edge.source, target: edge.target, sourceHandle: edge.sourceHandle, targetHandle: edge.targetHandle,
    label: pendingText?.kind === "edge" && pendingText.id === edge.id ? pendingText.text : edge.label,
    selected: selectedEdges.includes(edge.id), type: "smoothstep",
    markerEnd: { type: MarkerType.ArrowClosed, color: selectedEdges.includes(edge.id) ? "var(--primary)" : "var(--muted-foreground)" },
    labelStyle: { fill: "var(--foreground)", fontSize: "var(--text-meta)" }, labelBgStyle: { fill: "var(--card)" },
  })) || [], [draft, selectedEdges, pendingText])

  function onNodesChange(changes: NodeChange<FlowNode>[]) {
    const resized = changes.filter((change) => change.type === "dimensions" && change.dimensions)
    if (resized.length) {
      const liveIds = new Set(draftRef.current?.nodes.map((node) => node.id))
      setMeasurements((current) => {
        let next = current
        for (const change of resized) {
          if (change.type !== "dimensions" || !change.dimensions || !liveIds.has(change.id)) continue
          const size = change.dimensions
          if (next[change.id]?.width === size.width && next[change.id]?.height === size.height) continue
          if (next === current) next = { ...current }
          next[change.id] = { width: size.width, height: size.height }
        }
        return next
      })
    }
    const selectChanges = changes.filter((change) => change.type === "select")
    if (selectChanges.length) setSelectedNodes((current) => {
      const next = new Set(current)
      for (const change of selectChanges) { if (change.selected) next.add(change.id); else next.delete(change.id) }
      return [...next]
    })
    const moved = changes.filter((change): change is NodePositionChange => change.type === "position" && !!change.position)
    if (moved.length) {
      if (draggingRef.current) setPositions((current) => ({ ...current, ...Object.fromEntries(moved.map((change) => [change.id, change.position!])) }))
      else commit((file) => moved.reduce((next, change) => updateCanvasNode(next, change.id, change.position!), file), "keyboard-move")
    }
  }

  function onEdgesChange(changes: EdgeChange[]) {
    const selectChanges = changes.filter((change) => change.type === "select")
    if (selectChanges.length) setSelectedEdges((current) => {
      const next = new Set(current)
      for (const change of selectChanges) { if (change.selected) next.add(change.id); else next.delete(change.id) }
      return [...next]
    })
  }

  function connect(connection: Connection) {
    if (!connection.source || !connection.target) return
    commit((file) => addCanvasEdge(file, { id: createCanvasId(), source: connection.source!, target: connection.target!, label: "",
      ...(connection.sourceHandle ? { sourceHandle: connection.sourceHandle as Position } : {}),
      ...(connection.targetHandle ? { targetHandle: connection.targetHandle as Position } : {}) }))
  }

  useEffect(() => {
    const element = viewportRef.current
    if (!element) return
    let start: { x: number; y: number; zoom: number; scale: number; clientX: number; clientY: number } | null = null
    function begin(event: Event) {
      event.preventDefault()
      const gesture = event as Event & { scale: number; clientX: number; clientY: number }
      const viewport = flowRef.current?.getViewport()
      if (viewport) start = { ...viewport, scale: gesture.scale || 1, clientX: gesture.clientX, clientY: gesture.clientY }
    }
    function change(event: Event) {
      event.preventDefault()
      if (!start || !element || blockedRef.current) return
      const gesture = event as Event & { scale: number }
      const rect = element.getBoundingClientRect()
      const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, start.zoom * (gesture.scale || 1) / start.scale))
      const x = start.clientX - rect.left; const y = start.clientY - rect.top
      void flowRef.current?.setViewport({ x: x - (x - start.x) * zoom / start.zoom, y: y - (y - start.y) * zoom / start.zoom, zoom })
    }
    function end(event: Event) { event.preventDefault(); start = null }
    element.addEventListener("gesturestart", begin); element.addEventListener("gesturechange", change); element.addEventListener("gestureend", end)
    return () => { element.removeEventListener("gesturestart", begin); element.removeEventListener("gesturechange", change); element.removeEventListener("gestureend", end) }
  }, [loading])

  const references = useMemo(() => fragments.filter((item) => !item.lockbox && !item.archived && item.content.slice(0, 2000).toLocaleLowerCase().includes(query.toLocaleLowerCase())).slice(0, 100), [fragments, query])
  const statusText = saveState?.status === "error" ? "保存失败" : saveState?.saving ? "正在保存" : saveState?.dirty || pendingText ? "等待保存" : "已保存"

  if (loading) return <div className="shard-canvas-loading" role="status">正在打开画布…</div>
  if (!draft) return <div className="shard-canvas-loading" role="alert"><p>{loadError || "画布无法打开"}</p>
    <Button variant="outline" onClick={() => setLoadAttempt((value) => value + 1)}>重新打开</Button></div>

  if (draft.kind === "shard.canvas") return <div className="shard-canvas-legacy" aria-label="旧画布拆分" aria-busy={recovering}>
    <strong>{draft.title}</strong>
    <p>这是一份旧版混合画布。思维导图和流程图现在分别保存在独立文档中。</p>
    <ul>{draft.nodes.filter(node => node.kind === "mindmap").map(node => <li key={node.id}>思维导图：{node.mindMap?.title || node.text}（{Object.keys(node.mindMap?.nodes ?? {}).length} 个主题）</li>)}
      {draft.nodes.some(node => node.kind !== "mindmap") && <li>流程图：{draft.nodes.filter(node => node.kind !== "mindmap").length} 个对象</li>}
    </ul>
    <p>拆分会保留原文件，并生成各类图文件与一份关联说明，记录原来的跨图连线。</p>
    {actionError && <p role="alert" className="shard-canvas-error-text">{actionError}</p>}
    {splitResult && <p role="status">已生成 {splitResult.documents.length} 份图文档和关联说明：{splitResult.indexPath}</p>}
    <Button disabled={blocked} onClick={() => { void splitLegacy() }}>{recovering ? "正在拆分…" : splitResult ? "打开关联说明" : "拆分为独立文档"}</Button>
  </div>

  return <div ref={rootRef} className="shard-canvas-workspace" data-canvas-workspace data-save-state={pendingText ? "dirty" : saveState?.status}
    tabIndex={-1} onKeyDownCapture={handleShortcut} onPointerDownCapture={cancelDeferredFocus} aria-label="图形工作台" aria-busy={blocked}
    onCompositionStartCapture={() => { composingRef.current = true; setComposing(true) }}
    onCompositionEndCapture={() => { composingRef.current = false; setComposing(false) }}>
    <header className="shard-canvas-toolbar" aria-label="画布工具栏">
      <DropdownMenu onOpenChange={(open) => { if (open) { skipMenuFocusRef.current = false; menuActionRef.current = null } }}
        onOpenChangeComplete={(open) => {
          if (open) return
          const action = menuActionRef.current
          menuActionRef.current = null
          action?.()
        }}><DropdownMenuTrigger render={<Button size="sm" variant="primary" disabled={blocked}>添加对象</Button>} />
        <DropdownMenuContent align="start" finalFocus={() => !skipMenuFocusRef.current}>
          {(["process", "decision", "terminal", "text"] as const).map((kind) => <DropdownMenuItem key={kind} onClick={() => runMenuAction(() => insertNode(kind))}>{NODE_LABELS[kind]}</DropdownMenuItem>)}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => runMenuAction(() => { setPicker("reference"); setQuery("") })}>资料引用</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <div className="shard-canvas-toolbar-group">
        <Button size="sm" variant="outline" disabled={blocked || !historyRef.current?.canUndo()} onClick={() => undo()}>撤销</Button>
        <Button size="sm" variant="outline" disabled={blocked || !historyRef.current?.canRedo()} onClick={() => undo(true)}>重做</Button>
        <Button size="sm" variant="outline" disabled={blocked || (!selectedNodes.length && !selectedEdges.length)} onClick={deleteSelection}>删除</Button>
      </div>
      {selectedNodes.length + selectedEdges.length > 1 && <span className="shard-canvas-selection-status" role="status">
        已选 {selectedNodes.length + selectedEdges.length} 个对象
      </span>}
      <span className={`shard-canvas-save-status${saveState?.status === "error" ? " shard-canvas-error-text" : ""}`} role="status">{statusText}</span>
      <Button size="sm" variant="outline" disabled={blocked || composing || !!recoveryAttemptRef.current || saveState?.saving || (!saveState?.dirty && !pendingText)}
        onClick={() => { if (!finalizeText()) return; if (saveState?.status === "error") void queueRef.current?.retry().then((ok) => { if (ok) callbacksRef.current.onSaved?.() }); else void flush() }}>
        {saveState?.status === "error" ? "重试保存" : "保存"}</Button>
      <Button size="sm" variant="outline" aria-label="对象面板" aria-expanded={inspectorVisible} aria-controls={inspectorId}
        onClick={() => {
          if (inspectorVisible) closeInspector()
          else if (!composingRef.current && finalizeText()) { setInspectorOpen(true); setInspectorPinned(true) }
        }}>对象面板</Button>
    </header>
    {(actionError || saveState?.error) && <div className="shard-canvas-error" role="alert">{actionError || saveState?.error}</div>}
    {(saveState?.status === "error" || recoveryError) && <div className="shard-canvas-recovery" aria-busy={recovering}>
      <span>{recoveryError || "当前草稿可以另存为新流程图，原文件和冲突副本都会保留。"}</span>
      <Button size="sm" variant="outline" disabled={externalBlockedRef.current || recovering || composing}
        onClick={() => { void recoverAsCopy() }}>{recovering ? "正在另存副本…" : recoveryAttemptRef.current ? "重试另存副本" : "另存流程图副本"}</Button>
    </div>}
    <div className="shard-canvas-body">
      <div className={`shard-canvas-viewport${connecting ? " is-connecting" : ""}`} ref={viewportRef}
        onDragOver={(event) => {
          if (!blockedRef.current && event.dataTransfer.types.includes(REFERENCE_DRAG_TYPE)) { event.preventDefault(); event.dataTransfer.dropEffect = "copy" }
        }}
        onDrop={(event) => {
          if (blockedRef.current || !event.dataTransfer.types.includes(REFERENCE_DRAG_TYPE)) return
          event.preventDefault()
          const id = event.dataTransfer.getData(REFERENCE_DRAG_TYPE)
          const item = fragments.find((fragment) => fragment.id === id && !fragment.lockbox && !fragment.archived)
          if (!item || !flowRef.current) return
          insertNode("reference", { text: item.content.slice(0, 100).split("\n")[0], link:
            { id: createCanvasId(), targetType: "fragment", targetId: item.id } },
          flowRef.current.screenToFlowPosition({ x: event.clientX, y: event.clientY }))
        }}>
        <ReactFlow<FlowNode, Edge> nodes={flowNodes} edges={flowEdges} nodeTypes={NODE_TYPES} onInit={(instance) => { flowRef.current = instance; setFlowReady(true); setZoomPercent(Math.round(instance.getZoom() * 100)) }}
          onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={connect} connectionMode={ConnectionMode.Loose}
          onConnectStart={() => setConnecting(true)} onConnectEnd={() => setConnecting(false)}
          onMove={(_event, viewport) => setZoomPercent(Math.round(viewport.zoom * 100))}
          nodesDraggable={!blocked} nodesConnectable={!blocked} elementsSelectable={!blocked} deleteKeyCode={null}
          onNodeDragStart={() => { draggingRef.current = true; historyRef.current?.breakMerge(); setEditing(null); setTreeSelection(null) }}
          onNodeDragStop={(_event, _node, nodes) => {
            draggingRef.current = false
            commit((file) => nodes.reduce((next, node) => updateCanvasNode(next, node.id, { x: node.position.x, y: node.position.y }), file))
            setPositions({})
          }}
          onNodeClick={(_event, node) => { if (node.id !== treeSelection?.nodeId) setTreeSelection(null); if (node.id !== editing) setEditing(null); setSelectedEdges([]) }}
          onEdgeClick={(_event, edge) => { setSelectedEdges([edge.id]); setSelectedNodes([]); setTreeSelection(null); setPicker(null); setEditing(null) }}
          onEdgeDoubleClick={(_event, edge) => { setSelectedEdges([edge.id]); setSelectedNodes([]); setPicker(null) }}
          onPaneClick={() => { setSelectedNodes([]); setSelectedEdges([]); setTreeSelection(null); setEditing(null); rootRef.current?.focus() }}
          panOnScroll zoomOnScroll={false} zoomOnPinch={!blocked} zoomOnDoubleClick={false} panOnDrag={blocked ? false : [1, 2]}
          selectionOnDrag={!blocked} selectionMode={SelectionMode.Partial} multiSelectionKeyCode={["Meta", "Control", "Shift"]}
          selectionKeyCode="Shift" panActivationKeyCode="Space" zoomActivationKeyCode={["Meta", "Control"]}
          minZoom={MIN_ZOOM} maxZoom={MAX_ZOOM} fitView fitViewOptions={{ padding: 0.2, maxZoom: 1 }} onlyRenderVisibleElements>
          <Background variant={BackgroundVariant.Dots} gap={24} color="var(--border-visible)" />
        </ReactFlow>
        {draft.nodes.length === 0 && <div className="shard-canvas-empty">添加流程节点，连接步骤；通过资料引用关联其他文档。</div>}
        <div className="shard-canvas-zoom" aria-label="画布缩放">
          <Button size="icon-sm" variant="outline" aria-label="缩小画布" disabled={blocked || zoomPercent <= MIN_ZOOM * 100} onClick={() => { void flowRef.current?.zoomOut() }}>−</Button>
          <Button size="sm" variant="outline" className="shard-canvas-zoom-value" aria-label="重置缩放" title="恢复 100%" disabled={blocked}
            onClick={() => { void flowRef.current?.zoomTo(1) }}>{zoomPercent}%</Button>
          <Button size="icon-sm" variant="outline" aria-label="放大画布" disabled={blocked || zoomPercent >= MAX_ZOOM * 100} onClick={() => { void flowRef.current?.zoomIn() }}>+</Button>
          <Button size="sm" variant="outline" disabled={blocked || !draft.nodes.length} onClick={() => { void flowRef.current?.fitView({ padding: 0.2, maxZoom: 1 }) }}>适合画布</Button>
        </div>
      </div>
      {inspectorVisible && <aside ref={inspectorRef} id={inspectorId} className="shard-canvas-inspector" aria-label="画布对象面板">
        <div className="shard-canvas-inspector-heading">
          <strong>{picker === "reference" ? "添加资料引用" : selectedNode ? NODE_LABELS[selectedNode.kind] : selectedEdge ? "连接线" : "画布"}</strong>
          <Button size="icon-sm" variant="outline" aria-label="关闭" title="收起对象面板" onClick={closeInspector}><XIcon /></Button>
        </div>
        {!picker && selectedMap && <>
          <div className="shard-canvas-inspector-tabs" role="tablist" aria-label="导图面板视图"
            onKeyDown={(event) => {
              if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return
              event.preventDefault(); event.stopPropagation()
              if (composingRef.current || !finalizeText()) return
              const tab = event.key === "Home" ? "properties" : event.key === "End" ? "outline" : inspectorTab === "properties" ? "outline" : "properties"
              changeInspectorTab(tab)
              event.currentTarget.querySelector<HTMLButtonElement>(`[data-view="${tab}"]`)?.focus()
            }}>
            {([['properties', '属性'], ['outline', '大纲']] as const).map(([tab, label]) => <button className="shard-canvas-inspector-tab" type="button" key={tab}
              id={`${inspectorId}-${tab}`} data-view={tab} role="tab" aria-selected={inspectorTab === tab}
              aria-controls={`${inspectorId}-content`} tabIndex={inspectorTab === tab ? 0 : -1}
              onClick={() => changeInspectorTab(tab)}>{label}</button>)}
          </div>
          <div className="shard-canvas-tree-actions" aria-label="主题操作">
            <Button size="sm" variant="outline" title="新建子节点（Tab）" disabled={blocked} onClick={() => editTree("child")}>子节点</Button>
            <Button size="sm" variant="outline" title="新建同级节点（Enter）" disabled={blocked || !selectedTreeNode || selectedTreeNode.id === selectedMap.rootId} onClick={() => editTree("sibling")}>同级节点</Button>
            <DropdownMenu onOpenChange={(open) => { if (open) { skipMenuFocusRef.current = false; menuActionRef.current = null } }}
              onOpenChangeComplete={(open) => {
                if (open) return
                const action = menuActionRef.current; menuActionRef.current = null; action?.()
              }}>
              <DropdownMenuTrigger render={<Button size="icon-sm" variant="outline" aria-label="更多主题操作" title="更多主题操作" disabled={blocked}><MoreHorizontalIcon /></Button>} />
              <DropdownMenuContent align="end" finalFocus={() => !skipMenuFocusRef.current}>
                {([
                  ["collapse", selectedTreeNode?.collapsed ? "展开" : "折叠"],
                  ["before", "在前面插入同级"], ["parent", "插入父节点"], ["up", "上移主题"], ["down", "下移主题"],
                ] as const).map(([action, label]) => <DropdownMenuItem key={action}
                  disabled={!selectedTreeNode || selectedTreeNode.id === selectedMap.rootId || (action === "collapse" && !getMindMapChildren(selectedMap, selectedTreeNode.id).length)}
                  onClick={() => { skipMenuFocusRef.current = true; menuActionRef.current = () => editTree(action) }}>{label}</DropdownMenuItem>)}
                <DropdownMenuSeparator />
                <DropdownMenuItem disabled={!selectedTreeNode || selectedTreeNode.id === selectedMap.rootId} variant="destructive"
                  onClick={() => { skipMenuFocusRef.current = true; menuActionRef.current = () => editTree("delete-only") }}>删除节点，保留子节点</DropdownMenuItem>
                <DropdownMenuItem disabled={!selectedTreeNode || selectedTreeNode.id === selectedMap.rootId} variant="destructive"
                  onClick={() => { skipMenuFocusRef.current = true; menuActionRef.current = () => editTree("delete") }}>删除节点及子节点</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </>}
        <div id={`${inspectorId}-content`} className="shard-canvas-inspector-body" role={!picker && selectedMap ? "tabpanel" : undefined}
          aria-labelledby={!picker && selectedMap ? `${inspectorId}-${inspectorTab}` : undefined}>
          {picker ? <>
          <Input aria-label="搜索资料" placeholder="搜索…" value={query} onChange={(event) => setQuery(event.target.value)} />
          <div className="shard-canvas-picker-list" aria-busy={pickerLoading}>
            {references.map((item) => <button type="button" className="shard-canvas-picker-item" key={item.id}
              draggable={!blocked} onDragStart={(event) => { event.dataTransfer.setData(REFERENCE_DRAG_TYPE, item.id); event.dataTransfer.effectAllowed = "copy" }}
              disabled={blocked} onClick={() => insertNode("reference", { text: item.content.slice(0, 100).split("\n")[0], link:
                { id: createCanvasId(), targetType: "fragment", targetId: item.id } })}>
              <span>{deriveKind(item.tags) === "note" ? "文档" : "碎片"}</span><strong>{item.content.slice(0, 64).split("\n")[0].replace(/^#+\s*/, "") || "未命名资料"}</strong>
            </button>)}
            {documents.filter(item => item.id !== draft.id && item.title.toLocaleLowerCase().includes(query.toLocaleLowerCase())).map(item =>
              <button type="button" className="shard-canvas-picker-item" key={`${item.kind}:${item.id}`} disabled={blocked}
                onClick={() => insertNode("reference", { text: item.title, link: { id: createCanvasId(), targetType: item.kind === "mindmap" ? "map" : "flow", targetId: item.id } })}>
                <span>{item.kind === "mindmap" ? "思维导图" : "流程图"}</span><strong>{item.title}</strong>
              </button>)}
            {pickerLoading && <p role="status">正在读取图文档…</p>}
            {!pickerLoading && !references.length && !documents.some(item => item.id !== draft.id && item.title.toLocaleLowerCase().includes(query.toLocaleLowerCase())) && <p>没有匹配的公开资料。</p>}
          </div>
          </> : selectedMap && selectedNode ? inspectorTab === "outline" ? <>
            <div className="shard-canvas-section-heading"><span>主题大纲</span><span>{Object.keys(selectedMap.nodes).length} 个主题</span></div>
            <div className="shard-canvas-outline" aria-label="导图大纲">{treeRows.map((row) => {
              const children = getMindMapChildren(selectedMap, row.node.id)
              return <div className="shard-canvas-outline-item" key={row.node.id}
                style={{ paddingInlineStart: `calc(${Math.min(row.depth, 10)} * var(--space-3))` }}>
                {children.length > 0 && row.node.id !== selectedMap.rootId ? <button type="button" className="shard-canvas-outline-toggle"
                  aria-label={`${row.node.collapsed ? "展开" : "折叠"}分支：${row.node.text || "新主题"}`} aria-expanded={!row.node.collapsed}
                  disabled={blocked} onClick={() => toggleOutlineBranch(row.node.id)}>{row.node.collapsed ? <ChevronRightIcon /> : <ChevronDownIcon />}</button>
                  : <span className="shard-canvas-outline-spacer" />}
                <button type="button" className={`shard-canvas-outline-row${selectedTreeNode?.id === row.node.id ? " is-selected" : ""}`}
                  data-tree-node-id={row.node.id} aria-pressed={selectedTreeNode?.id === row.node.id} disabled={blocked} title={row.node.text || "新主题"}
                  tabIndex={selectedTreeNode?.id === row.node.id || (!selectedTreeNode && row.node.id === selectedMap.rootId) ? 0 : -1}
                  onFocus={() => {
                    if (selectedTreeNode?.id === row.node.id) return
                    selectTree(selectedNode.id, row.node.id, false)
                    treeFocusRef.current = null
                  }}
                  onClick={() => {
                    selectTree(selectedNode.id, row.node.id, false)
                    treeRevealRef.current = { nodeId: selectedNode.id, treeNodeId: row.node.id }
                  }}
                  onDoubleClick={() => selectTree(selectedNode.id, row.node.id, true)}>{row.node.text || "新主题"}</button>
              </div>
            })}</div>
          </> : selectedTreeNode ? <>
            <div className="shard-canvas-topic-context"><span>{selectedTreeNode.id === selectedMap.rootId ? "中心主题" : "子主题"}</span>
              <strong title={selectedTreeNode.text}>{selectedTreeNode.text || "新主题"}</strong></div>
            <section className="shard-canvas-inspector-section">
          <label className="shard-canvas-field">节点文字
            <textarea ref={treeEditorRef} aria-label="导图节点文字" rows={3}
              value={pendingText?.kind === "tree" && pendingText.id === selectedNode.id && pendingText.treeNodeId === selectedTreeNode.id ? pendingText.text : selectedTreeNode.text}
              disabled={blocked} className="shard-canvas-inspector-editor"
              onChange={(event) => stageText({ kind: "tree", id: selectedNode.id, treeNodeId: selectedTreeNode.id, text: event.target.value })} onBlur={breakMerge}
              onKeyDown={(event) => {
                if (composingRef.current || event.nativeEvent.isComposing || event.keyCode === 229) return
                if (event.key === "Escape" || (event.key === "Enter" && (event.metaKey || event.ctrlKey))) {
                  event.preventDefault(); event.stopPropagation()
                  if (finalizeText()) { historyRef.current?.breakMerge(); selectTree(selectedNode.id, selectedTreeNode.id, false) }
                  return
                }
                if (!event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey && (event.key === "Tab" || event.key === "Enter")) {
                  event.preventDefault(); event.stopPropagation(); editTree(event.key === "Tab" ? "child" : "sibling")
                }
              }} />
          </label>
            </section>
            <section className="shard-canvas-inspector-section" aria-label="主题外观">
              <h3>外观</h3>
              <fieldset className="shard-canvas-tone-field"><legend>强调色</legend><div className="shard-canvas-tone-options">
                {(Object.entries(TOPIC_TONES) as [keyof typeof TOPIC_TONES, string][]).map(([tone, label]) => <button className="shard-canvas-tone-option" type="button" key={tone}
                  data-tone={tone} aria-label={`主题颜色：${label}`} title={label} aria-pressed={(selectedTreeNode.style?.tone ?? "default") === tone}
                  disabled={blocked} onClick={() => updateTopicProperties({ style: { ...selectedTreeNode.style, tone } })}>
                  <span>{(selectedTreeNode.style?.tone ?? "default") === tone && <CheckIcon />}</span><small>{label}</small>
                </button>)}
              </div></fieldset>
              <label className="shard-canvas-property-row">节点宽度
                <SelectControl className="shard-canvas-width-select" size="sm" aria-label="节点宽度" value={String(selectedTreeNode.width ?? "")} disabled={blocked}
                  onValueChange={value => updateTopicProperties({ width: value ? Number(value) : undefined })}
                  options={[{ value: "", label: "自动" }, { value: "160", label: "紧凑" }, { value: "240", label: "适中" }, { value: "360", label: "宽" },
                    ...(selectedTreeNode.width && ![160, 240, 360].includes(selectedTreeNode.width) ? [{ value: String(selectedTreeNode.width), label: "自定义" }] : [])]} />
              </label>
            </section>
            <div className="shard-canvas-key-hints"><span><kbd>Enter</kbd> 同级</span><span><kbd>Tab</kbd> 子节点</span><span><kbd>Space</kbd> 编辑</span></div>
          </> : <div className="shard-canvas-panel-empty"><strong>{selectedMap.title}</strong><p>{Object.keys(selectedMap.nodes).length} 个主题</p>
            <Button size="sm" variant="outline" onClick={() => selectTree(selectedNode.id, selectedMap.rootId, false)}>选择中心主题</Button>
          </div> : selectedEdge ? <section className="shard-canvas-inspector-section"><label className="shard-canvas-field">连线标签
            <Input aria-label="连线标签" value={pendingText?.kind === "edge" && pendingText.id === selectedEdge.id ? pendingText.text : selectedEdge.label} disabled={blocked}
              onChange={(event) => stageText({ kind: "edge", id: selectedEdge.id, text: event.target.value })} onBlur={breakMerge} />
          </label></section> : selectedNode ? selectedNode.kind === "reference" ? <div className="shard-canvas-reference-detail">
            <strong>{sourcePreview(selectedNode.link, fragments, documents).title}</strong><p>{sourcePreview(selectedNode.link, fragments, documents).excerpt}</p>
            <Button size="sm" variant="outline" disabled={blocked || sourcePreview(selectedNode.link, fragments, documents).missing}
              onClick={() => selectedNode.link && void openLink(selectedNode.link)}>{sourcePreview(selectedNode.link, fragments, documents).isFragment ? "在碎片中打开" : "打开原文"}</Button>
          </div> : <section className="shard-canvas-inspector-section"><label className="shard-canvas-field">文字
            <textarea className="shard-canvas-inspector-editor" aria-label="对象文字" rows={3} disabled={blocked}
              value={pendingText?.kind === "node" && pendingText.id === selectedNode.id ? pendingText.text : selectedNode.text}
              onChange={(event) => stageText({ kind: "node", id: selectedNode.id, text: event.target.value })} onBlur={breakMerge}
              onKeyDown={(event) => {
                if (event.key === "Escape" && !composingRef.current && !event.nativeEvent.isComposing && finalizeText()) {
                  event.preventDefault(); event.stopPropagation(); setEditing(null); rootRef.current?.focus({ preventScroll: true })
                }
              }} />
          </label></section> : <div className="shard-canvas-panel-empty">
            <strong>{selectedNodes.length + selectedEdges.length > 1 ? `已选 ${selectedNodes.length + selectedEdges.length} 个对象` : "选择对象以查看属性"}</strong>
            <p>{selectedNodes.length + selectedEdges.length > 1 ? "可一起拖动，或在工具栏删除。选择单个对象可编辑其属性。" : "选择画布中的主题、图形或连接线。"}</p>
          </div>}
        </div>
      </aside>}
    </div>
  </div>
})
