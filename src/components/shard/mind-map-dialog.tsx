import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react"
import {
  AlertTriangleIcon,
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowUpIcon,
  FileJsonIcon,
  GitBranchIcon,
  Loader2Icon,
  PlusIcon,
  RefreshCwIcon,
  SaveIcon,
  Trash2Icon,
} from "lucide-react"

import { Button } from "@astryxdesign/core/Button"
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog"
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout"
import { TextInput } from "@astryxdesign/core/TextInput"
import { useToast } from "@astryxdesign/core/Toast"
import {
  createMindMap,
  getApiErrorMessage,
  listMindMaps,
  readMindMap,
  writeMindMap,
} from "@/lib/api"
import {
  addMindMapChild,
  addMindMapSibling,
  deleteMindMapNode,
  findFirstEditableNodeId,
  getMindMapRows,
  indentMindMapNode,
  moveMindMapNode,
  outdentMindMapNode,
  updateMindMapNodeText,
  updateMindMapTitle,
} from "@/lib/mind-map-tree"
import type { MindMapReadResult, MindMapSummary, ShardMapFile } from "@/types"

interface MindMapDialogProps {
  initialMapId?: string | null
  open: boolean
  onMapsChange?: (maps: MindMapSummary[]) => void
  onOpenChange: (open: boolean) => void
  onOpenMap?: (mapId: string) => void
}

type ConflictState = {
  message: string
  draft: ShardMapFile
}

// astryx 的 toast() 只有单个 body，没有独立的 title/description 两段式插槽，
// 这里把原来 sonner 的 title + description 拼成一行文案。
function toastText(title: string, description?: string) {
  return description ? `${title}：${description}` : title
}

export function MindMapDialog({
  initialMapId = null,
  open,
  onMapsChange,
  onOpenChange,
  onOpenMap,
}: MindMapDialogProps) {
  const toast = useToast()
  const createFormId = useId()
  const [maps, setMaps] = useState<MindMapSummary[]>([])
  const [selectedMap, setSelectedMap] = useState<MindMapReadResult | null>(null)
  const [draftFile, setDraftFile] = useState<ShardMapFile | null>(null)
  const [title, setTitle] = useState("")
  const [isCreating, setIsCreating] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [isReadingId, setIsReadingId] = useState<string | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const [focusNodeId, setFocusNodeId] = useState<string | null>(null)
  const [conflict, setConflict] = useState<ConflictState | null>(null)
  const inputRefs = useRef<Record<string, HTMLInputElement | null>>({})
  const isDirty =
    selectedMap && draftFile
      ? JSON.stringify(selectedMap.file) !== JSON.stringify(draftFile)
      : false
  const rows = useMemo(() => (draftFile ? getMindMapRows(draftFile) : []), [
    draftFile,
  ])

  useEffect(() => {
    if (!open) return
    void refreshMindMaps()
  }, [open])

  useEffect(() => {
    if (!open || !initialMapId) return
    void openMapById(initialMapId)
  }, [initialMapId, open])

  useEffect(() => {
    if (!focusNodeId) return

    requestAnimationFrame(() => {
      inputRefs.current[focusNodeId]?.focus()
      inputRefs.current[focusNodeId]?.select()
      setFocusNodeId(null)
    })
  }, [focusNodeId, rows])

  function requestClose(nextOpen: boolean) {
    if (nextOpen) {
      onOpenChange(true)
      return
    }

    if (isDirty && !window.confirm("思维导图有未保存修改，确定关闭吗？")) {
      return
    }

    onOpenChange(false)
  }

  async function refreshMindMaps() {
    setIsLoading(true)
    try {
      const nextMaps = await listMindMaps()
      updateMaps(nextMaps)

      if (
        selectedMap &&
        !nextMaps.some((summary) => summary.id === selectedMap.file.id)
      ) {
        setSelectedMap(null)
        setDraftFile(null)
      }
    } catch (error) {
      toast({
        body: toastText("读取思维导图失败", getApiErrorMessage(error)),
        type: "error",
      })
    } finally {
      setIsLoading(false)
    }
  }

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const nextTitle = title.trim()
    if (!nextTitle) return

    setIsCreating(true)
    try {
      const created = await createMindMap(nextTitle)
      selectReadResult(created, true)
      setTitle("")
      upsertSummary(created)
      toast({ body: "思维导图已创建" })
      onOpenMap?.(created.file.id)
    } catch (error) {
      toast({
        body: toastText("创建思维导图失败", getApiErrorMessage(error)),
        type: "error",
      })
    } finally {
      setIsCreating(false)
    }
  }

  async function handleSelectMap(summary: MindMapSummary) {
    if (onOpenMap) {
      onOpenMap(summary.id)
      return
    }

    if (isDirty && !window.confirm("当前导图有未保存修改，确定切换吗？")) {
      return
    }

    setIsReadingId(summary.id)
    try {
      selectReadResult(await readMindMap(summary.id), false)
    } catch (error) {
      toast({
        body: toastText("打开思维导图失败", getApiErrorMessage(error)),
        type: "error",
      })
    } finally {
      setIsReadingId(null)
    }
  }

  async function openMapById(id: string) {
    setIsReadingId(id)
    try {
      selectReadResult(await readMindMap(id), false)
    } catch (error) {
      toast({
        body: toastText("打开思维导图失败", getApiErrorMessage(error)),
        type: "error",
      })
    } finally {
      setIsReadingId(null)
    }
  }

  async function handleSave() {
    if (!selectedMap || !draftFile || isSaving) return

    setIsSaving(true)
    setConflict(null)
    try {
      const saved = await writeMindMap(
        selectedMap.file.id,
        draftFile,
        selectedMap.file.revision,
        selectedMap.lastSavedHash
      )
      selectReadResult(saved, false)
      upsertSummary(saved)
      toast({ body: "思维导图已保存" })
    } catch (error) {
      const message = getApiErrorMessage(error)
      if (message.includes("冲突副本")) {
        setConflict({ message, draft: draftFile })
      }
      toast({ body: toastText("保存思维导图失败", message), type: "error" })
    } finally {
      setIsSaving(false)
    }
  }

  async function keepDiskVersion() {
    if (!selectedMap) return

    setIsReadingId(selectedMap.file.id)
    try {
      selectReadResult(await readMindMap(selectedMap.file.id), false)
      setConflict(null)
      toast({ body: "已载入磁盘版本" })
    } catch (error) {
      toast({
        body: toastText("载入磁盘版本失败", getApiErrorMessage(error)),
        type: "error",
      })
    } finally {
      setIsReadingId(null)
    }
  }

  async function keepMyVersion() {
    if (!selectedMap || !conflict) return

    setIsSaving(true)
    try {
      const latest = await readMindMap(selectedMap.file.id)
      const saved = await writeMindMap(
        latest.file.id,
        conflict.draft,
        latest.file.revision,
        latest.lastSavedHash
      )
      selectReadResult(saved, false)
      upsertSummary(saved)
      setConflict(null)
      toast({ body: "已保存我的版本" })
    } catch (error) {
      toast({
        body: toastText("保存我的版本失败", getApiErrorMessage(error)),
        type: "error",
      })
    } finally {
      setIsSaving(false)
    }
  }

  function selectReadResult(result: MindMapReadResult, focusFirstBranch: boolean) {
    setSelectedMap(result)
    setDraftFile(result.file)
    setConflict(null)
    if (focusFirstBranch) {
      setFocusNodeId(findFirstEditableNodeId(result.file))
    }
  }

  function upsertSummary(result: MindMapReadResult) {
    const summary = toSummary(result)
    setMaps((current) => {
      const nextMaps = [
        summary,
        ...current.filter((item) => item.id !== summary.id),
      ]
      onMapsChange?.(nextMaps)
      return nextMaps
    })
  }

  function updateMaps(nextMaps: MindMapSummary[]) {
    setMaps(nextMaps)
    onMapsChange?.(nextMaps)
  }

  function updateDraft(nextFile: ShardMapFile) {
    setDraftFile(nextFile)
    setConflict(null)
  }

  function handleTitleChange(value: string) {
    if (!draftFile) return
    updateDraft(updateMindMapTitle(draftFile, value))
  }

  function handleAddChild(nodeId: string) {
    if (!draftFile) return
    const next = addMindMapChild(draftFile, nodeId)
    updateDraft(next.file)
    setFocusNodeId(next.nodeId)
  }

  function handleAddSibling(nodeId: string) {
    if (!draftFile) return
    const next = addMindMapSibling(draftFile, nodeId)
    updateDraft(next.file)
    setFocusNodeId(next.nodeId)
  }

  function handleDeleteNode(nodeId: string) {
    if (!draftFile) return
    const next = deleteMindMapNode(draftFile, nodeId)
    updateDraft(next.file)
    setFocusNodeId(next.focusNodeId)
  }

  function handleNodeKeyDown(
    event: KeyboardEvent<HTMLInputElement>,
    nodeId: string
  ) {
    if (!draftFile) return

    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault()
      void handleSave()
      return
    }

    if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      event.preventDefault()
      handleAddSibling(nodeId)
      return
    }

    if (event.key === "Tab") {
      event.preventDefault()
      updateDraft(
        event.shiftKey
          ? outdentMindMapNode(draftFile, nodeId)
          : indentMindMapNode(draftFile, nodeId)
      )
      setFocusNodeId(nodeId)
      return
    }

    if (
      event.key === "Backspace" &&
      event.currentTarget.value === "" &&
      nodeId !== draftFile.rootId
    ) {
      event.preventDefault()
      handleDeleteNode(nodeId)
    }
  }

  return (
    <Dialog
      isOpen={open}
      onOpenChange={requestClose}
      maxHeight="min(760px, calc(100dvh - 32px))"
      width="min(1040px, calc(100vw - 32px))"
    >
      <Layout
        header={
          <DialogHeader
            hasDivider
            onOpenChange={requestClose}
            subtitle="Structures / Maps"
            title="思维导图"
          />
        }
        content={
          <LayoutContent
            className="flex h-full min-h-0 flex-col gap-[var(--shard-space-4)]"
            isScrollable={false}
          >
            <form
              className="flex min-w-0 items-center gap-[var(--shard-space-2)]"
              id={createFormId}
              onSubmit={handleCreate}
            >
              <TextInput
                isDisabled={isCreating}
                isLabelHidden
                label="思维导图标题"
                onChange={setTitle}
                placeholder="新建导图标题"
                value={title}
              />
              <Button
                icon={<GitBranchIcon />}
                isDisabled={!title.trim()}
                isLoading={isCreating}
                label="新建"
                type="submit"
                variant="primary"
              />
            </form>

            <div className="grid min-h-0 flex-1 gap-[var(--shard-space-4)] md:grid-cols-[minmax(190px,260px)_1fr]">
              <section
                aria-busy={isLoading}
                className="min-h-0 border-r border-border pr-[var(--shard-space-4)]"
              >
                <div className="mb-[var(--shard-space-2)] flex items-center justify-between gap-[var(--shard-space-2)]">
                  <div className="text-xs font-semibold text-muted-foreground">
                    {maps.length} 份导图
                  </div>
                  <Button
                    icon={<RefreshCwIcon />}
                    isDisabled={isLoading}
                    isIconOnly
                    isLoading={isLoading}
                    label="刷新思维导图列表"
                    onClick={() => void refreshMindMaps()}
                    size="sm"
                    type="button"
                    variant="ghost"
                  />
                </div>

                <div className="flex max-h-[520px] min-h-0 flex-col gap-[var(--shard-space-1)] overflow-y-auto pr-[var(--shard-space-1)]">
                  {isLoading && maps.length === 0 ? (
                    <div className="flex h-24 items-center justify-center text-sm text-muted-foreground">
                      正在读取...
                    </div>
                  ) : maps.length === 0 ? (
                    <div className="flex h-24 items-center justify-center text-center text-sm text-muted-foreground">
                      还没有思维导图
                    </div>
                  ) : (
                    maps.map((summary) => {
                      const selected = selectedMap?.file.id === summary.id

                      return (
                        <button
                          aria-pressed={selected}
                          className={[
                            "flex min-w-0 items-start gap-[var(--shard-space-2)] rounded-[var(--shard-radius-control)] px-[var(--shard-space-2)] py-[var(--shard-space-2)] text-left transition-colors",
                            selected
                              ? "bg-sidebar-accent text-sidebar-accent-foreground"
                              : "hover:bg-muted",
                          ].join(" ")}
                          key={summary.id}
                          onClick={() => void handleSelectMap(summary)}
                          type="button"
                        >
                          {isReadingId === summary.id ? (
                            <Loader2Icon className="mt-0.5 size-3.5 shrink-0 animate-spin" />
                          ) : (
                            <FileJsonIcon className="mt-0.5 size-3.5 shrink-0 stroke-[1.75]" />
                          )}
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-semibold">
                              {summary.title}
                            </span>
                            <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                              {summary.nodeCount} 节点 · {formatMapTime(summary.updatedAt)}
                            </span>
                          </span>
                        </button>
                      )
                    })
                  )}
                </div>
              </section>

              <section className="min-h-0 min-w-0">
                {draftFile && selectedMap ? (
                  <div className="flex min-h-0 flex-col gap-[var(--shard-space-3)]">
                    <div className="flex min-w-0 items-start justify-between gap-[var(--shard-space-3)]">
                      <div className="min-w-0 flex-1">
                        <TextInput
                          isLabelHidden
                          label="导图标题"
                          onChange={handleTitleChange}
                          value={draftFile.title}
                        />
                        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-[var(--shard-space-2)] gap-y-1 text-xs text-muted-foreground">
                          <span>revision {selectedMap.file.revision}</span>
                          <span aria-hidden="true">·</span>
                          <span>{Object.keys(draftFile.nodes).length} 节点</span>
                          <span aria-hidden="true">·</span>
                          <span className="truncate">{selectedMap.path}</span>
                        </div>
                      </div>
                      <Button
                        icon={<SaveIcon />}
                        isDisabled={!isDirty}
                        isLoading={isSaving}
                        label="保存"
                        onClick={() => void handleSave()}
                        type="button"
                        variant="primary"
                      />
                    </div>

                    {conflict ? (
                      <div className="rounded-[var(--shard-radius-control)] border border-destructive/30 bg-destructive/5 p-[var(--shard-space-3)]">
                        <div className="flex items-start gap-[var(--shard-space-2)]">
                          <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
                          <div className="min-w-0 flex-1">
                            <div className="text-sm font-semibold">检测到保存冲突</div>
                            <p className="mt-1 break-words text-xs text-muted-foreground">
                              {conflict.message}
                            </p>
                            <div className="mt-[var(--shard-space-2)] flex flex-wrap gap-[var(--shard-space-2)]">
                              <Button
                                isDisabled={isSaving}
                                label="保留我的版本"
                                onClick={() => void keepMyVersion()}
                                size="sm"
                                type="button"
                                variant="primary"
                              />
                              <Button
                                isDisabled={isSaving}
                                label="保留磁盘版本"
                                onClick={() => void keepDiskVersion()}
                                size="sm"
                                type="button"
                                variant="secondary"
                              />
                            </div>
                          </div>
                        </div>
                      </div>
                    ) : null}

                    <div
                      aria-busy={isSaving}
                      className="min-h-0 flex-1 overflow-y-auto rounded-[var(--shard-radius-control)] border border-border bg-card p-[var(--shard-space-3)]"
                    >
                      <div className="flex flex-col gap-[var(--shard-space-1)]">
                        {rows.map(({ node, depth }) => {
                          const isRoot = node.id === draftFile.rootId

                          return (
                            <div
                              className="group grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-[var(--shard-space-2)] rounded-[var(--shard-radius-control)] py-1 pr-1 hover:bg-muted/70"
                              key={node.id}
                              style={{ paddingLeft: `${Math.min(depth, 8) * 18}px` }}
                            >
                              <div className="flex min-w-0 items-center gap-[var(--shard-space-2)]">
                                <span
                                  aria-hidden="true"
                                  className={[
                                    "size-1.5 shrink-0 rounded-full",
                                    isRoot ? "bg-primary" : "bg-muted-foreground/45",
                                  ].join(" ")}
                                />
                                <TextInput
                                  isLabelHidden
                                  label={isRoot ? "根节点" : "导图节点"}
                                  onChange={(value) =>
                                    draftFile &&
                                    updateDraft(
                                      updateMindMapNodeText(draftFile, node.id, value)
                                    )
                                  }
                                  onKeyDown={(event) => handleNodeKeyDown(event, node.id)}
                                  placeholder={isRoot ? "根节点" : "输入分支"}
                                  ref={(element) => {
                                    inputRefs.current[node.id] = element
                                  }}
                                  value={node.text}
                                />
                              </div>
                              <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
                                <Button
                                  icon={<PlusIcon />}
                                  isIconOnly
                                  label="添加子节点"
                                  onClick={() => handleAddChild(node.id)}
                                  size="sm"
                                  type="button"
                                  variant="ghost"
                                />
                                <Button
                                  icon={<ArrowUpIcon />}
                                  isDisabled={isRoot}
                                  isIconOnly
                                  label="上移"
                                  onClick={() =>
                                    updateDraft(moveMindMapNode(draftFile, node.id, "up"))
                                  }
                                  size="sm"
                                  type="button"
                                  variant="ghost"
                                />
                                <Button
                                  icon={<ArrowDownIcon />}
                                  isDisabled={isRoot}
                                  isIconOnly
                                  label="下移"
                                  onClick={() =>
                                    updateDraft(moveMindMapNode(draftFile, node.id, "down"))
                                  }
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
                                    updateDraft(indentMindMapNode(draftFile, node.id))
                                    setFocusNodeId(node.id)
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
                                    updateDraft(outdentMindMapNode(draftFile, node.id))
                                    setFocusNodeId(node.id)
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
                                  onClick={() => handleDeleteNode(node.id)}
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
                  </div>
                ) : (
                  <div className="flex h-full min-h-[340px] flex-col items-center justify-center gap-[var(--shard-space-2)] text-center text-muted-foreground">
                    <GitBranchIcon className="size-7 stroke-[1.5]" />
                    <div className="text-sm font-semibold text-foreground">
                      新建或选择一份导图
                    </div>
                  </div>
                )}
              </section>
            </div>
          </LayoutContent>
        }
        footer={
          <LayoutFooter className="flex justify-between" hasDivider>
            <div className="text-xs text-muted-foreground">
              {isDirty ? "有未保存修改" : selectedMap ? "已保存" : ""}
            </div>
            <Button
              label="关闭"
              onClick={() => requestClose(false)}
              type="button"
              variant="secondary"
            />
          </LayoutFooter>
        }
      />
    </Dialog>
  )
}

function toSummary(result: MindMapReadResult): MindMapSummary {
  return {
    id: result.file.id,
    title: result.file.title,
    createdAt: result.file.createdAt,
    updatedAt: result.file.updatedAt,
    nodeCount: Object.keys(result.file.nodes).length,
    path: result.path,
  }
}

function formatMapTime(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value

  return new Intl.DateTimeFormat(undefined, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date)
}
