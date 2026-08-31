import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { isTauri } from "@tauri-apps/api/core"
import {
  AlertTriangleIcon,
  GitBranchIcon,
  ListTreeIcon,
  Loader2Icon,
  SaveIcon,
  XIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { toast } from "sonner"

import { MindMapCanvasEditor } from "@/components/shard/mind-map-canvas-editor"
import { MindMapOutlineEditor } from "@/components/shard/mind-map-outline-editor"
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
import type { MindMapReadResult, MindMapSummary, ShardMapFile } from "@/types"

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
}

export interface MindMapCanvasHandle {
  requestClose: () => boolean
  save: () => Promise<boolean>
}

type MindMapWorkspaceView = "map" | "outline"
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
  // 撤销/重做历史：KB 级文件快照栈，上限 UNDO_STACK_LIMIT。
  // 用 ref 管理（无 UI 依赖），避免 setState updater 内的副作用。
  const draftFileRef = useRef<ShardMapFile | null>(null)
  const undoStackRef = useRef<ShardMapFile[]>([])
  const redoStackRef = useRef<ShardMapFile[]>([])
  const lastMergeKeyRef = useRef<string | null>(null)
  const rootRef = useRef<HTMLElement | null>(null)
  draftFileRef.current = draftFile
  const isSaving = saveMode !== null
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
      if (!readResult || !draftFile || isSaving) return false

      const draftSnapshot = JSON.stringify(draftFile)
      if (isMindMapFileContentEqual(readResult.file, draftFile)) return true

      setSaveMode(mode)
      setConflict(null)
      try {
        const saved = await writeMindMap(
          readResult.file.id,
          draftFile,
          readResult.file.revision,
          readResult.lastSavedHash
        )
        setReadResult(saved)
        setDraftFile((currentDraft) => {
          if (!currentDraft) return saved.file
          return JSON.stringify(currentDraft) === draftSnapshot ? saved.file : currentDraft
        })
        setAutoSaveError(null)
        // 保存点即撤销合并边界：之后继续打字应作为新的历史步骤，
        // 这样 ⌘Z 能先回到刚保存的状态（且不触发再次写盘）。
        lastMergeKeyRef.current = null
        await refreshSummaries()
        if (mode === "manual") {
          toast("思维导图已保存", { duration: 5000 })
        }
        return true
      } catch (unknownError) {
        const message = getApiErrorMessage(unknownError)
        setAutoSaveError(message)
        if (message.includes("冲突副本")) {
          setConflict({ draft: draftFile, message })
        }
        if (mode === "manual") {
          toast.error(`保存思维导图失败：${message}`, {
            duration: Infinity,
          })
        }
        return false
      } finally {
        setSaveMode(null)
      }
    },
    [draftFile, isSaving, readResult, refreshSummaries]
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
    }),
    [requestClose, save]
  )

  const updateDraft = useCallback(
    (file: ShardMapFile, meta?: MindMapChangeMeta) => {
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
      setDraftFile(file)
      setConflict(null)
      setAutoSaveError(null)
    },
    []
  )

  const undoDraft = useCallback(() => {
    const current = draftFileRef.current
    const previous = undoStackRef.current.pop()
    if (!current || !previous) return
    redoStackRef.current.push(current)
    lastMergeKeyRef.current = null
    setDraftFile(previous)
    setConflict(null)
  }, [])

  const redoDraft = useCallback(() => {
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
    setFocusNodeId(nodeId)
  }, [])

  const selectNodes = useCallback(
    (nodeIds: string[], primaryNodeId: string | null) => {
      const nextNodeIds = draftFile
        ? nodeIds.filter((nodeId) => draftFile.nodes[nodeId])
        : nodeIds
      setSelectedNodeIds([...new Set(nextNodeIds)])
      setFocusNodeId(nextNodeIds.length === 1 ? primaryNodeId : null)
    },
    [draftFile]
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

      const target = event.target
      if (!(target instanceof Node) || !rootRef.current?.contains(target)) return

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        if (!event.defaultPrevented) {
          event.preventDefault()
          void save()
        }
        return
      }

      // 思维导图全屏界面内，Tab 只表达"新增子节点/缩进"语义；
      // 禁止默认的焦点迁移把焦点甩到底部全局操作区（退出/切换/保存按钮）。
      // 编辑器自身的 Tab 处理在目标阶段已执行，这里的 preventDefault 不影响它。
      if (event.key === "Tab") {
        event.preventDefault()
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
    if (!isDirty || !draftFile || !readResult || isSaving || conflict || autoSaveError) return

    const timeoutId = window.setTimeout(() => {
      void save("auto")
    }, AUTO_SAVE_DELAY_MS)

    return () => window.clearTimeout(timeoutId)
  }, [autoSaveError, conflict, draftFile, isDirty, isSaving, readResult, save])

  // 导图就绪后把焦点收进画布根节点：快捷键 handler 以 rootRef.contains(target)
  // 限定作用域（避免嵌在第三栏时全局劫持 Tab），焦点若留在外部按钮或 body 上，
  // Tab 拦截不会触发，默认焦点迁移就会把焦点甩到底部全局操作区。
  useEffect(() => {
    if (!draftFile) return
    if (rootRef.current?.contains(document.activeElement)) return
    rootRef.current?.focus({ preventScroll: true })
  }, [draftFile])

  const canvas = (
    <section
      aria-label="思维导图画布"
      className={styles.canvas}
      onPointerDownCapture={() => {
        if (!rootRef.current?.contains(document.activeElement)) {
          rootRef.current?.focus({ preventScroll: true })
        }
      }}
      ref={rootRef}
      style={{
        background: "var(--background)",
        color: "var(--foreground)",
      }}
      tabIndex={-1}
    >
      <main
        style={{
          background: "var(--background)",
          flex: "1 1 0%",
          minHeight: 0,
          overflow: "hidden",
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
              className={styles.spinner}
              size={16}
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
            />
          ) : (
            <MindMapOutlineEditor
              file={draftFile}
              focusNodeId={focusNodeId}
              onChange={updateDraft}
              onFocusHandled={() => setFocusNodeId(null)}
              onSave={save}
              onSelectNode={selectNode}
              selectedNodeId={selectedNode?.id ?? null}
            />
          )
        ) : null}
      </main>

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
            <AlertTriangleIcon
              size={16}
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

      <footer
        className="shard-content-inset"
        style={{ flexShrink: 0, paddingBottom: "var(--shard-space-4)" }}
      >
        <div
          className="mx-auto flex w-fit max-w-full items-center gap-2 px-3 py-3"
          style={{
            background: "var(--card)",
            borderRadius: "var(--shard-surface-radius)",
            boxShadow: "var(--shard-composer-shadow)",
          }}
        >
          {toolbarLeading}

          {draftFile ? (
            <Button
              aria-label={
                view === "map" ? "切换到大纲视图" : "切换到思维导图视图"
              }
              onClick={() => setView(view === "map" ? "outline" : "map")}
              size="icon-sm"
              title={
                view === "map" ? "切换到大纲视图" : "切换到思维导图视图"
              }
              variant="ghost"
            >
              {view === "map" ? (
                <ListTreeIcon aria-hidden="true" />
              ) : (
                <GitBranchIcon aria-hidden="true" />
              )}
              <span className="sr-only">
                {view === "map" ? "切换到大纲视图" : "切换到思维导图视图"}
              </span>
            </Button>
          ) : null}

          <span
            style={{
              color: "var(--muted-foreground)",
              fontSize: 12,
              minWidth: 80,
              textAlign: "right",
            }}
          >
            {saveStatusText}
          </span>
          <Button
            aria-label={isSaving ? saveStatusText : "保存思维导图"}
            disabled={!isDirty || isSaving || !draftFile}
            onClick={() => void save("manual")}
            size="icon-sm"
            title={isSaving ? saveStatusText : "保存思维导图"}
            variant="default"
          >
            {isSaving ? (
              <Loader2Icon aria-hidden="true" className={styles.spinner} />
            ) : (
              <SaveIcon aria-hidden="true" />
            )}
            <span className="sr-only">
              {isSaving ? saveStatusText : "保存思维导图"}
            </span>
          </Button>
        </div>
      </footer>
    </section>
  )

  return surface ? surface(canvas) : canvas
})

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
