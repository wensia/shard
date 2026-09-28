import {
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import {
  GitBranchIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  FilePlus2Icon,
  FileSpreadsheetIcon,
  FolderIcon,
  FolderPlusIcon,
  ImageIcon,
  LockKeyholeIcon,
  Maximize2Icon,
  PlusIcon,
  Trash2Icon,
} from "@/components/icons"

import { FragmentBacklinksPanel } from "@/components/shard/fragment-related"
import { AssetGrid, AssetViewer } from "@/components/shard/asset-grid"
import { DirectorySelectionToolbar } from "@/components/shard/directory-selection-toolbar"
import { TrashEntryContextMenu } from "@/components/shard/library-entry-menu"
import {
  DirectoryView,
  DirectoryViewToolbar,
  LibraryEntryMenu,
  TrashEntryMenu,
  type DirectoryViewMode,
  libraryEntryDestinations,
  readDirectoryViewPreference,
  readDirectorySortPreference,
  writeDirectoryViewPreference,
  writeDirectorySortPreference,
} from "@/components/shard/directory-view"
import { MindMapCanvas, type MindMapCanvasHandle } from "@/components/shard/mind-map-workspace"
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
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import type { CanvasWorkspaceHandle } from "@/features/canvas/canvas-workspace"
import { createCanvas } from "@/features/canvas/api"
import { createCanvasFile, type CanvasFile, type CanvasReadResult } from "@/features/canvas/model"
import { TableWorkspace, type TableWorkspaceHandle } from "@/features/tables/table-workspace"
import { TableImportDialog } from "@/features/tables/exchange-dialog"
import { createTable, type CreateTableRequest } from "@/features/tables/api"
import { createTableId, type TableContent, type TableReadResult } from "@/features/tables/model"
import {
  ShardRichEditor,
  type ShardRichEditorHandle,
} from "@/editor-rich/ShardRichEditor"
import {
  createLibraryDirectory,
  createLibraryNote,
  createMindMap,
  listDiagramDocuments,
  listLibraryTree,
  listFragments,
  convertNoteToFragment,
  deleteLibraryEntry,
  emptyTrash,
  getApiErrorMessage,
  moveLibraryEntry,
  openCsvFile,
  purgeFromTrash,
  renameLibraryEntry,
  restoreFromTrash,
} from "@/lib/api"
import { deriveKind } from "@/lib/content-kind"
import { extractTags, normalizeTagList } from "@/lib/editor-format"
import { libraryEntryName, libraryNameError, type LibrarySort } from "@/lib/library-entry"
import { notify } from "@/lib/notify"
import { useLibraryFileSelection } from "@/lib/use-library-file-selection"
import { useImageUpload } from "@/hooks/use-image-upload"
import { useFragmentRelations } from "@/lib/use-fragment-relations"
import {
  buildCsvWikilinkCandidates,
  buildMindMapWikilinkCandidates,
  buildWikilinkCandidates,
  isCsvWikilinkTarget,
  resolveWikilinkTarget,
} from "@/lib/wikilink"
import type {
  ShardDocumentLink,
  DiagramDocumentSummary,
  CsvFileSummary,
  Fragment,
  LibraryAssetEntry,
  LibraryMutationResult,
  LibraryTreeEntry,
  LibraryTreeSnapshot,
  MindMapReadResult,
} from "@/types"
import type { SearchTarget } from "@/lib/search-contract"

import styles from "./library-shell.module.css"

const CanvasWorkspace = lazy(() => import("@/features/canvas/canvas-workspace").then(module => ({ default: module.CanvasWorkspace })))

export type LibrarySaveHandler = () => Promise<boolean>

/** 工作台用来编排「保存门禁」的句柄：flush 排空草稿，isDirty 报告是否有未落盘内容或在飞保存。 */
export interface LibraryDraftHandle {
  flush: LibrarySaveHandler
  isDirty: () => boolean
  setInteractionBlocked: (blocked: boolean) => void
}

export type LibraryNavigationTarget =
  | { kind: "note"; id: string; requestId: number; edit?: boolean }
  | { kind: "trash"; requestId: number }

export type LibrarySearchNavigationTarget =
  | {
      kind: "note"
      requestId: string
      target: SearchTarget
      fragment: Fragment
      readOnly: boolean
      revision: string
    }
  | {
      kind: "canvas" | "flowchart"
      requestId: string
      target: SearchTarget
      result: CanvasReadResult
    }
  | {
      kind: "table"
      requestId: string
      target: SearchTarget
      result: TableReadResult
    }
  | {
      kind: "mindmap"
      requestId: string
      target: SearchTarget
      result: MindMapReadResult
    }

interface LibraryShellProps {
  vaultPath: string
  csvFiles?: CsvFileSummary[]
  fragments: Fragment[]
  isLoading: boolean
  libraryTree: LibraryTreeSnapshot | null
  knownTags: string[]
  navigateTo?: LibraryNavigationTarget | null
  searchNavigateTo?: LibrarySearchNavigationTarget | null
  onSearchNavigationSettled?: (
    requestId: string,
    result: { status: "ready"; revision: string } | { status: "error"; error: unknown }
  ) => void
  onNavigateToFragment?: (fragmentId: string) => void
  onConvertedToFragment?: (fragment: Fragment) => void
  onLibraryMutation: (result: LibraryMutationResult) => void
  onMoveToLockbox: (fragment: Fragment) => Promise<void>
  /** 点击树上的密匣挂载点：解锁并进入密匣一级空间（传送门）。 */
  onOpenLockbox: () => void
  onRegisterSaveHandler: (handle: LibraryDraftHandle | null) => void
  onRefreshLibrary?: () => Promise<void>
  onTableSaved?: () => void
  onSave: (
    id: string,
    content: string,
    tags: string[],
    expectedSha?: string
  ) => Promise<Fragment>
  /** 冲突后「载入磁盘版本」需要父级重新拉取 fragments 才能拿到最新内容。 */
  onRefreshFragments?: () => Promise<unknown> | void
  relationFragments?: Fragment[]
  /** 向工作台状态栏上报保存态；没有打开文档时报 null。 */
  onSaveStateChange: (state: SaveState | null) => void
}

export type SaveState = "dirty" | "error" | "saved" | "saving"
type TreeDialogState =
  | { kind: "delete"; entry: LibraryTreeEntry }
  | { kind: "batchDelete"; entries: LibraryTreeEntry[] }
  | { kind: "purge"; entry: LibraryTreeEntry }
  | { kind: "emptyTrash" }
type LibrarySelection =
  | { kind: "note"; id: string }
  | { kind: "mindmap"; path: string }
  | { kind: "table"; path: string }
  | { kind: "canvas" | "flowchart"; path: string }
  | { kind: "trash" }
  | { kind: "assets"; path?: string }
  | { kind: "directory"; path: string }
  | null

function readLibrarySelection(vaultPath: string): LibrarySelection {
  try {
    const value = JSON.parse(sessionStorage.getItem(`shard.library-selection:${vaultPath}`) ?? "null")
    if (value?.kind === "note" && typeof value.id === "string") return { kind: "note", id: value.id }
    if (["directory", "mindmap", "table", "canvas", "flowchart"].includes(value?.kind) &&
      typeof value.path === "string" && (value.path === "notes" || value.path.startsWith("notes/"))) {
      return { kind: value.kind, path: value.path }
    }
    if (value?.kind === "assets") return { kind: "assets", ...(typeof value.path === "string" ? { path: value.path } : {}) }
  } catch { /* A missing or stale session preference falls back to the root directory. */ }
  return { kind: "directory", path: "notes" }
}

interface RenameState {
  path: string
  source: "directory" | "editor" | "tree"
  value: string
}

function countTreeEntries(entries: LibraryTreeEntry[]): number {
  return entries.reduce(
    (total, entry) => total + 1 + countTreeEntries(entry.children ?? []),
    0
  )
}

function countLibraryFiles(entries: LibraryTreeEntry[]): number {
  return entries.reduce((total, entry) => total + (
    entry.kind === "directory" ? countLibraryFiles(entry.children ?? []) : 1
  ), 0)
}

/**
 * 两份正文落盘后是否是同一份：后端写入时去掉尾部空白再补一个换行，读回时
 * 去掉开头的空行（`write_fragment_file` / `read_fragment`）。编辑器序列化
 * 从不带尾换行，只按全等比较，排空式保存会把同一份正文无限重存下去。
 */
function isSameStoredBody(left: string, right: string) {
  const stored = (body: string) => body.replace(/^\n+/u, "").trimEnd()
  return stored(left) === stored(right)
}

export function LibraryShell({
  vaultPath,
  csvFiles = [],
  fragments,
  isLoading,
  libraryTree,
  knownTags,
  navigateTo = null,
  searchNavigateTo = null,
  onSearchNavigationSettled,
  onNavigateToFragment,
  onConvertedToFragment,
  onLibraryMutation,
  onMoveToLockbox,
  onOpenLockbox,
  onRegisterSaveHandler,
  onRefreshLibrary,
  onTableSaved,
  onSaveStateChange,
  onRefreshFragments,
  onSave,
  relationFragments = fragments,
}: LibraryShellProps) {
  const notes = useMemo(
    () => fragments.filter((fragment) => deriveKind(fragment.tags) === "note"),
    [fragments]
  )
  const markdownContentByPath = useMemo(
    () => new Map(notes.map((note) => [note.path, note.content])),
    [notes]
  )
  const [selection, setSelection] = useState<LibrarySelection>(() => readLibrarySelection(vaultPath))
  const [searchNote, setSearchNote] = useState<Fragment | null>(null)
  const [activeSearchNavigation, setActiveSearchNavigation] =
    useState<LibrarySearchNavigationTarget | null>(null)
  const [pendingIndexPath, setPendingIndexPath] = useState<string | null>(null)
  const richNoteEditor = useRef<ShardRichEditorHandle>(null)
  const tableHandle = useRef<TableWorkspaceHandle>(null)
  const canvasHandle = useRef<CanvasWorkspaceHandle>(null)
  const mindMapHandle = useRef<MindMapCanvasHandle>(null)
  const selectedCanvasPath = selection?.kind === "canvas" || selection?.kind === "flowchart" ? selection.path : null
  const [canvasSaveState, setCanvasSaveState] = useState<SaveState>("saved")
  const [mindMapSaveState, setMindMapSaveState] = useState<SaveState>("saved")
  const pendingCanvasCreate = useRef<{ parent: string; file: CanvasFile } | null>(null)
  const [importTableParent, setImportTableParent] = useState<string | null>(null)
  const [importTableSource, setImportTableSource] = useState<string | undefined>()
  const pendingTableCreate = useRef<CreateTableRequest | null>(null)
  const selectedTablePath = selection?.kind === "table" ? selection.path : null
  const [tableSaveState, setTableSaveState] = useState<SaveState>("saved")
  const tableStructurePending = useRef(false)
  const [tableStructureBusy, setTableStructureBusy] = useState(false)
  const [interactionBlocked, setInteractionBlocked] = useState(false)
  const [directoryViewMode, setDirectoryViewMode] =
    useState<DirectoryViewMode>(readDirectoryViewPreference)
  const [directorySort, setDirectorySort] = useState<LibrarySort>(readDirectorySortPreference)
  function changeDirectorySort(sort: LibrarySort) {
    setDirectorySort(sort)
    writeDirectorySortPreference(sort)
  }
  const [trashDirectoryPath, setTrashDirectoryPath] = useState(".trash")
  const [selectedTreePath, setSelectedTreePath] = useState("notes")
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(
    () => new Set(["notes"])
  )
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const pendingCreateAction = useRef<(() => void) | null>(null)
  const restoreCreateMenuFocus = useRef(true)

  function queueCreateAction(action: () => void) {
    restoreCreateMenuFocus.current = false
    pendingCreateAction.current = action
  }
  const batchPending = useRef(false)
  const [batchError, setBatchError] = useState<string | null>(null)
  const [treeDialog, setTreeDialog] = useState<TreeDialogState | null>(null)
  const [renaming, setRenaming] = useState<RenameState | null>(null)
  const titleRenameInput = useRef<HTMLInputElement>(null)
  const renamePromiseRef = useRef<Promise<LibraryMutationResult | null> | null>(null)
  useEffect(() => {
    if (renaming?.source !== "editor") return
    const blurTitle = () => titleRenameInput.current?.blur()
    const handlePointerDown = (event: PointerEvent) => {
      const input = titleRenameInput.current
      if (input && !event.composedPath().includes(input)) input.blur()
    }
    // Tauri drag regions cancel the normal mousedown focus transfer.
    // End title editing before that happens, using the same onBlur save path.
    document.addEventListener("pointerdown", handlePointerDown, true)
    window.addEventListener("blur", blurTitle)
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true)
      window.removeEventListener("blur", blurTitle)
    }
  }, [renaming?.source])
  const [creatingDirectory, setCreatingDirectory] = useState<{
    parent: string
    value: string
  } | null>(null)
  const [draft, setDraft] = useState("")
  const [mobilePane, setMobilePane] = useState<"editor" | "list">("editor")
  const [saveState, setSaveState] = useState<SaveState>("saved")
  const [isZen, setIsZen] = useState(false)
  const selectedNoteId = selection?.kind === "note" ? selection.id : null
  const selectedNote = useMemo(
    () => (searchNote?.id === selectedNoteId ? searchNote : null) ??
      notes.find((note) => note.id === selectedNoteId) ?? null,
    [notes, searchNote, selectedNoteId]
  )
  const selectedNoteReadOnly = Boolean(
    activeSearchNavigation?.kind === "note" &&
    activeSearchNavigation.fragment.id === selectedNoteId &&
    activeSearchNavigation.readOnly
  ) || Boolean(searchNote?.archived && searchNote.id === selectedNoteId)
  const selectedTargetReadOnly =
    selectedNoteReadOnly || Boolean(activeSearchNavigation?.target.archived)
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
  const directoryScope = selection?.kind === "directory" ? selection.path : null
  const fileSelection = useLibraryFileSelection(
    directoryScope, selectedDirectoryEntries, directorySort, busyAction !== null || renaming !== null || treeDialog !== null,
  )
  useEffect(() => { setBatchError(null) }, [directoryScope])
  useEffect(() => {
    if (!fileSelection.active && !batchPending.current) setBatchError(null)
  }, [fileSelection.active])
  const [selectionDockSize, setSelectionDockSize] = useState({ width: 0, height: 0 })
  const directoryWorkspaceRef = useRef<HTMLDivElement>(null)
  function clearFileSelectionFromDock() {
    directoryWorkspaceRef.current?.querySelector<HTMLElement>('[data-selection-active="true"]')?.focus({ preventScroll: true })
    fileSelection.onClear()
    setBatchError(null)
  }
  const measureSelectionDock = useCallback(({ width, height }: { width: number; height: number }) => {
    if (width === 0) return
    setSelectionDockSize(current => {
      // Retain clearance when selection/error text disappears, including at the scroll end.
      const nextHeight = Math.ceil(current.width === width ? Math.max(current.height, height) : height)
      return current.width === width && current.height === nextHeight ? current : { width, height: nextHeight }
    })
  }, [])
  const selectedTrashEntries = useMemo(() => {
    if (selection?.kind !== "trash") return []
    if (trashDirectoryPath === ".trash") return libraryTree?.trashEntries ?? []
    return (
      findTreeEntry(libraryTree?.trashEntries ?? [], trashDirectoryPath)
        ?.children ?? []
    )
  }, [libraryTree, selection, trashDirectoryPath])
  const draftRef = useRef(draft)
  const lastSavedContentRef = useRef("")
  /** 上次读到/存下正文的 SHA-256，保存时作为基线校验；null=暂缺（放行保存）。 */
  const baseShaRef = useRef<string | null>(null)
  /** 用户在冲突提示里选择「放弃草稿」后，等待父级刷新换入磁盘版本。 */
  const pendingDiskReloadRef = useRef(false)
  const selectedNoteRef = useRef<Fragment | null>(selectedNote)
  const savePromiseRef = useRef<Promise<boolean> | null>(null)
  const consumedNavigationRef = useRef<string | number | null>(null)
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
  draftRef.current = draft
  selectedNoteRef.current = selectedNote

  const { uploadPastedImages } = useImageUpload({
    getContent: () => draftRef.current,
    isLockbox: selectedNote?.lockbox,
    onUploaded: ({ alt, path, previewUrl }) => {
      if (selectedNoteReadOnly) {
        URL.revokeObjectURL(previewUrl)
        return
      }
      const imageMarkdown = `![${escapeMarkdownImageAlt(alt)}](${path})`
      // 空行分隔：图片附件按方言要独占一个块（技术方案 §3）。只隔一个换行时，
      // 正文末尾若是列表或段落，图片会被当成它的续行。
      const nextDraft = [draftRef.current.trimEnd(), imageMarkdown]
        .filter(Boolean)
        .join("\n\n")
      draftRef.current = nextDraft
      setDraft(nextDraft)
      setSaveState(
        nextDraft === lastSavedContentRef.current ? "saved" : "dirty"
      )
      URL.revokeObjectURL(previewUrl)
    },
  })

  useEffect(() => {
    if (isLoading || !libraryTree) return
    const missingNote = selection?.kind === "note" &&
      !notes.some((note) => note.id === selection.id) &&
      searchNote?.id !== selection.id
    const missingFile = selection && ["directory", "mindmap", "table", "canvas", "flowchart"].includes(selection.kind) &&
      "path" in selection && selection.path !== "notes" && !findTreeEntry(libraryTree.entries, selection.path!)
    if (!selection || missingNote || missingFile) {
      setSelection({ kind: "directory", path: "notes" })
      setSelectedTreePath("notes")
      if (missingNote) {
        setDraft("")
        draftRef.current = ""
        lastSavedContentRef.current = ""
        setSaveState("saved")
      }
      setIsZen(false)
      setMobilePane("editor")
      return
    }
    if (selection.kind === "assets" && selection.path && !libraryTree.assets.some(asset => asset.path === selection.path)) {
      setSelection({ kind: "assets" })
      return
    }
    if (selection.kind === "trash") return
    if (selection.kind !== "note") setSelectedTreePath(selection.kind === "assets" ? "::assets" : selection.path)
    try { sessionStorage.setItem(`shard.library-selection:${vaultPath}`, JSON.stringify(selection)) }
    catch { /* Browsing remains available when session storage is unavailable. */ }
  }, [isLoading, libraryTree, notes, searchNote?.id, selection, vaultPath])

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
    if (tableStructurePending.current) return false
    if (canvasHandle.current && !(await canvasHandle.current.flush())) return false
    if (mindMapHandle.current && !(await mindMapHandle.current.save())) return false
    if (tableHandle.current && !(await tableHandle.current.flush())) return false
    if (selectedNoteReadOnly) return true
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
      // 落盘取编辑器的收敛视图：手打的 `#标签` 还没跟空格时，onChange 缓存的
      // 草稿里是字面转义 `\#标签`。peek 只算不改，用户可以接着打字；宿主刚写入
      // 编辑器还没接到的内容（图片附件）时它原样返回草稿。
      const content = richNoteEditor.current?.peekMarkdown(draftRef.current) ?? draftRef.current
      if (!note || isSameStoredBody(content, lastSavedContentRef.current)) {
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
        notify.error("文档内容不能为空")
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
            "这篇文档的磁盘内容已被修改（可能来自同步或外部编辑）。\n\n「确定」：用当前草稿覆盖磁盘版本\n「取消」：放弃当前草稿，载入磁盘最新版本"
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
        notify.failure("文档保存失败", error, {
          action: { label: "重试", onClick: () => void saveCurrentNote() },
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
  }, [onSave, selectedNoteReadOnly])

  const saveStateRef = useRef<SaveState>("saved")
  saveStateRef.current = saveState

  // 状态栏要的是能触发重渲染的值，saveHandlerRef 那条通道是 ref，拿不到
  useEffect(() => {
    onSaveStateChange(selectedCanvasPath ? canvasSaveState : selectedTablePath ? tableSaveState : selectedMindMap ? mindMapSaveState : selectedNote ? saveState : null)
    return () => onSaveStateChange(null)
  }, [onSaveStateChange, saveState, selectedNote, selectedTablePath, tableSaveState, selectedCanvasPath, canvasSaveState, selectedMindMap, mindMapSaveState])

  useEffect(() => {
    onRegisterSaveHandler({
      flush: saveCurrentNote,
      setInteractionBlocked: blocked => {
        setInteractionBlocked(blocked)
        tableHandle.current?.setInteractionBlocked(blocked)
        canvasHandle.current?.setInteractionBlocked(blocked)
        mindMapHandle.current?.setInteractionBlocked(blocked)
      },
      // error 也算 dirty：内容仍未落盘，检查点与同步都必须等它解决
      isDirty: () =>
        tableStructurePending.current || Boolean(canvasHandle.current?.isDirty()) || Boolean(mindMapHandle.current?.isDirty()) || Boolean(tableHandle.current?.isDirty()) || saveStateRef.current !== "saved" || savePromiseRef.current !== null,
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
      if (selectedNoteRef.current || tableHandle.current || canvasHandle.current || mindMapHandle.current) void saveCurrentNote()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [saveCurrentNote])

  async function selectNote(noteId: string, edit = false) {
    if (noteId !== selectedNoteRef.current?.id) {
      const saved = await saveCurrentNote()
      if (!saved) return false
      if (searchNote?.id !== noteId) setSearchNote(null)
      setSelection({ kind: "note", id: noteId })
      const note = notes.find((candidate) => candidate.id === noteId)
      if (note) setSelectedTreePath(note.path)
    }
    setIsZen(false)
    setMobilePane("editor")
    if (edit) window.requestAnimationFrame(() => {
      if (selectedNoteRef.current?.id === noteId) focusNoteEditor()
    })
    return true
  }

  function focusNoteEditor() {
    richNoteEditor.current?.focus()
  }

  /**
   * 富文本双链芯片的点击：分派规则——
   * CSV 交给系统打开，导图切到画布，碎片 / 笔记走宿主导航，待建只提示。
   */
  function navigateWikilink(target: string) {
    const candidate = resolveWikilinkTarget(target, wikilinkCandidatesRef.current)
    const csvPath =
      candidate?.kind === "csv"
        ? candidate.path
        : isCsvWikilinkTarget(target)
          ? target
          : undefined
    if (csvPath) {
      void openCsvFile(csvPath).catch((error) => {
        notify.failure("CSV 文件打开失败", error)
      })
      return
    }

    if (candidate?.kind === "mindmap" && candidate.path) {
      void selectMindMap(candidate.path)
      return
    }

    if (candidate?.fragmentId) {
      wikilinkNavigateRef.current?.(candidate.fragmentId)
      return
    }

    notify.info(`「${target}」还没有文档`, { description: "可在资料库新建同名文档。" })
  }

  useEffect(() => {
    if (!pendingIndexPath) return
    const note = notes.find(item => item.path === pendingIndexPath)
    if (!note) return
    setPendingIndexPath(null)
    void selectNote(note.id)
  }, [notes, pendingIndexPath])

  async function selectMindMap(path: string) {
    const map = libraryMindMaps.find((candidate) => candidate.path === path)
    if (!map?.mindMapId) {
      notify.error("思维导图无法读取")
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

  async function selectCanvas(path: string, kind: "canvas" | "flowchart" = path.endsWith(".shardflow.json") ? "flowchart" : "canvas") {
    if (selectedCanvasPath !== path) {
      if (!(await saveCurrentNote())) return false
      setSelection({ kind, path })
      setSelectedTreePath(path)
    }
    setIsZen(false)
    setMobilePane("editor")
    return true
  }

  async function openCanvasLink(link: ShardDocumentLink) {
    if (!(await saveCurrentNote())) return
    if (link.targetType === "map" || link.targetType === "flow") {
      try {
        const documents = await listDiagramDocuments()
        const document = documents.find(item => item.id === link.targetId && item.kind === (link.targetType === "map" ? "mindmap" : "flowchart"))
        if (!document) { notify.error("引用的图文档已不存在"); return }
        if (document.kind === "mindmap") await selectMindMap(document.path)
        else await selectCanvas(document.path, "flowchart")
      } catch (error) { notify.failure("图文档打开失败", error) }
      return
    }
    const source = relationFragments.find(fragment => link.targetType === "fragment" ? fragment.id === link.targetId : fragment.path === link.path)
    if (!source) { notify.error("引用的资料已不存在或已移动"); return }
    if (deriveKind(source.tags) === "note") await selectNote(source.id)
    else onNavigateToFragment?.(source.id)
  }

  async function selectTable(path: string) {
    if (selectedTablePath !== path) {
      if (!(await saveCurrentNote())) return false
      setSelection({ kind: "table", path })
      setSelectedTreePath(path)
    }
    setIsZen(false)
    setMobilePane("editor")
    return true
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

  async function selectTrashView(path = ".trash") {
    if (!(await saveCurrentNote())) return false
    setSelection({ kind: "trash" })
    setTrashDirectoryPath(path)
    setSelectedTreePath("::trash")
    setIsZen(false)
    setMobilePane("editor")
    return true
  }

  useEffect(() => {
    if (!navigateTo || navigateTo.requestId === consumedNavigationRef.current) {
      return
    }
    if (navigateTo.kind === "note") {
      // 目标文档可能还没进列表（刚整理生成、刷新在途）：不消费，等 notes 更新重试
      if (!notes.some((note) => note.id === navigateTo.id)) return
      void selectNote(navigateTo.id, navigateTo.edit).then((selected) => {
        if (selected) consumedNavigationRef.current = navigateTo.requestId
      })
      return
    }
    if (navigateTo.kind === "trash") {
      void selectTrashView().then((selected) => {
        if (selected) consumedNavigationRef.current = navigateTo.requestId
      })
    }
  }, [navigateTo, notes])

  useEffect(() => {
    if (
      !searchNavigateTo ||
      searchNavigateTo.requestId === consumedNavigationRef.current ||
      searchNavigateTo.requestId === activeSearchNavigation?.requestId
    ) {
      return
    }

    setActiveSearchNavigation(searchNavigateTo)
    setIsZen(false)
    setMobilePane("editor")
    if (searchNavigateTo.kind === "note") {
      const note = searchNavigateTo.fragment
      setSearchNote(note)
      setSelection({ kind: "note", id: note.id })
      setSelectedTreePath(note.path)
      setDraft(note.content)
      draftRef.current = note.content
      lastSavedContentRef.current = note.content
      baseShaRef.current = null
      setSaveState("saved")
      return
    }
    if (searchNavigateTo.kind === "mindmap") {
      setSelection({ kind: "mindmap", path: searchNavigateTo.target.path })
    } else if (searchNavigateTo.kind === "table") {
      setSelection({ kind: "table", path: searchNavigateTo.target.path })
    } else {
      setSelection({ kind: searchNavigateTo.kind, path: searchNavigateTo.target.path })
    }
    setSelectedTreePath(searchNavigateTo.target.path)
  }, [activeSearchNavigation?.requestId, searchNavigateTo])

  useLayoutEffect(() => {
    const navigation = activeSearchNavigation
    if (
      navigation?.kind !== "note" ||
      navigation.fragment.id !== selectedNote?.id ||
      draft !== navigation.fragment.content
    ) {
      return
    }
    settleSearchNavigation(navigation.requestId, {
      status: "ready",
      revision: navigation.revision,
    })
  }, [activeSearchNavigation, draft, searchNavigateTo, selectedNote?.id])

  function settleSearchNavigation(
    requestId: string,
    result: { status: "ready"; revision: string } | { status: "error"; error: unknown }
  ) {
    if (activeSearchNavigation?.requestId !== requestId) return
    if (result.status === "ready") consumedNavigationRef.current = requestId
    onSearchNavigationSettled?.(requestId, result)
  }

  // 树只剩目录后，第三栏打开文件就没有回到列表的路了——给出所在目录的返回口，
  // 与图片单张视图的「返回图片列表」同一个模式。
  const selectedFilePath = selectedNote?.path ?? selectedMindMap?.path ??
    activeSearchNavigation?.target.path ?? selectedTablePath ?? selectedCanvasPath
  const canEnterZen = selection?.kind === "note" || selection?.kind === "mindmap" ||
    (selection?.kind === "assets" && Boolean(selection.path))
  const openedFileParentPath = (() => {
    const path = selectedFilePath
    if (!path) return null
    const separator = path.lastIndexOf("/")
    return separator > 0 ? path.slice(0, separator) : "notes"
  })()

  const selectedTitle =
    selection?.kind === "trash"
        ? "回收站"
      : selection?.kind === "assets"
        ? "图片"
      : selection?.kind === "directory"
        ? selection.path === "notes"
          ? "资料库"
          : selection.path.split("/").pop() || "资料库"
      : selectedCanvasPath
        ? selectedCanvasPath.split("/").pop()?.replace(/\.shard(?:canvas|flow)\.json$/iu, "") || "未命名流程图"
      : selectedTablePath
        ? selectedTablePath.split("/").pop()?.replace(/\.shardtable\.json$/iu, "") || "未命名多维表格"
      : selectedNote
        ? selectedNote.path.split("/").pop()?.replace(/\.md$/iu, "") || "无标题文档"
      : selectedMindMap
        ? stripMindMapExtension(selectedMindMap.name)
        : "选择内容"

  const directories = useMemo(
    () => ["notes", ...collectDirectoryPaths(libraryTree?.entries ?? [])],
    [libraryTree]
  )
  const batchDestinations = useMemo(() => fileSelection.selectedEntries.reduce(
    (available, entry) => libraryEntryDestinations(entry, available), directories,
  ), [directories, fileSelection.selectedEntries])
  const selectedDirectory = useMemo(() => {
    if (selectedTreePath === "notes") return "notes"
    const selectedEntry = findTreeEntry(libraryTree?.entries ?? [], selectedTreePath)
    if (selectedEntry?.kind === "directory") return selectedEntry.path
    const separator = selectedTreePath.lastIndexOf("/")
    return separator > 0 ? selectedTreePath.slice(0, separator) : "notes"
  }, [libraryTree, selectedTreePath])
  const activeFileDirectory = selection && !["assets", "trash"].includes(selection.kind)
    ? selectedDirectory : null
  const fileCount = useMemo(() => countLibraryFiles(libraryTree?.entries ?? []), [libraryTree])

  useEffect(() => {
    if (!activeFileDirectory || activeFileDirectory === "notes") return
    setExpandedPaths((current) => {
      const ancestors = activeFileDirectory.split("/").slice(0, -1)
        .map((_, index, parts) => parts.slice(0, index + 1).join("/"))
      if (ancestors.every(path => current.has(path))) return current
      return new Set([...current, ...ancestors])
    })
  }, [activeFileDirectory])

  async function runMutation(
    label: string,
    mutation: () => Promise<LibraryMutationResult>,
    { revealNote = true, reportError = true, onSuccess }: { revealNote?: boolean; reportError?: boolean; onSuccess?(result: LibraryMutationResult): void } = {}
  ) {
    if (busyAction) return null
    setBusyAction(label)
    try {
      const result = await mutation()
      onLibraryMutation(result)
      if (result.fragment && deriveKind(result.fragment.tags) === "note") {
        if (revealNote) {
          setSelection({ kind: "note", id: result.fragment.id })
          setMobilePane("editor")
        }
        setSelectedTreePath(result.fragment.path)
      }
      if (result.updatedLinks > 0) {
        notify.success(`${result.updatedLinks} 处双链引用已更新`)
      }
      // Keep path selection and the new tree in one update, before a missing-file effect can clear the viewer.
      onSuccess?.(result)
      return result
    } catch (error) {
      if (reportError) notify.failure(`${label}失败`, error)
      return null
    } finally {
      setBusyAction(null)
    }
  }

  async function runSavedMutation(
    label: string,
    mutation: () => Promise<LibraryMutationResult>,
    options?: { revealNote?: boolean; reportError?: boolean; onSuccess?(result: LibraryMutationResult): void }
  ) {
    if (busyAction || tableStructurePending.current) return null
    const table = tableHandle.current ?? canvasHandle.current ?? mindMapHandle.current
    table?.setInteractionBlocked(true)
    setTableStructureBusy(true)
    // Begin the existing flush before closing navigation's gate. The table's
    // synchronous input gate spans that flush, the filesystem work and remap.
    const saving = saveCurrentNote()
    tableStructurePending.current = true
    try {
      if (!(await saving)) return null
      return await runMutation(label, mutation, options)
    } finally {
      tableStructurePending.current = false
      table?.setInteractionBlocked(false)
      setTableStructureBusy(false)
    }
  }

  function requestDelete(entry: LibraryTreeEntry) {
    setTreeDialog({ kind: "delete", entry })
  }

  function requestPurge(entry: LibraryTreeEntry) {
    setTreeDialog({ kind: "purge", entry })
  }

  function remapSelectedTable(oldPath: string, newPath: string) {
    setSelection(current => {
      if ((current?.kind !== "table" && current?.kind !== "canvas" && current?.kind !== "flowchart" && current?.kind !== "mindmap") || !(current.path === oldPath || current.path.startsWith(`${oldPath}/`))) return current
      const path = newPath + current.path.slice(oldPath.length)
      setSelectedTreePath(path)
      return { kind: current.kind, path }
    })
  }

  function moveEntry(entry: LibraryTreeEntry, destinationDirectory: string) {
    void runSavedMutation("移动", () =>
      moveLibraryEntry(entry.path, destinationDirectory),
      { onSuccess: () => remapSelectedTable(entry.path, `${destinationDirectory}/${entry.name}`) }
    )
  }

  async function runBatchMutation(entries: LibraryTreeEntry[], destination?: string) {
    if (batchPending.current || busyAction || tableStructurePending.current || entries.length === 0) return
    batchPending.current = true
    const label = destination ? "移动" : "删除"
    const completed: string[] = []
    let latest: LibraryMutationResult | null = null
    let updatedLinks = 0
    setBatchError(null)
    setBusyAction(`${label}中（0/${entries.length}）`)
    const saving = saveCurrentNote()
    tableStructurePending.current = true
    try {
      if (!(await saving)) return
      for (const entry of entries) {
        setBusyAction(`${label}中（${completed.length + 1}/${entries.length}）`)
        try {
          latest = destination
            ? await moveLibraryEntry(entry.path, destination)
            : await deleteLibraryEntry(entry.path)
          updatedLinks += latest.updatedLinks
          completed.push(entry.path)
        } catch (error) {
          let message = `已完成 ${completed.length}/${entries.length} 项；「${entry.name}」操作失败：${getApiErrorMessage(error)}，已停止后续操作。`
          let hasRemainingFiles = true
          // A command can fail while building its result after the file has moved.
          // Read the actual tree before offering another attempt; never retry writes.
          if (latest) onLibraryMutation({ ...latest, updatedLinks })
          try {
            const tree = await listLibraryTree()
            hasRemainingFiles = entries.some(entry => findTreeEntry(tree.entries, entry.path) !== null)
            onLibraryMutation({ tree, updatedLinks: 0 })
          } catch {
            message += " 目录刷新失败，请重新打开资料库核对结果。"
          }
          setBatchError(message)
          if (!hasRemainingFiles) {
            notify.warning("请核对文件位置", { description: `批量${label}时出现异常，目录已刷新。` })
          }
          fileSelection.finish(completed, false)
          setTreeDialog(null)
          return
        }
      }
      if (latest) onLibraryMutation({ ...latest, updatedLinks })
      fileSelection.finish(completed, true)
      setTreeDialog(null)
      notify.success(`${completed.length} 项已${label}`, updatedLinks ? { description: `同时更新了 ${updatedLinks} 处双链引用。` } : undefined)
    } finally {
      tableStructurePending.current = false
      batchPending.current = false
      setBusyAction(null)
    }
  }

  function convertEntryToFragment(entry: LibraryTreeEntry) {
    const note = notes.find((candidate) => candidate.path === entry.path)
    if (!note) return
    const parent = note.path.slice(0, note.path.lastIndexOf("/")) || "notes"
    let attempted = false
    let failure: unknown
    function closeConvertedDocument() {
      setSelection({ kind: "directory", path: parent })
      setSelectedTreePath(parent)
      selectedNoteRef.current = null
      setIsZen(false)
      setMobilePane("editor")
      try { sessionStorage.setItem(`shard.library-selection:${vaultPath}`, JSON.stringify({ kind: "directory", path: parent })) }
      catch { /* The conversion does not depend on restoring the previous directory. */ }
    }
    function openConvertedFragment(fragment: Fragment) {
      closeConvertedDocument()
      setInteractionBlocked(false)
      if (onConvertedToFragment) onConvertedToFragment(fragment)
      else onNavigateToFragment?.(fragment.id)
    }
    async function verifyConversion() {
      // A failed response does not prove that the file stayed in notes. Freeze
      // the old editor until a read confirms the current identity and type.
      setInteractionBlocked(true)
      try {
        const state = await listFragments()
        const current = state.fragments.find(fragment => fragment.id === note!.id)
        if (current && deriveKind(current.tags) === "fragment") {
          try {
            const tree = await listLibraryTree()
            onLibraryMutation({ tree, fragment: current, updatedLinks: 0 })
          } catch {
            // The object is already verified. A tree refresh failure must not
            // leave its previous document editor available for another save.
            void onRefreshLibrary?.().catch(() => undefined)
          }
          openConvertedFragment(current)
          notify.success("内容已转回碎片")
        } else if (current) {
          setInteractionBlocked(false)
          notify.failure("转回碎片失败", failure)
        } else {
          closeConvertedDocument()
          setInteractionBlocked(false)
          notify.error("文档当前无法访问", { description: "已关闭编辑器并刷新资料库。" })
          void onRefreshLibrary?.().catch(() => undefined)
        }
        void Promise.resolve(onRefreshFragments?.()).catch(() => undefined)
      } catch (verifyError) {
        notify.failure("转换结果暂时无法核对", verifyError, {
          description: "已暂停原文档编辑。",
          action: { label: "重新核对", onClick: () => void verifyConversion() },
        })
      }
    }
    void runSavedMutation("转回碎片", async () => {
      attempted = true
      try { return await convertNoteToFragment(note.id) }
      catch (error) { failure = error; throw error }
    }, { revealNote: false, reportError: false }).then((result) => {
      if (result?.fragment) openConvertedFragment(result.fragment)
      else if (attempted) void verifyConversion()
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
      value: fileName.replace(/\.(?:shardflow\.json|shardcanvas\.json|shardtable\.json|shardmap\.json|md|csv)$/iu, ""),
    })
  }

  async function submitRename() {
    if (renamePromiseRef.current) return renamePromiseRef.current
    if (!renaming || busyAction) return
    const value = renaming.value.trim()
    const currentName = (renaming.path.split("/").pop() ?? "").replace(
      /\.(?:shardflow\.json|shardcanvas\.json|shardtable\.json|shardmap\.json|md|csv)$/iu,
      ""
    )
    if (!value || value === currentName) {
      setRenaming(null)
      return
    }
    const entry = findTreeEntry(libraryTree?.entries ?? [], renaming.path)
    const extension = entry ? entry.name.slice(libraryEntryName(entry).length) : ""
    const nameError = libraryNameError(value, extension)
    if (nameError) {
      notify.error("名称过长", { description: nameError })
      return
    }
    const oldPath = renaming.path
    const promise = runSavedMutation("重命名", () => renameLibraryEntry(oldPath, value), {
      onSuccess: () => {
        const extension = oldPath.endsWith(".shardflow.json") ? ".shardflow.json" : oldPath.endsWith(".shardmap.json") ? ".shardmap.json" : oldPath.endsWith(".shardcanvas.json") ? ".shardcanvas.json" : oldPath.endsWith(".shardtable.json") ? ".shardtable.json" : ""
        const name = extension && !value.endsWith(extension) ? `${value}${extension}` : value
        remapSelectedTable(oldPath, `${oldPath.slice(0, oldPath.lastIndexOf("/"))}/${name}`)
        setRenaming(null)
      },
    })
    renamePromiseRef.current = promise
    try {
      return await promise
    } finally {
      renamePromiseRef.current = null
    }
  }

  async function tableCreated(result: TableReadResult) {
    onTableSaved?.()
    await onRefreshLibrary?.()
    if (!(await selectTable(result.path))) throw new Error("多维表格已创建；当前内容尚未保存，暂未打开")
  }

  async function importLibraryTable(entry: LibraryTreeEntry) {
    if (busyAction || !(await saveCurrentNote())) return
    setImportTableSource(`${vaultPath.replace(/\/$/u, "")}/${entry.path}`)
    setImportTableParent(entry.path.slice(0, entry.path.lastIndexOf("/")))
  }

  async function createNativeMindMap() {
    if (busyAction || !(await saveCurrentNote())) return
    setBusyAction("新建思维导图")
    try {
      const result = await createMindMap("未命名思维导图", undefined, selectedDirectory)
      onTableSaved?.()
      await onRefreshLibrary?.()
      setSelection({ kind: "mindmap", path: result.path })
      setSelectedTreePath(result.path)
      setIsZen(false)
      setMobilePane("editor")
    } catch (error) { notify.failure("思维导图创建失败", error) }
    finally { setBusyAction(null) }
  }

  async function copyDiagramLink(entry: LibraryTreeEntry) {
    try {
      const documents = await listDiagramDocuments()
      const document = documents.find(item => item.path === entry.path)
      if (!document) throw new Error("图文档已不存在")
      const label = document.title.replace(/[\[\]\\]/gu, "\\$&")
      await navigator.clipboard.writeText(`[${label}](shard://${document.kind === "mindmap" ? "map" : "flow"}/${encodeURIComponent(document.id)})`)
      notify.success("文档链接已复制", { description: "可粘贴到文档中。" })
    } catch (error) { notify.failure("文档链接复制失败", error) }
  }

  async function onCanvasSplit(result: { documents: DiagramDocumentSummary[]; indexPath: string }) {
    onTableSaved?.()
    await onRefreshLibrary?.()
    await onRefreshFragments?.()
    setSelection({ kind: "directory", path: result.indexPath.slice(0, result.indexPath.lastIndexOf("/")) })
    setSelectedTreePath(result.indexPath)
    setPendingIndexPath(result.indexPath)
  }

  async function createNativeFlowchart() {
    if (busyAction || !(await saveCurrentNote())) return
    setBusyAction("新建流程图")
    try {
      pendingCanvasCreate.current ??= { parent: selectedDirectory, file: createCanvasFile("未命名流程图") }
      const request = pendingCanvasCreate.current
      const result = await createCanvas(request.parent, request.file.title, request.file)
      onTableSaved?.()
      await onRefreshLibrary?.()
      if (await selectCanvas(result.path)) pendingCanvasCreate.current = null
    } catch (error) {
      notify.failure("流程图创建失败", error)
    } finally { setBusyAction(null) }
  }

  async function createNativeTable() {
    if (busyAction || !(await saveCurrentNote())) return
    setBusyAction("新建多维表格")
    try {
      if (!pendingTableCreate.current) {
        const primary = createTableId("fld"); const viewId = createTableId("view")
        const content: TableContent = { primaryFieldId: primary, fields: { [primary]: { id: primary, name: "名称", type: "text" } }, fieldOrder: [primary], records: {}, recordOrder: [],
          views: { [viewId]: { id: viewId, name: "全部记录", type: "table", filters: { operator: "and", conditions: [] }, sorts: [], groupBy: null, fieldOrder: [primary], hiddenFieldIds: [], columnWidths: {} } }, viewOrder: [viewId] }
        pendingTableCreate.current = { requestId: createTableId("req"), tableId: createTableId("tbl"), parentPath: selectedDirectory, suggestedName: "未命名", content }
      }
      const result = await createTable(pendingTableCreate.current)
      await tableCreated(result)
      pendingTableCreate.current = null
    } catch (error) { notify.failure("多维表格创建失败", error) }
    finally { setBusyAction(null) }
  }

  async function createNoteAndEdit() {
    const parent = selectedDirectory
    const result = await runSavedMutation(
      "新建文档",
      () => createLibraryNote(parent, "未命名")
    )
    if (!result?.fragment) return
    if (parent !== "notes") {
      setExpandedPaths((current) => new Set(current).add(parent))
    }
    setIsZen(false)
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
    const nameError = libraryNameError(value)
    if (nameError) {
      notify.error("名称过长", { description: nameError })
      return
    }
    const result = await runMutation("新建目录", () =>
      createLibraryDirectory(creatingDirectory.parent, value)
    )
    if (result) setCreatingDirectory(null)
  }

  async function submitTreeDialog() {
    if (!treeDialog || busyAction) return
    if (treeDialog.kind === "batchDelete") {
      await runBatchMutation(treeDialog.entries)
      return
    }
    if (treeDialog.kind === "emptyTrash") {
      const result = await runMutation("清空回收站", emptyTrash)
      if (!result) return
      setTrashDirectoryPath(".trash")
      setTreeDialog(null)
      return
    }
    const deletedPath = treeDialog.entry.path
    const result =
      treeDialog.kind === "purge"
        ? await runMutation("彻底删除", () => purgeFromTrash(deletedPath))
        : await runSavedMutation("删除", () =>
            deleteLibraryEntry(deletedPath)
          )
    if (!result) return
    if (
      treeDialog.kind === "delete" &&
      (selectedTreePath === deletedPath ||
        selectedTreePath.startsWith(`${deletedPath}/`))
    ) {
      setSelection({ kind: "directory", path: "notes" })
      setSelectedTreePath("notes")
      setIsZen(false)
      setMobilePane("list")
    }
    setTreeDialog(null)
  }

  function restoreTrashEntry(entry: LibraryTreeEntry) {
    void runMutation("恢复", () => restoreFromTrash(entry.path))
  }

  function handleTreeEntryClick(entry: LibraryTreeEntry) {
    if (busyAction || batchPending.current) return
    if (entry.kind === "directory") {
      void selectDirectoryView(entry.path)
      return
    }
    if (entry.kind === "canvas" || entry.kind === "flowchart") {
      void selectCanvas(entry.path)
      return
    }
    if (entry.kind === "table") {
      void selectTable(entry.path)
      return
    }
    if (entry.kind === "mindmap") {
      void selectMindMap(entry.path)
      return
    }
    if (entry.kind === "csv") {
      setSelectedTreePath(entry.path)
      void openCsvFile(entry.path).catch((error) =>
        notify.failure("CSV 文件打开失败", error)
      )
      return
    }
    const note = notes.find((candidate) => candidate.path === entry.path)
    if (note) {
      void selectNote(note.id)
    } else {
      notify.warning("文档还在准备中", { description: "请稍后再试。" })
    }
  }

  function handleDirectoryEntryClick(entry: LibraryTreeEntry) {
    if (entry.kind === "directory") {
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
        <div ref={directoryWorkspaceRef} className={styles.directoryWorkspace}>
          <DirectoryView
            bottomInset={selectionDockSize.height}
            busy={busyAction !== null}
            destinations={directories}
            entries={selectedDirectoryViewEntries}
            sort={directorySort}
            onSortChange={changeDirectorySort}
            onConvertToFragment={convertEntryToFragment}
            onCreateNote={() => void createNoteAndEdit()}
            onCreateDirectory={startCreateDirectory}
            onBatchDelete={entries => setTreeDialog({ kind: "batchDelete", entries })}
            onBatchMove={(entries, destination) => void runBatchMutation(entries, destination)}
            onCopyDocumentLink={copyDiagramLink}
            onDelete={requestDelete}
            onImportTable={(entry) => void importLibraryTable(entry)}
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
            selection={fileSelection}
            viewMode={directoryViewMode}
          />
          <DirectorySelectionToolbar
            visible={fileSelection.paths.size > 0 || batchPending.current}
            onSizeChange={measureSelectionDock}
            busy={busyAction !== null}
            count={fileSelection.paths.size}
            total={selectedDirectoryEntries.length}
            destinations={batchDestinations}
            progress={batchPending.current ? busyAction : null}
            error={batchError}
            onSelectAll={fileSelection.onSelectAll}
            onDeselectAll={clearFileSelectionFromDock}
            onMove={destination => void runBatchMutation([...fileSelection.selectedEntries], destination)}
            onDelete={() => setTreeDialog({ kind: "batchDelete", entries: [...fileSelection.selectedEntries] })}
            onDone={clearFileSelectionFromDock}
          />
        </div>
      )
    }


    if (selection?.kind === "trash") {
      return (
        <DirectoryView
          busy={busyAction !== null}
          destinations={[]}
          emptyMessage="回收站是空的"
          entries={selectedTrashEntries}
          sort={directorySort}
          onSortChange={changeDirectorySort}
          isEntryOpenable={(entry) => entry.kind === "directory"}
          onConvertToFragment={() => undefined}
          onDelete={() => undefined}
          onMove={() => undefined}
          onMoveToLockbox={() => undefined}
          onOpenEntry={(entry) => {
            if (entry.kind === "directory") void selectTrashView(entry.path)
          }}
          onRename={() => undefined}
          onRenameCancel={() => undefined}
          onRenameChange={() => undefined}
          onRenameSubmit={() => undefined}
          path={trashDirectoryPath}
          renaming={null}
          renderEntryActions={(entry) => (
            <TrashEntryMenu
              busy={busyAction !== null}
              entry={entry}
              onPurge={requestPurge}
              onRestore={restoreTrashEntry}
            />
          )}
          renderEntryContextMenu={(entry, element) => (
            <TrashEntryContextMenu key={entry.path} busy={busyAction !== null} entry={entry} onPurge={requestPurge} onRestore={restoreTrashEntry}>
              {element}
            </TrashEntryContextMenu>
          )}
          viewMode={directoryViewMode}
        />
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

    if (selectedCanvasPath) {
      const searchCanvas = activeSearchNavigation &&
        (activeSearchNavigation.kind === "canvas" || activeSearchNavigation.kind === "flowchart") &&
        activeSearchNavigation.target.path === selectedCanvasPath
        ? activeSearchNavigation
        : null
      return <Suspense fallback={<LibraryEmptyState message={selection?.kind === "flowchart" ? "正在载入流程图…" : "正在载入旧画布…"} />}>
        <CanvasWorkspace key={`${selectedCanvasPath}:${searchCanvas?.requestId ?? "browse"}`} ref={canvasHandle} path={selectedCanvasPath}
          initialRead={searchCanvas?.result ?? null} fragments={relationFragments}
          readOnly={Boolean(searchCanvas?.target.archived)}
          onOpenLink={openCanvasLink} onSplit={onCanvasSplit} onSaved={onTableSaved} onSaveStateChange={setCanvasSaveState}
          onReady={(revision) => searchCanvas && settleSearchNavigation(searchCanvas.requestId, { status: "ready", revision })}
          onLoadError={(error) => searchCanvas && settleSearchNavigation(searchCanvas.requestId, { status: "error", error })}
          onRecovered={async (path) => {
            setSelection({ kind: path.endsWith(".shardflow.json") ? "flowchart" : "canvas", path })
            setSelectedTreePath(path)
            setCanvasSaveState("saved")
            try { await onRefreshLibrary?.() }
            catch (error) { notify.failure("资料库刷新失败", error, { description: "画布副本已保存。" }) }
          }} />
      </Suspense>
    }

    if (selectedTablePath) {
      const searchTable = activeSearchNavigation?.kind === "table" &&
        activeSearchNavigation.target.path === selectedTablePath
        ? activeSearchNavigation
        : null
      return <TableWorkspace key={`${selectedTablePath}:${searchTable?.requestId ?? "browse"}`} ref={tableHandle} embedded disabled={Boolean(searchTable?.target.archived) || tableStructureBusy || !!busyAction}
        initialRead={searchTable?.result ?? null} path={selectedTablePath} title={selectedTitle} refreshToken={libraryTree}
        onReady={(revision) => searchTable && settleSearchNavigation(searchTable.requestId, { status: "ready", revision })}
        onLoadError={(error) => searchTable && settleSearchNavigation(searchTable.requestId, { status: "error", error })}
        onSaveStateChange={setTableSaveState} onSaved={onTableSaved} onClose={() => void selectDirectoryView(openedFileParentPath ?? "notes")} />
    }

    if (selectedNote) {
      return (
        <div className={zen ? styles.zenNoteViewport : styles.editorViewport}>
          <ShardRichEditor
            ref={richNoteEditor}
            ariaLabel="资料库文档编辑器"
            autoFocus={zen || mobilePane === "editor"}
            editorId={`library:${selectedNote.id}`}
            getKnownTags={() => knownTagsRef.current}
            getWikilinkCandidates={() => wikilinkCandidatesRef.current}
            // 换一篇文档就换一个编辑器实例：正文与撤销历史一起重置。
            key={`${selectedNote.id}:${activeSearchNavigation?.kind === "note" ? activeSearchNavigation.requestId : "browse"}`}
            onChange={selectedNoteReadOnly ? () => undefined : (content) => {
              setDraft(content)
              draftRef.current = content
              setSaveState(
                content === lastSavedContentRef.current ? "saved" : "dirty"
              )
            }}
            onDropFiles={selectedNoteReadOnly ? undefined : (files) => void uploadPastedImages(files)}
            // ProseMirror 对 Esc 一律 preventDefault，ZenSurface 挂在 window 上的
            // 监听因此等不到这个键；由编辑器转交回宿主（见 shard-host.ts）。
            onEscape={zen ? () => setIsZen(false) : undefined}
            onImageFiles={selectedNoteReadOnly ? undefined : (files) => void uploadPastedImages(files)}
            onNavigateWikilink={navigateWikilink}
            onOpenDocumentLink={(link) => void openCanvasLink(link)}
            onPasteFiles={selectedNoteReadOnly ? undefined : (files) => void uploadPastedImages(files)}
            onSubmit={selectedNoteReadOnly ? undefined : () => void saveCurrentNote()}
            placeholder="开始写文档…"
            readOnly={selectedNoteReadOnly || interactionBlocked || tableStructureBusy || busyAction !== null}
            // 资料库里全是文档：工具集合按文档档开放（产品框架 §2）。
            tier="document"
            value={draft}
            variant="library"
          />
        </div>
      )
    }

    const searchMindMap = activeSearchNavigation?.kind === "mindmap" &&
      selection?.kind === "mindmap" &&
      activeSearchNavigation.target.path === selection.path
      ? activeSearchNavigation
      : null
    if (selectedMindMap || searchMindMap) {
      return (
        <div
          className={
            zen ? styles.zenMindMapViewport : styles.mindMapViewport
          }
        >
          <MindMapCanvas
            initialRead={searchMindMap?.result ?? null}
            key={`${selection?.kind === "mindmap" ? selection.path : "map"}:${searchMindMap?.requestId ?? "browse"}`}
            ref={mindMapHandle}
            mapId={searchMindMap?.result.file.id ?? selectedMindMap!.mindMapId!}
            fragments={relationFragments}
            onOpenLink={openCanvasLink}
            onSaveStateChange={setMindMapSaveState}
            onMapsChange={() => onTableSaved?.()}
            onReady={(revision) => searchMindMap && settleSearchNavigation(searchMindMap.requestId, { status: "ready", revision })}
            onLoadError={(error) => searchMindMap && settleSearchNavigation(searchMindMap.requestId, { status: "error", error })}
            readOnly={Boolean(searchMindMap?.target.archived)}
            surface={zen ? renderMindMapZenSurface : undefined}
            toolbarLeading={zen ? <Button aria-label="退出禅模式" title="退出禅模式（Esc）"
              onClick={() => setIsZen(false)} size="icon-sm" variant="ghost"><ChevronLeftIcon /></Button> : undefined}
          />
        </div>
      )
    }

    return <LibraryEmptyState message="从资料库选择文档、图片、目录、多维表格、思维导图或流程图" />
  }

  const dialogTitle =
    treeDialog?.kind === "emptyTrash"
      ? "确认清空资料库回收站"
      : treeDialog?.kind === "purge"
        ? "确认彻底删除"
        : "确认删除"
  const dialogDescription =
    treeDialog?.kind === "emptyTrash"
      ? "资料库回收站中的文档和文件将被永久删除，此操作不可恢复。"
      : treeDialog?.kind === "purge"
        ? `「${treeDialog.entry.name}」将被永久删除，此操作不可恢复。`
        : treeDialog?.kind === "batchDelete"
          ? `选中的 ${treeDialog.entries.length} 项及所选目录中的内容将移入回收站，之后仍可恢复。`
        : treeDialog?.kind === "delete"
          ? `「${treeDialog.entry.name}」将移入回收站，之后仍可恢复。`
          : ""
  const dialogConfirmLabel =
    treeDialog?.kind === "emptyTrash"
      ? "清空回收站"
      : treeDialog?.kind === "purge"
        ? "彻底删除"
        : treeDialog?.kind === "batchDelete"
          ? `删除 ${treeDialog.entries.length} 项`
        : "删除"

  return (
    <section aria-label="资料库" className={styles.shell}>
      <div className={styles.workspace} data-table-open={selectedTablePath || selectedCanvasPath || selectedMindMap ? "true" : undefined}>
        <aside
          aria-busy={busyAction !== null || isLoading ? true : undefined}
          aria-label="资料库目录"
          className={styles.noteListPane}
          data-focus-region="library-tree"
          data-mobile-hidden={mobilePane === "editor" ? "true" : undefined}
        >
          {/* 标题栏工具条：根目录 + 新建操作直接放进 Overlay 标题栏，空白处保持可拖拽 */}
          <div className={styles.paneHeader} data-tauri-drag-region>
            <h2 className={styles.paneTitle}>资料库</h2>
            <div className={styles.paneActions}>
              <DropdownMenu onOpenChange={(open) => {
                if (open) restoreCreateMenuFocus.current = true
              }} onOpenChangeComplete={(open) => {
                if (open) return
                const action = pendingCreateAction.current
                pendingCreateAction.current = null
                action?.()
              }}>
                <DropdownMenuTrigger disabled={busyAction !== null || isLoading} render={
                  <Button aria-label="新建" size="sm" variant="outline" />
                }>
                  <PlusIcon aria-hidden="true" />新建
                  <ChevronDownIcon aria-hidden="true" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" finalFocus={() => restoreCreateMenuFocus.current}>
                  <DropdownMenuItem onClick={() => queueCreateAction(() => void createNoteAndEdit())}>
                    <FilePlus2Icon aria-hidden="true" />新建文档
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => queueCreateAction(() => void createNativeTable())}>
                    <FileSpreadsheetIcon aria-hidden="true" />新建多维表格
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => queueCreateAction(() => void createNativeMindMap())}>
                    <GitBranchIcon aria-hidden="true" />新建思维导图
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => queueCreateAction(() => void createNativeFlowchart())}>
                    <GitBranchIcon aria-hidden="true" />新建流程图
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => queueCreateAction(startCreateDirectory)}>
                    <FolderPlusIcon aria-hidden="true" />新建目录
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => queueCreateAction(() => void (async () => {
                    if (await saveCurrentNote()) { setImportTableSource(undefined); setImportTableParent(selectedDirectory) }
                  })())}>从 CSV / Excel 导入…</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>

          {isLoading || !libraryTree ? (
            <LibraryEmptyState message="正在读取资料库…" />
          ) : (
            <>
              <nav aria-label="资料库浏览" className={styles.browseNavigation}>
                <button
                  aria-current={selection?.kind === "assets" ? "page" : undefined}
                  aria-label={`图片（${libraryTree.assets.length}）`}
                  className={styles.navigationButton}
                  disabled={busyAction !== null}
                  onClick={() => void selectAssetsView()}
                  type="button"
                >
                  <ImageIcon aria-hidden="true" />
                  <span className={styles.treeLabel}>图片</span>
                  <span className={styles.treeCount}>{libraryTree.assets.length}</span>
                </button>
              </nav>

              <div className={styles.filesSection}>
                <div className={styles.filesRoot}>
                  <button
                    aria-current={activeFileDirectory === "notes" ? "page" : undefined}
                    aria-label={`文件（${fileCount}）`}
                    className={styles.navigationButton}
                    disabled={busyAction !== null}
                    onClick={() => void selectDirectoryView("notes")}
                    type="button"
                  >
                    <FolderIcon aria-hidden="true" />
                    <span className={styles.treeLabel}>文件</span>
                    <span className={styles.treeCount}>{fileCount}</span>
                  </button>
                </div>
                <div className={styles.noteListViewport} data-library-tree-viewport="true">
                  {libraryTree.entries.length === 0 && !creatingDirectory ? (
                    <p className={styles.treeEmptyState}>暂无文件，可从「新建」开始</p>
                  ) : (
                    <ul aria-label="文件夹" className={styles.tree} role="tree">
                      {renderCreateDirectoryRow("notes")}
                      <TreeEntries
                        busy={busyAction !== null}
                        directories={directories}
                        entries={libraryTree.entries}
                        expandedPaths={expandedPaths}
                        onToggleExpand={(path) => toggleSetValue(setExpandedPaths, path)}
                        onDelete={requestDelete}
                        onConvertToFragment={convertEntryToFragment}
                        onEntryClick={handleTreeEntryClick}
                        onMove={moveEntry}
                        onMoveToLockbox={moveEntryToLockbox}
                        onRename={(entry) => startRename(entry.path, "tree")}
                        onRenameCancel={() => setRenaming(null)}
                        onRenameChange={(value) => setRenaming((current) => current ? { ...current, value } : null)}
                        onRenameSubmit={() => void submitRename()}
                        renaming={renaming?.source === "tree" ? renaming : null}
                        renderCreateRow={renderCreateDirectoryRow}
                        selectedPath={activeFileDirectory ?? ""}
                      />
                    </ul>
                  )}
                </div>
              </div>
            </>
          )}

          {/*
           * 回收站与密匣不是内容目录，是这一列的两个常驻出口：钉在底部不随
           * 文档树滚动，否则树一长就被推出视野。密匣刻意不显示条目数——上锁
           * 时连数量都不该泄露。
           */}
          {libraryTree ? (
            <div className={styles.paneFooter} data-library-footer="true">
              <button
                aria-label={`回收站（${countTreeEntries(libraryTree.trashEntries)}）`}
                className={styles.navigationButton}
                aria-current={selection?.kind === "trash" ? "page" : undefined}
                disabled={busyAction !== null}
                onClick={() => void selectTrashView()}
                type="button"
              >
                <Trash2Icon aria-hidden="true" />
                <span>回收站</span>
                <span className={styles.treeCount}>
                  {countTreeEntries(libraryTree.trashEntries)}
                </span>
              </button>
              <button
                aria-label="密匣（上锁空间）"
                className={styles.navigationButton}
                disabled={busyAction !== null}
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
          ) : null}
        </aside>

        <article
          aria-label="资料库查看器"
          aria-busy={saveState === "saving" || busyAction !== null ? true : undefined}
          className={styles.editorPane}
          data-focus-region="library-viewer"
          data-mobile-hidden={mobilePane === "list" ? "true" : undefined}
          onKeyDown={directoryScope ? fileSelection.onKeyDown : undefined}
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
                action={
                  <Button
                    aria-label="多选文件"
                    aria-pressed={fileSelection.active}
                    disabled={busyAction !== null || renaming !== null || selectedDirectoryEntries.length === 0}
                    onClick={() => {
                      setBatchError(null)
                      if (fileSelection.active) fileSelection.onClear()
                      else fileSelection.enter()
                    }}
                    size="sm"
                    variant="outline"
                  >多选</Button>
                }
                onSelectDirectory={(path) => void selectDirectoryView(path)}
                sort={directorySort}
                onSortChange={changeDirectorySort}
                rootLabel="文件"
                onViewModeChange={(mode) => {
                  setDirectoryViewMode(mode)
                  writeDirectoryViewPreference(mode)
                }}
                path={selection.path}
                viewMode={directoryViewMode}
              />
            ) : selection?.kind === "trash" ? (
              <DirectoryViewToolbar
                action={
                  <Button
                    disabled={
                      busyAction !== null ||
                      countTreeEntries(libraryTree?.trashEntries ?? []) === 0
                    }
                    onClick={() => setTreeDialog({ kind: "emptyTrash" })}
                    size="sm"
                    type="button"
                    variant="destructive"
                  >
                    <Trash2Icon aria-hidden="true" />
                    清空回收站
                  </Button>
                }
                onSelectDirectory={(path) => void selectTrashView(path)}
                sort={directorySort}
                onSortChange={changeDirectorySort}
                onViewModeChange={(mode) => {
                  setDirectoryViewMode(mode)
                  writeDirectoryViewPreference(mode)
                }}
                path={trashDirectoryPath}
                rootLabel="回收站"
                viewMode={directoryViewMode}
              />
            ) : (
              <>
                {openedFileParentPath ? (
                  <Button
                    aria-label="返回所在目录"
                    className={styles.backToDirectory}
                    disabled={busyAction !== null && busyAction !== "重命名"}
                    onClick={async () => {
                      // A fast blur failure may finish before click; keep its editable draft visible.
                      if (renaming?.source === "editor" && !renamePromiseRef.current) return
                      if (renamePromiseRef.current && !(await renamePromiseRef.current)) return
                      await selectDirectoryView(openedFileParentPath)
                    }}
                    size="icon-sm"
                    title="返回所在目录"
                    variant="ghost"
                  >
                    <ChevronLeftIcon aria-hidden="true" />
                  </Button>
                ) : null}
                <div className={styles.editorHeading} data-tauri-drag-region>
                  {selectedFilePath && renaming?.source === "editor" && renaming.path === selectedFilePath ? (
                    <div className={styles.renameWrap} aria-busy={busyAction !== null || tableStructureBusy}>
                      <Input
                        aria-label="重命名名称"
                        autoFocus
                        ref={titleRenameInput}
                        disabled={busyAction !== null || tableStructureBusy}
                        onBlur={() => void submitRename()}
                        onChange={(event) =>
                          setRenaming((current) =>
                            current ? { ...current, value: event.target.value } : null
                          )
                        }
                        onFocus={(event) => event.target.select()}
                        onKeyDown={(event) => {
                          if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
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
                      {selectedFilePath ? (
                        <button
                          aria-label="重命名文件"
                          className={styles.editorTitleButton}
                          disabled={selectedTargetReadOnly || busyAction !== null || tableStructureBusy}
                          onClick={() => startRename(selectedFilePath, "editor")}
                          title="重命名文件"
                          type="button"
                        >
                          {selectedTitle}
                        </button>
                      ) : selectedTitle}
                    </h2>
                  )}
                </div>
              </>
            )}
            {selectedNote || canEnterZen ? (
              <div className={styles.editorActions}>
                {selectedNote ? (
                  <span
                    className={styles.saveState}
                    data-state={saveState}
                    data-tauri-drag-region
                  >
                    {selectedNoteReadOnly ? "只读" : formatSaveState(saveState)}
                  </span>
                ) : null}
                {canEnterZen ? (
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
            ) : null}
          </div>

          {selectedMindMap || activeSearchNavigation?.kind === "mindmap"
            ? renderSelectedViewer(isZen)
            : !isZen
              ? renderSelectedViewer(false)
              : null}
        </article>

        <aside
          aria-label="文档检查器"
          className={styles.inspectorSlot}
          data-focus-region="library-inspector"
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
          ariaLabel="资料库文档禅模式"
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

      {importTableParent !== null ? <TableImportDialog parentPath={importTableParent} initialPath={importTableSource} onCreated={tableCreated} onClose={() => { setImportTableParent(null); setImportTableSource(undefined) }} /> : null}

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
            <DialogTitle>{dialogTitle}</DialogTitle>
            <DialogDescription>{dialogDescription}</DialogDescription>
          </DialogHeader>

          {treeDialog?.kind === "batchDelete" ? (
            <ul aria-label="待删除文件" className={styles.batchFileList}>
              {treeDialog.entries.map(entry => <li key={entry.path}>{entry.name}</li>)}
            </ul>
          ) : null}

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
              {busyAction ?? dialogConfirmLabel}
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
  onToggleExpand: (path: string) => void
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
  onToggleExpand,
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
            {canExpand ? (
              <button
                aria-label={`${expanded ? "折叠" : "展开"} ${entry.name}`}
                aria-expanded={expanded}
                className={styles.treeDisclosure}
                disabled={busy}
                onClick={() => onToggleExpand(entry.path)}
                type="button"
              >
                {expanded ? <ChevronDownIcon aria-hidden="true" /> : <ChevronRightIcon aria-hidden="true" />}
              </button>
            ) : <span className={styles.treeDisclosureSpacer} />}
            <button
              aria-current={selectedPath === entry.path ? "page" : undefined}
              className={styles.treeButton}
              disabled={busy}
              onClick={() => onEntryClick(entry)}
              title={entry.name}
              type="button"
            >
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
              onToggleExpand={onToggleExpand}
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

export function formatSaveState(state: SaveState) {
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
