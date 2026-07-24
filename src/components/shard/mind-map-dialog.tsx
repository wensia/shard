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
import { Center } from "@astryxdesign/core/Center"
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog"
import { HStack, Stack } from "@astryxdesign/core/Stack"
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
import styles from "./mind-map-dialog.module.css"

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
            isScrollable={false}
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "var(--shard-space-4)",
              height: "100%",
              minHeight: 0,
            }}
          >
            <form
              id={createFormId}
              onSubmit={handleCreate}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "var(--shard-space-2)",
                minWidth: 0,
              }}
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

            <div className={styles.splitGrid}>
              <section
                aria-busy={isLoading}
                style={{
                  minHeight: 0,
                  borderRight: "1px solid var(--border)",
                  paddingRight: "var(--shard-space-4)",
                }}
              >
                <HStack
                  gap={2}
                  hAlign="between"
                  style={{ marginBottom: "var(--shard-space-2)" }}
                  vAlign="center"
                >
                  <div
                    style={{
                      fontSize: 12,
                      fontWeight: 600,
                      color: "var(--muted-foreground)",
                    }}
                  >
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
                </HStack>

                <Stack
                  gap={1}
                  isScrollable
                  style={{
                    maxHeight: 520,
                    paddingRight: "var(--shard-space-1)",
                  }}
                >
                  {isLoading && maps.length === 0 ? (
                    <Center
                      height={96}
                      style={{ fontSize: 14, color: "var(--muted-foreground)" }}
                    >
                      正在读取...
                    </Center>
                  ) : maps.length === 0 ? (
                    <Center
                      height={96}
                      style={{
                        fontSize: 14,
                        textAlign: "center",
                        color: "var(--muted-foreground)",
                      }}
                    >
                      还没有思维导图
                    </Center>
                  ) : (
                    maps.map((summary) => {
                      const selected = selectedMap?.file.id === summary.id

                      return (
                        <button
                          aria-pressed={selected}
                          className={[
                            styles.mapRow,
                            selected ? styles.mapRowSelected : "",
                          ].join(" ")}
                          key={summary.id}
                          onClick={() => void handleSelectMap(summary)}
                          type="button"
                        >
                          {isReadingId === summary.id ? (
                            <Loader2Icon
                              className={styles.spin}
                              size={14}
                              strokeWidth={1.75}
                              style={{ marginTop: 2, flexShrink: 0 }}
                            />
                          ) : (
                            <FileJsonIcon
                              size={14}
                              strokeWidth={1.75}
                              style={{ marginTop: 2, flexShrink: 0 }}
                            />
                          )}
                          <span style={{ minWidth: 0, flex: "1 1 0%" }}>
                            <span
                              style={{
                                display: "block",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                                fontSize: 14,
                                fontWeight: 600,
                              }}
                            >
                              {summary.title}
                            </span>
                            <span
                              style={{
                                marginTop: 2,
                                display: "block",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                                fontSize: 12,
                                color: "var(--muted-foreground)",
                              }}
                            >
                              {summary.nodeCount} 节点 · {formatMapTime(summary.updatedAt)}
                            </span>
                          </span>
                        </button>
                      )
                    })
                  )}
                </Stack>
              </section>

              <section style={{ minHeight: 0, minWidth: 0 }}>
                {draftFile && selectedMap ? (
                  <Stack gap={3} style={{ minHeight: 0 }}>
                    <HStack
                      gap={3}
                      hAlign="between"
                      style={{ minWidth: 0 }}
                      vAlign="start"
                    >
                      <div style={{ minWidth: 0, flex: "1 1 0%" }}>
                        <TextInput
                          isLabelHidden
                          label="导图标题"
                          onChange={handleTitleChange}
                          value={draftFile.title}
                        />
                        <div
                          style={{
                            marginTop: 4,
                            display: "flex",
                            flexWrap: "wrap",
                            alignItems: "center",
                            minWidth: 0,
                            columnGap: "var(--shard-space-2)",
                            rowGap: 4,
                            fontSize: 12,
                            color: "var(--muted-foreground)",
                          }}
                        >
                          <span>revision {selectedMap.file.revision}</span>
                          <span aria-hidden="true">·</span>
                          <span>{Object.keys(draftFile.nodes).length} 节点</span>
                          <span aria-hidden="true">·</span>
                          <span
                            style={{
                              display: "inline-block",
                              maxWidth: "100%",
                              minWidth: 0,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {selectedMap.path}
                          </span>
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
                    </HStack>

                    {conflict ? (
                      <div
                        style={{
                          borderRadius: "var(--shard-radius-control)",
                          border:
                            "1px solid color-mix(in srgb, var(--destructive) 30%, transparent)",
                          background:
                            "color-mix(in srgb, var(--destructive) 5%, transparent)",
                          padding: "var(--shard-space-3)",
                        }}
                      >
                        <HStack gap={2} vAlign="start">
                          <AlertTriangleIcon
                            size={16}
                            style={{
                              marginTop: 2,
                              flexShrink: 0,
                              color: "var(--destructive)",
                            }}
                          />
                          <div style={{ minWidth: 0, flex: "1 1 0%" }}>
                            <div style={{ fontSize: 14, fontWeight: 600 }}>
                              检测到保存冲突
                            </div>
                            <p
                              style={{
                                marginTop: 4,
                                overflowWrap: "break-word",
                                fontSize: 12,
                                color: "var(--muted-foreground)",
                              }}
                            >
                              {conflict.message}
                            </p>
                            <HStack
                              gap={2}
                              style={{ marginTop: "var(--shard-space-2)" }}
                              wrap="wrap"
                            >
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
                            </HStack>
                          </div>
                        </HStack>
                      </div>
                    ) : null}

                    <div
                      aria-busy={isSaving}
                      style={{
                        minHeight: 0,
                        flex: "1 1 auto",
                        overflowY: "auto",
                        borderRadius: "var(--shard-radius-control)",
                        border: "1px solid var(--border)",
                        background: "var(--card)",
                        padding: "var(--shard-space-3)",
                      }}
                    >
                      <Stack gap={1}>
                        {rows.map(({ node, depth }) => {
                          const isRoot = node.id === draftFile.rootId

                          return (
                            <div
                              className={styles.nodeRow}
                              key={node.id}
                              style={{
                                display: "grid",
                                gridTemplateColumns: "minmax(0, 1fr) auto",
                                alignItems: "center",
                                minWidth: 0,
                                gap: "var(--shard-space-2)",
                                borderRadius: "var(--shard-radius-control)",
                                paddingBlock: 4,
                                paddingRight: 4,
                                paddingLeft: `${Math.min(depth, 8) * 18}px`,
                              }}
                            >
                              <HStack gap={2} style={{ minWidth: 0 }} vAlign="center">
                                <span
                                  aria-hidden="true"
                                  style={{
                                    width: 6,
                                    height: 6,
                                    flexShrink: 0,
                                    borderRadius: 999,
                                    background: isRoot
                                      ? "var(--primary)"
                                      : "color-mix(in srgb, var(--muted-foreground) 45%, transparent)",
                                  }}
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
                              </HStack>
                              <HStack
                                className={styles.nodeActions}
                                gap={0.5}
                                vAlign="center"
                              >
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
                              </HStack>
                            </div>
                          )
                        })}
                      </Stack>
                    </div>
                  </Stack>
                ) : (
                  <Stack
                    gap={2}
                    hAlign="center"
                    style={{
                      height: "100%",
                      minHeight: 340,
                      textAlign: "center",
                      color: "var(--muted-foreground)",
                    }}
                    vAlign="center"
                  >
                    <GitBranchIcon size={28} strokeWidth={1.5} />
                    <div style={{ fontSize: 14, fontWeight: 600, color: "var(--foreground)" }}>
                      新建或选择一份导图
                    </div>
                  </Stack>
                )}
              </section>
            </div>
          </LayoutContent>
        }
        footer={
          <LayoutFooter
            hasDivider
            style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}
          >
            <div style={{ fontSize: 12, color: "var(--muted-foreground)" }}>
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
