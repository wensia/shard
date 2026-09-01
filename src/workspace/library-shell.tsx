import {
  type Dispatch,
  type ComponentProps,
  type ReactNode,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import {
  ArchiveIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  FilePlus2Icon,
  FolderIcon,
  FolderPlusIcon,
  ImageIcon,
  LockKeyholeIcon,
  Maximize2Icon,
} from "lucide-react"
import { toast } from "sonner"

import { FragmentBacklinksPanel } from "@/components/shard/fragment-related"
import { AssetGrid, AssetViewer } from "@/components/shard/asset-grid"
import {
  DirectoryView,
  DirectoryViewToolbar,
  LibraryEntryMenu,
  type DirectoryViewMode,
  libraryEntryDestinations,
  readDirectoryViewPreference,
  writeDirectoryViewPreference,
} from "@/components/shard/directory-view"
import { FragmentTimeline } from "@/components/shard/fragment-timeline"
import { InboxTagBar } from "@/components/shard/inbox-tag-bar"
import { SearchContextBar } from "@/components/shard/fragment-search-workspace"
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
import { isFragmentInMonth } from "@/lib/fragment-month"
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
  LibraryAssetEntry,
  LibraryMutationResult,
  LibraryTreeEntry,
  LibraryTreeSnapshot,
} from "@/types"

import styles from "./library-shell.module.css"

export type LibrarySaveHandler = () => Promise<boolean>

/** 工作台用来编排「保存门禁」的句柄：flush 排空草稿，isDirty 报告是否有未落盘内容或在飞保存。 */
export interface LibraryDraftHandle {
  flush: LibrarySaveHandler
  isDirty: () => boolean
}

export type LibraryNavigationTarget =
  | { kind: "note"; id: string; requestId: number }
  | { kind: "fragments"; archived?: boolean; requestId: number }

interface LibraryShellProps {
  csvFiles?: CsvFileSummary[]
  archivedFragments: Fragment[]
  fragments: Fragment[]
  fragmentsTimeline: Omit<
    ComponentProps<typeof FragmentTimeline>,
    "fragments" | "scrollToFragmentId"
  >
  fragmentsTagBar: Omit<
    ComponentProps<typeof InboxTagBar>,
    "selectedTag" | "onSelectTag" | "totalCount"
  >
  isLoading: boolean
  libraryTree: LibraryTreeSnapshot | null
  knownTags: string[]
  navigateTo?: LibraryNavigationTarget | null
  onNavigateToFragment?: (fragmentId: string) => void
  onLibraryMutation: (result: LibraryMutationResult) => void
  onMoveToLockbox: (fragment: Fragment) => Promise<void>
  /** 点击树上的密匣挂载点：解锁并进入密匣一级空间（传送门）。 */
  onOpenLockbox: () => void
  pendingScrollFragmentId?: string | null
  searchContextBar?: ComponentProps<typeof SearchContextBar> | null
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
  | { kind: "fragments"; month?: string; archived?: boolean }
  | { kind: "assets"; path?: string }
  | { kind: "directory"; path: string }
  | null

interface RenameState {
  path: string
  source: "directory" | "editor" | "tree"
  value: string
}

export function LibraryShell({
  archivedFragments,
  csvFiles = [],
  fragments,
  fragmentsTimeline,
  fragmentsTagBar,
  isLoading,
  libraryTree,
  knownTags,
  navigateTo = null,
  onNavigateToFragment,
  onLibraryMutation,
  onMoveToLockbox,
  onOpenLockbox,
  pendingScrollFragmentId = null,
  onRegisterSaveHandler,
  onRefreshFragments,
  onSave,
  relationFragments = fragments,
  searchContextBar = null,
}: LibraryShellProps) {
  const notes = useMemo(
    () => fragments.filter((fragment) => deriveKind(fragment.tags) === "note"),
    [fragments]
  )
  const markdownContentByPath = useMemo(
    () => new Map(notes.map((note) => [note.path, note.content])),
    [notes]
  )
  const inboxTimelineFragments = useMemo(
    () =>
      fragments.filter(
        (fragment) =>
          deriveKind(fragment.tags) === "fragment" &&
          fragment.tags.includes("inbox")
      ),
    [fragments]
  )
  const [selection, setSelection] = useState<LibrarySelection>(null)
  const [directoryViewMode, setDirectoryViewMode] =
    useState<DirectoryViewMode>(readDirectoryViewPreference)
  const [fragmentsTag, setFragmentsTag] = useState<string | null>(null)
  const [selectedTreePath, setSelectedTreePath] = useState("notes")
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(
    () => new Set(["notes"])
  )
  const [isFragmentStreamExpanded, setIsFragmentStreamExpanded] =
    useState(false)
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
  const libraryMindMaps = useMemo(
    () => collectMindMapEntries(libraryTree?.entries ?? []),
    [libraryTree]
  )
  const selectedMindMap = useMemo(
    () =>
      selection?.kind === "mindmap"
        ? libraryMindMaps.find((map) => map.path === selection.path) ?? null
        : null,
    [libraryMindMaps, selection]
  )
  const selectedAsset = useMemo<LibraryAssetEntry | null>(
    () =>
      selection?.kind === "assets" && selection.path
        ? libraryTree?.assets.find((asset) => asset.path === selection.path) ?? null
        : null,
    [libraryTree, selection]
  )
  const selectedDirectoryEntries = useMemo(() => {
    if (selection?.kind !== "directory") return []
    if (selection.path === "notes") return libraryTree?.entries ?? []
    return findTreeEntry(libraryTree?.entries ?? [], selection.path)?.children ?? []
  }, [libraryTree, selection])
  const selectedDirectoryViewEntries = useMemo(
    () =>
      selectedDirectoryEntries.map((entry) =>
        entry.kind === "markdown"
          ? { ...entry, content: markdownContentByPath.get(entry.path) }
          : entry
      ),
    [markdownContentByPath, selectedDirectoryEntries]
  )
  const draftRef = useRef(draft)
  const lastSavedContentRef = useRef("")
  /** 上次读到/存下正文的 SHA-256，保存时作为基线校验；null=暂缺（放行保存）。 */
  const baseShaRef = useRef<string | null>(null)
  /** 用户在冲突提示里选择「放弃草稿」后，等待父级刷新换入磁盘版本。 */
  const pendingDiskReloadRef = useRef(false)
  const selectedNoteRef = useRef<Fragment | null>(selectedNote)
  const savePromiseRef = useRef<Promise<boolean> | null>(null)
  const consumedNavigationRef = useRef(0)
  const knownTagsRef = useRef<string[]>([])
  const wikilinkCandidates = useMemo(
    () => [
      ...buildWikilinkCandidates(relationFragments),
      ...buildCsvWikilinkCandidates(csvFiles),
      ...buildMindMapWikilinkCandidates(
        libraryMindMaps.map((entry) => ({
          path: entry.path,
          title: stripMindMapExtension(entry.name),
        }))
      ),
    ],
    [csvFiles, libraryMindMaps, relationFragments]
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
        onNavigateToMindMap: (path) => void selectMindMap(path),
      }),
    [wikilinkCandidates]
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
      !libraryMindMaps.some((map) => map.path === selection.path)
    ) {
      setSelection(null)
      setSelectedTreePath("notes")
      setIsZen(false)
      setMobilePane("list")
    }
  }, [libraryMindMaps, selection])

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
    const map = libraryMindMaps.find((candidate) => candidate.path === path)
    if (!map?.mindMapId) {
      toast.error("思维导图文件无法读取", { duration: Infinity })
      return
    }
    if (selection?.kind !== "mindmap" || selection.path !== path) {
      if (!(await saveCurrentNote())) return
      setSelection({ kind: "mindmap", path })
      setSelectedTreePath(path)
    }
    setIsZen(false)
    setMobilePane("editor")
  }

  async function selectFragmentsView({
    archived,
    month,
  }: {
    archived?: boolean
    month?: string
  }) {
    if (!(await saveCurrentNote())) return
    setSelection({ kind: "fragments", archived, month })
    setFragmentsTag(null)
    setSelectedTreePath("::fragments")
    setIsZen(false)
    setMobilePane("editor")
  }

  async function selectAssetsView(path?: string) {
    if (!(await saveCurrentNote())) return
    setSelection(path ? { kind: "assets", path } : { kind: "assets" })
    setSelectedTreePath("::assets")
    setIsZen(false)
    setMobilePane("editor")
  }

  async function selectDirectoryView(path: string) {
    if (!(await saveCurrentNote())) return
    setSelection({ kind: "directory", path })
    setSelectedTreePath(path)
    setIsZen(false)
    setMobilePane("editor")
  }

  useEffect(() => {
    if (!navigateTo || navigateTo.requestId === consumedNavigationRef.current) {
      return
    }
    if (navigateTo.kind === "note") {
      if (navigateTo.id === selectedNoteRef.current?.id) {
        consumedNavigationRef.current = navigateTo.requestId
        return
      }
      // 目标笔记可能还没进列表（刚整理生成、刷新在途）：不消费，等 notes 更新重试
      if (!notes.some((note) => note.id === navigateTo.id)) return
      consumedNavigationRef.current = navigateTo.requestId
      void selectNote(navigateTo.id)
      return
    }
    consumedNavigationRef.current = navigateTo.requestId
    void selectFragmentsView({ archived: navigateTo.archived })
  }, [navigateTo, notes])

  const visibleTimelineFragments = useMemo(() => {
    if (selection?.kind !== "fragments") return []
    if (selection.archived) return archivedFragments
    return inboxTimelineFragments.filter(
      (fragment) =>
        (!selection.month || isFragmentInMonth(fragment, selection.month)) &&
        (!fragmentsTag || fragment.tags.includes(fragmentsTag))
    )
  }, [
    archivedFragments,
    fragmentsTag,
    inboxTimelineFragments,
    selection,
  ])
  const fragmentsScrollTargetId = pendingScrollFragmentId &&
    visibleTimelineFragments.some((fragment) => fragment.id === pendingScrollFragmentId)
    ? pendingScrollFragmentId
    : null

  // 树只剩目录后，第三栏打开文件就没有回到列表的路了——给出所在目录的返回口，
  // 与图片单张视图的「返回图片列表」同一个模式。
  const openedFileParentPath = (() => {
    const path = selectedNote?.path ?? selectedMindMap?.path
    if (!path) return null
    const separator = path.lastIndexOf("/")
    return separator > 0 ? path.slice(0, separator) : "notes"
  })()

  const selectedTitle =
    selection?.kind === "fragments"
      ? selection.archived
        ? "归档"
        : selection.month
          ? `${selection.month.slice(0, 4)}年${selection.month.slice(5)}月`
          : "碎片流"
      : selection?.kind === "assets"
        ? "图片"
      : selection?.kind === "directory"
        ? selection.path === "notes"
          ? "资料库"
          : selection.path.split("/").pop() || "资料库"
      : selectedNote
        ? selectedNote.path.split("/").pop()?.replace(/\.md$/iu, "") || "无标题笔记"
      : selectedMindMap
        ? stripMindMapExtension(selectedMindMap.name)
        : "选择内容"

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

  function moveEntry(entry: LibraryTreeEntry, destinationDirectory: string) {
    void runSavedMutation("移动", () =>
      moveLibraryEntry(entry.path, destinationDirectory)
    )
  }

  function convertEntryToFragment(entry: LibraryTreeEntry) {
    const note = notes.find((candidate) => candidate.path === entry.path)
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
  }

  function moveEntryToLockbox(entry: LibraryTreeEntry) {
    const note = notes.find((candidate) => candidate.path === entry.path)
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
  }

  function startRename(path: string, source: RenameState["source"]) {
    const fileName = path.split("/").pop() ?? ""
    setRenaming({
      path,
      source,
      value: fileName.replace(/\.(?:shardmap\.json|md|csv)$/iu, ""),
    })
  }

  async function submitRename() {
    if (!renaming || busyAction) return
    const value = renaming.value.trim()
    const currentName = (renaming.path.split("/").pop() ?? "").replace(
      /\.(?:shardmap\.json|md|csv)$/iu,
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
    setSelection({ kind: "directory", path: parent })
    setSelectedTreePath(parent)
    setMobilePane("list")
    startRename(result.fragment.path, "directory")
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
    if (entry.kind === "directory") {
      toggleSetValue(setExpandedPaths, entry.path)
      void selectDirectoryView(entry.path)
      return
    }
    if (entry.kind === "mindmap") {
      void selectMindMap(entry.path)
      return
    }
    if (entry.kind === "csv") {
      setSelectedTreePath(entry.path)
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

  function handleDirectoryEntryClick(entry: LibraryTreeEntry) {
    if (entry.kind === "directory") {
      setExpandedPaths((current) => {
        if (current.has(entry.path)) return current
        const next = new Set(current)
        next.add(entry.path)
        return next
      })
      void selectDirectoryView(entry.path)
      return
    }
    handleTreeEntryClick(entry)
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
    if (selection?.kind === "directory") {
      return (
        <DirectoryView
          busy={busyAction !== null}
          destinations={directories}
          entries={selectedDirectoryViewEntries}
          onConvertToFragment={convertEntryToFragment}
          onDelete={requestDelete}
          onMove={moveEntry}
          onMoveToLockbox={moveEntryToLockbox}
          onOpenEntry={handleDirectoryEntryClick}
          onRename={(entry) => startRename(entry.path, "directory")}
          onRenameCancel={() => setRenaming(null)}
          onRenameChange={(value) =>
            setRenaming((current) =>
              current ? { ...current, value } : null
            )
          }
          onRenameSubmit={() => void submitRename()}
          path={selection.path}
          renaming={renaming?.source === "directory" ? renaming : null}
          viewMode={directoryViewMode}
        />
      )
    }

    if (selection?.kind === "fragments") {
      const emptyMessage = selection.archived
        ? "还没有归档内容。"
        : selection.month
          ? "这个月还没有碎片。"
          : fragmentsTag
            ? `#${fragmentsTag} 下还没有片段。写片段时输入 #${fragmentsTag} 即可归入。`
            : undefined
      return (
        <div className={styles.fragmentsViewport}>
          {selection.archived ? null : (
            <InboxTagBar
              {...fragmentsTagBar}
              onSelectTag={setFragmentsTag}
              selectedTag={fragmentsTag}
              totalCount={
                selection.month
                  ? inboxTimelineFragments.filter((fragment) =>
                      isFragmentInMonth(fragment, selection.month!)
                    ).length
                  : inboxTimelineFragments.length
              }
            />
          )}
          {searchContextBar ? <SearchContextBar {...searchContextBar} /> : null}
          <FragmentTimeline
            {...fragmentsTimeline}
            emptyMessage={emptyMessage}
            fragments={visibleTimelineFragments}
            scrollToFragmentId={fragmentsScrollTargetId}
          />
        </div>
      )
    }

    if (selection?.kind === "assets") {
      if (selection.path && selectedAsset) {
        return (
          <AssetViewer
            asset={selectedAsset}
            onBack={() => void selectAssetsView()}
          />
        )
      }
      return (
        <AssetGrid
          assets={libraryTree?.assets ?? []}
          onSelectAsset={(path) => void selectAssetsView(path)}
        />
      )
    }

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
            mapId={selectedMindMap.mindMapId!}
            surface={zen ? renderMindMapZenSurface : undefined}
          />
        </div>
      )
    }

    return <LibraryEmptyState message="从资料库目录选择碎片流、图片、目录、笔记或思维导图" />
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
              onClick={() => void selectDirectoryView("notes")}
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
                    data-selected={
                      selection?.kind === "fragments" &&
                      !selection.month &&
                      !selection.archived
                        ? "true"
                        : undefined
                    }
                    onClick={() => {
                      setIsFragmentStreamExpanded(true)
                      void selectFragmentsView({})
                    }}
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
                                        data-selected={
                                          selection?.kind === "fragments" &&
                                          selection.month === routeMonth &&
                                          !selection.archived
                                            ? "true"
                                            : undefined
                                        }
                                        onClick={() =>
                                          void selectFragmentsView({ month: routeMonth })
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
                      <li role="treeitem">
                        <button
                          aria-label={`归档（${archivedFragments.length}）`}
                          className={styles.treeButton}
                          data-depth="1"
                          data-selected={
                            selection?.kind === "fragments" && selection.archived
                              ? "true"
                              : undefined
                          }
                          onClick={() =>
                            void selectFragmentsView({ archived: true })
                          }
                          type="button"
                        >
                          <ArchiveIcon aria-hidden="true" />
                          <span>归档</span>
                          <span className={styles.treeCount}>
                            {archivedFragments.length}
                          </span>
                        </button>
                      </li>
                    </ul>
                  ) : null}
                </div>

                {libraryTree.assets.length > 0 ? (
                  <div className={styles.fragmentStream}>
                    <button
                      aria-label={`图片（${libraryTree.assets.length}）`}
                      className={styles.treeButton}
                      data-selected={
                        selection?.kind === "assets" ? "true" : undefined
                      }
                      onClick={() => void selectAssetsView()}
                      type="button"
                    >
                      <ImageIcon aria-hidden="true" />
                      <span>图片</span>
                      <span className={styles.treeCount}>
                        {libraryTree.assets.length}
                      </span>
                    </button>
                  </div>
                ) : null}

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
                      onConvertToFragment={convertEntryToFragment}
                      onEntryClick={handleTreeEntryClick}
                      onMove={moveEntry}
                      onMoveToLockbox={moveEntryToLockbox}
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

                {/* 密匣挂载点：地图上可见、不可展开，推门进入加密一级空间 */}
                <div className={styles.lockboxMount}>
                  <button
                    aria-label="密匣（上锁空间）"
                    className={styles.treeButton}
                    onClick={() => {
                      void (async () => {
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
            {selection?.kind === "directory" ? (
              <DirectoryViewToolbar
                onSelectDirectory={(path) => void selectDirectoryView(path)}
                onViewModeChange={(mode) => {
                  setDirectoryViewMode(mode)
                  writeDirectoryViewPreference(mode)
                }}
                path={selection.path}
                viewMode={directoryViewMode}
              />
            ) : selectedNote &&
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
              <>
                {openedFileParentPath ? (
                  <Button
                    aria-label="返回所在目录"
                    className={styles.backToDirectory}
                    disabled={busyAction !== null}
                    onClick={() => void selectDirectoryView(openedFileParentPath)}
                    size="icon-sm"
                    title="返回所在目录"
                    variant="ghost"
                  >
                    <ChevronLeftIcon aria-hidden="true" />
                  </Button>
                ) : null}
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
                ) : selection ? (
                  selectedTitle
                ) : (
                  "选择内容"
                )}
                </h2>
              </>
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
            {selection &&
            selection.kind !== "fragments" &&
            selection.kind !== "directory" &&
            (selection.kind !== "assets" || selection.path) ? (
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

      {isZen && selection?.kind === "assets" && selectedAsset ? (
        <ZenSurface
          ariaLabel="资料库图片禅模式"
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
  return entries.filter((entry) => entry.kind === "directory").map((entry) => {
    const childDirectories = (entry.children ?? []).filter(
      (child) => child.kind === "directory"
    )
    const createRow = renderCreateRow(entry.path)
    const canExpand = childDirectories.length > 0 || createRow !== null
    const expanded = canExpand && expandedPaths.has(entry.path)
    const destinations = libraryEntryDestinations(entry, directories)

    return (
      <li
        aria-expanded={canExpand ? expanded : undefined}
        key={entry.path}
        role="treeitem"
      >
        {renaming?.path === entry.path ? (
          <div className={styles.renameRow}>
            <span className={styles.treeIndentIcon} />
            <FolderIcon aria-hidden="true" />
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
              {canExpand ? (
                expanded ? (
                  <ChevronDownIcon aria-hidden="true" />
                ) : (
                  <ChevronRightIcon aria-hidden="true" />
                )
              ) : (
                <span className={styles.treeIndentIcon} />
              )}
              <FolderIcon aria-hidden="true" />
              <span className={styles.treeLabel}>{entry.name}</span>
            </button>
            <LibraryEntryMenu
              busy={busy}
              className={styles.treeMenuButton}
              destinations={destinations}
              entry={entry}
              onConvertToFragment={onConvertToFragment}
              onDelete={onDelete}
              onMove={onMove}
              onMoveToLockbox={onMoveToLockbox}
              onRename={onRename}
            />
          </div>
        )}
        {expanded ? (
          <ul role="group">
            {createRow}
            <TreeEntries
              busy={busy}
              directories={directories}
              entries={childDirectories}
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

function collectMindMapEntries(entries: LibraryTreeEntry[]): LibraryTreeEntry[] {
  return entries.flatMap((entry) => [
    ...(entry.kind === "mindmap" ? [entry] : []),
    ...collectMindMapEntries(entry.children ?? []),
  ])
}

function stripMindMapExtension(name: string) {
  return name.replace(/\.shardmap\.json$/iu, "")
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
