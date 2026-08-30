import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type MouseEvent,
  type RefObject,
} from "react"
import { Loader2Icon, SendHorizontalIcon } from "lucide-react"
import { startCompletion } from "@codemirror/autocomplete"
import { isTauri } from "@tauri-apps/api/core"
import { open } from "@tauri-apps/plugin-dialog"
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
import { ToolbarIconButton } from "@/components/ui/toolbar-icon-button"
import {
  ShardEditor,
  type ShardEditorHandle,
} from "@/editor/shard-editor"
import { createShardTagAutocomplete } from "@/editor/extensions/tag-autocomplete"
import { isLegacyEditorEnabled } from "@/editor/kill-switch"
import { getClipboardImageFiles } from "@/lib/clipboard-images"
import {
  applyActiveTagCompletion,
  applyInlineFormat,
  applyLineFormat,
  applyTaskLineBreak,
  applyTagCompletion,
  applyTaskMarkerDeletion,
  extractTags,
  getActiveTag,
  getMarkdownImageAlt,
  insertHorizontalRule,
  insertMarkdownBlock,
  insertMarkdownTable,
  insertTagMarker,
  normalizeTag,
  normalizeTagList,
  toggleTaskLine,
  type InlineFormat,
  type LineFormat,
  type TextEdit,
} from "@/lib/editor-format"
import {
  convertTableDocumentToMarkdown,
  getApiErrorMessage,
  saveFragmentImage,
} from "@/lib/api"
import {
  getEditorCaretBox,
  startEditorPointerSelection,
  type EditorCaretBox,
} from "@/lib/editor-caret"
import { wantsLockbox } from "@/lib/lockbox"
import {
  getFirstEditableTableOffset,
  hasOversizedTable,
  MAX_EDITABLE_TABLE_CELLS,
  replaceTableLines,
  type MarkdownTable,
} from "@/lib/markdown-table"
import {
  TABLE_DOCUMENT_FILTER,
  useTableDocumentDrop,
} from "@/lib/use-table-document-drop"
import {
  buildTagSearchIndex,
  getMatchingTagsBySearchQuery,
} from "@/lib/tag-index"

import styles from "./capture-box.module.css"

interface CaptureBoxProps {
  collapseSignal: number
  isCreating: boolean
  knownTags: string[]
  onCreate: (content: string, tags: string[]) => void | Promise<void>
  onOpenZen?: (content: string) => void
}

interface PendingImage {
  alt: string
  bytes: number[]
  fileName: string
  id: string
  previewUrl: string
}

export function CaptureBox({
  collapseSignal,
  isCreating,
  knownTags,
  onCreate,
  onOpenZen,
}: CaptureBoxProps) {
  const [content, setContent] = useState("")
  const [caretEpoch, setCaretEpoch] = useState(0)
  const [customCaret, setCustomCaret] = useState<EditorCaretBox | null>(null)
  const [editorScrollTop, setEditorScrollTop] = useState(0)
  const [isEditorExpanded, setIsEditorExpanded] = useState(false)
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([])
  const [selectionStart, setSelectionStart] = useState(0)
  const [tagPopoverPosition, setTagPopoverPosition] = useState({
    left: 12,
    top: 44,
  })
  const [isEditorFocused, setIsEditorFocused] = useState(false)
  const [selectionEnd, setSelectionEnd] = useState(0)
  const legacyEditorEnabled = isLegacyEditorEnabled()
  const containerRef = useRef<HTMLDivElement>(null)
  const editorFrameRef = useRef<HTMLDivElement>(null)
  const codeMirrorViewportRef = useRef<HTMLDivElement>(null)
  const codeMirrorContentHeightRef = useRef(0)
  const [isImportingTable, setIsImportingTable] = useState(false)
  const shardEditorRef = useRef<ShardEditorHandle>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const tagPopoverId = useId()
  const hasSkippedInitialFocusRef = useRef(false)
  const isComposingRef = useRef(false)
  const pendingImagesRef = useRef<PendingImage[]>([])
  const stopPointerSelectionRef = useRef<(() => void) | null>(null)

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
  const codeMirrorExtensionSet = useMemo(
    () => [tagAutocompleteExtension],
    [tagAutocompleteExtension]
  )
  const activeTag = useMemo(
    () =>
      legacyEditorEnabled ? getActiveTag(content, selectionStart) : null,
    [content, legacyEditorEnabled, selectionStart]
  )
  const tagSearchIndex = useMemo(
    () =>
      legacyEditorEnabled ? buildTagSearchIndex(normalizedKnownTags) : [],
    [legacyEditorEnabled, normalizedKnownTags]
  )
  const activeNewTag = activeTag ? normalizeTag(activeTag.query) : ""
  const tagSuggestions = useMemo<TagSuggestion[]>(() => {
    if (!legacyEditorEnabled || !activeTag) return []

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
    legacyEditorEnabled,
    normalizedKnownTags,
    tagSearchIndex,
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
  const canSubmit =
    (content.trim().length > 0 || pendingImages.length > 0) && !isCreating

  function getCurrentSelection() {
    if (legacyEditorEnabled) {
      const textarea = textareaRef.current
      return textarea
        ? { start: textarea.selectionStart, end: textarea.selectionEnd }
        : { start: selectionStart, end: selectionEnd }
    }

    return (
      shardEditorRef.current?.getSelection() ?? {
        start: selectionStart,
        end: selectionEnd,
      }
    )
  }

  function getCurrentEditorValue() {
    return legacyEditorEnabled
      ? (textareaRef.current?.value ?? content)
      : (shardEditorRef.current?.view?.state.doc.toString() ?? content)
  }

  function focusActiveEditor() {
    if (legacyEditorEnabled) textareaRef.current?.focus()
    else shardEditorRef.current?.focus()
  }

  const syncTextareaGeometry = useCallback(() => {
    if (!legacyEditorEnabled) return
    const textarea = textareaRef.current
    resizeTextarea(
      textarea,
      isEditorExpanded,
      containerRef.current,
      editorFrameRef.current
    )
    if (textarea) {
      setEditorScrollTop(textarea.scrollTop)
    }
  }, [isEditorExpanded, legacyEditorEnabled])

  const syncCodeMirrorGeometry = useCallback(() => {
    if (legacyEditorEnabled || codeMirrorContentHeightRef.current <= 0) return
    resizeCodeMirrorEditor(
      codeMirrorViewportRef.current,
      codeMirrorContentHeightRef.current,
      isEditorExpanded,
      containerRef.current,
      editorFrameRef.current
    )
  }, [isEditorExpanded, legacyEditorEnabled])

  function handleCodeMirrorHeightChange(height: number) {
    codeMirrorContentHeightRef.current = height
    resizeCodeMirrorEditor(
      codeMirrorViewportRef.current,
      height,
      isEditorExpanded,
      containerRef.current,
      editorFrameRef.current
    )
  }

  function handleEditorFocus() {
    if (!hasSkippedInitialFocusRef.current) {
      hasSkippedInitialFocusRef.current = true
      return
    }

    setIsEditorExpanded(true)
  }

  useEffect(() => {
    setActiveSuggestionIndex(0)
  }, [activeNewTag])

  useEffect(() => {
    pendingImagesRef.current = pendingImages
  }, [pendingImages])

  useEffect(() => {
    return () => {
      stopPointerSelectionRef.current?.()
      pendingImagesRef.current.forEach((image) => {
        URL.revokeObjectURL(image.previewUrl)
      })
    }
  }, [])

  useEffect(() => {
    if (collapseSignal === 0) return

    setIsEditorExpanded(false)
  }, [collapseSignal])

  useEffect(() => {
    if (!legacyEditorEnabled) return

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
  }, [legacyEditorEnabled])

  useLayoutEffect(() => {
    if (legacyEditorEnabled) syncTextareaGeometry()
    else syncCodeMirrorGeometry()
  }, [
    content,
    legacyEditorEnabled,
    pendingImages.length,
    syncCodeMirrorGeometry,
    syncTextareaGeometry,
  ])

  useEffect(() => {
    function handleViewportResize() {
      if (legacyEditorEnabled) syncTextareaGeometry()
      else syncCodeMirrorGeometry()
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
  }, [legacyEditorEnabled, syncCodeMirrorGeometry, syncTextareaGeometry])

  useLayoutEffect(() => {
    if (!legacyEditorEnabled) {
      setCustomCaret(null)
      return
    }

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
    isEditorExpanded,
    isEditorFocused,
    selectionEnd,
    selectionStart,
    legacyEditorEnabled,
  ])

  useLayoutEffect(() => {
    if (!legacyEditorEnabled) return
    if (!activeTag || !textareaRef.current || !containerRef.current) return

    const nextPosition = getTagCompletionPopoverPosition(
      textareaRef.current,
      containerRef.current,
      selectionStart
    )

    setTagPopoverPosition((currentPosition) => {
      const isSamePosition =
        Math.abs(currentPosition.left - nextPosition.left) < 0.5 &&
        Math.abs(currentPosition.top - nextPosition.top) < 0.5

      return isSamePosition ? currentPosition : nextPosition
    })
  }, [activeTag, content, editorScrollTop, legacyEditorEnabled, selectionStart])

  async function submit() {
    if (isCreating) return

    const draftTags = normalizeTagList(["inbox", ...extractTags(content)])
    if (wantsLockbox(content, draftTags) && pendingImages.length > 0) {
      toast.error("密匣暂不支持图片附件：请先移除图片，再保存到密匣，避免附件写入公开 assets 目录。", { duration: Infinity })
      setIsEditorExpanded(true)
      return
    }

    try {
      const savedImages = []
      for (const image of pendingImages) {
        const path = await saveFragmentImage(image.fileName, image.bytes).catch(
          (error) => {
            toast.error(`图片保存失败：${getApiErrorMessage(error)}`, { duration: Infinity })
            throw error
          }
        )
        savedImages.push({ alt: image.alt, path })
      }
      const next = buildContentWithPendingImages(content, savedImages)
      if (!next) return

      await onCreate(next, normalizeTagList(["inbox", ...extractTags(next)]))
      pendingImages.forEach((image) => {
        URL.revokeObjectURL(image.previewUrl)
      })
      setContent("")
      setPendingImages([])
      setIsEditorExpanded(false)
      setSelectionStart(0)
      setSelectionEnd(0)
      requestAnimationFrame(() => {
        if (legacyEditorEnabled) {
          const textarea = textareaRef.current
          if (!textarea) return
          textarea.value = ""
          textarea.setSelectionRange(0, 0)
        } else {
          shardEditorRef.current?.replaceDocument("")
        }
      })
    } catch {
      setIsEditorExpanded(true)
      requestAnimationFrame(() => {
        focusActiveEditor()
      })
    }
  }

  function insertTag() {
    const cursor = getCurrentSelection().start
    const nextEdit = insertTagMarker(getCurrentEditorValue(), cursor)
    setIsEditorExpanded(true)
    applyTextEdit(nextEdit)
    if (!legacyEditorEnabled) {
      const view = shardEditorRef.current?.view
      if (view) startCompletion(view)
    }
  }

  function formatLines(format: LineFormat) {
    const selection = getCurrentSelection()

    const nextEdit = applyLineFormat(
      content,
      selection.start,
      selection.end,
      format
    )

    setIsEditorExpanded(true)
    applyTextEdit(nextEdit)
  }

  function formatInline(format: InlineFormat) {
    const selection = getCurrentSelection()

    const nextEdit = applyInlineFormat(
      content,
      selection.start,
      selection.end,
      format
    )

    setIsEditorExpanded(true)
    applyTextEdit(nextEdit)
  }

  function insertDivider() {
    const selection = getCurrentSelection()

    setIsEditorExpanded(true)
    applyTextEdit(
      insertHorizontalRule(
        content,
        selection.start,
        selection.end
      )
    )
  }

  function insertTable(columns: number, rows: number) {
    const selection = getCurrentSelection()

    setIsEditorExpanded(true)
    const nextEdit = insertMarkdownTable(
      content,
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
      if (!legacyEditorEnabled) {
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
    if (!legacyEditorEnabled) return
    const nextContent = replaceTableLines(content, startLine, lineCount, table)
    if (nextContent === content) return

    setIsEditorExpanded(true)
    setContent(nextContent)
  }

  /**
   * 表格文档导入：转成 Markdown 表格插进正文，原文件不进 vault。
   * 数据留在正文里，搜索、标签、git diff 才都还能用上。
   */
  const { isDropTarget: isTableDropTarget } = useTableDocumentDrop({
    frameRef: editorFrameRef,
    onDrop: (paths) => insertTableDocuments(paths),
  })

  async function insertTableDocuments(paths: string[]) {
    if (paths.length === 0 || isImportingTable) return

    setIsEditorExpanded(true)
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
      const selection = getCurrentSelection()
      const nextEdit = insertMarkdownBlock(
        getCurrentEditorValue(),
        selection.start,
        selection.end,
        markdown
      )
      applyTextEdit(nextEdit)

      if (!legacyEditorEnabled) {
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

  function openZenEditor() {
    if (!onOpenZen) return

    if (pendingImages.length > 0) {
      toast.error("带图片的草稿暂不能切换到禅模式：请先保存当前片段，或移除图片后再进入禅模式。", { duration: Infinity })
      return
    }

    const draftContent = getCurrentEditorValue()
    onOpenZen(draftContent)
    setContent("")
    setIsEditorExpanded(false)
    setSelectionStart(0)
    setSelectionEnd(0)
    requestAnimationFrame(() => {
      if (legacyEditorEnabled) {
        const textarea = textareaRef.current
        if (!textarea) return
        textarea.value = ""
        textarea.setSelectionRange(0, 0)
      } else {
        shardEditorRef.current?.replaceDocument("")
      }
    })
  }

  async function uploadImage(file: File) {
    const previewUrl = URL.createObjectURL(file)

    try {
      const bytes = Array.from(new Uint8Array(await file.arrayBuffer()))
      setIsEditorExpanded(true)
      setPendingImages((current) => [
        ...current,
        {
          alt: getMarkdownImageAlt(file.name),
          bytes,
          fileName: file.name,
          id: `${Date.now()}-${file.name}`,
          previewUrl,
        },
      ])
      requestAnimationFrame(() => {
        focusActiveEditor()
      })
    } catch (error) {
      toast.error(`图片上传失败：${getApiErrorMessage(error)}`, { duration: Infinity })
      URL.revokeObjectURL(previewUrl)
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

  function showCaretImmediately() {
    setCaretEpoch((current) => current + 1)
  }

  function applyTextEdit(nextEdit: TextEdit) {
    showCaretImmediately()
    setContent(nextEdit.content)
    setSelectionStart(nextEdit.selectionStart)
    setSelectionEnd(nextEdit.selectionEnd)
    if (!legacyEditorEnabled) {
      shardEditorRef.current?.applyTextEdit(nextEdit)
      return
    }

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

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    const nativeEvent = event.nativeEvent
    const isSaveShortcut =
      event.key === "Enter" &&
      (event.metaKey || event.ctrlKey)
    const isZenShortcut =
      !!onOpenZen &&
      (event.metaKey || event.ctrlKey) &&
      event.shiftKey &&
      !event.altKey &&
      event.key.toLowerCase() === "f"
    const isComposing =
      isComposingRef.current ||
      nativeEvent.isComposing ||
      event.key === "Process" ||
      nativeEvent.keyCode === 229

    if (isComposing) {
      return
    }

    if (isZenShortcut) {
      event.preventDefault()
      if (!isCreating) {
        openZenEditor()
      }
      return
    }

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
        setIsEditorExpanded(true)
        applyTextEdit(nextEdit)
        return
      }
    }

    const isCollapsedCaret =
      event.currentTarget.selectionStart === event.currentTarget.selectionEnd

    // 当标签建议列表可见时，方向键在列表内移动，回车选中高亮项
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
        setIsEditorExpanded(true)
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
        setIsEditorExpanded(true)
        applyTextEdit(nextEdit)
        return
      }
    }

    if (!isSaveShortcut) {
      return
    }

    event.preventDefault()
    void submit()
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

    setIsEditorExpanded(true)
    applyTextEdit(nextEdit)
  }

  function toggleTask(lineIndex: number) {
    const nextContent = toggleTaskLine(content, lineIndex)
    if (nextContent === content) return

    const selection = getCurrentSelection()
    const nextSelectionStart = selection.start
    const nextSelectionEnd = selection.end

    setIsEditorExpanded(true)
    setContent(nextContent)
    setSelectionStart(nextSelectionStart)
    setSelectionEnd(nextSelectionEnd)
    requestAnimationFrame(() => {
      if (legacyEditorEnabled) {
        textareaRef.current?.focus()
        textareaRef.current?.setSelectionRange(
          nextSelectionStart,
          nextSelectionEnd
        )
      } else {
        shardEditorRef.current?.replaceDocument(nextContent)
        shardEditorRef.current?.focus()
      }
    })
  }

  function removePendingImage(id: string) {
    setPendingImages((current) => {
      const removedImage = current.find((image) => image.id === id)
      if (removedImage) {
        URL.revokeObjectURL(removedImage.previewUrl)
      }

      return current.filter((image) => image.id !== id)
    })
    requestAnimationFrame(() => {
      focusActiveEditor()
    })
  }

  function syncSelection(textarea: HTMLTextAreaElement) {
    setSelectionStart(textarea.selectionStart)
    setSelectionEnd(textarea.selectionEnd)
  }

  function startPointerSelection(event: MouseEvent<HTMLTextAreaElement>) {
    setIsEditorExpanded(true)
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

  return (
    <div
      className={`shard-content-measure ${styles.composer}`}
      ref={containerRef}
    >
      <div ref={editorFrameRef} style={{ position: "relative" }}>
        {legacyEditorEnabled ? (
          <LegacyComposerEditor
            activeSuggestionOptionId={activeSuggestionOptionId}
            activeTag={Boolean(activeTag)}
            caretEpoch={caretEpoch}
            content={content}
            customCaret={customCaret}
            editorScrollTop={editorScrollTop}
            isEditorFocused={isEditorFocused}
            onBlur={() => setIsEditorFocused(false)}
            onChange={(textarea) => {
              setIsEditorExpanded(true)
              setContent(textarea.value)
              syncSelection(textarea)
            }}
            onCompositionEnd={() => {
              isComposingRef.current = false
            }}
            onCompositionStart={() => {
              isComposingRef.current = true
            }}
            onFocus={() => {
              setIsEditorFocused(true)
              handleEditorFocus()
            }}
            onKeyDown={handleKeyDown}
            onMouseDown={startPointerSelection}
            onPaste={handlePaste}
            onScroll={setEditorScrollTop}
            onSelectionChange={syncSelection}
            onTaskToggle={toggleTask}
            onTableChange={updateTable}
            selectionEnd={selectionEnd}
            selectionStart={selectionStart}
            tagPopoverId={tagPopoverId}
            textareaRef={textareaRef}
          />
        ) : (
          <div
            className={styles.codeMirrorViewport}
            data-expanded={isEditorExpanded ? "true" : undefined}
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) {
                setIsEditorExpanded(true)
                shardEditorRef.current?.focus()
              }
            }}
            ref={codeMirrorViewportRef}
          >
            <ShardEditor
              ariaLabel="快速记录"
              autoFocus
              documentKey="composer"
              editorId="composer"
              extensions={codeMirrorExtensionSet}
              onChange={(nextContent) => {
                setIsEditorExpanded(true)
                setContent(nextContent)
              }}
              onDropFiles={(files) => void uploadPastedImages(files)}
              onFocus={handleEditorFocus}
              onHeightChange={handleCodeMirrorHeightChange}
              onPasteFiles={(files) => void uploadPastedImages(files)}
              onSelectionChange={(start, end) => {
                setSelectionStart(start)
                setSelectionEnd(end)
              }}
              onSubmit={() => void submit()}
              onToggleZen={
                onOpenZen && !isCreating ? openZenEditor : undefined
              }
              placeholder="想到什么，写什么..."
              ref={shardEditorRef}
              value={content}
              variant="composer"
            />
          </div>
        )}
        {isTableDropTarget || isImportingTable ? (
          <div className="shard-editor-drop-hint">
            {isImportingTable ? "正在导入表格…" : "松手导入为表格"}
          </div>
        ) : null}
      </div>
      {legacyEditorEnabled && activeTag ? (
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

      {pendingImages.length > 0 ? (
        <div
          className="shard-image-attachment-row"
          style={{
            paddingInline: "var(--shard-composer-padding)",
            paddingBottom: "var(--shard-space-3)",
          }}
        >
          {pendingImages.map((image) => (
            <FragmentImageAttachment
              alt={image.alt}
              key={image.id}
              onRemove={() => removePendingImage(image.id)}
              path={image.fileName}
              src={image.previewUrl}
              wrapped={false}
            />
          ))}
        </div>
      ) : null}

      <div
        className="shard-edge-action-row"
        style={{
          borderRadius:
            "0 0 var(--shard-surface-radius) var(--shard-surface-radius)",
          background: "var(--card)",
        }}
      >
        <div style={{ minWidth: 0, flex: "1 1 0%" }}>
          <EditorToolbar
            disabled={isCreating}
            onImageUpload={uploadImage}
            onImportTable={isTauri() ? pickTableDocument : undefined}
            onInlineFormat={formatInline}
            onInsertHorizontalRule={insertDivider}
            onInsertTable={insertTable}
            onInsertTag={insertTag}
            onLineFormat={formatLines}
            onOpenZen={onOpenZen ? openZenEditor : undefined}
            trailing={
              <ToolbarIconButton
                className="shard-edge-action"
                disabled={!canSubmit}
                label={isCreating ? "保存中" : "保存片段"}
                onClick={() => void submit()}
                type="button"
                variant="primary"
              >
                {isCreating ? (
                  <Loader2Icon className={styles.spin} />
                ) : (
                  <SendHorizontalIcon />
                )}
              </ToolbarIconButton>
            }
          />
        </div>
      </div>
      {isCreating ? (
        <div
          style={{
            display: "flex",
            position: "absolute",
            top: "var(--shard-space-4)",
            right: "var(--shard-space-4)",
            alignItems: "center",
            gap: "var(--shard-space-micro)",
            pointerEvents: "none",
            fontSize: 12,
            fontWeight: 400,
            color: "var(--muted-foreground)",
          }}
        >
          <Loader2Icon className={styles.spin} size={14} />
          <span>保存中</span>
        </div>
      ) : null}
    </div>
  )
}

interface LegacyComposerEditorProps {
  activeSuggestionOptionId?: string
  activeTag: boolean
  caretEpoch: number
  content: string
  customCaret: EditorCaretBox | null
  editorScrollTop: number
  isEditorFocused: boolean
  onBlur: () => void
  onChange: (textarea: HTMLTextAreaElement) => void
  onCompositionEnd: () => void
  onCompositionStart: () => void
  onFocus: () => void
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void
  onMouseDown: (event: MouseEvent<HTMLTextAreaElement>) => void
  onPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void
  onScroll: (scrollTop: number) => void
  onSelectionChange: (textarea: HTMLTextAreaElement) => void
  onTableChange: (
    startLine: number,
    lineCount: number,
    table: MarkdownTable
  ) => void
  onTaskToggle: (lineIndex: number) => void
  selectionEnd: number
  selectionStart: number
  tagPopoverId: string
  textareaRef: RefObject<HTMLTextAreaElement | null>
}

function LegacyComposerEditor({
  activeSuggestionOptionId,
  activeTag,
  caretEpoch,
  content,
  customCaret,
  editorScrollTop,
  isEditorFocused,
  onBlur,
  onChange,
  onCompositionEnd,
  onCompositionStart,
  onFocus,
  onKeyDown,
  onMouseDown,
  onPaste,
  onScroll,
  onSelectionChange,
  onTableChange,
  onTaskToggle,
  selectionEnd,
  selectionStart,
  tagPopoverId,
  textareaRef,
}: LegacyComposerEditorProps) {
  return (
    <>
      {content ? (
        <div
          aria-hidden="true"
          className="shard-editor-highlight-layer shard-memo-tags"
        >
          <div
            style={{
              paddingInline: "var(--shard-composer-padding)",
              paddingBlock: "var(--shard-composer-padding)",
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
              onTaskToggle={onTaskToggle}
              selectionEnd={isEditorFocused ? selectionEnd : undefined}
              selectionStart={isEditorFocused ? selectionStart : undefined}
              tableEditing={{
                onChange: onTableChange,
                onExit: () => textareaRef.current?.focus(),
              }}
            />
          </div>
        </div>
      ) : null}
      <textarea
        aria-activedescendant={activeSuggestionOptionId}
        aria-autocomplete={activeTag ? "list" : undefined}
        aria-controls={activeTag ? tagPopoverId : undefined}
        aria-expanded={activeTag ? true : undefined}
        autoFocus
        className={`shard-editor-field shard-editor-overlay-field ${styles.textareaField}`}
        onBlur={onBlur}
        onChange={(event) => onChange(event.currentTarget)}
        onCompositionEnd={onCompositionEnd}
        onCompositionStart={onCompositionStart}
        onFocus={onFocus}
        onKeyDown={onKeyDown}
        onKeyUp={(event) => onSelectionChange(event.currentTarget)}
        onMouseDown={onMouseDown}
        onPaste={onPaste}
        onScroll={(event) => onScroll(event.currentTarget.scrollTop)}
        onSelect={(event) => onSelectionChange(event.currentTarget)}
        placeholder="想到什么，写什么..."
        ref={textareaRef}
        value={content}
      />
      {!content ? (
        <span
          aria-hidden="true"
          className="shard-editor-placeholder"
          style={{
            left: "var(--shard-composer-padding)",
            top: "var(--shard-composer-padding)",
          }}
        >
          想到什么，写什么...
        </span>
      ) : null}
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
    </>
  )
}

const MAX_TAG_SUGGESTIONS = 8
const CAPTURE_COLLAPSED_ROWS = 2
const CAPTURE_EXPANDED_ROWS = 4

function buildContentWithPendingImages(
  value: string,
  pendingImages: Array<{ alt: string; path: string }>
) {
  const text = value.trim()
  const imageMarkdown = pendingImages
    .map((image) => `![${escapeMarkdownImageAlt(image.alt)}](${image.path})`)
    .join("\n")

  return [text, imageMarkdown].filter(Boolean).join("\n")
}

function escapeMarkdownImageAlt(alt: string) {
  return alt.replace(/\\/g, "\\\\").replace(/]/g, "\\]")
}

const TEXTAREA_MIRROR_PROPERTIES = [
  "box-sizing",
  "border-bottom-width",
  "border-left-width",
  "border-right-width",
  "border-top-width",
  "font-family",
  "font-size",
  "font-style",
  "font-variant",
  "font-weight",
  "letter-spacing",
  "line-height",
  "padding-bottom",
  "padding-left",
  "padding-right",
  "padding-top",
  "tab-size",
  "text-align",
  "text-indent",
  "text-transform",
  "white-space",
  "word-break",
  "word-spacing",
  "overflow-wrap",
] as const

function resizeCodeMirrorEditor(
  viewport: HTMLDivElement | null,
  contentHeight: number,
  isExpanded: boolean,
  container: HTMLDivElement | null,
  editorFrame: HTMLDivElement | null
) {
  if (!viewport) return

  const targetRows = isExpanded
    ? CAPTURE_EXPANDED_ROWS
    : CAPTURE_COLLAPSED_ROWS
  const minimumHeight = getCodeMirrorRowsHeight(viewport, targetRows)
  const maximumHeight = getCaptureTextareaMaxHeight(
    container,
    editorFrame,
    contentHeight
  )
  const boundedMinimumHeight =
    maximumHeight === null
      ? minimumHeight
      : Math.min(minimumHeight, maximumHeight)
  const nextHeight =
    maximumHeight === null
      ? Math.max(contentHeight, minimumHeight)
      : Math.min(Math.max(contentHeight, boundedMinimumHeight), maximumHeight)
  const isScrollable = contentHeight > nextHeight + 1

  viewport.style.minHeight = `${boundedMinimumHeight}px`
  viewport.style.height = `${nextHeight}px`
  viewport.style.overflowY = isScrollable ? "auto" : "hidden"
  if (maximumHeight === null) viewport.style.removeProperty("max-height")
  else viewport.style.maxHeight = `${maximumHeight}px`

  if (!isScrollable && viewport.scrollTop !== 0) viewport.scrollTop = 0
}

function getCodeMirrorRowsHeight(viewport: HTMLDivElement, rows: number) {
  const content = viewport.querySelector<HTMLElement>(".cm-content")
  if (!content) return 0

  const styles = window.getComputedStyle(content)
  const fontSize = toPixelValue(styles.fontSize, 14)
  const lineHeight = toPixelValue(styles.lineHeight, fontSize * 1.8)
  const paddingTop = toPixelValue(styles.paddingTop, 0)
  const paddingBottom = toPixelValue(styles.paddingBottom, 0)

  return Math.ceil(lineHeight * rows + paddingTop + paddingBottom)
}

function resizeTextarea(
  textarea: HTMLTextAreaElement | null,
  isExpanded: boolean,
  container: HTMLDivElement | null,
  editorFrame: HTMLDivElement | null
) {
  if (!textarea) return

  const targetRows = isExpanded
    ? CAPTURE_EXPANDED_ROWS
    : CAPTURE_COLLAPSED_ROWS
  const minimumHeight = getTextareaRowsHeight(textarea, targetRows)
  const contentHeight = getTextareaContentHeight(textarea)
  const maximumHeight = getCaptureTextareaMaxHeight(
    container,
    editorFrame,
    contentHeight
  )
  const boundedMinimumHeight =
    maximumHeight === null
      ? minimumHeight
      : Math.min(minimumHeight, maximumHeight)
  const nextHeight =
    maximumHeight === null
      ? Math.max(contentHeight, minimumHeight)
      : Math.min(Math.max(contentHeight, boundedMinimumHeight), maximumHeight)
  const isScrollable = contentHeight > nextHeight + 1

  textarea.style.minHeight = `${boundedMinimumHeight}px`
  if (maximumHeight === null) {
    textarea.style.removeProperty("max-height")
  } else {
    textarea.style.maxHeight = `${maximumHeight}px`
  }
  textarea.style.height = `${nextHeight}px`
  textarea.style.overflowY = isScrollable ? "auto" : "hidden"

  if (!isScrollable && textarea.scrollTop !== 0) {
    textarea.scrollTop = 0
  }
}

function getCaptureTextareaMaxHeight(
  container: HTMLDivElement | null,
  editorFrame: HTMLDivElement | null,
  contentHeight: number
) {
  if (!container || !editorFrame) return null

  const containerRect = container.getBoundingClientRect()
  const editorFrameRect = editorFrame.getBoundingClientRect()
  const viewportBottom = getCaptureViewportBottom(container)
  const rootStyles = window.getComputedStyle(document.documentElement)
  const topGap = toPixelValue(
    rootStyles.getPropertyValue("--shard-composer-top-gap"),
    32
  )
  const bottomGap = toPixelValue(
    rootStyles.getPropertyValue("--shard-composer-bottom-gap"),
    16
  )
  const composerChromeHeight = Math.max(
    0,
    containerRect.height - editorFrameRect.height
  )
  const currentReclaim = toPixelValue(
    container.dataset.composerTopReclaim ?? "",
    0
  )
  const currentMaximumHeight = Math.max(
    1,
    Math.floor(
      viewportBottom - containerRect.top - bottomGap - composerChromeHeight
    )
  )
  const normalMaximumHeight = Math.max(
    1,
    currentMaximumHeight - currentReclaim
  )
  const reclaimLimit = window.matchMedia("(min-width: 64rem)").matches
    ? Math.max(0, topGap - bottomGap)
    : 0
  const nextReclaim = Math.min(
    Math.max(contentHeight - normalMaximumHeight, 0),
    reclaimLimit
  )

  container.dataset.composerTopReclaim = String(nextReclaim)
  if (reclaimLimit > 0 && nextReclaim >= reclaimLimit) {
    container.dataset.heightCapped = "true"
  } else {
    delete container.dataset.heightCapped
  }
  container.style.marginTop = nextReclaim > 0 ? `-${nextReclaim}px` : ""

  return normalMaximumHeight + nextReclaim
}

function getCaptureViewportBottom(container: HTMLDivElement) {
  const mainColumn = container.closest("section")
  if (mainColumn instanceof HTMLElement) {
    return mainColumn.getBoundingClientRect().bottom
  }

  return window.visualViewport?.height ?? window.innerHeight
}

function getTextareaContentHeight(textarea: HTMLTextAreaElement) {
  const styles = window.getComputedStyle(textarea)
  const mirror = document.createElement("div")

  for (const property of TEXTAREA_MIRROR_PROPERTIES) {
    mirror.style.setProperty(property, styles.getPropertyValue(property))
  }

  mirror.style.position = "absolute"
  mirror.style.visibility = "hidden"
  mirror.style.top = "0"
  mirror.style.left = "-9999px"
  mirror.style.width = `${textarea.getBoundingClientRect().width}px`
  mirror.style.height = "auto"
  mirror.style.minHeight = "0"
  mirror.style.maxHeight = "none"
  mirror.style.overflow = "hidden"
  mirror.style.whiteSpace = "pre-wrap"
  mirror.style.overflowWrap = "break-word"
  mirror.textContent = textarea.value || " "

  if (textarea.value.endsWith("\n")) {
    mirror.appendChild(document.createTextNode("\u200b"))
  }

  document.body.appendChild(mirror)

  const borderTop = toPixelValue(styles.borderTopWidth, 0)
  const borderBottom = toPixelValue(styles.borderBottomWidth, 0)
  const contentHeight = Math.ceil(
    mirror.scrollHeight + borderTop + borderBottom
  )

  mirror.remove()
  return contentHeight
}

function getTextareaRowsHeight(textarea: HTMLTextAreaElement, rows: number) {
  const styles = window.getComputedStyle(textarea)
  const fontSize = toPixelValue(styles.fontSize, 14)
  const lineHeight = toPixelValue(styles.lineHeight, fontSize * 1.8)
  const paddingTop = toPixelValue(styles.paddingTop, 0)
  const paddingBottom = toPixelValue(styles.paddingBottom, 0)
  const borderTop = toPixelValue(styles.borderTopWidth, 0)
  const borderBottom = toPixelValue(styles.borderBottomWidth, 0)

  return Math.ceil(
    lineHeight * rows + paddingTop + paddingBottom + borderTop + borderBottom
  )
}

function toPixelValue(value: string, fallback: number) {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : fallback
}
