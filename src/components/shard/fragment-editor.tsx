import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type MouseEvent,
} from "react"
import { isTauri } from "@tauri-apps/api/core"
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
import { Textarea } from "@/components/ui/textarea"
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
  getApiErrorMessage,
  saveFragmentImage,
  setWindowControlsHidden,
} from "@/lib/api"
import { getClipboardImageFiles } from "@/lib/clipboard-images"
import { getEditorCaretBox, type EditorCaretBox } from "@/lib/editor-caret"
import { hasMarkdownImage, wantsLockbox } from "@/lib/lockbox"
import {
  buildTagSearchIndex,
  getMatchingTagsBySearchQuery,
} from "@/lib/tag-index"
import type { Fragment } from "@/types"

interface FragmentEditorProps {
  fragment: Fragment | null
  knownTags: string[]
  onClose: () => void
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
  fragment,
  knownTags,
  onClose,
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
  const onSaveRef = useRef(onSave)
  const saveTimerRef = useRef<number | null>(null)
  const editorFrameRef = useRef<HTMLDivElement>(null)
  const lastPointerRef = useRef<PointerPoint | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const tagPopoverId = useId()
  const isZen = variant === "zen"

  const rawActiveTag = useMemo(
    () => getActiveTag(content, selectionStart),
    [content, selectionStart]
  )
  const activeTag =
    rawActiveTag &&
    !isSuppressedActiveTag(suppressedActiveTag, content, selectionStart)
      ? rawActiveTag
      : null
  const normalizedKnownTags = useMemo(
    () => normalizeTagList(knownTags.filter((tag) => tag !== "inbox")),
    [knownTags]
  )
  const tagSearchIndex = useMemo(
    () => buildTagSearchIndex(normalizedKnownTags),
    [normalizedKnownTags]
  )
  const activeNewTag = activeTag ? normalizeTag(activeTag.query) : ""
  const draftContent = useMemo(
    () => buildContentWithImageAttachments(content, imageAttachments),
    [content, imageAttachments]
  )
  const tagSuggestions = useMemo<TagSuggestion[]>(() => {
    if (!activeTag) return []

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
  }, [activeTag, activeNewTag, normalizedKnownTags, tagSearchIndex])
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
    imageAttachmentsRef.current = imageAttachments
  }, [imageAttachments])

  useEffect(() => {
    return () => {
      revokeEditorImagePreviewUrls(imageAttachmentsRef.current)
    }
  }, [])

  useEffect(() => {
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
  }, [])

  useEffect(() => {
    if (!fragment) {
      revokeEditorImagePreviewUrls(imageAttachmentsRef.current)
      imageAttachmentsRef.current = []
      setImageAttachments([])
      return
    }

    const draft = splitContentImageAttachments(fragment.content)
    const cursor = draft.content.length
    revokeEditorImagePreviewUrls(imageAttachmentsRef.current)
    imageAttachmentsRef.current = draft.images
    setContent(draft.content)
    setImageAttachments(draft.images)
    setSelectionEnd(cursor)
    setSelectionStart(cursor)
    setSuppressedActiveTag({ content: draft.content, cursor })
    setSaveState("saved")
    lastSavedContentRef.current = buildContentWithImageAttachments(
      draft.content,
      draft.images
    )

    requestAnimationFrame(() => {
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
  }, [fragment?.id])

  useLayoutEffect(() => {
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
  }, [content, editorScrollTop, isEditorFocused, selectionEnd, selectionStart])

  useLayoutEffect(() => {
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
  }, [activeTag, content, editorScrollTop, selectionStart])

  useEffect(() => {
    if (!fragment) return

    clearSaveTimer()

    if (draftContent === lastSavedContentRef.current) {
      setSaveState("saved")
      return
    }

    setSaveState("dirty")

    if (!isZen) return

    saveTimerRef.current = window.setTimeout(() => {
      void saveDraft(draftContent)
    }, 800)

    return clearSaveTimer
  }, [draftContent, fragment?.id, isZen])

  useEffect(() => {
    if (!fragment || !isZen || !isTauri()) return

    void setWindowControlsHidden(true).catch((error) => {
      console.warn("Unable to hide window controls for zen editor", error)
    })

    return () => {
      void setWindowControlsHidden(false).catch((error) => {
        console.warn("Unable to restore window controls", error)
      })
    }
  }, [fragment?.id, isZen])

  if (!fragment) return null

  async function handleClose() {
    clearSaveTimer()

    if (!isZen) {
      onClose()
      return
    }

    if (draftContent !== lastSavedContentRef.current) {
      const saved = await saveDraft(draftContent)
      if (!saved) return
    }

    onClose()
  }

  async function handleSubmit() {
    clearSaveTimer()

    if (draftContent === lastSavedContentRef.current) {
      onClose()
      return
    }

    const saved = await saveDraft(draftContent)
    if (saved) {
      onClose()
    }
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
  }

  function showCaretImmediately() {
    setCaretEpoch((current) => current + 1)
  }

  async function saveDraft(nextContent: string) {
    if (!fragment) return false
    if (nextContent.trim().length === 0) {
      setSaveState("error")
      toast.error("片段内容不能为空")
      return false
    }

    setSaveState("saving")

    try {
      const tags = normalizeTagList(["inbox", ...extractTags(nextContent)])
      if ((fragment.lockbox || wantsLockbox(nextContent, tags)) && hasMarkdownImage(nextContent)) {
        throw new Error("密匣暂不支持图片附件。请先移除图片，再保存到密匣。")
      }
      await onSaveRef.current(fragment.id, nextContent, tags)
      lastSavedContentRef.current = nextContent
      setSaveState("saved")
      return true
    } catch (error) {
      setSaveState("error")
      toast.error("自动保存失败", {
        description: getApiErrorMessage(error),
      })
      return false
    }
  }

  function insertTag() {
    const cursor = textareaRef.current?.selectionStart ?? selectionStart
    setSuppressedActiveTag(null)
    applyTextEdit(insertTagMarker(content, cursor))
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
    const textarea = textareaRef.current
    if (!textarea) return

    applyTextEdit(
      applyLineFormat(
        content,
        textarea.selectionStart,
        textarea.selectionEnd,
        format
      )
    )
  }

  function formatInline(format: InlineFormat) {
    const textarea = textareaRef.current
    if (!textarea) return

    applyTextEdit(
      applyInlineFormat(
        content,
        textarea.selectionStart,
        textarea.selectionEnd,
        format
      )
    )
  }

  async function uploadImage(file: File) {
    const textarea = textareaRef.current
    if (!textarea || !fragment) return
    const tags = normalizeTagList(["inbox", ...extractTags(draftContent)])
    if (fragment.lockbox || wantsLockbox(draftContent, tags)) {
      toast.error("密匣暂不支持图片附件", {
        description: "请先移除 #密匣，或在公开笔记中上传图片。",
      })
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
        textareaRef.current?.focus()
      })
    } catch (error) {
      URL.revokeObjectURL(previewUrl)
      toast.error("图片上传失败", {
        description: getApiErrorMessage(error),
      })
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
      textareaRef.current?.focus()
    })
  }

  function applyTextEdit(nextEdit: TextEdit) {
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

  const editorPaddingClass = isZen
    ? "px-0 py-[var(--shard-space-4)]"
    : "px-[var(--shard-composer-padding)] py-[var(--shard-composer-padding)]"
  const fieldClass = isZen
    ? "h-full min-h-0 overflow-y-auto px-0 py-[var(--shard-space-4)]"
    : "min-h-[144px] max-h-[min(52dvh,520px)] overflow-y-auto rounded-t-[var(--shard-surface-radius)] rounded-b-none px-[var(--shard-composer-padding)] py-[var(--shard-composer-padding)]"
  const imageAttachmentRow =
    imageAttachments.length > 0 ? (
      <div
        className={`shard-image-attachment-row ${
          isZen
            ? "px-0 pb-[var(--shard-space-4)]"
            : "px-[var(--shard-composer-padding)] pb-[var(--shard-space-3)]"
        }`}
      >
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
  const editorFrame = (
    <div
      className={isZen ? "relative min-h-0 flex-1" : "relative"}
      ref={editorFrameRef}
    >
      {content ? (
        <div
          aria-hidden="true"
          className={`shard-editor-highlight-layer shard-memo-tags ${editorPaddingClass}`}
          style={{
            transform: `translateY(-${editorScrollTop}px)`,
          }}
        >
          <FragmentContent
            caretAligned
            content={content}
            highlightTags
            onTaskToggle={toggleTask}
            selectionEnd={isEditorFocused ? selectionEnd : undefined}
            selectionStart={isEditorFocused ? selectionStart : undefined}
            vaultPath={vaultPath}
          />
        </div>
      ) : null}
      <Textarea
        aria-activedescendant={activeSuggestionOptionId}
        aria-autocomplete={activeTag ? "list" : undefined}
        aria-controls={activeTag ? tagPopoverId : undefined}
        aria-expanded={activeTag ? true : undefined}
        className={`shard-editor-field shard-editor-overlay-field relative z-10 resize-none border-0 bg-transparent shadow-none focus-visible:border-transparent focus-visible:ring-0 ${fieldClass}`}
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
        onClick={(event) => {
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
    </div>
  )

  if (!isZen) {
    return (
      <article className="relative flex flex-col rounded-[var(--shard-surface-radius)] border border-border bg-card p-0 shadow-[var(--shard-composer-shadow)] transition-colors focus-within:border-[color:var(--shard-sapphire)]">
        {editorFrame}
        {imageAttachmentRow}
        <div className="shard-edge-action-row rounded-b-[var(--shard-surface-radius)] bg-card">
          <EditorToolbar
            disabled={saveState === "saving"}
            onImageUpload={uploadImage}
            onInlineFormat={formatInline}
            onInsertTag={insertTag}
            onLineFormat={formatLines}
            trailing={
              <>
                <span
                  aria-hidden="true"
                  className="mx-[var(--shard-space-1)] h-5 w-px bg-border/[var(--shard-alpha-55)]"
                />
                <span className="px-[var(--shard-space-1)] text-sm font-medium text-muted-foreground tabular-nums">
                  {content.trim().length}
                </span>
                <Button
                  className="h-8 rounded-[var(--shard-radius-control)] px-[var(--shard-space-2)] text-muted-foreground"
                  disabled={saveState === "saving"}
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
                <Button
                  className="shard-edge-action shard-edge-action-save rounded-full bg-[color:var(--shard-sapphire)] text-white hover:bg-[color:var(--shard-sapphire-hover)] disabled:bg-transparent disabled:text-muted-foreground"
                  disabled={!canSubmit}
                  onMouseDown={(event) => {
                    event.preventDefault()
                    void handleSubmit()
                  }}
                  size="icon-sm"
                  title={saveState === "saving" ? "保存中" : "保存修改"}
                  type="button"
                >
                  {saveState === "saving" ? (
                    <Loader2Icon
                      className="animate-spin"
                      data-icon="inline-start"
                    />
                  ) : (
                    <SendHorizontalIcon data-icon="inline-start" />
                  )}
                  <span className="sr-only">
                    {saveState === "saving" ? "保存中" : "保存修改"}
                  </span>
                </Button>
              </>
            }
          />
        </div>
      </article>
    )
  }

  return (
    <div className="fixed inset-0 z-50 grid grid-rows-[minmax(0,1fr)_auto] bg-background text-foreground">
      <div className="shard-content-inset min-h-0">
        <div className="shard-content-measure flex h-full min-h-0 flex-col">
          {editorFrame}
          {imageAttachmentRow}
        </div>
      </div>

      <footer className="shard-content-inset pb-[var(--shard-space-4)]">
        <div className="mx-auto w-fit max-w-full rounded-[var(--shard-surface-radius)] bg-card p-[var(--shard-space-3)] shadow-[var(--shard-composer-shadow)]">
          <EditorToolbar
            disabled={saveState === "saving"}
            onImageUpload={uploadImage}
            onInlineFormat={formatInline}
            onInsertTag={insertTag}
            onLineFormat={formatLines}
            trailing={
              <>
                <span
                  aria-hidden="true"
                  className="mx-[var(--shard-space-1)] h-5 w-px bg-border/[var(--shard-alpha-55)]"
                />
                <Button
                  className="shard-edge-action rounded-[var(--shard-radius-control)] text-muted-foreground"
                  onMouseDown={(event) => {
                    event.preventDefault()
                    void handleClose()
                  }}
                  size="icon-sm"
                  title="退出编辑"
                  type="button"
                  variant="ghost"
                >
                  <XIcon data-icon="inline-start" />
                  <span className="sr-only">退出编辑</span>
                </Button>
              </>
            }
          />
        </div>
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
