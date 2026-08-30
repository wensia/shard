import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { ChevronLeftIcon } from "lucide-react"
import { toast } from "sonner"

import { TagBadge } from "@/components/shard/tag-badge"
import { FragmentBacklinksPanel } from "@/components/shard/fragment-related"
import { Button } from "@/components/ui/button"
import { ShardEditor } from "@/editor/shard-editor"
import { createShardTagAutocomplete } from "@/editor/extensions/tag-autocomplete"
import {
  createShardWikilinkCompletionSource,
  createShardWikilinkExtension,
} from "@/editor/extensions/wikilink"
import { getApiErrorMessage } from "@/lib/api"
import { deriveKind, deriveNoteTitle, isTypeTag } from "@/lib/content-kind"
import { extractTags, normalizeTagList } from "@/lib/editor-format"
import { useFragmentRelations } from "@/lib/use-fragment-relations"
import { buildCsvWikilinkCandidates, buildWikilinkCandidates } from "@/lib/wikilink"
import type { CsvFileSummary, Fragment } from "@/types"

import styles from "./library-shell.module.css"

export type LibrarySaveHandler = () => Promise<boolean>

interface LibraryShellProps {
  csvFiles?: CsvFileSummary[]
  fragments: Fragment[]
  isLoading: boolean
  knownTags: string[]
  navigateToNote?: { id: string; requestId: number } | null
  onNavigateToFragment?: (fragmentId: string) => void
  onRegisterSaveHandler: (handler: LibrarySaveHandler | null) => void
  onSave: (id: string, content: string, tags: string[]) => Promise<Fragment>
  relationFragments?: Fragment[]
}

type SaveState = "dirty" | "error" | "saved" | "saving"

export function LibraryShell({
  csvFiles = [],
  fragments,
  isLoading,
  knownTags,
  navigateToNote = null,
  onNavigateToFragment,
  onRegisterSaveHandler,
  onSave,
  relationFragments = fragments,
}: LibraryShellProps) {
  const notes = useMemo(
    () =>
      fragments
        .filter((fragment) => deriveKind(fragment.tags) === "note")
        .sort(
          (left, right) =>
            Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
        ),
    [fragments]
  )
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null)
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

    if (!selectedNoteId || !notes.some((note) => note.id === selectedNoteId)) {
      setSelectedNoteId(notes[0].id)
    }
  }, [notes, selectedNoteId])

  useEffect(() => {
    if (!selectedNote) return

    setDraft(selectedNote.content)
    draftRef.current = selectedNote.content
    lastSavedContentRef.current = selectedNote.content
    setSaveState("saved")
  }, [selectedNote?.id])

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

  return (
    <section aria-label="资料库" className={styles.shell}>
      <header className={styles.topbar} data-tauri-drag-region>
        <h1 className={styles.pageTitle}>资料库</h1>
      </header>

      <div className={styles.workspace}>
        <aside
          aria-label="笔记列表"
          className={styles.noteListPane}
          data-mobile-hidden={mobilePane === "editor" ? "true" : undefined}
        >
          <div className={styles.paneHeader}>
            <h2 className={styles.paneTitle}>笔记</h2>
            <span className={styles.noteCount}>{notes.length}</span>
          </div>

          <div className={styles.noteListViewport}>
            {isLoading ? (
              <LibraryEmptyState message="正在读取资料库…" />
            ) : notes.length === 0 ? (
              <LibraryEmptyState message="到碎片流把一条内容转为笔记" />
            ) : (
              <ul className={styles.noteList}>
                {notes.map((note) => {
                  const displayTags = note.tags.filter(
                    (tag) => tag !== "inbox" && !isTypeTag(tag)
                  )
                  const selected = note.id === selectedNoteId

                  return (
                    <li key={note.id}>
                      <button
                        aria-current={selected ? "page" : undefined}
                        className={styles.noteButton}
                        data-selected={selected ? "true" : undefined}
                        onClick={() => void selectNote(note.id)}
                        type="button"
                      >
                        <span className={styles.noteTitle}>
                          {deriveNoteTitle(note.content) || "无标题笔记"}
                        </span>
                        <time
                          className={styles.updatedAt}
                          dateTime={note.updatedAt}
                        >
                          {formatUpdatedAt(note.updatedAt)}
                        </time>
                        {displayTags.length > 0 ? (
                          <span className={styles.tagRow}>
                            {displayTags.slice(0, 3).map((tag) => (
                              <TagBadge key={tag} tag={tag} />
                            ))}
                          </span>
                        ) : null}
                      </button>
                    </li>
                  )
                })}
              </ul>
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
              aria-label="返回笔记列表"
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
            <LibraryEmptyState message="选择一篇笔记开始编辑" />
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
    </section>
  )
}

function LibraryEmptyState({ message }: { message: string }) {
  return (
    <div className={styles.emptyState}>
      <p>{message}</p>
    </div>
  )
}

function formatUpdatedAt(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "更新时间未知"

  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
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
