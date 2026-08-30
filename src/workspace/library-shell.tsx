import {
  type Dispatch,
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
  MoreHorizontalIcon,
} from "lucide-react"
import { toast } from "sonner"

import { FragmentBacklinksPanel } from "@/components/shard/fragment-related"
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
import { deriveKind, deriveNoteTitle } from "@/lib/content-kind"
import { extractTags, normalizeTagList } from "@/lib/editor-format"
import { useFragmentRelations } from "@/lib/use-fragment-relations"
import { buildCsvWikilinkCandidates, buildWikilinkCandidates } from "@/lib/wikilink"
import type {
  CsvFileSummary,
  Fragment,
  LibraryMutationResult,
  LibraryTreeEntry,
  LibraryTreeSnapshot,
} from "@/types"

import styles from "./library-shell.module.css"

export type LibrarySaveHandler = () => Promise<boolean>

interface LibraryShellProps {
  csvFiles?: CsvFileSummary[]
  fragments: Fragment[]
  isLoading: boolean
  libraryTree: LibraryTreeSnapshot | null
  knownTags: string[]
  navigateToNote?: { id: string; requestId: number } | null
  onNavigateToFragment?: (fragmentId: string) => void
  onLibraryMutation: (result: LibraryMutationResult) => void
  onSelectFragmentMonth: (month: string) => void
  onRegisterSaveHandler: (handler: LibrarySaveHandler | null) => void
  onSave: (id: string, content: string, tags: string[]) => Promise<Fragment>
  relationFragments?: Fragment[]
}

type SaveState = "dirty" | "error" | "saved" | "saving"
type TreeDialogState =
  | { kind: "create-note" | "create-directory"; value: string }
  | { kind: "rename" | "delete"; entry: LibraryTreeEntry; value: string }

export function LibraryShell({
  csvFiles = [],
  fragments,
  isLoading,
  libraryTree,
  knownTags,
  navigateToNote = null,
  onNavigateToFragment,
  onLibraryMutation,
  onSelectFragmentMonth,
  onRegisterSaveHandler,
  onSave,
  relationFragments = fragments,
}: LibraryShellProps) {
  const notes = useMemo(
    () => fragments.filter((fragment) => deriveKind(fragment.tags) === "note"),
    [fragments]
  )
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null)
  const [selectedTreePath, setSelectedTreePath] = useState("notes")
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(
    () => new Set(["notes"])
  )
  const [isFragmentStreamExpanded, setIsFragmentStreamExpanded] =
    useState(false)
  const [expandedYears, setExpandedYears] = useState<Set<string>>(new Set())
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [treeDialog, setTreeDialog] = useState<TreeDialogState | null>(null)
  const [draft, setDraft] = useState("")
  const [mobilePane, setMobilePane] = useState<"editor" | "list">("list")
  const [saveState, setSaveState] = useState<SaveState>("saved")
  const selectedNote = useMemo(
    () => notes.find((note) => note.id === selectedNoteId) ?? null,
    [notes, selectedNoteId]
  )
  const draftRef = useRef(draft)
  const lastSavedContentRef = useRef("")
  const selectedNoteRef = useRef<Fragment | null>(selectedNote)
  const savePromiseRef = useRef<Promise<boolean> | null>(null)
  const knownTagsRef = useRef<string[]>([])
  const wikilinkCandidates = useMemo(
    () => [
      ...buildWikilinkCandidates(relationFragments),
      ...buildCsvWikilinkCandidates(csvFiles),
    ],
    [csvFiles, relationFragments]
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
      }),
    [wikilinkCandidates]
  )
  const editorExtensions = useMemo(
    () => [tagAutocompleteExtension, wikilinkExtension],
    [tagAutocompleteExtension, wikilinkExtension]
  )

  draftRef.current = draft
  selectedNoteRef.current = selectedNote

  useEffect(() => {
    if (notes.length === 0) {
      setSelectedNoteId(null)
      setDraft("")
      draftRef.current = ""
      lastSavedContentRef.current = ""
      setSaveState("saved")
      setMobilePane("list")
      return
    }

    if (selectedNoteId && !notes.some((note) => note.id === selectedNoteId)) {
      setSelectedNoteId(null)
      setSelectedTreePath("notes")
    }
  }, [notes, selectedNoteId])

  useEffect(() => {
    if (!selectedNote) return

    setDraft(selectedNote.content)
    draftRef.current = selectedNote.content
    lastSavedContentRef.current = selectedNote.content
    setSaveState("saved")
  }, [selectedNote?.id])

  useEffect(() => {
    if (selectedNote) setSelectedTreePath(selectedNote.path)
  }, [selectedNote?.path])

  const saveCurrentNote = useCallback<LibrarySaveHandler>(async () => {
    if (savePromiseRef.current) return savePromiseRef.current

    const note = selectedNoteRef.current
    const content = draftRef.current
    if (!note || content === lastSavedContentRef.current) {
      setSaveState("saved")
      return true
    }

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
        const updated = await onSave(note.id, content, tags)
        lastSavedContentRef.current = updated.content
        if (selectedNoteRef.current?.id === updated.id) {
          setDraft(updated.content)
          draftRef.current = updated.content
        }
        setSaveState("saved")
        return true
      } catch (error) {
        setSaveState("error")
        toast.error(`自动保存失败：${getApiErrorMessage(error)}`, {
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
  }, [onSave])

  useEffect(() => {
    onRegisterSaveHandler(saveCurrentNote)
    return () => onRegisterSaveHandler(null)
  }, [onRegisterSaveHandler, saveCurrentNote])

  async function selectNote(noteId: string) {
    if (noteId !== selectedNoteRef.current?.id) {
      const saved = await saveCurrentNote()
      if (!saved) return
      setSelectedNoteId(noteId)
      const note = notes.find((candidate) => candidate.id === noteId)
      if (note) setSelectedTreePath(note.path)
    }
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
    ? deriveNoteTitle(selectedNote.content) || "无标题笔记"
    : "选择笔记"

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
    mutation: () => Promise<LibraryMutationResult>
  ) {
    if (busyAction) return null
    setBusyAction(label)
    try {
      const result = await mutation()
      onLibraryMutation(result)
      if (result.fragment) {
        setSelectedNoteId(result.fragment.id)
        setSelectedTreePath(result.fragment.path)
        setMobilePane("editor")
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
    mutation: () => Promise<LibraryMutationResult>
  ) {
    if (!(await saveCurrentNote())) return null
    return runMutation(label, mutation)
  }

  function requestDelete(entry: LibraryTreeEntry) {
    if (entry.kind === "directory" && (entry.children?.length ?? 0) > 0) {
      toast.error("目录非空，不能删除", { duration: Infinity })
      return
    }
    setTreeDialog({ kind: "delete", entry, value: entry.name })
  }

  async function submitTreeDialog() {
    if (!treeDialog || busyAction) return
    const value = treeDialog.value.trim()
    if (treeDialog.kind !== "delete" && !value) return

    if (treeDialog.kind === "create-note") {
      const result = await runMutation("新建笔记", () =>
        createLibraryNote(selectedDirectory, value)
      )
      if (result) setTreeDialog(null)
      return
    }
    if (treeDialog.kind === "create-directory") {
      const result = await runMutation("新建目录", () =>
        createLibraryDirectory(selectedDirectory, value)
      )
      if (result) {
        setExpandedPaths((current) => new Set(current).add(selectedDirectory))
        setTreeDialog(null)
      }
      return
    }
    if (treeDialog.kind === "rename") {
      const currentName = treeDialog.entry.name.replace(/\.(md|csv)$/iu, "")
      if (value === currentName) {
        setTreeDialog(null)
        return
      }
      const result = await runSavedMutation("重命名", () =>
        renameLibraryEntry(treeDialog.entry.path, value)
      )
      if (result) setTreeDialog(null)
      return
    }

    if (treeDialog.kind !== "delete") return
    const deletedPath = treeDialog.entry.path
    const result = await runSavedMutation("删除", () =>
      deleteLibraryEntry(deletedPath)
    )
    if (!result) return
    if (selectedTreePath === deletedPath) {
      setSelectedNoteId(null)
      setSelectedTreePath("notes")
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

  return (
    <section aria-label="资料库" className={styles.shell}>
      <header className={styles.topbar} data-tauri-drag-region>
        <h1 className={styles.pageTitle}>资料库</h1>
      </header>

      <div className={styles.workspace}>
        <aside
          aria-busy={busyAction !== null || isLoading ? true : undefined}
          aria-label="资料库目录"
          className={styles.noteListPane}
          data-mobile-hidden={mobilePane === "editor" ? "true" : undefined}
        >
          <div className={styles.paneHeader}>
            <button
              aria-current={selectedTreePath === "notes" ? "page" : undefined}
              className={styles.rootButton}
              onClick={() => {
                setSelectedNoteId(null)
                setSelectedTreePath("notes")
                setMobilePane("list")
              }}
              type="button"
            >
              <FolderIcon aria-hidden="true" />
              <span>资料库</span>
            </button>
            <span className={styles.noteCount}>{notes.length}</span>
          </div>

          <div className={styles.treeToolbar}>
            <Button
              disabled={busyAction !== null}
              onClick={() => setTreeDialog({ kind: "create-note", value: "" })}
              size="sm"
              type="button"
              variant="primary"
            >
              <FilePlus2Icon aria-hidden="true" />
              新建笔记
            </Button>
            <Button
              disabled={busyAction !== null}
              onClick={() =>
                setTreeDialog({ kind: "create-directory", value: "" })
              }
              size="sm"
              type="button"
              variant="outline"
            >
              <FolderPlusIcon aria-hidden="true" />
              新建目录
            </Button>
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

                {libraryTree.entries.length === 0 ? (
                  <LibraryEmptyState message="到碎片流把一条内容转为笔记" />
                ) : (
                  <ul aria-label="笔记和数据文件" className={styles.tree} role="tree">
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
                          setSelectedNoteId(null)
                          setSelectedTreePath("notes")
                          setMobilePane("list")
                        })
                      }}
                      onEntryClick={handleTreeEntryClick}
                      onMove={(entry, destinationDirectory) => {
                        void runSavedMutation("移动", () =>
                          moveLibraryEntry(entry.path, destinationDirectory)
                        )
                      }}
                      onRename={(entry) =>
                        setTreeDialog({
                          entry,
                          kind: "rename",
                          value: entry.name.replace(/\.(md|csv)$/iu, ""),
                        })
                      }
                      selectedPath={selectedTreePath}
                    />
                  </ul>
                )}
              </div>
            )}
          </div>
        </aside>

        <article
          aria-label="笔记编辑器"
          aria-busy={saveState === "saving" ? true : undefined}
          className={styles.editorPane}
          data-mobile-hidden={mobilePane === "list" ? "true" : undefined}
        >
          <div className={styles.editorHeader}>
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
            <h2 className={styles.editorTitle}>{selectedTitle}</h2>
            {selectedNote ? (
              <span className={styles.saveState} data-state={saveState}>
                {formatSaveState(saveState)}
              </span>
            ) : null}
          </div>

          {selectedNote ? (
            <div className={styles.editorViewport}>
              <ShardEditor
                ariaLabel="资料库笔记编辑器"
                autoFocus={mobilePane === "editor"}
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
                onSubmit={() => void saveCurrentNote()}
                placeholder="开始写笔记…"
                value={draft}
                variant="inline"
              />
            </div>
          ) : (
            <LibraryEmptyState message="从资料库目录选择一篇笔记开始编辑" />
          )}
        </article>

        <aside
          aria-label="笔记检查器"
          className={styles.inspectorSlot}
          data-library-inspector-slot
        >
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
            <DialogTitle>{getTreeDialogTitle(treeDialog)}</DialogTitle>
            {treeDialog?.kind === "delete" ? (
              <DialogDescription>
                将永久删除「{treeDialog.entry.name}」，此操作不可撤销。
              </DialogDescription>
            ) : (
              <DialogDescription>
                {treeDialog?.kind === "rename"
                  ? "引用当前名称的 wikilink 会在保存后自动更新。"
                  : `将在「${formatDirectoryLabel(selectedDirectory)}」中创建。`}
              </DialogDescription>
            )}
          </DialogHeader>

          {treeDialog && treeDialog.kind !== "delete" ? (
            <Input
              aria-label={treeDialog.kind === "create-note" ? "笔记标题" : "名称"}
              autoFocus
              disabled={busyAction !== null}
              onChange={(event) =>
                setTreeDialog((current) =>
                  current ? { ...current, value: event.target.value } : null
                )
              }
              onKeyDown={(event) => {
                if (event.key === "Enter") void submitTreeDialog()
              }}
              placeholder={
                treeDialog.kind === "create-note" ? "输入笔记标题" : "输入名称"
              }
              value={treeDialog.value}
            />
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
              disabled={
                busyAction !== null ||
                (treeDialog?.kind !== "delete" && !treeDialog?.value.trim())
              }
              onClick={() => void submitTreeDialog()}
              type="button"
              variant={treeDialog?.kind === "delete" ? "destructive" : "default"}
            >
              {busyAction ?? (treeDialog?.kind === "delete" ? "删除" : "确认")}
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
  onRename: (entry: LibraryTreeEntry) => void
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
  onRename,
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
                <DropdownMenuItem onClick={() => onConvertToFragment(entry)}>
                  转为碎片
                </DropdownMenuItem>
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
        {expanded && entry.children?.length ? (
          <ul role="group">
            <TreeEntries
              busy={busy}
              directories={directories}
              entries={entry.children}
              expandedPaths={expandedPaths}
              onConvertToFragment={onConvertToFragment}
              onDelete={onDelete}
              onEntryClick={onEntryClick}
              onMove={onMove}
              onRename={onRename}
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

function getTreeDialogTitle(dialog: TreeDialogState | null) {
  switch (dialog?.kind) {
    case "create-note":
      return "新建笔记"
    case "create-directory":
      return "新建目录"
    case "rename":
      return "重命名"
    case "delete":
      return "确认删除"
    default:
      return "资料库操作"
  }
}

function formatDirectoryLabel(path: string) {
  return path === "notes" ? "资料库根目录" : path.replace(/^notes\//u, "")
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
