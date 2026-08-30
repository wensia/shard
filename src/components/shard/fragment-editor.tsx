import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type CSSProperties,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
} from "react"
import { isTauri } from "@tauri-apps/api/core"
import { open } from "@tauri-apps/plugin-dialog"
import { startCompletion } from "@codemirror/autocomplete"
import { keymap } from "@codemirror/view"
import { Loader2Icon, SendHorizontalIcon, XIcon } from "lucide-react"
import { toast } from "sonner"

import { EditorToolbar } from "@/components/shard/editor-toolbar"
import {
  FragmentContent,
  FragmentImageAttachment,
} from "@/components/shard/fragment-content"
import {
  getBoundedTagSuggestionIndex,
  getNextTagSuggestionIndex,
  getTagCompletionPopoverPosition,
  getTagSuggestionOptionId,
  TagCompletionPopover,
  type TagSuggestion,
} from "@/components/shard/tag-completion-popover"
import { Button } from "@/components/ui/button"
import { ToolbarIconButton } from "@/components/ui/toolbar-icon-button"
import {
  ShardEditor,
  type ShardEditorHandle,
} from "@/editor/shard-editor"
import { createShardTagAutocomplete } from "@/editor/extensions/tag-autocomplete"
import { isLegacyEditorEnabled } from "@/editor/kill-switch"
import {
  applyActiveTagCompletion,
  applyInlineFormat,
  applyLineFormat,
  applyTaskLineBreak,
  applyTagCompletion,
  applyTaskMarkerDeletion,
  extractTags,
  getActiveTag,
  getTagRanges,
  getMarkdownImageAlt,
  insertHorizontalRule,
  insertMarkdownBlock,
  insertMarkdownTable,
  insertTagMarker,
  normalizeTag,
  normalizeTagList,
  parseMarkdownImageLine,
  toggleTaskLine,
  type InlineFormat,
  type LineFormat,
  type TextEdit,
} from "@/lib/editor-format"
import {
  convertTableDocumentToMarkdown,
  getApiErrorMessage,
  saveFragmentImage,
  setWindowControlsHidden,
} from "@/lib/api"
import { getClipboardImageFiles } from "@/lib/clipboard-images"
import {
  getEditorCaretBox,
  startEditorPointerSelection,
  type EditorCaretBox,
} from "@/lib/editor-caret"
import { hasMarkdownImage, wantsLockbox } from "@/lib/lockbox"
import {
  getFirstEditableTableOffset,
  hasOversizedTable,
  MAX_EDITABLE_TABLE_CELLS,
  replaceTableLines,
  type MarkdownTable,
} from "@/lib/markdown-table"
import {
  buildTagSearchIndex,
  getMatchingTagsBySearchQuery,
} from "@/lib/tag-index"
import {
  TABLE_DOCUMENT_FILTER,
  useTableDocumentDrop,
} from "@/lib/use-table-document-drop"
import type { Fragment } from "@/types"
import styles from "./fragment-editor.module.css"

export interface FragmentEditorDraft {
  content: string
  id: number
}

interface FragmentEditorProps {
  commitOnBlur?: boolean
  draft?: FragmentEditorDraft | null
  fragment: Fragment | null
  knownTags: string[]
  onClose: () => void
  onCreate?: (content: string, tags: string[]) => Promise<void>
  onSave: (id: string, content: string, tags: string[]) => Promise<Fragment>
  variant?: "inline" | "zen"
  vaultPath?: string
}

type SaveState = "dirty" | "error" | "saved" | "saving"

interface EditorImageAttachment {
  alt: string
  id: string
  path: string
  previewUrl?: string
}

export function FragmentEditor({
  commitOnBlur = false,
  draft = null,
  fragment,
  knownTags,
  onClose,
  onCreate,
  onSave,
  variant = "zen",
  vaultPath,
}: FragmentEditorProps) {
  const [content, setContent] = useState("")
  const [caretEpoch, setCaretEpoch] = useState(0)
  const [customCaret, setCustomCaret] = useState<EditorCaretBox | null>(null)
  const [editorScrollTop, setEditorScrollTop] = useState(0)
  const [imageAttachments, setImageAttachments] = useState<
    EditorImageAttachment[]
  >([])
  const [isEditorFocused, setIsEditorFocused] = useState(false)
  const [saveState, setSaveState] = useState<SaveState>("saved")
  const [selectionEnd, setSelectionEnd] = useState(0)
  const [selectionStart, setSelectionStart] = useState(0)
  const [tagPopoverPosition, setTagPopoverPosition] = useState({
    left: 12,
    top: 44,
  })
  const [suppressedActiveTag, setSuppressedActiveTag] = useState<{
    content: string
    cursor: number
  } | null>(null)
  const isComposingRef = useRef(false)
  const imageAttachmentsRef = useRef<EditorImageAttachment[]>([])
  const lastSavedContentRef = useRef("")
  const onCreateRef = useRef(onCreate)
  const onSaveRef = useRef(onSave)
  const blurCommitTimerRef = useRef<number | null>(null)
  const saveTimerRef = useRef<number | null>(null)
  const editorFrameRef = useRef<HTMLDivElement>(null)
  const shardEditorRef = useRef<ShardEditorHandle>(null)
  const closeEditorRef = useRef<() => void>(() => undefined)
  const lastPointerRef = useRef<PointerPoint | null>(null)
  const stopPointerSelectionRef = useRef<(() => void) | null>(null)
  const [isImportingTable, setIsImportingTable] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const tagPopoverId = useId()
  const isZen = variant === "zen"
  const isDraft = fragment === null && draft !== null
  const isOpen = fragment !== null || draft !== null
  const useLegacyEditor = isLegacyEditorEnabled()
  const editorDocumentKey = fragment?.id ?? `draft:${draft?.id ?? "closed"}`
  const editorId = isZen
    ? `zen:${fragment?.id ?? `draft:${draft?.id ?? "closed"}`}`
    : `fragment:${fragment?.id ?? "closed"}`
  const normalizedKnownTags = useMemo(
    () => normalizeTagList(knownTags.filter((tag) => tag !== "inbox")),
    [knownTags]
  )
  const knownTagsRef = useRef(normalizedKnownTags)
  knownTagsRef.current = normalizedKnownTags
  const tagAutocompleteExtension = useMemo(
    () =>
      createShardTagAutocomplete({
        getKnownTags: () => knownTagsRef.current,
        maxSuggestions: MAX_TAG_SUGGESTIONS,
      }),
    []
  )
  const fragmentEditorExtensions = useMemo(
    () =>
      keymap.of([
        {
          key: "Escape",
          run: (view) => {
            if (view.composing) return false
            closeEditorRef.current()
            return true
          },
        },
      ]),
    []
  )
  const fragmentEditorExtensionSet = useMemo(
    () => [fragmentEditorExtensions, tagAutocompleteExtension],
    [fragmentEditorExtensions, tagAutocompleteExtension]
  )

  const syncInlineEditorHeight = useCallback(() => {
    if (isZen) return

    const textarea = textareaRef.current
    resizeInlineEditorTextarea(textarea)
    if (textarea) {
      setEditorScrollTop(textarea.scrollTop)
    }
  }, [isZen])

  const rawActiveTag = useMemo(
    () =>
      useLegacyEditor ? getActiveTag(content, selectionStart) : null,
    [content, selectionStart, useLegacyEditor]
  )
  const activeTag =
    rawActiveTag &&
    !isSuppressedActiveTag(suppressedActiveTag, content, selectionStart)
      ? rawActiveTag
      : null
  const tagSearchIndex = useMemo(
    () =>
      useLegacyEditor ? buildTagSearchIndex(normalizedKnownTags) : [],
    [normalizedKnownTags, useLegacyEditor]
  )
  const activeNewTag = activeTag ? normalizeTag(activeTag.query) : ""
  const draftContent = useMemo(
    () => buildContentWithImageAttachments(content, imageAttachments),
    [content, imageAttachments]
  )
  const tagSuggestions = useMemo<TagSuggestion[]>(() => {
    if (!useLegacyEditor || !activeTag) return []

    const query = activeNewTag
    const matches = getMatchingTagsBySearchQuery(
      tagSearchIndex,
      query,
      MAX_TAG_SUGGESTIONS
    )

    const items: TagSuggestion[] = matches.map((tag) => ({
      kind: "existing",
      tag,
    }))

    if (query.length > 0 && !normalizedKnownTags.includes(query)) {
      items.push({ kind: "create", tag: query })
    }

    return items
  }, [
    activeTag,
    activeNewTag,
    normalizedKnownTags,
    tagSearchIndex,
    useLegacyEditor,
  ])
  const [activeSuggestionIndex, setActiveSuggestionIndex] = useState(0)
  const boundedActiveSuggestionIndex = getBoundedTagSuggestionIndex(
    activeSuggestionIndex,
    tagSuggestions.length
  )
  const activeSuggestionOptionId =
    activeTag && tagSuggestions.length > 0
      ? getTagSuggestionOptionId(tagPopoverId, boundedActiveSuggestionIndex)
      : undefined

  useEffect(() => {
    setActiveSuggestionIndex(0)
  }, [activeNewTag])

  useEffect(() => {
    onSaveRef.current = onSave
  }, [onSave])

  useEffect(() => {
    onCreateRef.current = onCreate
  }, [onCreate])

  useEffect(() => {
    imageAttachmentsRef.current = imageAttachments
  }, [imageAttachments])

  useEffect(() => {
    return () => {
      clearBlurCommitTimer()
      stopPointerSelectionRef.current?.()
      revokeEditorImagePreviewUrls(imageAttachmentsRef.current)
    }
  }, [])

  useEffect(() => {
    if (!useLegacyEditor) return

    // React's onSelect stays silent while the mouse is still down, so drag
    // selection needs the document-level selectionchange stream to paint the
    // highlight live instead of only after mouseup
    function handleSelectionChange() {
      const textarea = textareaRef.current
      if (!textarea || document.activeElement !== textarea) return

      setSelectionStart(textarea.selectionStart)
      setSelectionEnd(textarea.selectionEnd)
    }

    document.addEventListener("selectionchange", handleSelectionChange)
    return () => {
      document.removeEventListener("selectionchange", handleSelectionChange)
    }
  }, [useLegacyEditor])

  useEffect(() => {
    if (!fragment && !draft) {
      revokeEditorImagePreviewUrls(imageAttachmentsRef.current)
      imageAttachmentsRef.current = []
      setContent("")
      setImageAttachments([])
      setSelectionEnd(0)
      setSelectionStart(0)
      setSaveState("saved")
      lastSavedContentRef.current = ""
      return
    }

    const sourceContent = fragment?.content ?? draft?.content ?? ""
    const nextDraft = splitContentImageAttachments(sourceContent)
    const cursor = nextDraft.content.length
    revokeEditorImagePreviewUrls(imageAttachmentsRef.current)
    imageAttachmentsRef.current = nextDraft.images
    setContent(nextDraft.content)
    setImageAttachments(nextDraft.images)
    setSelectionEnd(cursor)
    setSelectionStart(cursor)
    setSuppressedActiveTag(
      useLegacyEditor ? { content: nextDraft.content, cursor } : null
    )
    const initialContent = buildContentWithImageAttachments(
      nextDraft.content,
      nextDraft.images
    )
    lastSavedContentRef.current = fragment ? initialContent : ""
    setSaveState(fragment || !initialContent ? "saved" : "dirty")

    requestAnimationFrame(() => {
      if (!useLegacyEditor) {
        const view = shardEditorRef.current?.view
        if (!view) return

        view.focus()
        view.dispatch({
          selection: { anchor: cursor },
          scrollIntoView: true,
        })
        return
      }

      const textarea = textareaRef.current
      if (!textarea) return

      textarea.focus()
      textarea.setSelectionRange(cursor, cursor)
      textarea.scrollTop = textarea.scrollHeight
      setEditorScrollTop(textarea.scrollTop)
      // focus() 会同步触发 onFocus→syncSelection，在 setSelectionRange 之前
      // 读到浏览器默认选区(0)并写回 state；这里再同步一次，确保自绘光标与
      // 原生选区都停在末尾，而不是被覆盖到起始位置
      setSelectionStart(cursor)
      setSelectionEnd(cursor)
      setIsEditorFocused(true)
    })
  }, [draft?.id, fragment?.id, useLegacyEditor])

  useLayoutEffect(() => {
    if (!useLegacyEditor) return
    syncInlineEditorHeight()
  }, [content, syncInlineEditorHeight, useLegacyEditor])

  useEffect(() => {
    if (isZen || !useLegacyEditor) return

    function handleViewportResize() {
      syncInlineEditorHeight()
    }

    window.addEventListener("resize", handleViewportResize)
    window.visualViewport?.addEventListener("resize", handleViewportResize)

    return () => {
      window.removeEventListener("resize", handleViewportResize)
      window.visualViewport?.removeEventListener(
        "resize",
        handleViewportResize
      )
    }
  }, [isZen, syncInlineEditorHeight, useLegacyEditor])

  useLayoutEffect(() => {
    if (!useLegacyEditor) return
    const textarea = textareaRef.current
    const frame = editorFrameRef.current

    if (
      !textarea ||
      !frame ||
      !isEditorFocused ||
      selectionStart !== selectionEnd
    ) {
      setCustomCaret(null)
      return
    }

    setCustomCaret(getEditorCaretBox(textarea, frame, selectionStart))
  }, [
    content,
    editorScrollTop,
    isEditorFocused,
    selectionEnd,
    selectionStart,
    useLegacyEditor,
  ])

  useLayoutEffect(() => {
    if (!useLegacyEditor) return
    if (!activeTag || !textareaRef.current || !editorFrameRef.current) return

    const nextPosition = getTagCompletionPopoverPosition(
      textareaRef.current,
      editorFrameRef.current,
      selectionStart
    )

    setTagPopoverPosition((currentPosition) => {
      const isSamePosition =
        Math.abs(currentPosition.left - nextPosition.left) < 0.5 &&
        Math.abs(currentPosition.top - nextPosition.top) < 0.5

      return isSamePosition ? currentPosition : nextPosition
    })
  }, [activeTag, content, editorScrollTop, selectionStart, useLegacyEditor])

  useEffect(() => {
    if (!isOpen) return

    clearSaveTimer()

    if (draftContent === lastSavedContentRef.current) {
      setSaveState("saved")
      return
    }

    setSaveState("dirty")

    if (!isZen || isDraft) return

    saveTimerRef.current = window.setTimeout(() => {
      void saveDraft(draftContent)
    }, 800)

    return clearSaveTimer
  }, [draft?.id, draftContent, fragment?.id, isDraft, isOpen, isZen])

  useEffect(() => {
    if (!isOpen || !isZen || !isTauri()) return

    void setWindowControlsHidden(true).catch((error) => {
      console.warn("Unable to hide window controls for zen editor", error)
    })

    return () => {
      void setWindowControlsHidden(false).catch((error) => {
        console.warn("Unable to restore window controls", error)
      })
    }
  }, [draft?.id, fragment?.id, isOpen, isZen])

  /**
   * 表格文档导入：转成 Markdown 表格插进正文，原文件不进 vault。
   * 数据留在正文里，搜索、标签、git diff 才都还能用上。
   *
   * 必须放在下面的 `if (!isOpen) return null` 之前：hook 一旦排在提前
   * return 之后，编辑器从关闭到打开时 hooks 数量就会变化，React 会报
   * "Rendered more hooks than during the previous render" 并卸载整棵树
   * （禅模式白屏就是这么来的）。`insertTableDocuments` 是函数声明，提升后可用。
   */
  const { isDropTarget: isTableDropTarget } = useTableDocumentDrop({
    frameRef: editorFrameRef,
    onDrop: (paths) => insertTableDocuments(paths),
  })

  if (!isOpen) return null

  async function handleClose() {
    clearBlurCommitTimer()
    clearSaveTimer()

    if (!isZen) {
      onClose()
      return
    }

    const currentDraftContent = getCurrentDraftContent()
    if (currentDraftContent !== lastSavedContentRef.current) {
      const saved = await saveDraft(currentDraftContent)
      if (!saved) return
    }

    onClose()
  }

  closeEditorRef.current = () => {
    void handleClose()
  }

  async function handleSubmit() {
    clearBlurCommitTimer()
    clearSaveTimer()

    const currentDraftContent = getCurrentDraftContent()
    if (currentDraftContent === lastSavedContentRef.current) {
      onClose()
      return
    }

    const saved = await saveDraft(currentDraftContent)
    if (saved) {
      onClose()
    }
  }

  function handleEditorBlur(event: FocusEvent<HTMLElement>) {
    if (!commitOnBlur || isZen) return

    const editorElement = event.currentTarget
    const nextFocused = event.relatedTarget
    if (nextFocused instanceof Node && editorElement.contains(nextFocused)) return

    clearBlurCommitTimer()
    blurCommitTimerRef.current = window.setTimeout(() => {
      blurCommitTimerRef.current = null
      const activeElement = document.activeElement
      if (activeElement instanceof Node && editorElement.contains(activeElement)) {
        return
      }

      void handleSubmit()
    }, 0)
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    const nativeEvent = event.nativeEvent
    const isCloseShortcut = event.key === "Escape"
    const isSaveShortcut =
      event.key === "Enter" &&
      (event.metaKey || event.ctrlKey)
    const isComposing =
      isComposingRef.current ||
      nativeEvent.isComposing ||
      event.key === "Process" ||
      nativeEvent.keyCode === 229

    if (isComposing) return

    if (
      (event.key === "Backspace" || event.key === "Delete") &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey
    ) {
      const nextEdit = applyTaskMarkerDeletion(
        content,
        event.currentTarget.selectionStart,
        event.currentTarget.selectionEnd,
        event.key
      )

      if (nextEdit) {
        event.preventDefault()
        applyTextEdit(nextEdit)
        return
      }
    }

    const isCollapsedCaret =
      event.currentTarget.selectionStart === event.currentTarget.selectionEnd

    // 标签建议列表可见时，方向键在列表内移动，回车选中高亮项
    if (activeTag && tagSuggestions.length > 0 && isCollapsedCaret) {
      if (event.key === "ArrowDown") {
        event.preventDefault()
        setActiveSuggestionIndex(
          (current) =>
            getNextTagSuggestionIndex(current, "next", tagSuggestions.length)
        )
        return
      }

      if (event.key === "ArrowUp") {
        event.preventDefault()
        setActiveSuggestionIndex(
          (current) =>
            getNextTagSuggestionIndex(
              current,
              "previous",
              tagSuggestions.length
            )
        )
        return
      }

      if (
        event.key === "Enter" &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.shiftKey
      ) {
        const item = tagSuggestions[boundedActiveSuggestionIndex]
        if (item) {
          event.preventDefault()
          applyTag(item.tag)
          return
        }
      }
    }

    if (
      event.key === "Enter" &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.shiftKey &&
      isCollapsedCaret
    ) {
      const nextEdit = applyActiveTagCompletion(
        event.currentTarget.value,
        event.currentTarget.selectionStart
      )

      if (nextEdit) {
        event.preventDefault()
        applyTextEdit(nextEdit)
        return
      }
    }

    if (
      event.key === "Enter" &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      isCollapsedCaret
    ) {
      const nextEdit = applyTaskLineBreak(
        event.currentTarget.value,
        event.currentTarget.selectionStart,
        event.currentTarget.selectionEnd
      )

      if (nextEdit) {
        event.preventDefault()
        applyTextEdit(nextEdit)
        return
      }
    }

    // 复用主编辑框（capture-box）的保存快捷键：cmd/ctrl + Enter 提交
    if (isSaveShortcut) {
      event.preventDefault()
      void handleSubmit()
      return
    }

    if (!isCloseShortcut) return

    event.preventDefault()
    void handleClose()
  }

  function rememberPointer(event: MouseEvent<HTMLTextAreaElement>) {
    lastPointerRef.current = {
      time: window.performance.now(),
      x: event.clientX,
      y: event.clientY,
    }
    showCaretImmediately()

    const frame = editorFrameRef.current
    if (!frame) return
    const textarea = event.currentTarget

    stopPointerSelectionRef.current?.()
    stopPointerSelectionRef.current = startEditorPointerSelection(
      textarea,
      frame,
      event.nativeEvent,
      (start, end) => {
        setSelectionStart(start)
        setSelectionEnd(end)
      },
      () => syncSelection(textarea)
    )
  }

  function showCaretImmediately() {
    setCaretEpoch((current) => current + 1)
  }

  async function saveDraft(nextContent: string) {
    if (nextContent.trim().length === 0) {
      setSaveState("error")
      toast.error("片段内容不能为空", { duration: Infinity })
      return false
    }

    setSaveState("saving")

    try {
      const tags = normalizeTagList(["inbox", ...extractTags(nextContent)])
      const editsLockbox = Boolean(fragment?.lockbox)
      if ((editsLockbox || wantsLockbox(nextContent, tags)) && hasMarkdownImage(nextContent)) {
        throw new Error("密匣暂不支持图片附件。请先移除图片，再保存到密匣。")
      }
      if (isDraft) {
        if (!onCreateRef.current) {
          throw new Error("当前编辑器缺少创建入口。")
        }
        await onCreateRef.current(nextContent, tags)
      } else if (fragment) {
        await onSaveRef.current(fragment.id, nextContent, tags)
      } else {
        return false
      }
      lastSavedContentRef.current = nextContent
      setSaveState("saved")
      return true
    } catch (error) {
      setSaveState("error")
      toast.error(`${isDraft ? "保存失败" : "自动保存失败"}：${getApiErrorMessage(error)}`, { duration: Infinity })
      return false
    }
  }

  function insertTag() {
    const { start: cursor } = getEditorSelection()
    if (useLegacyEditor) setSuppressedActiveTag(null)
    applyTextEdit(insertTagMarker(getEditorValue(), cursor))
    if (!useLegacyEditor) {
      const view = shardEditorRef.current?.view
      if (view) startCompletion(view)
    }
  }

  function applyTag(tag: string) {
    const textarea = textareaRef.current
    const currentContent = textarea?.value ?? content
    const cursor = textarea?.selectionStart ?? selectionStart
    const tagAtCursor = getActiveTag(currentContent, cursor)
    const targetTag = tagAtCursor ?? activeTag
    if (!targetTag) return

    const nextEdit = applyTagCompletion(currentContent, targetTag, tag)
    if (!nextEdit) return

    applyTextEdit(nextEdit)
  }

  function formatLines(format: LineFormat) {
    const selection = getEditorSelection()
    const currentContent = getEditorValue()

    applyTextEdit(
      applyLineFormat(
        currentContent,
        selection.start,
        selection.end,
        format
      )
    )
  }

  function formatInline(format: InlineFormat) {
    const selection = getEditorSelection()
    const currentContent = getEditorValue()

    applyTextEdit(
      applyInlineFormat(
        currentContent,
        selection.start,
        selection.end,
        format
      )
    )
  }

  function insertDivider() {
    const selection = getEditorSelection()
    const currentContent = getEditorValue()

    setSuppressedActiveTag(null)
    applyTextEdit(
      insertHorizontalRule(
        currentContent,
        selection.start,
        selection.end
      )
    )
  }

  function insertTable(columns: number, rows: number) {
    const selection = getEditorSelection()
    const currentContent = getEditorValue()

    setSuppressedActiveTag(null)
    const nextEdit = insertMarkdownTable(
      currentContent,
      selection.start,
      selection.end,
      columns,
      rows
    )
    applyTextEdit(nextEdit)
    focusInsertedTable(nextEdit.content, nextEdit.selectionStart)
  }

  /** 插完表格直接进第一个表头格，省得用户再点一下。 */
  function focusInsertedTable(nextContent: string, cursor: number) {
    const tableStart = nextContent.lastIndexOf("\n", cursor - 1) + 1

    requestAnimationFrame(() => {
      if (!useLegacyEditor) {
        shardEditorRef.current?.focusTableCell(tableStart, "-1:0")
        return
      }

      editorFrameRef.current
        ?.querySelector<HTMLInputElement>(
          `[data-table-start="${tableStart}"] [data-cell="-1:0"]`
        )
        ?.focus()
    })
  }

  /**
   * 表格里改一个格子只重写它占的那几行。这里不碰焦点也不动选区——焦点正在
   * 单元格里，抢回 textarea 会把用户正在打的字打断。
   */
  function updateTable(
    startLine: number,
    lineCount: number,
    table: MarkdownTable
  ) {
    if (!useLegacyEditor) return
    const nextContent = replaceTableLines(content, startLine, lineCount, table)
    if (nextContent === content) return

    setContent(nextContent)
  }

  async function insertTableDocuments(paths: string[]) {
    if (paths.length === 0 || isImportingTable) return

    setIsImportingTable(true)
    try {
      const blocks: string[] = []
      for (const path of paths) {
        blocks.push(await convertTableDocumentToMarkdown(path))
      }

      const markdown = blocks.join("\n\n")
      if (hasOversizedTable(markdown)) {
        toast.info(
          `表格较大，已作为纯文本插入：超过 ${MAX_EDITABLE_TABLE_CELLS} 个单元格不提供可视化编辑，源码照常可改。`
        )
      }

      const body = markdown.trim()
      const currentContent = getEditorValue()
      const selection = getEditorSelection()
      const nextEdit = insertMarkdownBlock(
        currentContent,
        selection.start,
        selection.end,
        markdown
      )
      applyTextEdit(nextEdit)

      if (!useLegacyEditor) {
        const relativeTableStart = getFirstEditableTableOffset(body)
        if (relativeTableStart !== null) {
          const bodyStart = nextEdit.selectionStart - body.length
          shardEditorRef.current?.focusTableCell(
            bodyStart + relativeTableStart,
            "-1:0",
          )
        }
      }
    } catch (error) {
      toast.error(`导入表格失败：${getApiErrorMessage(error)}`, {
        duration: Infinity,
      })
    } finally {
      setIsImportingTable(false)
    }
  }

  async function pickTableDocument() {
    try {
      const selected = await open({
        filters: [TABLE_DOCUMENT_FILTER],
        multiple: false,
        title: "选择表格文件",
      })
      const path = Array.isArray(selected) ? selected[0] : selected
      if (!path) return

      await insertTableDocuments([path])
    } catch (error) {
      toast.error(`选择文件失败：${getApiErrorMessage(error)}`, {
        duration: Infinity,
      })
    }
  }

  async function uploadImage(file: File) {
    if (!useLegacyEditor && !shardEditorRef.current?.view) return
    if (useLegacyEditor && !textareaRef.current) return
    const currentDraftContent = getCurrentDraftContent()
    const tags = normalizeTagList([
      "inbox",
      ...extractTags(currentDraftContent),
    ])
    if (fragment?.lockbox || wantsLockbox(currentDraftContent, tags)) {
      toast.error("密匣暂不支持图片附件：请先移除 #密匣，或在公开笔记中上传图片。", { duration: Infinity })
      return
    }

    const previewUrl = URL.createObjectURL(file)
    try {
      const bytes = Array.from(new Uint8Array(await file.arrayBuffer()))
      const path = await saveFragmentImage(file.name, bytes)
      setImageAttachments((current) => [
        ...current,
        {
          alt: getMarkdownImageAlt(file.name),
          id: `${Date.now()}-${file.name}`,
          path,
          previewUrl,
        },
      ])
      requestAnimationFrame(() => {
        focusEditor()
      })
    } catch (error) {
      URL.revokeObjectURL(previewUrl)
      toast.error(`图片上传失败：${getApiErrorMessage(error)}`, { duration: Infinity })
    }
  }

  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const imageFiles = getClipboardImageFiles(event)
    if (imageFiles.length === 0) return

    event.preventDefault()
    void uploadPastedImages(imageFiles)
  }

  async function uploadPastedImages(files: File[]) {
    for (const file of files) {
      await uploadImage(file)
    }
  }

  function removeImageAttachment(id: string) {
    setImageAttachments((current) => {
      const removedImage = current.find((image) => image.id === id)
      if (removedImage?.previewUrl) {
        URL.revokeObjectURL(removedImage.previewUrl)
      }

      return current.filter((image) => image.id !== id)
    })
    requestAnimationFrame(() => {
      focusEditor()
    })
  }

  function applyTextEdit(nextEdit: TextEdit) {
    if (!useLegacyEditor) {
      setSuppressedActiveTag(null)
      shardEditorRef.current?.applyTextEdit(nextEdit)
      return
    }

    showCaretImmediately()
    setContent(nextEdit.content)
    setSelectionEnd(nextEdit.selectionEnd)
    setSelectionStart(nextEdit.selectionStart)
    setSuppressedActiveTag(null)
    if (textareaRef.current) {
      textareaRef.current.value = nextEdit.content
      textareaRef.current.focus()
      textareaRef.current.setSelectionRange(
        nextEdit.selectionStart,
        nextEdit.selectionEnd
      )
    }
    requestAnimationFrame(() => {
      const textarea = textareaRef.current
      if (!textarea || textarea.value !== nextEdit.content) return

      textarea.focus()
      textarea.setSelectionRange(
        nextEdit.selectionStart,
        nextEdit.selectionEnd
      )
    })
  }

  function clearSaveTimer() {
    if (saveTimerRef.current === null) return
    window.clearTimeout(saveTimerRef.current)
    saveTimerRef.current = null
  }

  function clearBlurCommitTimer() {
    if (blurCommitTimerRef.current === null) return
    window.clearTimeout(blurCommitTimerRef.current)
    blurCommitTimerRef.current = null
  }

  function syncSelection(textarea: HTMLTextAreaElement) {
    setSelectionStart(textarea.selectionStart)
    setSelectionEnd(textarea.selectionEnd)
    if (
      shouldSuppressActiveTagAfterPointer(
        textarea,
        textarea.value,
        lastPointerRef.current
      )
    ) {
      const boundaryEdit = getTagClickBoundaryEdit(
        textarea.value,
        textarea.selectionStart
      )

      if (boundaryEdit) {
        applyTextEdit(boundaryEdit)
        return
      }

      setSuppressedActiveTag(null)
      return
    }

    setSuppressedActiveTag((current) => {
      if (isRecentPointer(lastPointerRef.current)) return null
      return isSuppressedActiveTag(
        current,
        textarea.value,
        textarea.selectionStart
      )
        ? current
        : null
    })
  }

  function toggleTask(lineIndex: number) {
    const nextContent = toggleTaskLine(content, lineIndex)
    if (nextContent === content) return

    const nextSelectionStart =
      textareaRef.current?.selectionStart ?? selectionStart
    const nextSelectionEnd = textareaRef.current?.selectionEnd ?? selectionEnd

    setContent(nextContent)
    setSelectionStart(nextSelectionStart)
    setSelectionEnd(nextSelectionEnd)
    requestAnimationFrame(() => {
      textareaRef.current?.focus()
      textareaRef.current?.setSelectionRange(
        nextSelectionStart,
        nextSelectionEnd
      )
    })
  }

  function getEditorSelection() {
    if (!useLegacyEditor) {
      return shardEditorRef.current?.getSelection() ?? {
        start: selectionStart,
        end: selectionEnd,
      }
    }

    return {
      start: textareaRef.current?.selectionStart ?? selectionStart,
      end: textareaRef.current?.selectionEnd ?? selectionEnd,
    }
  }

  function getEditorValue() {
    if (!useLegacyEditor) {
      return shardEditorRef.current?.view?.state.doc.toString() ?? content
    }

    return textareaRef.current?.value ?? content
  }

  function getCurrentDraftContent() {
    return buildContentWithImageAttachments(
      getEditorValue(),
      imageAttachmentsRef.current
    )
  }

  function focusEditor() {
    if (useLegacyEditor) {
      textareaRef.current?.focus()
      return
    }

    shardEditorRef.current?.focus()
  }

  // 高亮层要和 textarea 用完全相同的内边距才能像素级对齐，两者都从这份
  // editorPadding 派生，避免各写一份 padding 字符串导致后续改一处漏一处。
  const editorPadding: CSSProperties = isZen
    ? {
        paddingInline: "var(--zen-editor-inline-padding)",
        paddingBlock: "var(--shard-space-4)",
      }
    : {
        paddingInline: "var(--shard-composer-padding)",
        paddingBlock: "var(--shard-composer-padding)",
      }
  const fieldStyle: CSSProperties = isZen
    ? {
        height: "100%",
        minHeight: 0,
        overflowY: "auto",
        ...editorPadding,
      }
    : {
        minHeight: 144,
        maxHeight: "min(52dvh, 520px)",
        overflowY: "hidden",
        borderTopLeftRadius: "var(--shard-surface-radius)",
        borderTopRightRadius: "var(--shard-surface-radius)",
        borderBottomLeftRadius: 0,
        borderBottomRightRadius: 0,
        ...editorPadding,
      }
  const codeMirrorFieldStyle: CSSProperties = {
    ...fieldStyle,
    overflowY: "auto",
  }
  const imageRowStyle: CSSProperties = isZen
    ? {
        paddingInline: "var(--zen-editor-inline-padding)",
        paddingBottom: "var(--shard-space-4)",
      }
    : {
        paddingInline: "var(--shard-composer-padding)",
        paddingBottom: "var(--shard-space-3)",
      }
  const imageAttachmentRow =
    imageAttachments.length > 0 ? (
      <div className="shard-image-attachment-row" style={imageRowStyle}>
        {imageAttachments.map((image) => (
          <FragmentImageAttachment
            alt={image.alt}
            key={image.id}
            onRemove={() => removeImageAttachment(image.id)}
            path={image.path}
            src={image.previewUrl}
            vaultPath={vaultPath}
            wrapped={false}
          />
        ))}
      </div>
    ) : null
  const canSubmit = saveState !== "saving" && draftContent.trim().length > 0
  const characterCount = Array.from(content.replace(/\s/g, "")).length
  const lineCount = content.length > 0 ? content.split(/\r\n?|\n/).length : 0
  const legacyEditor = (
    <>
      {content ? (
        <div
          aria-hidden="true"
          className="shard-editor-highlight-layer shard-memo-tags"
        >
          <div
            style={{
              ...editorPadding,
              transform:
                editorScrollTop > 0
                  ? `translateY(-${editorScrollTop}px)`
                  : undefined,
            }}
          >
            <FragmentContent
              caretAligned
              content={content}
              highlightTags
              onTaskToggle={toggleTask}
              selectionEnd={isEditorFocused ? selectionEnd : undefined}
              selectionStart={isEditorFocused ? selectionStart : undefined}
              tableEditing={{
                onChange: updateTable,
                onExit: () => textareaRef.current?.focus(),
              }}
              vaultPath={vaultPath}
            />
          </div>
        </div>
      ) : null}
      <textarea
        aria-activedescendant={activeSuggestionOptionId}
        aria-autocomplete={activeTag ? "list" : undefined}
        aria-controls={activeTag ? tagPopoverId : undefined}
        aria-expanded={activeTag ? true : undefined}
        className="shard-editor-field shard-editor-overlay-field"
        style={{
          position: "relative",
          zIndex: 10,
          display: "block",
          width: "100%",
          resize: "none",
          border: "none",
          background: "transparent",
          boxShadow: "none",
          outline: "none",
          ...fieldStyle,
        }}
        onChange={(event) => {
          const outsideTagEdit = getOutsideTagInputEdit(
            content,
            event.currentTarget.value,
            event.currentTarget.selectionStart,
            suppressedActiveTag
          )

          if (outsideTagEdit) {
            applyTextEdit(outsideTagEdit)
            return
          }

          setSuppressedActiveTag(null)
          setContent(event.currentTarget.value)
          syncSelection(event.currentTarget)
        }}
        onCompositionEnd={() => {
          isComposingRef.current = false
        }}
        onCompositionStart={() => {
          isComposingRef.current = true
        }}
        onKeyDown={handleKeyDown}
        onMouseDown={rememberPointer}
        onPaste={handlePaste}
        onKeyUp={(event) => {
          syncSelection(event.currentTarget)
        }}
        onSelect={(event) => {
          syncSelection(event.currentTarget)
        }}
        onBlur={() => {
          setIsEditorFocused(false)
        }}
        onFocus={(event) => {
          setIsEditorFocused(true)
          syncSelection(event.currentTarget)
        }}
        onScroll={(event) => {
          setEditorScrollTop(event.currentTarget.scrollTop)
        }}
        ref={textareaRef}
        value={content}
      />
      {customCaret ? (
        <span
          aria-hidden="true"
          className="shard-custom-caret"
          key={`${caretEpoch}-${selectionStart}-${selectionEnd}`}
          style={{
            height: customCaret.height,
            left: customCaret.left,
            top: customCaret.top,
          }}
        />
      ) : null}
      {activeTag ? (
        <TagCompletionPopover
          activeIndex={boundedActiveSuggestionIndex}
          id={tagPopoverId}
          left={tagPopoverPosition.left}
          onHover={setActiveSuggestionIndex}
          onSelect={applyTag}
          suggestions={tagSuggestions}
          top={tagPopoverPosition.top}
        />
      ) : null}
    </>
  )
  const editorFrame = (
    <div
      ref={editorFrameRef}
      style={{
        position: "relative",
        ...(isZen ? { minHeight: 0, flex: "1 1 auto" } : {}),
      }}
    >
      {useLegacyEditor ? (
        legacyEditor
      ) : (
        <div style={codeMirrorFieldStyle}>
          <ShardEditor
            ariaLabel={isZen ? "禅模式片段编辑器" : "片段编辑器"}
            autoFocus
            documentKey={editorDocumentKey}
            editorId={editorId}
            extensions={fragmentEditorExtensionSet}
            onChange={(nextContent) => {
              setContent(nextContent)
            }}
            onDropFiles={(files) => {
              void uploadPastedImages(files)
            }}
            onFocus={() => {
              setIsEditorFocused(true)
            }}
            onPasteFiles={(files) => {
              void uploadPastedImages(files)
            }}
            onSelectionChange={(start, end) => {
              setSelectionStart(start)
              setSelectionEnd(end)
            }}
            onSubmit={() => {
              void handleSubmit()
            }}
            ref={shardEditorRef}
            value={content}
            variant={isZen ? "zen" : "inline"}
          />
        </div>
      )}
      {isTableDropTarget || isImportingTable ? (
        <div className="shard-editor-drop-hint">
          {isImportingTable ? "正在导入表格…" : "松手导入为表格"}
        </div>
      ) : null}
    </div>
  )

  if (!isZen) {
    return (
      <article
        className={styles.composerFrame}
        onBlurCapture={handleEditorBlur}
      >
        {editorFrame}
        {imageAttachmentRow}
        <div
          className="shard-edge-action-row"
          style={{
            borderBottomLeftRadius: "var(--shard-surface-radius)",
            borderBottomRightRadius: "var(--shard-surface-radius)",
            background: "var(--card)",
          }}
        >
          <EditorToolbar
            disabled={saveState === "saving"}
            onImageUpload={uploadImage}
            onImportTable={isTauri() ? pickTableDocument : undefined}
            onInlineFormat={formatInline}
            onInsertHorizontalRule={insertDivider}
            onInsertTable={insertTable}
            onInsertTag={insertTag}
            onLineFormat={formatLines}
            trailing={
              <>
                <span
                  aria-hidden="true"
                  style={{
                    marginInline: "var(--shard-space-1)",
                    height: 20,
                    width: 1,
                    background: "var(--border)",
                    opacity: "var(--shard-alpha-55)",
                  }}
                />
                <span
                  style={{
                    paddingInline: "var(--shard-space-1)",
                    fontSize: 14,
                    fontWeight: 500,
                    color: "var(--muted-foreground)",
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {content.trim().length}
                </span>
                <Button
                  disabled={saveState === "saving"}
                  style={{
                    height: 32,
                    borderRadius: "var(--shard-radius-control)",
                    paddingInline: "var(--shard-space-2)",
                    color: "var(--muted-foreground)",
                  }}
                  onMouseDown={(event) => {
                    event.preventDefault()
                    void handleClose()
                  }}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  取消
                </Button>
                <ToolbarIconButton
                  className="shard-edge-action"
                  disabled={!canSubmit}
                  label={saveState === "saving" ? "保存中" : "保存修改"}
                  onMouseDown={(event) => {
                    event.preventDefault()
                    void handleSubmit()
                  }}
                  type="button"
                  variant="default"
                >
                  {saveState === "saving" ? (
                    <Loader2Icon className={styles.spin} />
                  ) : (
                    <SendHorizontalIcon />
                  )}
                </ToolbarIconButton>
              </>
            }
          />
        </div>
      </article>
    )
  }

  return (
    <div
      className={styles.zenEditorShell}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 50,
        display: "grid",
        gridTemplateRows: "minmax(0, 1fr) auto",
        background: "var(--background)",
        color: "var(--foreground)",
      }}
    >
      <div
        data-tauri-drag-region
        style={{ minHeight: 0, paddingTop: "var(--shard-top-inset)" }}
      >
        <div
          style={{
            display: "flex",
            height: "100%",
            minHeight: 0,
            flexDirection: "column",
          }}
        >
          {editorFrame}
          {imageAttachmentRow}
        </div>
      </div>

      <footer
        className={`shard-content-inset ${styles.zenFooter}`}
      >
        <div
          className={styles.zenToolbar}
          style={{
            width: "fit-content",
            maxWidth: "100%",
            borderRadius: "var(--shard-surface-radius)",
            background: "var(--card)",
            padding: "var(--shard-space-3)",
            boxShadow: "var(--shard-composer-shadow)",
          }}
        >
          <EditorToolbar
            disabled={saveState === "saving"}
            onImageUpload={uploadImage}
            onImportTable={isTauri() ? pickTableDocument : undefined}
            onInlineFormat={formatInline}
            onInsertHorizontalRule={insertDivider}
            onInsertTable={insertTable}
            onInsertTag={insertTag}
            onLineFormat={formatLines}
            trailing={
              <>
                <span
                  aria-hidden="true"
                  style={{
                    marginInline: "var(--shard-space-1)",
                    height: 20,
                    width: 1,
                    background: "var(--border)",
                    opacity: "var(--shard-alpha-55)",
                  }}
                />
                <ToolbarIconButton
                  className="shard-edge-action"
                  label="退出编辑"
                  onMouseDown={(event) => {
                    event.preventDefault()
                    void handleClose()
                  }}
                  style={{
                    borderRadius: "var(--shard-radius-control)",
                    color: "var(--muted-foreground)",
                  }}
                  type="button"
                  variant="ghost"
                >
                  <XIcon />
                </ToolbarIconButton>
              </>
            }
          />
        </div>
        <span
          aria-label={`${characterCount} 字，${lineCount} 行`}
          className={styles.zenStats}
          title="字数不计空格与换行"
        >
          {characterCount.toLocaleString("zh-CN")} 字 ·{" "}
          {lineCount.toLocaleString("zh-CN")} 行
        </span>
      </footer>
    </div>
  )
}

interface PointerPoint {
  time: number
  x: number
  y: number
}

const MAX_TAG_SUGGESTIONS = 8

function resizeInlineEditorTextarea(textarea: HTMLTextAreaElement | null) {
  if (!textarea) return

  textarea.style.height = "auto"

  const styles = window.getComputedStyle(textarea)
  const minimumHeight = toPixelValue(styles.minHeight, 144)
  const maximumHeight = toPixelValue(styles.maxHeight, 520)
  const contentHeight = Math.ceil(textarea.scrollHeight)
  const nextHeight = Math.min(
    Math.max(contentHeight, minimumHeight),
    maximumHeight
  )
  const isScrollable = contentHeight > nextHeight + 1

  textarea.style.height = `${nextHeight}px`
  textarea.style.overflowY = isScrollable ? "auto" : "hidden"

  if (!isScrollable && textarea.scrollTop !== 0) {
    textarea.scrollTop = 0
  }
}

function splitContentImageAttachments(value: string) {
  const contentLines: string[] = []
  const images: EditorImageAttachment[] = []

  value.split("\n").forEach((line, index) => {
    const image = parseMarkdownImageLine(line)
    if (!image) {
      contentLines.push(line)
      return
    }

    images.push({
      alt: image.alt,
      id: `${index}-${image.path}`,
      path: image.path,
    })
  })

  return {
    content: contentLines.join("\n").trim(),
    images,
  }
}

function buildContentWithImageAttachments(
  value: string,
  images: EditorImageAttachment[]
) {
  const text = value.trim()
  const imageMarkdown = images
    .map((image) => `![${escapeMarkdownImageAlt(image.alt)}](${image.path})`)
    .join("\n")

  return [text, imageMarkdown].filter(Boolean).join("\n")
}

function escapeMarkdownImageAlt(alt: string) {
  return alt.replace(/\\/g, "\\\\").replace(/]/g, "\\]")
}

function toPixelValue(value: string, fallback: number) {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function revokeEditorImagePreviewUrls(images: EditorImageAttachment[]) {
  images.forEach((image) => {
    if (image.previewUrl) {
      URL.revokeObjectURL(image.previewUrl)
    }
  })
}

function shouldSuppressActiveTagAfterPointer(
  textarea: HTMLTextAreaElement,
  value: string,
  pointer: PointerPoint | null
) {
  if (!isRecentPointer(pointer)) return false
  if (textarea.selectionStart !== textarea.selectionEnd) return false

  const tagElement = getTagElementAtCursor(textarea, value, textarea.selectionStart)
  const rect = tagElement?.getBoundingClientRect()
  if (!rect) return false

  const isSameLine = pointer.y >= rect.top && pointer.y <= rect.bottom
  if (!isSameLine) return false

  const clickedInsideTag = pointer.x >= rect.left && pointer.x <= rect.right
  return !clickedInsideTag
}

function isRecentPointer(pointer: PointerPoint | null): pointer is PointerPoint {
  return Boolean(pointer && window.performance.now() - pointer.time <= 500)
}

function getOutsideTagInputEdit(
  previousContent: string,
  nextContent: string,
  nextSelectionStart: number,
  suppressedActiveTag: { content: string; cursor: number } | null
): TextEdit | null {
  if (
    !suppressedActiveTag ||
    suppressedActiveTag.content !== previousContent ||
    nextContent.length <= previousContent.length
  ) {
    return null
  }

  const cursor = suppressedActiveTag.cursor
  const activeTag = getActiveTag(previousContent, cursor)
  const tagRange = getTagRanges(previousContent).find(
    (range) => range.start === activeTag?.hashStart && range.end === cursor
  )
  if (!activeTag || !tagRange) return null

  const prefix = previousContent.slice(0, cursor)
  const suffix = previousContent.slice(cursor)
  if (!nextContent.startsWith(prefix) || !nextContent.endsWith(suffix)) {
    return null
  }

  const inserted = nextContent.slice(
    cursor,
    nextContent.length - suffix.length
  )
  if (!inserted || /^[\s#]/u.test(inserted)) return null

  return {
    content: `${prefix} ${inserted}${suffix}`,
    selectionEnd: nextSelectionStart + 1,
    selectionStart: nextSelectionStart + 1,
  }
}

function getTagClickBoundaryEdit(
  value: string,
  cursor: number
): TextEdit | null {
  const activeTag = getActiveTag(value, cursor)
  const tagRange = getTagRanges(value).find(
    (range) => range.start === activeTag?.hashStart && range.end === cursor
  )
  if (!activeTag || !tagRange) return null

  const nextChar = value[cursor] ?? ""
  if (/^[^\S\r\n]$/u.test(nextChar)) {
    return {
      content: value,
      selectionEnd: cursor + 1,
      selectionStart: cursor + 1,
    }
  }

  return {
    content: `${value.slice(0, cursor)} ${value.slice(cursor)}`,
    selectionEnd: cursor + 1,
    selectionStart: cursor + 1,
  }
}

function isSuppressedActiveTag(
  suppressedActiveTag: { content: string; cursor: number } | null,
  content: string,
  cursor: number
) {
  return (
    suppressedActiveTag?.content === content &&
    suppressedActiveTag.cursor === cursor
  )
}

function getTagElementAtCursor(
  textarea: HTMLTextAreaElement,
  value: string,
  cursor: number
) {
  const activeTag = getActiveTag(value, cursor)
  if (!activeTag) return null

  const tagRanges = getTagRanges(value)
  const tagIndex = tagRanges.findIndex(
    (range) => range.start === activeTag.hashStart && range.end === cursor
  )
  if (tagIndex < 0) return null

  return (
    textarea.parentElement?.querySelectorAll(".shard-editor-tag-highlight")[
      tagIndex
    ] ?? null
  )
}
