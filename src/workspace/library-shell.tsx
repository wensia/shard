import {
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import {
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  DatabaseIcon,
  FilePlus2Icon,
  FileTextIcon,
  FolderIcon,
  FolderPlusIcon,
  GitBranchIcon,
  LockKeyholeIcon,
  Maximize2Icon,
  MoreHorizontalIcon,
} from "lucide-react"
import { toast } from "sonner"

import { FragmentBacklinksPanel } from "@/components/shard/fragment-related"
import { MindMapCanvas } from "@/components/shard/mind-map-workspace"
import { ZenSurface } from "@/components/shard/zen-surface"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { ShardEditor } from "@/editor/shard-editor"
import { createShardTagAutocomplete } from "@/editor/extensions/tag-autocomplete"
import {
  createShardWikilinkCompletionSource,
  createShardWikilinkExtension,
} from "@/editor/extensions/wikilink"
import {
  createLibraryDirectory,
  createLibraryNote,
  convertNoteToFragment,
  deleteLibraryEntry,
  getApiErrorMessage,
  moveLibraryEntry,
  openCsvFile,
  renameLibraryEntry,
} from "@/lib/api"
import { deriveKind } from "@/lib/content-kind"
import { extractTags, normalizeTagList } from "@/lib/editor-format"
import { useImageUpload } from "@/hooks/use-image-upload"
import { useFragmentRelations } from "@/lib/use-fragment-relations"
import {
  buildCsvWikilinkCandidates,
  buildMindMapWikilinkCandidates,
  buildWikilinkCandidates,
} from "@/lib/wikilink"
import type {
  CsvFileSummary,
  Fragment,
  LibraryMutationResult,
  LibraryTreeEntry,
  LibraryTreeSnapshot,
  MindMapSummary,
} from "@/types"

import styles from "./library-shell.module.css"

export type LibrarySaveHandler = () => Promise<boolean>

/** 工作台用来编排「保存门禁」的句柄：flush 排空草稿，isDirty 报告是否有未落盘内容或在飞保存。 */
export interface LibraryDraftHandle {
  flush: LibrarySaveHandler
  isDirty: () => boolean
}

interface LibraryShellProps {
  csvFiles?: CsvFileSummary[]
  fragments: Fragment[]
  isLoading: boolean
  libraryTree: LibraryTreeSnapshot | null
  mindMaps?: MindMapSummary[]
  knownTags: string[]
  navigateToNote?: { id: string; requestId: number } | null
  onNavigateToFragment?: (fragmentId: string) => void
  onMindMapsChange?: (maps: MindMapSummary[]) => void
  onOpenMindMap: (map: MindMapSummary) => void
  onLibraryMutation: (result: LibraryMutationResult) => void
  onMoveToLockbox: (fragment: Fragment) => Promise<void>
  /** 点击树上的密匣挂载点：解锁并进入密匣一级空间（传送门）。 */
  onOpenLockbox: () => void
  onSelectFragmentMonth: (month: string) => void
  onRegisterSaveHandler: (handle: LibraryDraftHandle | null) => void
  onSave: (
    id: string,
    content: string,
    tags: string[],
    expectedSha?: string
  ) => Promise<Fragment>
  /** 冲突后「载入磁盘版本」需要父级重新拉取 fragments 才能拿到最新内容。 */
  onRefreshFragments?: () => Promise<unknown> | void
  relationFragments?: Fragment[]
}

type SaveState = "dirty" | "error" | "saved" | "saving"
type TreeDialogState = { kind: "delete"; entry: LibraryTreeEntry }
type LibrarySelection =
  | { kind: "note"; id: string }
  | { kind: "mindmap"; path: string }
  | null

interface RenameState {
  path: string
  source: "editor" | "tree"
  value: string
}

export function LibraryShell({
  csvFiles = [],
  fragments,
  isLoading,
  libraryTree,
  mindMaps = [],
  knownTags,
  navigateToNote = null,
  onNavigateToFragment,
  onMindMapsChange,
  onOpenMindMap,
  onLibraryMutation,
  onMoveToLockbox,
  onOpenLockbox,
  onSelectFragmentMonth,
  onRegisterSaveHandler,
  onRefreshFragments,
  onSave,
  relationFragments = fragments,
}: LibraryShellProps) {
  const notes = useMemo(
    () => fragments.filter((fragment) => deriveKind(fragment.tags) === "note"),
    [fragments]
  )
  const [selection, setSelection] = useState<LibrarySelection>(null)
  const [selectedTreePath, setSelectedTreePath] = useState("notes")
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(
    () => new Set(["notes"])
  )
  const [isFragmentStreamExpanded, setIsFragmentStreamExpanded] =
    useState(false)
  const [isMindMapsExpanded, setIsMindMapsExpanded] = useState(false)
  const [expandedYears, setExpandedYears] = useState<Set<string>>(new Set())
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [treeDialog, setTreeDialog] = useState<TreeDialogState | null>(null)
  const [renaming, setRenaming] = useState<RenameState | null>(null)
  const [creatingDirectory, setCreatingDirectory] = useState<{
    parent: string
    value: string
  } | null>(null)
  const [draft, setDraft] = useState("")
  const [mobilePane, setMobilePane] = useState<"editor" | "list">("list")
  const [saveState, setSaveState] = useState<SaveState>("saved")
  const [isZen, setIsZen] = useState(false)
  const selectedNoteId = selection?.kind === "note" ? selection.id : null
  const selectedNote = useMemo(
    () => notes.find((note) => note.id === selectedNoteId) ?? null,
    [notes, selectedNoteId]
  )
  const selectedMindMap = useMemo(
    () =>
      selection?.kind === "mindmap"
        ? mindMaps.find((map) => map.path === selection.path) ?? null
        : null,
    [mindMaps, selection]
  )
  const draftRef = useRef(draft)
  const lastSavedContentRef = useRef("")
  /** 上次读到/存下正文的 SHA-256，保存时作为基线校验；null=暂缺（放行保存）。 */
  const baseShaRef = useRef<string | null>(null)
  /** 用户在冲突提示里选择「放弃草稿」后，等待父级刷新换入磁盘版本。 */
  const pendingDiskReloadRef = useRef(false)
  const selectedNoteRef = useRef<Fragment | null>(selectedNote)
  const savePromiseRef = useRef<Promise<boolean> | null>(null)
  const knownTagsRef = useRef<string[]>([])
  const wikilinkCandidates = useMemo(
    () => [
      ...buildWikilinkCandidates(relationFragments),
      ...buildCsvWikilinkCandidates(csvFiles),
      ...buildMindMapWikilinkCandidates(mindMaps),
    ],
    [csvFiles, mindMaps, relationFragments]
  )
  const { indexVersion, requestRelated } = useFragmentRelations(relationFragments)
  const wikilinkCandidatesRef = useRef(wikilinkCandidates)
  const wikilinkNavigateRef = useRef(onNavigateToFragment)

  const normalizedKnownTags = useMemo(
    () => normalizeTagList(knownTags.filter((tag) => tag !== "inbox")),
    [knownTags]
  )
  knownTagsRef.current = normalizedKnownTags
  wikilinkCandidatesRef.current = wikilinkCandidates
  wikilinkNavigateRef.current = onNavigateToFragment
  const wikilinkCompletionSource = useMemo(
    () =>
      createShardWikilinkCompletionSource({
        getCandidates: () => wikilinkCandidatesRef.current,
      }),
    []
  )
  const tagAutocompleteExtension = useMemo(
    () =>
      createShardTagAutocomplete({
        additionalSources: [wikilinkCompletionSource],
        getKnownTags: () => knownTagsRef.current,
      }),
    [wikilinkCompletionSource]
  )
  const wikilinkExtension = useMemo(
    () =>
      createShardWikilinkExtension({
        getCandidates: () => wikilinkCandidatesRef.current,
        maxCsvRows: 50,
        onMissingTarget: (target) =>
          toast(`待建链接「${target}」尚不存在，可在资料库新建笔记`),
        onNavigate: (fragmentId) =>
          wikilinkNavigateRef.current?.(fragmentId),
        onNavigateToMindMap: (path) => {
          const map = mindMaps.find((candidate) => candidate.path === path)
          if (map) onOpenMindMap(map)
        },
      }),
    [mindMaps, onOpenMindMap, wikilinkCandidates]
  )
  const editorExtensions = useMemo(
    () => [tagAutocompleteExtension, wikilinkExtension],
    [tagAutocompleteExtension, wikilinkExtension]
  )

  draftRef.current = draft
  selectedNoteRef.current = selectedNote

  const { uploadPastedImages } = useImageUpload({
    getContent: () => draftRef.current,
    isLockbox: selectedNote?.lockbox,
    onUploaded: ({ alt, path, previewUrl }) => {
      const imageMarkdown = `![${escapeMarkdownImageAlt(alt)}](${path})`
      const nextDraft = [draftRef.current.trimEnd(), imageMarkdown]
        .filter(Boolean)
        .join("\n")
      draftRef.current = nextDraft
      setDraft(nextDraft)
      setSaveState(
        nextDraft === lastSavedContentRef.current ? "saved" : "dirty"
      )
      URL.revokeObjectURL(previewUrl)
    },
  })

  useEffect(() => {
    if (notes.length === 0) {
      if (selection?.kind === "note") {
        setSelection(null)
        setDraft("")
        draftRef.current = ""
        lastSavedContentRef.current = ""
        setSaveState("saved")
        setIsZen(false)
        setMobilePane("list")
      }
      return
    }

    if (selectedNoteId && !notes.some((note) => note.id === selectedNoteId)) {
      setSelection(null)
      setSelectedTreePath("notes")
      setIsZen(false)
    }
  }, [notes, selectedNoteId, selection?.kind])

  useEffect(() => {
    if (
      selection?.kind === "mindmap" &&
      !mindMaps.some((map) => map.path === selection.path)
    ) {
      setSelection(null)
      setSelectedTreePath("notes")
      setIsZen(false)
      setMobilePane("list")
    }
  }, [mindMaps, selection])

  useEffect(() => {
    if (!selectedNote) return

    setDraft(selectedNote.content)
    draftRef.current = selectedNote.content
    lastSavedContentRef.current = selectedNote.content
    setSaveState("saved")
    baseShaRef.current = null
    const content = selectedNote.content
    void sha256Hex(content).then((sha) => {
      if (lastSavedContentRef.current === content) baseShaRef.current = sha
    })
  }, [selectedNote?.id])

  // 磁盘版本变化（同步 pull / 外部编辑 / 冲突后放弃草稿）时换入新内容：
  // 编辑器干净或已明确放弃草稿才换；有未保存修改时交给保存时的冲突流程。
  useEffect(() => {
    const note = selectedNote
    if (!note) return
    if (
      note.content === lastSavedContentRef.current ||
      note.content === draftRef.current
    ) {
      pendingDiskReloadRef.current = false
      return
    }
    const clean =
      draftRef.current === lastSavedContentRef.current &&
      savePromiseRef.current === null
    if (!clean && !pendingDiskReloadRef.current) return
    pendingDiskReloadRef.current = false
    setDraft(note.content)
    draftRef.current = note.content
    lastSavedContentRef.current = note.content
    setSaveState("saved")
    baseShaRef.current = null
    void sha256Hex(note.content).then((sha) => {
      if (
        selectedNoteRef.current?.id === note.id &&
        lastSavedContentRef.current === note.content
      ) {
        baseShaRef.current = sha
      }
    })
  }, [selectedNote])

  useEffect(() => {
    if (selectedNote) setSelectedTreePath(selectedNote.path)
  }, [selectedNote?.path])

  const saveCurrentNote = useCallback<LibrarySaveHandler>(async () => {
    // 排空式保存：在飞的保存只覆盖它启动瞬间的快照。等它结束后必须回头重查
    // 草稿是否又变了，直到「无在飞 && 草稿==已落盘」才算 flush 完成，
    // 否则慢保存期间的尾随输入会被吞掉（自动保存 800ms 与切换/同步都依赖这里）。
    for (;;) {
      const inFlight = savePromiseRef.current
      if (inFlight) {
        if (!(await inFlight)) return false
        continue
      }

      const note = selectedNoteRef.current
      const content = draftRef.current
      if (!note || content === lastSavedContentRef.current) {
        setSaveState("saved")
        return true
      }

      const saved = await runSingleSave(note, content)
      if (!saved) return false
    }

    async function runSingleSave(note: Fragment, content: string) {
      const savePromise = (async () => {
      if (content.trim().length === 0) {
        setSaveState("error")
        toast.error("笔记内容不能为空", { duration: Infinity })
        return false
      }

      setSaveState("saving")
      try {
        const tags = normalizeTagList([
          "inbox",
          "note",
          ...extractTags(content),
        ])
        const updated = await onSave(
          note.id,
          content,
          tags,
          baseShaRef.current ?? undefined
        )
        lastSavedContentRef.current = updated.content
        baseShaRef.current = null
        void sha256Hex(updated.content).then((sha) => {
          if (lastSavedContentRef.current === updated.content) {
            baseShaRef.current = sha
          }
        })
        // 自动保存可能在用户继续输入时完成：只有草稿仍等于送出的内容才回写，
        // 否则会覆盖保存期间的新键入
        if (
          selectedNoteRef.current?.id === updated.id &&
          draftRef.current === content &&
          updated.content !== content
        ) {
          setDraft(updated.content)
          draftRef.current = updated.content
        }
        setSaveState(
          draftRef.current === lastSavedContentRef.current ? "saved" : "dirty"
        )
        return true
      } catch (error) {
        const message = getApiErrorMessage(error)
        if (message.includes("STALE_BASE")) {
          const keepMine = window.confirm(
            "这篇笔记的磁盘内容已被修改（可能来自同步或外部编辑）。\n\n「确定」：用当前草稿覆盖磁盘版本\n「取消」：放弃当前草稿，载入磁盘最新版本"
          )
          if (keepMine) {
            // 清掉基线哈希放行一次强制保存；外层排空循环会立即重存
            baseShaRef.current = null
            setSaveState("dirty")
            return true
          }
          // 放弃草稿：把草稿视作已处理让排空循环退出，等父级刷新后
          // 由磁盘重载 effect 换入最新版本（pendingDiskReloadRef 兜住中间态）
          pendingDiskReloadRef.current = true
          lastSavedContentRef.current = draftRef.current
          setSaveState("saved")
          void onRefreshFragments?.()
          return true
        }
        setSaveState("error")
        toast.error(`自动保存失败：${message}`, {
          duration: Infinity,
        })
        return false
      }
    })()

      savePromiseRef.current = savePromise
      try {
        return await savePromise
      } finally {
        savePromiseRef.current = null
      }
    }
  }, [onSave])

  const saveStateRef = useRef<SaveState>("saved")
  saveStateRef.current = saveState

  useEffect(() => {
    onRegisterSaveHandler({
      flush: saveCurrentNote,
      // error 也算 dirty：内容仍未落盘，检查点与同步都必须等它解决
      isDirty: () =>
        saveStateRef.current !== "saved" || savePromiseRef.current !== null,
    })
    return () => onRegisterSaveHandler(null)
  }, [onRegisterSaveHandler, saveCurrentNote])

  // 自动保存：停止输入 800ms 后落盘，与禅模式编辑器同节奏。
  // 空内容不自动保存（避免重写时反复报错），交给显式保存与切换时的校验。
  useEffect(() => {
    if (!selectedNote || saveState !== "dirty") return
    if (draft.trim().length === 0 || draft === lastSavedContentRef.current) {
      return
    }
    const timerId = window.setTimeout(() => void saveCurrentNote(), 800)
    return () => window.clearTimeout(timerId)
  }, [draft, saveCurrentNote, saveState, selectedNote])

  // Cmd/Ctrl+S 显式保存；资料库视图卸载时监听随之移除
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return
      if (event.shiftKey || event.altKey) return
      if (event.key.toLowerCase() !== "s") return
      event.preventDefault()
      if (selectedNoteRef.current) void saveCurrentNote()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [saveCurrentNote])

  async function selectNote(noteId: string) {
    if (noteId !== selectedNoteRef.current?.id) {
      const saved = await saveCurrentNote()
      if (!saved) return
      setSelection({ kind: "note", id: noteId })
      const note = notes.find((candidate) => candidate.id === noteId)
      if (note) setSelectedTreePath(note.path)
    }
    setIsZen(false)
    setMobilePane("editor")
  }

  async function selectMindMap(path: string) {
    if (selection?.kind !== "mindmap" || selection.path !== path) {
      if (!(await saveCurrentNote())) return
      setSelection({ kind: "mindmap", path })
      setSelectedTreePath(path)
    }
    setIsZen(false)
    setMobilePane("editor")
  }

  useEffect(() => {
    if (!navigateToNote || navigateToNote.id === selectedNoteRef.current?.id) {
      return
    }
    if (!notes.some((note) => note.id === navigateToNote.id)) return
    void selectNote(navigateToNote.id)
  }, [navigateToNote, notes])

  const selectedTitle = selectedNote
    ? selectedNote.path.split("/").pop()?.replace(/\.md$/iu, "") || "无标题笔记"
    : selectedMindMap?.title ?? "选择内容"

  const directories = useMemo(
    () => ["notes", ...collectDirectoryPaths(libraryTree?.entries ?? [])],
    [libraryTree]
  )
  const selectedDirectory = useMemo(() => {
    if (selectedTreePath === "notes") return "notes"
    const selectedEntry = findTreeEntry(libraryTree?.entries ?? [], selectedTreePath)
    if (selectedEntry?.kind === "directory") return selectedEntry.path
    const separator = selectedTreePath.lastIndexOf("/")
    return separator > 0 ? selectedTreePath.slice(0, separator) : "notes"
  }, [libraryTree, selectedTreePath])

  async function runMutation(
    label: string,
    mutation: () => Promise<LibraryMutationResult>,
    { revealNote = true }: { revealNote?: boolean } = {}
  ) {
    if (busyAction) return null
    setBusyAction(label)
    try {
      const result = await mutation()
      onLibraryMutation(result)
      if (result.fragment) {
        if (revealNote) {
          setSelection({ kind: "note", id: result.fragment.id })
          setMobilePane("editor")
        }
        setSelectedTreePath(result.fragment.path)
      }
      if (result.updatedLinks > 0) {
        toast(`已更新 ${result.updatedLinks} 处双链引用`)
      }
      return result
    } catch (error) {
      toast.error(`${label}失败：${getApiErrorMessage(error)}`, {
        duration: Infinity,
      })
      return null
    } finally {
      setBusyAction(null)
    }
  }

  async function runSavedMutation(
    label: string,
    mutation: () => Promise<LibraryMutationResult>,
    options?: { revealNote?: boolean }
  ) {
    if (!(await saveCurrentNote())) return null
    return runMutation(label, mutation, options)
  }

  function requestDelete(entry: LibraryTreeEntry) {
    if (entry.kind === "directory" && (entry.children?.length ?? 0) > 0) {
      toast.error("目录非空，不能删除", { duration: Infinity })
      return
    }
    setTreeDialog({ kind: "delete", entry })
  }

  function startRename(path: string, source: RenameState["source"]) {
    const fileName = path.split("/").pop() ?? ""
    setRenaming({ path, source, value: fileName.replace(/\.(md|csv)$/iu, "") })
  }

  async function submitRename() {
    if (!renaming || busyAction) return
    const value = renaming.value.trim()
    const currentName = (renaming.path.split("/").pop() ?? "").replace(
      /\.(md|csv)$/iu,
      ""
    )
    if (!value || value === currentName) {
      setRenaming(null)
      return
    }
    const result = await runSavedMutation("重命名", () =>
      renameLibraryEntry(renaming.path, value)
    )
    if (result) setRenaming(null)
  }

  async function createNoteAndRename() {
    const parent = selectedDirectory
    const result = await runSavedMutation(
      "新建笔记",
      () => createLibraryNote(parent, "未命名"),
      { revealNote: false }
    )
    if (!result?.fragment) return
    if (parent !== "notes") {
      setExpandedPaths((current) => new Set(current).add(parent))
    }
    setMobilePane("list")
    startRename(result.fragment.path, "tree")
  }

  function startCreateDirectory() {
    const parent = selectedDirectory
    if (parent !== "notes") {
      setExpandedPaths((current) => new Set(current).add(parent))
    }
    setMobilePane("list")
    setCreatingDirectory({ parent, value: "" })
  }

  async function submitCreateDirectory() {
    if (!creatingDirectory || busyAction) return
    const value = creatingDirectory.value.trim()
    if (!value) {
      setCreatingDirectory(null)
      return
    }
    const result = await runMutation("新建目录", () =>
      createLibraryDirectory(creatingDirectory.parent, value)
    )
    if (result) setCreatingDirectory(null)
  }

  async function submitTreeDialog() {
    if (!treeDialog || busyAction) return
    const deletedPath = treeDialog.entry.path
    const result = await runSavedMutation("删除", () =>
      deleteLibraryEntry(deletedPath)
    )
    if (!result) return
    if (selectedTreePath === deletedPath) {
      setSelection(null)
      setSelectedTreePath("notes")
      setIsZen(false)
      setMobilePane("list")
    }
    setTreeDialog(null)
  }

  function handleTreeEntryClick(entry: LibraryTreeEntry) {
    setSelectedTreePath(entry.path)
    if (entry.kind === "directory") {
      toggleSetValue(setExpandedPaths, entry.path)
      return
    }
    if (entry.kind === "csv") {
      void openCsvFile(entry.path).catch((error) =>
        toast.error(`打开 CSV 失败：${getApiErrorMessage(error)}`, {
          duration: Infinity,
        })
      )
      return
    }
    const note = notes.find((candidate) => candidate.path === entry.path)
    if (note) {
      void selectNote(note.id)
    } else {
      toast.error("笔记索引尚未刷新，请稍后重试", { duration: Infinity })
    }
  }

  function renderCreateDirectoryRow(parentPath: string) {
    if (creatingDirectory?.parent !== parentPath) return null
    return (
      <li role="treeitem">
        <div className={styles.renameRow}>
          <span className={styles.treeIndentIcon} />
          <FolderIcon aria-hidden="true" />
          <div className={styles.renameWrap}>
            <Input
              aria-label="新目录名称"
              autoFocus
              disabled={busyAction !== null}
              onBlur={() => void submitCreateDirectory()}
              onChange={(event) =>
                setCreatingDirectory((current) =>
                  current ? { ...current, value: event.target.value } : null
                )
              }
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault()
                  void submitCreateDirectory()
                } else if (event.key === "Escape") {
                  event.stopPropagation()
                  setCreatingDirectory(null)
                }
              }}
              placeholder="目录名称"
              value={creatingDirectory.value}
            />
          </div>
        </div>
      </li>
    )
  }

  const renderMindMapZenSurface = useCallback(
    (canvas: ReactNode) => (
      <ZenSurface
        ariaLabel="资料库思维导图禅模式"
        onRequestClose={() => setIsZen(false)}
      >
        {canvas}
      </ZenSurface>
    ),
    []
  )

  function renderSelectedViewer(zen: boolean) {
    if (selectedNote) {
      return (
        <div className={zen ? styles.zenNoteViewport : styles.editorViewport}>
          <ShardEditor
            ariaLabel="资料库笔记编辑器"
            autoFocus={zen || mobilePane === "editor"}
            documentKey={selectedNote.id}
            editorId={`library:${selectedNote.id}`}
            extensions={editorExtensions}
            onChange={(content) => {
              setDraft(content)
              draftRef.current = content
              setSaveState(
                content === lastSavedContentRef.current ? "saved" : "dirty"
              )
            }}
            onDropFiles={(files) => void uploadPastedImages(files)}
            onPasteFiles={(files) => void uploadPastedImages(files)}
            onSubmit={() => void saveCurrentNote()}
            placeholder="开始写笔记…"
            value={draft}
            variant={zen ? "zen" : "inline"}
          />
        </div>
      )
    }

    if (selectedMindMap) {
      return (
        <div
          className={
            zen ? styles.zenMindMapViewport : styles.mindMapViewport
          }
        >
          <MindMapCanvas
            mapId={selectedMindMap.id}
            onMapsChange={onMindMapsChange}
            surface={zen ? renderMindMapZenSurface : undefined}
          />
        </div>
      )
    }

    return <LibraryEmptyState message="从资料库目录选择一篇笔记或思维导图" />
  }

  return (
    <section aria-label="资料库" className={styles.shell}>
      <div className={styles.workspace}>
        <aside
          aria-busy={busyAction !== null || isLoading ? true : undefined}
          aria-label="资料库目录"
          className={styles.noteListPane}
          data-mobile-hidden={mobilePane === "editor" ? "true" : undefined}
        >
          {/* 标题栏工具条：根目录 + 新建操作直接放进 Overlay 标题栏，空白处保持可拖拽 */}
          <div className={styles.paneHeader} data-tauri-drag-region>
            <button
              aria-current={selectedTreePath === "notes" ? "page" : undefined}
              aria-label={`资料库根目录（${notes.length}）`}
              className={styles.rootButton}
              onClick={() => {
                void (async () => {
                  // 清掉选中会让 saveCurrentNote 失去保存对象，必须先 flush 草稿
                  if (!(await saveCurrentNote())) return
                  setSelection(null)
                  setSelectedTreePath("notes")
                  setIsZen(false)
                  setMobilePane("list")
                })()
              }}
              title="资料库根目录"
              type="button"
            >
              <FolderIcon aria-hidden="true" />
              <span className={styles.rootLabel}>资料库</span>
              <span className={styles.noteCount}>{notes.length}</span>
            </button>
            <div className={styles.paneActions}>
              <Button
                aria-label="新建笔记"
                disabled={busyAction !== null}
                onClick={() => void createNoteAndRename()}
                size="icon-sm"
                title="新建笔记"
                type="button"
                variant="ghost"
              >
                <FilePlus2Icon aria-hidden="true" />
              </Button>
              <Button
                aria-label="新建目录"
                disabled={busyAction !== null}
                onClick={() => startCreateDirectory()}
                size="icon-sm"
                title="新建目录"
                type="button"
                variant="ghost"
              >
                <FolderPlusIcon aria-hidden="true" />
              </Button>
            </div>
          </div>

          <div className={styles.noteListViewport}>
            {isLoading || !libraryTree ? (
              <LibraryEmptyState message="正在读取资料库…" />
            ) : (
              <div className={styles.treeViewportInner}>
                <div className={styles.fragmentStream}>
                  <button
                    aria-label={`碎片流（${libraryTree.fragmentStream.totalCount}）`}
                    aria-expanded={isFragmentStreamExpanded}
                    className={styles.treeButton}
                    onClick={() =>
                      setIsFragmentStreamExpanded((current) => !current)
                    }
                    type="button"
                  >
                    {isFragmentStreamExpanded ? (
                      <ChevronDownIcon aria-hidden="true" />
                    ) : (
                      <ChevronRightIcon aria-hidden="true" />
                    )}
                    <span>碎片流</span>
                    <span className={styles.treeCount}>
                      {libraryTree.fragmentStream.totalCount}
                    </span>
                  </button>
                  {isFragmentStreamExpanded ? (
                    <ul aria-label="碎片流年月" className={styles.tree} role="tree">
                      {libraryTree.fragmentStream.years.map((year) => {
                        const expanded = expandedYears.has(year.year)
                        return (
                          <li
                            aria-expanded={expanded}
                            key={year.year}
                            role="treeitem"
                          >
                            <button
                              aria-label={`${year.year}（${year.totalCount}）`}
                              className={styles.treeButton}
                              data-depth="1"
                              onClick={() =>
                                toggleSetValue(setExpandedYears, year.year)
                              }
                              type="button"
                            >
                              {expanded ? (
                                <ChevronDownIcon aria-hidden="true" />
                              ) : (
                                <ChevronRightIcon aria-hidden="true" />
                              )}
                              <span>{year.year}年</span>
                              <span className={styles.treeCount}>
                                {year.totalCount}
                              </span>
                            </button>
                            {expanded ? (
                              <ul role="group">
                                {year.months.map((month) => {
                                  const routeMonth = `${year.year}-${month.month}`
                                  return (
                                    <li key={routeMonth} role="treeitem">
                                      <button
                                        aria-label={`${month.month}（${month.count}）`}
                                        className={styles.treeButton}
                                        data-depth="2"
                                        onClick={() =>
                                          onSelectFragmentMonth(routeMonth)
                                        }
                                        type="button"
                                      >
                                        <span className={styles.treeIndentIcon} />
                                        <span>{month.month}月</span>
                                        <span className={styles.treeCount}>
                                          {month.count}
                                        </span>
                                      </button>
                                    </li>
                                  )
                                })}
                              </ul>
                            ) : null}
                          </li>
                        )
                      })}
                    </ul>
                  ) : null}
                </div>

                {/* 密匣挂载点：地图上可见、不可展开，推门进入加密一级空间 */}
                <div className={styles.lockboxMount}>
                  <button
                    aria-label="密匣（上锁空间）"
                    className={styles.treeButton}
                    onClick={() => {
                      void (async () => {
                        // 离开资料库前必须排空草稿，与其他导航同一门禁
                        if (!(await saveCurrentNote())) return
                        onOpenLockbox()
                      })()
                    }}
                    type="button"
                  >
                    <LockKeyholeIcon aria-hidden="true" />
                    <span>密匣</span>
                  </button>
                </div>

                <div className={styles.fragmentStream}>
                  <button
                    aria-label={`思维导图（${libraryTree.mindMaps.length}）`}
                    aria-expanded={isMindMapsExpanded}
                    className={styles.treeButton}
                    onClick={() => setIsMindMapsExpanded((current) => !current)}
                    type="button"
                  >
                    {isMindMapsExpanded ? (
                      <ChevronDownIcon aria-hidden="true" />
                    ) : (
                      <ChevronRightIcon aria-hidden="true" />
                    )}
                    <span>思维导图</span>
                    <span className={styles.treeCount}>
                      {libraryTree.mindMaps.length}
                    </span>
                  </button>
                  {isMindMapsExpanded ? (
                    <ul aria-label="思维导图文件" className={styles.tree} role="tree">
                      {libraryTree.mindMaps.map((entry) => (
                        <li key={entry.path} role="treeitem">
                          <button
                            aria-label={entry.name}
                            className={styles.treeButton}
                            data-depth="1"
                            data-selected={
                              selection?.kind === "mindmap" &&
                              selection.path === entry.path
                                ? "true"
                                : undefined
                            }
                            onClick={() => void selectMindMap(entry.path)}
                            type="button"
                          >
                            <GitBranchIcon aria-hidden="true" />
                            <span className={styles.treeLabel}>{entry.name}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>

                {libraryTree.entries.length === 0 && !creatingDirectory ? (
                  <LibraryEmptyState message="到碎片流把一条内容转为笔记" />
                ) : (
                  <ul aria-label="笔记和数据文件" className={styles.tree} role="tree">
                    {renderCreateDirectoryRow("notes")}
                    <TreeEntries
                      busy={busyAction !== null}
                      directories={directories}
                      entries={libraryTree.entries}
                      expandedPaths={expandedPaths}
                      onDelete={requestDelete}
                      onConvertToFragment={(entry) => {
                        const note = notes.find(
                          (candidate) => candidate.path === entry.path
                        )
                        if (!note) return
                        void runSavedMutation("转回碎片", () =>
                          convertNoteToFragment(note.id)
                        ).then((result) => {
                          if (!result) return
                          setSelection(null)
                          setSelectedTreePath("notes")
                          setIsZen(false)
                          setMobilePane("list")
                        })
                      }}
                      onEntryClick={handleTreeEntryClick}
                      onMove={(entry, destinationDirectory) => {
                        void runSavedMutation("移动", () =>
                          moveLibraryEntry(entry.path, destinationDirectory)
                        )
                      }}
                      onMoveToLockbox={(entry) => {
                        const note = notes.find(
                          (candidate) => candidate.path === entry.path
                        )
                        if (!note || busyAction) return
                        void (async () => {
                          if (!(await saveCurrentNote())) return
                          setBusyAction("移入密匣")
                          try {
                            await onMoveToLockbox(note)
                          } finally {
                            setBusyAction(null)
                          }
                        })()
                      }}
                      onRename={(entry) => startRename(entry.path, "tree")}
                      onRenameCancel={() => setRenaming(null)}
                      onRenameChange={(value) =>
                        setRenaming((current) =>
                          current ? { ...current, value } : null
                        )
                      }
                      onRenameSubmit={() => void submitRename()}
                      renaming={renaming?.source === "tree" ? renaming : null}
                      renderCreateRow={renderCreateDirectoryRow}
                      selectedPath={selectedTreePath}
                    />
                  </ul>
                )}
              </div>
            )}
          </div>
        </aside>

        <article
          aria-label="资料库查看器"
          aria-busy={saveState === "saving" ? true : undefined}
          className={styles.editorPane}
          data-mobile-hidden={mobilePane === "list" ? "true" : undefined}
        >
          <div className={styles.editorHeader} data-tauri-drag-region>
            <Button
              aria-label="返回资料库目录"
              className={styles.mobileBackButton}
              onClick={() => setMobilePane("list")}
              size="icon-sm"
              type="button"
              variant="ghost"
            >
              <ChevronLeftIcon aria-hidden="true" />
            </Button>
            {selectedNote &&
            renaming?.source === "editor" &&
            renaming.path === selectedNote.path ? (
              <div className={styles.renameWrap}>
                <Input
                  aria-label="重命名名称"
                  autoFocus
                  disabled={busyAction !== null}
                  onBlur={() => void submitRename()}
                  onChange={(event) =>
                    setRenaming((current) =>
                      current ? { ...current, value: event.target.value } : null
                    )
                  }
                  onFocus={(event) => event.target.select()}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault()
                      void submitRename()
                    } else if (event.key === "Escape") {
                      event.stopPropagation()
                      setRenaming(null)
                    }
                  }}
                  value={renaming.value}
                />
              </div>
            ) : (
              <h2 className={styles.editorTitle} data-tauri-drag-region>
                {selectedNote ? (
                  <button
                    aria-label="重命名文件"
                    className={styles.editorTitleButton}
                    disabled={busyAction !== null}
                    onClick={() => startRename(selectedNote.path, "editor")}
                    title="重命名文件"
                    type="button"
                  >
                    {selectedTitle}
                  </button>
                ) : selectedMindMap ? (
                  selectedTitle
                ) : (
                  "选择内容"
                )}
              </h2>
            )}
            {selectedNote ? (
              <span
                className={styles.saveState}
                data-state={saveState}
                data-tauri-drag-region
              >
                {formatSaveState(saveState)}
              </span>
            ) : null}
            {selection ? (
              <Button
                aria-label="进入禅模式"
                onClick={() => setIsZen(true)}
                size="icon-sm"
                title="进入禅模式"
                type="button"
                variant="outline"
              >
                <Maximize2Icon aria-hidden="true" />
              </Button>
            ) : null}
          </div>

          {selectedMindMap
            ? renderSelectedViewer(isZen)
            : !isZen
              ? renderSelectedViewer(false)
              : null}
        </article>

        <aside
          aria-label="笔记检查器"
          className={styles.inspectorSlot}
          data-library-inspector-slot
        >
          <div
            aria-hidden="true"
            className={styles.inspectorHeader}
            data-tauri-drag-region
          />
          {selectedNote ? (
            <FragmentBacklinksPanel
              fragment={selectedNote}
              indexVersion={indexVersion}
              onNavigate={onNavigateToFragment}
              requestRelated={requestRelated}
            />
          ) : null}
        </aside>
      </div>

      {isZen && selection?.kind === "note" ? (
        <ZenSurface
          ariaLabel="资料库笔记禅模式"
          onRequestClose={() => setIsZen(false)}
        >
          {renderSelectedViewer(true)}
        </ZenSurface>
      ) : null}

      <Dialog
        open={treeDialog !== null}
        onOpenChange={(open) => {
          if (!open && !busyAction) setTreeDialog(null)
        }}
      >
        <DialogContent
          aria-busy={busyAction !== null ? true : undefined}
          showCloseButton={busyAction === null}
        >
          <DialogHeader>
            <DialogTitle>确认删除</DialogTitle>
            <DialogDescription>
              将永久删除「{treeDialog?.entry.name}」，此操作不可撤销。
            </DialogDescription>
          </DialogHeader>

          <DialogFooter className={styles.dialogFooter}>
            <Button
              disabled={busyAction !== null}
              onClick={() => setTreeDialog(null)}
              type="button"
              variant="outline"
            >
              取消
            </Button>
            <Button
              disabled={busyAction !== null}
              onClick={() => void submitTreeDialog()}
              type="button"
              variant="destructive"
            >
              {busyAction ?? "删除"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}

interface TreeEntriesProps {
  busy: boolean
  directories: string[]
  entries: LibraryTreeEntry[]
  expandedPaths: Set<string>
  onConvertToFragment: (entry: LibraryTreeEntry) => void
  onDelete: (entry: LibraryTreeEntry) => void
  onEntryClick: (entry: LibraryTreeEntry) => void
  onMove: (entry: LibraryTreeEntry, destinationDirectory: string) => void
  onMoveToLockbox: (entry: LibraryTreeEntry) => void
  onRename: (entry: LibraryTreeEntry) => void
  onRenameCancel: () => void
  onRenameChange: (value: string) => void
  onRenameSubmit: () => void
  renaming: { path: string; value: string } | null
  renderCreateRow: (parentPath: string) => ReactNode
  selectedPath: string
}

function TreeEntries({
  busy,
  directories,
  entries,
  expandedPaths,
  onConvertToFragment,
  onDelete,
  onEntryClick,
  onMove,
  onMoveToLockbox,
  onRename,
  onRenameCancel,
  onRenameChange,
  onRenameSubmit,
  renaming,
  renderCreateRow,
  selectedPath,
}: TreeEntriesProps) {
  return entries.map((entry) => {
    const expanded =
      entry.kind === "directory" && expandedPaths.has(entry.path)
    const destinations = directories.filter(
      (path) =>
        path !== entry.path &&
        !path.startsWith(`${entry.path}/`) &&
        path !== entry.path.slice(0, entry.path.lastIndexOf("/"))
    )
    const Icon =
      entry.kind === "directory"
        ? FolderIcon
        : entry.kind === "csv"
          ? DatabaseIcon
          : FileTextIcon

    return (
      <li
        aria-expanded={entry.kind === "directory" ? expanded : undefined}
        key={entry.path}
        role="treeitem"
      >
        {renaming?.path === entry.path ? (
          <div className={styles.renameRow}>
            <span className={styles.treeIndentIcon} />
            <Icon aria-hidden="true" />
            <div className={styles.renameWrap}>
              <Input
                aria-label="重命名名称"
                autoFocus
                disabled={busy}
                onBlur={onRenameSubmit}
                onChange={(event) => onRenameChange(event.target.value)}
                onFocus={(event) => event.target.select()}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault()
                    onRenameSubmit()
                  } else if (event.key === "Escape") {
                    event.stopPropagation()
                    onRenameCancel()
                  }
                }}
                value={renaming.value}
              />
            </div>
          </div>
        ) : (
          <div
            className={styles.treeRow}
            data-selected={selectedPath === entry.path ? "true" : undefined}
          >
            <button
              aria-current={selectedPath === entry.path ? "page" : undefined}
              className={styles.treeButton}
              disabled={busy}
              onClick={() => onEntryClick(entry)}
              type="button"
            >
              {entry.kind === "directory" ? (
                expanded ? (
                  <ChevronDownIcon aria-hidden="true" />
                ) : (
                  <ChevronRightIcon aria-hidden="true" />
                )
              ) : (
                <span className={styles.treeIndentIcon} />
              )}
              <Icon aria-hidden="true" />
              <span className={styles.treeLabel}>{entry.name}</span>
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger
                disabled={busy}
                render={
                  <Button
                    aria-label={`${entry.name} 操作`}
                    className={styles.treeMenuButton}
                    size="icon-sm"
                    type="button"
                    variant="ghost"
                  />
                }
              >
                <MoreHorizontalIcon aria-hidden="true" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => onRename(entry)}>
                  重命名
                </DropdownMenuItem>
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>移动到…</DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    {destinations.map((directory) => (
                      <DropdownMenuItem
                        key={directory}
                        onClick={() => onMove(entry, directory)}
                      >
                        {directory === "notes"
                          ? "资料库根目录"
                          : directory.replace(/^notes\//u, "")}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
                {entry.kind === "markdown" ? (
                  <>
                    <DropdownMenuItem onClick={() => onConvertToFragment(entry)}>
                      转为碎片
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => onMoveToLockbox(entry)}>
                      移入密匣
                    </DropdownMenuItem>
                  </>
                ) : null}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() => onDelete(entry)}
                  variant="destructive"
                >
                  删除
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
        {expanded &&
        ((entry.children?.length ?? 0) > 0 ||
          renderCreateRow(entry.path) !== null) ? (
          <ul role="group">
            {renderCreateRow(entry.path)}
            <TreeEntries
              busy={busy}
              directories={directories}
              entries={entry.children ?? []}
              expandedPaths={expandedPaths}
              onConvertToFragment={onConvertToFragment}
              onDelete={onDelete}
              onEntryClick={onEntryClick}
              onMove={onMove}
              onMoveToLockbox={onMoveToLockbox}
              onRename={onRename}
              onRenameCancel={onRenameCancel}
              onRenameChange={onRenameChange}
              onRenameSubmit={onRenameSubmit}
              renaming={renaming}
              renderCreateRow={renderCreateRow}
              selectedPath={selectedPath}
            />
          </ul>
        ) : null}
      </li>
    )
  })
}

function collectDirectoryPaths(entries: LibraryTreeEntry[]): string[] {
  return entries.flatMap((entry) =>
    entry.kind === "directory"
      ? [entry.path, ...collectDirectoryPaths(entry.children ?? [])]
      : []
  )
}

function findTreeEntry(
  entries: LibraryTreeEntry[],
  path: string
): LibraryTreeEntry | null {
  for (const entry of entries) {
    if (entry.path === path) return entry
    const nested = findTreeEntry(entry.children ?? [], path)
    if (nested) return nested
  }
  return null
}

function toggleSetValue(
  setter: Dispatch<SetStateAction<Set<string>>>,
  value: string
) {
  setter((current) => {
    const next = new Set(current)
    if (next.has(value)) next.delete(value)
    else next.add(value)
    return next
  })
}

function LibraryEmptyState({ message }: { message: string }) {
  return (
    <div className={styles.emptyState}>
      <p>{message}</p>
    </div>
  )
}

function escapeMarkdownImageAlt(alt: string) {
  return alt.replace(/\\/g, "\\\\").replace(/]/g, "\\]")
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text)
  )
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
}

function formatSaveState(state: SaveState) {
  switch (state) {
    case "dirty":
      return "待保存"
    case "error":
      return "保存失败"
    case "saving":
      return "保存中…"
    case "saved":
    default:
      return "已保存"
  }
}
