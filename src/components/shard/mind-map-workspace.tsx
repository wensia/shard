import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { isTauri } from "@tauri-apps/api/core"
import {
  TriangleAlertIcon,
  GitBranchIcon,
  ListTreeIcon,
  KeyboardIcon,
  Loader2Icon,
  SaveIcon,
  XIcon,
} from "@/components/icons"

import { Button } from "@/components/ui/button"
import { toast } from "sonner"

import { MindMapCanvasEditor, type MindMapCanvasSessionState } from "@/components/shard/mind-map-canvas-editor"
import { MindMapOutlineEditor, type MindMapOutlineSessionState } from "@/components/shard/mind-map-outline-editor"
import { MindMapDocumentInspector } from "@/components/shard/mind-map-document-inspector"
import { MindMapShortcuts } from "@/components/shard/mind-map-shortcuts"
import { ZenSurface } from "@/components/shard/zen-surface"
import {
  getApiErrorMessage,
  listMindMaps,
  readMindMap,
  setWindowControlsHidden,
  writeMindMap,
} from "@/lib/api"
import {
  isMindMapFileContentEqual,
  type MindMapChangeMeta,
} from "@/lib/mind-map-tree"
import type { Fragment, MindMapReadResult, MindMapSummary, ShardDocumentLink, ShardMapFile } from "@/types"

import styles from "./mind-map-workspace.module.css"

export interface MindMapWorkspaceProps {
  mapId: string
  onClose: () => void
  onMapsChange?: (maps: MindMapSummary[]) => void
}

export interface MindMapCanvasProps {
  mapId: string
  onMapsChange?: (maps: MindMapSummary[]) => void
  surface?: (canvas: ReactNode) => ReactNode
  toolbarLeading?: ReactNode
  fragments?: Fragment[]
  onOpenLink?: (link: ShardDocumentLink) => Promise<void> | void
  onSaveStateChange?: (state: "saved" | "dirty" | "saving" | "error") => void
}

export interface MindMapCanvasHandle {
  requestClose: () => boolean
  save: () => Promise<boolean>
  isDirty: () => boolean
  setInteractionBlocked: (blocked: boolean) => void
}

type MindMapWorkspaceView = "map" | "outline"
type MindMapSidePanel = "properties" | "shortcuts" | null
type SaveMode = "manual" | "auto"

type ConflictState = {
  draft: ShardMapFile
  message: string
}

const AUTO_SAVE_DELAY_MS = 1200
const UNDO_STACK_LIMIT = 100

export const MindMapCanvas = forwardRef<
  MindMapCanvasHandle,
  MindMapCanvasProps
>(function MindMapCanvas({
  mapId,
  onMapsChange,
  surface,
  toolbarLeading,
  fragments = [],
  onOpenLink,
  onSaveStateChange,
}, ref) {
  const [readResult, setReadResult] = useState<MindMapReadResult | null>(null)
  const [draftFile, setDraftFile] = useState<ShardMapFile | null>(null)
  const [view, setView] = useState<MindMapWorkspaceView>("map")
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([])
  const [focusNodeId, setFocusNodeId] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [saveMode, setSaveMode] = useState<SaveMode | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [autoSaveError, setAutoSaveError] = useState<string | null>(null)
  const [conflict, setConflict] = useState<ConflictState | null>(null)
  const [interactionBlocked, setInteractionBlocked] = useState(false)
  const [sidePanel, setSidePanel] = useState<MindMapSidePanel>(null)
  const inspectorOpen = sidePanel === "properties"
  const viewId = useId()
  const mapSessionRef = useRef<MindMapCanvasSessionState | null>(null)
  const outlineSessionRef = useRef<MindMapOutlineSessionState | null>(null)
  const editorFocusRef = useRef<{
    element: HTMLElement
    start?: number | null
    end?: number | null
    direction?: "forward" | "backward" | "none" | null
  } | null>(null)
  const restoreEditorFocusRef = useRef(false)
  const interactionBlockedRef = useRef(false)
  const readResultRef = useRef<MindMapReadResult | null>(null)
  const pendingSaveRef = useRef<Promise<boolean> | null>(null)
  const composingRef = useRef(false)
  const [isComposing, setIsComposing] = useState(false)
  // 撤销/重做历史：KB 级文件快照栈，上限 UNDO_STACK_LIMIT。
  // 用 ref 管理（无 UI 依赖），避免 setState updater 内的副作用。
  const draftFileRef = useRef<ShardMapFile | null>(null)
  const undoStackRef = useRef<ShardMapFile[]>([])
  const redoStackRef = useRef<ShardMapFile[]>([])
  const lastMergeKeyRef = useRef<string | null>(null)
  const rootRef = useRef<HTMLElement | null>(null)
  draftFileRef.current = draftFile
  readResultRef.current = readResult
  const isSaving = saveMode !== null

  function rememberEditorFocus(element: Element | null = document.activeElement) {
    if (!(element instanceof HTMLElement) || !element.closest("[data-mind-map-editor-region]")) return
    editorFocusRef.current = element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement
      ? { element, start: element.selectionStart, end: element.selectionEnd, direction: element.selectionDirection }
      : { element }
  }

  function closeSidePanel() {
    restoreEditorFocusRef.current = true
    setSidePanel(null)
  }

  function toggleSidePanel(panel: Exclude<MindMapSidePanel, null>) {
    if (composingRef.current || interactionBlockedRef.current) return
    rememberEditorFocus()
    if (sidePanel === panel) closeSidePanel()
    else setSidePanel(panel)
  }

  function changeView(nextView: MindMapWorkspaceView) {
    if (composingRef.current || interactionBlockedRef.current || nextView === view) return
    setFocusNodeId(null)
    editorFocusRef.current = null
    setView(nextView)
  }

  useLayoutEffect(() => {
    if (sidePanel) {
      rootRef.current?.querySelector<HTMLElement>("[data-mind-map-panel-header] button")?.focus({ preventScroll: true })
      return
    }
    if (!restoreEditorFocusRef.current) return
    restoreEditorFocusRef.current = false
    const previous = editorFocusRef.current
    const element = previous?.element.isConnected
      ? previous.element
      : rootRef.current?.querySelector<HTMLElement>("[data-mind-map-outline], [data-mind-map-context-menu]")
    element?.focus({ preventScroll: true })
    if (previous && element === previous.element && (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) && previous.start != null && previous.end != null) {
      element.setSelectionRange(previous.start, previous.end, previous.direction ?? undefined)
    }
  }, [sidePanel])
  // 时间戳归一化比较：撤销回到已保存内容时不算 dirty、不触发写盘。
  const isDirty =
    readResult && draftFile
      ? !isMindMapFileContentEqual(readResult.file, draftFile)
      : false
  const saveStatusText = saveMode
    ? saveMode === "auto"
      ? "自动保存中"
      : "保存中"
    : conflict
      ? "保存冲突"
      : autoSaveError
        ? "自动保存失败"
        : isDirty
          ? "等待自动保存"
          : draftFile
            ? "已自动保存"
            : ""

  useEffect(() => {
    onSaveStateChange?.(conflict || autoSaveError ? "error" : isSaving ? "saving" : isDirty ? "dirty" : "saved")
  }, [autoSaveError, conflict, isDirty, isSaving, onSaveStateChange])

  const selectedNodeId = useMemo(
    () =>
      draftFile
        ? selectedNodeIds.find((nodeId) => draftFile.nodes[nodeId]) ?? null
        : null,
    [draftFile, selectedNodeIds]
  )
  const selectedNode = useMemo(
    () => (draftFile && selectedNodeId ? draftFile.nodes[selectedNodeId] : null),
    [draftFile, selectedNodeId]
  )

  const loadMap = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      const next = await readMindMap(mapId)
      setReadResult(next)
      setDraftFile(next.file)
      setSelectedNodeIds([])
      setFocusNodeId(null)
      editorFocusRef.current = null
      setConflict(null)
      setAutoSaveError(null)
      undoStackRef.current = []
      redoStackRef.current = []
      lastMergeKeyRef.current = null
    } catch (unknownError) {
      setError(getApiErrorMessage(unknownError))
    } finally {
      setIsLoading(false)
    }
  }, [mapId])

  const refreshSummaries = useCallback(async () => {
    try {
      onMapsChange?.(await listMindMaps())
    } catch {
      // 保存后的列表刷新失败不影响当前编辑态；下次打开会重新读取。
    }
  }, [onMapsChange])

  const save = useCallback(
    async (mode: SaveMode = "manual") => {
      if (composingRef.current) return false
      while (pendingSaveRef.current) {
        if (!(await pendingSaveRef.current)) return false
      }
      if (!readResultRef.current || !draftFileRef.current) return true
      if (isMindMapFileContentEqual(readResultRef.current.file, draftFileRef.current)) return true

      const operation = (async () => {
        setSaveMode(mode)
        setConflict(null)
        try {
          // Drain the latest draft, including edits made while the previous write was in flight.
          while (readResultRef.current && draftFileRef.current &&
            !isMindMapFileContentEqual(readResultRef.current.file, draftFileRef.current)) {
            if (composingRef.current) return false
            const baseline = readResultRef.current
            const draft = draftFileRef.current
            const saved = await writeMindMap(baseline.file.id, draft, baseline.file.revision, baseline.lastSavedHash)
            readResultRef.current = saved
            setReadResult(saved)
            if (draftFileRef.current === draft) {
              draftFileRef.current = saved.file
              setDraftFile(saved.file)
            }
            setAutoSaveError(null)
            lastMergeKeyRef.current = null
          }
          if (composingRef.current) return false
          void refreshSummaries()
          if (mode === "manual") toast("思维导图已保存", { duration: 5000 })
          return true
        } catch (unknownError) {
          const message = getApiErrorMessage(unknownError)
          setAutoSaveError(message)
          if (message.includes("冲突副本") && draftFileRef.current) {
            setConflict({ draft: draftFileRef.current, message })
          }
          if (mode === "manual") toast.error(`保存思维导图失败：${message}`, { duration: Infinity })
          return false
        } finally {
          setSaveMode(null)
        }
      })()
      pendingSaveRef.current = operation
      try {
        return await operation
      } finally {
        if (pendingSaveRef.current === operation) pendingSaveRef.current = null
      }
    },
    [refreshSummaries]
  )

  const requestClose = useCallback(() => {
    if (isDirty && !window.confirm("思维导图有未保存修改，确定返回吗？")) {
      return false
    }
    return true
  }, [isDirty])

  useImperativeHandle(
    ref,
    () => ({
      requestClose,
      save: () => save("manual"),
      isDirty: () => Boolean(readResultRef.current && draftFileRef.current && !isMindMapFileContentEqual(readResultRef.current.file, draftFileRef.current)),
      setInteractionBlocked: (blocked) => {
        interactionBlockedRef.current = blocked
        setInteractionBlocked(blocked)
      },
    }),
    [requestClose, save]
  )

  const updateDraft = useCallback(
    (file: ShardMapFile, meta?: MindMapChangeMeta) => {
      if (interactionBlockedRef.current) return
      const current = draftFileRef.current
      const mergeKey = meta?.mergeKey ?? null
      // mergeKey 相同（同一节点连续打字）只更新 draft 不入栈；
      // 其余情况（结构操作/首次击键）先把当前 draft 压入历史。
      const shouldMerge =
        mergeKey !== null && mergeKey === lastMergeKeyRef.current
      if (current && !shouldMerge) {
        undoStackRef.current.push(current)
        if (undoStackRef.current.length > UNDO_STACK_LIMIT) {
          undoStackRef.current.shift()
        }
        redoStackRef.current = []
      }
      lastMergeKeyRef.current = mergeKey
      draftFileRef.current = file
      setDraftFile(file)
      setConflict(null)
      setAutoSaveError(null)
    },
    []
  )

  const undoDraft = useCallback(() => {
    if (interactionBlockedRef.current) return
    const current = draftFileRef.current
    const previous = undoStackRef.current.pop()
    if (!current || !previous) return
    redoStackRef.current.push(current)
    lastMergeKeyRef.current = null
    setDraftFile(previous)
    setConflict(null)
  }, [])

  const redoDraft = useCallback(() => {
    if (interactionBlockedRef.current) return
    const current = draftFileRef.current
    const next = redoStackRef.current.pop()
    if (!current || !next) return
    undoStackRef.current.push(current)
    lastMergeKeyRef.current = null
    setDraftFile(next)
    setConflict(null)
  }, [])

  const selectNode = useCallback((nodeId: string) => {
    setSelectedNodeIds([nodeId])
    setFocusNodeId(view === "outline" ? nodeId : null)
    rootRef.current?.querySelector<HTMLElement>("[data-mind-map-context-menu]")?.focus({ preventScroll: true })
  }, [view])

  // 大纲中的原生光标定位只改变选中态，不能反过来请求 focus/select 全文。
  const selectOutlineNode = useCallback((nodeId: string) => {
    setSelectedNodeIds([nodeId])
  }, [])

  const selectNodes = useCallback(
    (nodeIds: string[], primaryNodeId: string | null) => {
      const nextNodeIds = draftFile
        ? nodeIds.filter((nodeId) => draftFile.nodes[nodeId])
        : nodeIds
      setSelectedNodeIds([...new Set(nextNodeIds)])
      setFocusNodeId(view === "outline" && nextNodeIds.length === 1 ? primaryNodeId : null)
    },
    [draftFile, view]
  )

  const keepDiskVersion = useCallback(async () => {
    await loadMap()
    toast("已载入磁盘版本", { duration: 5000 })
  }, [loadMap])

  const keepMyVersion = useCallback(async () => {
    if (!readResult || !conflict || isSaving) return

    setSaveMode("manual")
    setAutoSaveError(null)
    try {
      const latest = await readMindMap(readResult.file.id)
      const saved = await writeMindMap(
        latest.file.id,
        conflict.draft,
        latest.file.revision,
        latest.lastSavedHash
      )
      setReadResult(saved)
      setDraftFile(saved.file)
      setConflict(null)
      undoStackRef.current = []
      redoStackRef.current = []
      lastMergeKeyRef.current = null
      await refreshSummaries()
      toast("已保存我的版本", { duration: 5000 })
    } catch (unknownError) {
      toast.error(`保存我的版本失败：${getApiErrorMessage(unknownError)}`, {
        duration: Infinity,
      })
    } finally {
      setSaveMode(null)
    }
  }, [conflict, isSaving, readResult, refreshSummaries])

  useEffect(() => {
    void loadMap()
  }, [loadMap])

  useEffect(() => {
    if (!draftFile) {
      setSelectedNodeIds([])
      setFocusNodeId(null)
      return
    }

    setSelectedNodeIds((currentNodeIds) =>
      currentNodeIds.filter((nodeId) => draftFile.nodes[nodeId])
    )
  }, [draftFile])

  useEffect(() => {
    function handleShortcut(event: KeyboardEvent) {
      const isComposing =
        event.isComposing || event.key === "Process" || event.keyCode === 229
      if (isComposing) return

      if (!isMindMapWorkspaceTarget(rootRef.current, event.target)) return
      if (interactionBlockedRef.current) return

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        if (!event.defaultPrevented) {
          event.preventDefault()
          void save()
        }
        return
      }

      // 撤销/重做统一走自定义历史栈（受控 textarea 的原生撤销会被
      // React 重赋值破坏，WKWebView 下尤甚），文本编辑靠 mergeKey 合并。
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault()
        if (event.shiftKey) {
          redoDraft()
        } else {
          undoDraft()
        }
      }
    }

    window.addEventListener("keydown", handleShortcut)
    return () => window.removeEventListener("keydown", handleShortcut)
  }, [redoDraft, save, undoDraft])

  useEffect(() => {
    if (!isDirty || !draftFile || !readResult || isSaving || isComposing || conflict || autoSaveError) return

    const timeoutId = window.setTimeout(() => {
      void save("auto")
    }, AUTO_SAVE_DELAY_MS)

    return () => window.clearTimeout(timeoutId)
  }, [autoSaveError, conflict, draftFile, isComposing, isDirty, isSaving, readResult, save])

  // 初次打开及禅模式容器切换后收进工作区；已有内部焦点保持不变。
  useEffect(() => {
    if (!draftFile) return
    if (isMindMapWorkspaceTarget(rootRef.current, document.activeElement)) return
    rootRef.current?.focus({ preventScroll: true })
  }, [draftFile, surface])

  const canvas = (
    <section
      aria-label="思维导图画布"
      className={styles.canvas}
      onKeyDownCapture={event => {
        if (sidePanel && event.key === "Escape" && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229
          && event.target instanceof Element && rootRef.current?.contains(event.target)
          && event.target.closest('[data-mind-map-side-panel], [data-mind-map-workspace-toolbar]')
          && !event.target.closest('[role="listbox"], [role="menu"], [role="dialog"]')) {
          event.preventDefault()
          event.stopPropagation()
          closeSidePanel()
        }
      }}
      onPointerDownCapture={() => {
        if (!isMindMapWorkspaceTarget(rootRef.current, document.activeElement)) {
          rootRef.current?.focus({ preventScroll: true })
        }
      }}
      ref={rootRef}
      style={{
        background: "var(--background)",
        color: "var(--foreground)",
      }}
      tabIndex={-1}
      aria-busy={interactionBlocked}
      onCompositionStartCapture={() => { composingRef.current = true; setIsComposing(true) }}
      onCompositionEndCapture={() => { composingRef.current = false; setIsComposing(false) }}
    >
      <div className={styles.toolbar} data-mind-map-workspace-toolbar inert={interactionBlocked}>
        {toolbarLeading}
        <div className={styles.viewTabs} role="tablist" aria-label="思维导图视图">
          {(["outline", "map"] as const).map((mode, index) => <Button
            key={mode} role="tab" id={`${viewId}-${mode}-tab`} aria-controls={`${viewId}-panel`}
            aria-selected={view === mode} tabIndex={view === mode ? 0 : -1}
            className={styles.viewTab} size="sm" variant="ghost"
            disabled={!draftFile || isLoading || isComposing || interactionBlocked}
            onClick={() => changeView(mode)} onKeyDown={event => {
              if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return
              event.preventDefault()
              const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? 1 : 1 - index
              changeView(nextIndex === 0 ? "outline" : "map")
              event.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="tab"]')[nextIndex]?.focus()
            }}>
            {mode === "map" ? <GitBranchIcon /> : <ListTreeIcon />}
            {mode === "map" ? "思维导图" : "大纲"}
          </Button>)}
        </div>
        <div className={styles.toolbarActions}>
          <Button aria-label={inspectorOpen ? "隐藏检查器" : "显示检查器"} aria-pressed={inspectorOpen}
            disabled={!draftFile || isLoading || isComposing || interactionBlocked} onClick={() => toggleSidePanel("properties")} size="sm" variant="ghost">主题属性</Button>
          <Button aria-pressed={sidePanel === "shortcuts"} disabled={!draftFile || isLoading || isComposing || interactionBlocked}
            onClick={() => toggleSidePanel("shortcuts")} size="sm" variant="ghost"><KeyboardIcon />快捷键</Button>
        </div>
        <div className={styles.saveControls}>
          <span className={styles.saveStatus} role="status">{saveStatusText}</span>
          <Button aria-label={isSaving ? saveStatusText : "保存思维导图"}
            disabled={!isDirty || isSaving || !draftFile || isComposing || interactionBlocked}
            onClick={() => void save("manual")} size="icon-sm" title={isSaving ? saveStatusText : "保存思维导图"} variant="ghost">
            {isSaving ? <Loader2Icon className={styles.spinner} /> : <SaveIcon />}
          </Button>
        </div>
      </div>
      <div className={styles.editorBody} inert={interactionBlocked}>
      <main
        role="tabpanel" id={`${viewId}-panel`} aria-labelledby={`${viewId}-${view}-tab`}
        data-mind-map-editor-region
        onBlurCapture={event => rememberEditorFocus(event.target)}
        style={{
          background: "var(--background)",
          flex: "1 1 0%",
          minHeight: 0,
          overflow: "hidden",
          display: "flex",
          minWidth: 0,
        }}
      >
        {isLoading ? (
          <div
            style={{
              alignItems: "center",
              color: "var(--muted-foreground)",
              display: "flex",
              fontSize: 14,
              height: "100%",
              justifyContent: "center",
            }}
          >
            <Loader2Icon
              className={`${styles.spinner} size-(--shard-icon-size-md)`}
              style={{ marginRight: "var(--shard-space-2)" }}
            />
            正在打开思维导图
          </div>
        ) : error ? (
          <div
            style={{
              alignItems: "center",
              color: "var(--muted-foreground)",
              display: "flex",
              fontSize: 14,
              height: "100%",
              justifyContent: "center",
            }}
          >
            {error}
          </div>
        ) : draftFile ? (
          view === "map" ? (
            <MindMapCanvasEditor
              file={draftFile}
              onChange={updateDraft}
              onSave={save}
              onSelectNode={selectNode}
              onSelectNodes={selectNodes}
              selectedNodeId={selectedNode?.id ?? null}
              selectedNodeIds={selectedNodeIds}
              inspectorVisible={sidePanel !== null}
              sessionStateRef={mapSessionRef}
            />
          ) : (
            <MindMapOutlineEditor
              file={draftFile}
              focusNodeId={focusNodeId}
              onChange={updateDraft}
              onFocusHandled={() => setFocusNodeId(null)}
              onSave={save}
              onSelectNode={selectOutlineNode}
              selectedNodeId={selectedNode?.id ?? null}
              sessionStateRef={outlineSessionRef}
            />
          )
        ) : null}
      </main>
      {!isLoading && draftFile && inspectorOpen && <MindMapDocumentInspector
        file={draftFile} selectedNodeIds={selectedNodeIds} onSelectNode={selectNode}
        onChange={updateDraft} fragments={fragments} onClose={closeSidePanel}
        onOpenLink={onOpenLink ? async (link) => {
          interactionBlockedRef.current = true
          setInteractionBlocked(true)
          try {
            if (await save("auto")) await onOpenLink(link)
          } catch (unknownError) {
            toast.error(`打开关联文档失败：${getApiErrorMessage(unknownError)}`)
          } finally {
            interactionBlockedRef.current = false
            setInteractionBlocked(false)
          }
        } : undefined}
      />}
      {!isLoading && draftFile && sidePanel === "shortcuts" && <MindMapShortcuts view={view} onClose={closeSidePanel} />}
      </div>

      {conflict ? (
        <div
          className="shard-content-inset"
          style={{ flexShrink: 0, paddingBottom: "var(--shard-space-2)" }}
        >
          <div
            className="flex items-start gap-2 px-3 py-3"
            style={{
              background: "color-mix(in srgb, var(--destructive) 5%, transparent)",
              border: "1px solid color-mix(in srgb, var(--destructive) 30%, transparent)",
              borderRadius: "var(--shard-radius-control)",
              marginInline: "auto",
              maxWidth: 896,
            }}
          >
            <TriangleAlertIcon
              className="size-(--shard-icon-size-md)"
              style={{ color: "var(--destructive)", flexShrink: 0, marginTop: 2 }}
            />
            <div style={{ flex: "1 1 0%", minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 600 }}>检测到保存冲突</div>
              <p
                style={{
                  color: "var(--muted-foreground)",
                  fontSize: 12,
                  margin: 0,
                  marginTop: 4,
                  overflowWrap: "break-word",
                }}
              >
                {conflict.message}
              </p>
            </div>
            <Button
              disabled={isSaving}
              onClick={() => void keepMyVersion()}
              size="sm"
              variant="default"
            >
              保留我的版本
            </Button>
            <Button
              disabled={isSaving}
              onClick={() => void keepDiskVersion()}
              size="sm"
              variant="secondary"
            >
              保留磁盘版本
            </Button>
          </div>
        </div>
      ) : null}

    </section>
  )

  return surface ? surface(canvas) : canvas
})

function isMindMapWorkspaceTarget(root: HTMLElement | null, target: EventTarget | null) {
  const menuOwnerId = target instanceof Element
    ? target.closest<HTMLElement>("[data-mind-map-menu-owner]")?.dataset.mindMapMenuOwner : null
  const owner = menuOwnerId ? document.getElementById(menuOwnerId) : target
  return owner instanceof Node && Boolean(root?.contains(owner))
}

export function MindMapWorkspace({
  mapId,
  onClose,
  onMapsChange,
}: MindMapWorkspaceProps) {
  const canvasRef = useRef<MindMapCanvasHandle>(null)

  const closeWorkspace = useCallback(() => {
    if (canvasRef.current?.requestClose() ?? true) {
      onClose()
    }
  }, [onClose])

  const saveAndCloseWorkspace = useCallback(async () => {
    if (await canvasRef.current?.save()) {
      onClose()
    }
  }, [onClose])

  useEffect(() => {
    if (!isTauri()) return

    void setWindowControlsHidden(true).catch((error) => {
      console.warn("Unable to hide window controls for mind map editor", error)
    })

    return () => {
      void setWindowControlsHidden(false).catch((error) => {
        console.warn("Unable to restore window controls", error)
      })
    }
  }, [])

  useEffect(() => {
    function handleShortcut(event: KeyboardEvent) {
      const isComposing =
        event.isComposing || event.key === "Process" || event.keyCode === 229
      if (
        isComposing ||
        event.defaultPrevented ||
        !(event.target instanceof Element) ||
        !event.target.closest('[aria-label="思维导图工作区"]') ||
        !(event.metaKey || event.ctrlKey) ||
        event.key !== "Enter"
      ) {
        return
      }

      event.preventDefault()
      void saveAndCloseWorkspace()
    }

    window.addEventListener("keydown", handleShortcut)
    return () => window.removeEventListener("keydown", handleShortcut)
  }, [saveAndCloseWorkspace])

  return (
    <ZenSurface
      ariaLabel="思维导图工作区"
      onRequestClose={closeWorkspace}
    >
      <MindMapCanvas
        mapId={mapId}
        onMapsChange={onMapsChange}
        ref={canvasRef}
        toolbarLeading={
          <Button
            aria-label="退出思维导图"
            onClick={closeWorkspace}
            size="icon-sm"
            title="退出思维导图（Cmd/Ctrl+Enter 保存并关闭）"
            variant="ghost"
          >
            <XIcon aria-hidden="true" />
            <span className="sr-only">退出思维导图</span>
          </Button>
        }
      />
    </ZenSurface>
  )
}
