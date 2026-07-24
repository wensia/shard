import { useCallback, useEffect, useMemo, useState } from "react"
import { isTauri } from "@tauri-apps/api/core"
import {
  AlertTriangleIcon,
  GitBranchIcon,
  ListTreeIcon,
  Loader2Icon,
  SaveIcon,
  XIcon,
} from "lucide-react"

import { Button } from "@astryxdesign/core/Button"
import { HStack } from "@astryxdesign/core/HStack"
import { Stack } from "@astryxdesign/core/Stack"
import { useToast } from "@astryxdesign/core/Toast"

import { MindMapCanvasEditor } from "@/components/shard/mind-map-canvas-editor"
import { MindMapOutlineEditor } from "@/components/shard/mind-map-outline-editor"
import {
  getApiErrorMessage,
  listMindMaps,
  readMindMap,
  setWindowControlsHidden,
  writeMindMap,
} from "@/lib/api"
import type { MindMapReadResult, MindMapSummary, ShardMapFile } from "@/types"

import styles from "./mind-map-workspace.module.css"

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
  const toast = useToast()
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
          toast({ body: "思维导图已保存" })
        }
      } catch (unknownError) {
        const message = getApiErrorMessage(unknownError)
        setAutoSaveError(message)
        if (message.includes("冲突副本")) {
          setConflict({ draft: draftFile, message })
        }
        if (mode === "manual") {
          toast({ body: `保存思维导图失败：${message}`, type: "error" })
        }
      } finally {
        setSaveMode(null)
      }
    },
    [draftFile, isSaving, readResult, refreshSummaries, toast]
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
    toast({ body: "已载入磁盘版本" })
  }, [loadMap, toast])

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
      toast({ body: "已保存我的版本" })
    } catch (unknownError) {
      toast({
        body: `保存我的版本失败：${getApiErrorMessage(unknownError)}`,
        type: "error",
      })
    } finally {
      setSaveMode(null)
    }
  }, [conflict, isSaving, readResult, refreshSummaries, toast])

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
    <Stack
      minHeight={0}
      style={{
        background: "var(--background)",
        color: "var(--foreground)",
        inset: 0,
        overflow: "hidden",
        position: "fixed",
        zIndex: 50,
      }}
    >
      <div
        aria-hidden="true"
        data-tauri-drag-region
        style={{ flexShrink: 0, height: "var(--shard-top-inset)" }}
      />
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
          <HStack
            gap={2}
            paddingBlock={3}
            paddingInline={3}
            style={{
              background: "color-mix(in srgb, var(--destructive) 5%, transparent)",
              border: "1px solid color-mix(in srgb, var(--destructive) 30%, transparent)",
              borderRadius: "var(--shard-radius-control)",
              marginInline: "auto",
              maxWidth: 896,
            }}
            vAlign="start"
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
              isDisabled={isSaving}
              label="保留我的版本"
              onClick={() => void keepMyVersion()}
              size="sm"
              variant="primary"
            />
            <Button
              isDisabled={isSaving}
              label="保留磁盘版本"
              onClick={() => void keepDiskVersion()}
              size="sm"
              variant="secondary"
            />
          </HStack>
        </div>
      ) : null}

      <footer
        className="shard-content-inset"
        style={{ flexShrink: 0, paddingBottom: "var(--shard-space-4)" }}
      >
        <HStack
          gap={2}
          maxWidth="100%"
          paddingBlock={3}
          paddingInline={3}
          style={{
            background: "var(--card)",
            borderRadius: "var(--shard-surface-radius)",
            boxShadow: "var(--shard-composer-shadow)",
            marginInline: "auto",
          }}
          vAlign="center"
          width="fit-content"
        >
          <Button
            icon={<XIcon />}
            isIconOnly
            label="退出思维导图"
            onClick={closeWorkspace}
            size="sm"
            tooltip="退出思维导图"
            variant="ghost"
          />

          {draftFile ? (
            <Button
              icon={view === "map" ? <ListTreeIcon /> : <GitBranchIcon />}
              isIconOnly
              label={view === "map" ? "切换到大纲视图" : "切换到思维导图视图"}
              onClick={() => setView(view === "map" ? "outline" : "map")}
              size="sm"
              tooltip={view === "map" ? "切换到大纲视图" : "切换到思维导图视图"}
              variant="ghost"
            />
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
            icon={
              isSaving ? (
                <Loader2Icon className={styles.spinner} />
              ) : (
                <SaveIcon />
              )
            }
            isDisabled={!isDirty || isSaving || !draftFile}
            isIconOnly
            label={isSaving ? saveStatusText : "保存思维导图"}
            onClick={() => void save("manual")}
            size="sm"
            tooltip={isSaving ? saveStatusText : "保存思维导图"}
            variant="ghost"
          />
        </HStack>
      </footer>
    </Stack>
  )
}
