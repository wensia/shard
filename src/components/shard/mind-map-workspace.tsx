import { useCallback, useEffect, useMemo, useState } from "react"
import { isTauri } from "@tauri-apps/api/core"
import {
  AlertTriangleIcon,
  Loader2Icon,
  SaveIcon,
  XIcon,
} from "lucide-react"
import { toast } from "sonner"

import { MindMapCanvasEditor } from "@/components/shard/mind-map-canvas-editor"
import { MindMapOutlineEditor } from "@/components/shard/mind-map-outline-editor"
import { Button } from "@/components/ui/button"
import {
  getApiErrorMessage,
  listMindMaps,
  readMindMap,
  setWindowControlsHidden,
  writeMindMap,
} from "@/lib/api"
import type { MindMapReadResult, MindMapSummary, ShardMapFile } from "@/types"

interface MindMapWorkspaceProps {
  mapId: string
  onClose: () => void
  onMapsChange?: (maps: MindMapSummary[]) => void
}

type MindMapWorkspaceView = "map" | "outline"
type SaveMode = "manual" | "auto"

type ConflictState = {
  draft: ShardMapFile
  message: string
}

const AUTO_SAVE_DELAY_MS = 1200

export function MindMapWorkspace({
  mapId,
  onClose,
  onMapsChange,
}: MindMapWorkspaceProps) {
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
  const isSaving = saveMode !== null
  const isDirty =
    readResult && draftFile
      ? JSON.stringify(readResult.file) !== JSON.stringify(draftFile)
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
      if (!readResult || !draftFile || isSaving) return

      const draftSnapshot = JSON.stringify(draftFile)
      if (JSON.stringify(readResult.file) === draftSnapshot) return

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
        await refreshSummaries()
        if (mode === "manual") {
          toast.success("思维导图已保存")
        }
      } catch (unknownError) {
        const message = getApiErrorMessage(unknownError)
        setAutoSaveError(message)
        if (message.includes("冲突副本")) {
          setConflict({ draft: draftFile, message })
        }
        if (mode === "manual") {
          toast.error("保存思维导图失败", { description: message })
        }
      } finally {
        setSaveMode(null)
      }
    },
    [draftFile, isSaving, readResult, refreshSummaries]
  )

  const closeWorkspace = useCallback(() => {
    if (isDirty && !window.confirm("思维导图有未保存修改，确定返回吗？")) {
      return
    }
    onClose()
  }, [isDirty, onClose])

  const updateDraft = useCallback((file: ShardMapFile) => {
    setDraftFile(file)
    setConflict(null)
    setAutoSaveError(null)
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
    toast.success("已载入磁盘版本")
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
      await refreshSummaries()
      toast.success("已保存我的版本")
    } catch (unknownError) {
      toast.error("保存我的版本失败", {
        description: getApiErrorMessage(unknownError),
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
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault()
        void save()
        return
      }

      if (event.key === "Escape") {
        event.preventDefault()
        closeWorkspace()
      }
    }

    window.addEventListener("keydown", handleShortcut)
    return () => window.removeEventListener("keydown", handleShortcut)
  }, [closeWorkspace, save])

  useEffect(() => {
    if (!isDirty || !draftFile || !readResult || isSaving || conflict || autoSaveError) return

    const timeoutId = window.setTimeout(() => {
      void save("auto")
    }, AUTO_SAVE_DELAY_MS)

    return () => window.clearTimeout(timeoutId)
  }, [autoSaveError, conflict, draftFile, isDirty, isSaving, readResult, save])

  return (
    <div className="fixed inset-0 z-50 flex min-h-0 flex-col overflow-hidden bg-white text-foreground">
      <main className="min-h-0 flex-1 overflow-hidden bg-white">
        {isLoading ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            <Loader2Icon className="mr-[var(--shard-space-2)] size-4 animate-spin" />
            正在打开思维导图
          </div>
        ) : error ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
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
        <div className="shard-content-inset shrink-0 pb-[var(--shard-space-2)]">
          <div className="mx-auto flex max-w-4xl items-start gap-[var(--shard-space-2)] rounded-[var(--shard-radius-control)] border border-destructive/30 bg-destructive/5 px-[var(--shard-space-3)] py-[var(--shard-space-3)]">
            <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold">检测到保存冲突</div>
              <p className="mt-1 break-words text-xs text-muted-foreground">
                {conflict.message}
              </p>
            </div>
            <Button
              disabled={isSaving}
              onClick={() => void keepMyVersion()}
              size="sm"
              type="button"
            >
              保留我的版本
            </Button>
            <Button
              disabled={isSaving}
              onClick={() => void keepDiskVersion()}
              size="sm"
              type="button"
              variant="outline"
            >
              保留磁盘版本
            </Button>
          </div>
        </div>
      ) : null}

      <footer className="shard-content-inset shrink-0 pb-[var(--shard-space-4)]">
        <div className="mx-auto flex w-fit max-w-full items-center gap-[var(--shard-space-2)] rounded-[var(--shard-surface-radius)] bg-card p-[var(--shard-space-3)] shadow-[var(--shard-composer-shadow)]">
          <Button
            aria-label="退出思维导图"
            onClick={closeWorkspace}
            size="icon-sm"
            title="退出思维导图"
            type="button"
            variant="ghost"
          >
            <XIcon data-icon="inline-start" />
          </Button>

          {draftFile ? (
            <div
              aria-label="视图切换"
              className="flex rounded-[var(--shard-radius-control)] border border-border bg-background p-0.5"
            >
              <Button
                onClick={() => setView("map")}
                size="sm"
                type="button"
                variant={view === "map" ? "secondary" : "ghost"}
              >
                思维导图
              </Button>
              <Button
                onClick={() => setView("outline")}
                size="sm"
                type="button"
                variant={view === "outline" ? "secondary" : "ghost"}
              >
                大纲
              </Button>
            </div>
          ) : null}

          <span className="min-w-20 text-right text-xs text-muted-foreground">
            {saveStatusText}
          </span>
          <Button
            disabled={!isDirty || isSaving || !draftFile}
            onClick={() => void save("manual")}
            size="icon-sm"
            title={isSaving ? saveStatusText : "保存思维导图"}
            type="button"
            variant="ghost"
          >
            {isSaving ? (
              <Loader2Icon className="animate-spin" data-icon="inline-start" />
            ) : (
              <SaveIcon data-icon="inline-start" />
            )}
            <span className="sr-only">{isSaving ? saveStatusText : "保存思维导图"}</span>
          </Button>
        </div>
      </footer>
    </div>
  )
}
