import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react"
import { isTauri } from "@tauri-apps/api/core"
import { XIcon } from "lucide-react"
import { toast } from "sonner"

import { EditorToolbar } from "@/components/shard/editor-toolbar"
import { FragmentContent } from "@/components/shard/fragment-content"
import {
  getTagCompletionPopoverPosition,
  TagCompletionPopover,
} from "@/components/shard/tag-completion-popover"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import {
  applyActiveTagCompletion,
  applyInlineFormat,
  applyLineFormat,
  applyTagCompletion,
  applyTaskMarkerDeletion,
  extractTags,
  getActiveTag,
  getTagRanges,
  insertMarkdownImage,
  insertTagMarker,
  normalizeTag,
  normalizeTagList,
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
import { getTextareaCaretBox, type TextareaCaretBox } from "@/lib/textarea-caret"
import type { Fragment } from "@/types"

interface FragmentEditorProps {
  fragment: Fragment | null
  knownTags: string[]
  onClose: () => void
  onSave: (id: string, content: string, tags: string[]) => Promise<Fragment>
}

type SaveState = "dirty" | "error" | "saved" | "saving"

export function FragmentEditor({
  fragment,
  knownTags,
  onClose,
  onSave,
}: FragmentEditorProps) {
  const [content, setContent] = useState("")
  const [caretEpoch, setCaretEpoch] = useState(0)
  const [customCaret, setCustomCaret] = useState<TextareaCaretBox | null>(null)
  const [editorScrollTop, setEditorScrollTop] = useState(0)
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
  const lastSavedContentRef = useRef("")
  const onSaveRef = useRef(onSave)
  const saveTimerRef = useRef<number | null>(null)
  const editorFrameRef = useRef<HTMLDivElement>(null)
  const lastPointerRef = useRef<PointerPoint | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

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
  const activeNewTag = activeTag ? normalizeTag(activeTag.query) : ""
  const activeTagExists =
    activeNewTag.length > 0 && normalizedKnownTags.includes(activeNewTag)

  useEffect(() => {
    onSaveRef.current = onSave
  }, [onSave])

  useEffect(() => {
    if (!fragment) return

    const cursor = fragment.content.length
    setContent(fragment.content)
    setSelectionEnd(cursor)
    setSelectionStart(cursor)
    setSuppressedActiveTag({ content: fragment.content, cursor })
    setSaveState("saved")
    lastSavedContentRef.current = fragment.content

    requestAnimationFrame(() => {
      const textarea = textareaRef.current
      if (!textarea) return

      textarea.focus()
      textarea.setSelectionRange(cursor, cursor)
      textarea.scrollTop = textarea.scrollHeight
      setEditorScrollTop(textarea.scrollTop)
      setIsEditorFocused(true)
    })
  }, [fragment?.id])

  useLayoutEffect(() => {
    syncCustomCaret()
  }, [
    content,
    isEditorFocused,
    selectionEnd,
    selectionStart,
    suppressedActiveTag,
  ])

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
    if (!fragment || content === lastSavedContentRef.current) return

    setSaveState("dirty")
    clearSaveTimer()
    saveTimerRef.current = window.setTimeout(() => {
      void saveDraft(content)
    }, 800)

    return clearSaveTimer
  }, [content, fragment?.id])

  useEffect(() => {
    if (!fragment || !isTauri()) return

    void setWindowControlsHidden(true).catch((error) => {
      console.warn("Unable to hide window controls for zen editor", error)
    })

    return () => {
      void setWindowControlsHidden(false).catch((error) => {
        console.warn("Unable to restore window controls", error)
      })
    }
  }, [fragment?.id])

  if (!fragment) return null

  async function handleClose() {
    clearSaveTimer()

    if (content !== lastSavedContentRef.current) {
      const saved = await saveDraft(content)
      if (!saved) return
    }

    onClose()
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    const nativeEvent = event.nativeEvent
    const isCloseShortcut = event.key === "Escape"
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

    if (
      event.key === "Enter" &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.shiftKey &&
      event.currentTarget.selectionStart === event.currentTarget.selectionEnd
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
    if (!textarea) return

    try {
      const bytes = Array.from(new Uint8Array(await file.arrayBuffer()))
      const path = await saveFragmentImage(file.name, bytes)
      applyTextEdit(
        insertMarkdownImage(
          content,
          textarea.selectionStart,
          textarea.selectionEnd,
          file.name,
          path
        )
      )
    } catch (error) {
      toast.error("图片上传失败", {
        description: getApiErrorMessage(error),
      })
    }
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

  function showCaretImmediately() {
    setCaretEpoch((current) => current + 1)
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

  function syncCustomCaret() {
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

    const currentValue = textarea.value
    const currentActiveTag = getActiveTag(currentValue, selectionStart)
    const caret = getTextareaCaretBox(textarea, selectionStart)
    setCustomCaret(currentActiveTag ? { ...caret, top: caret.lineTop } : caret)
  }

  return (
    <div className="fixed inset-0 z-50 grid grid-rows-[minmax(0,1fr)_auto] bg-background text-foreground">
      <div className="shard-content-inset min-h-0">
        <div
          className="shard-content-measure relative h-full"
          ref={editorFrameRef}
        >
          {content ? (
            <div
              aria-hidden="true"
              className="shard-editor-highlight-layer shard-memo-tags px-0 py-[var(--shard-space-4)]"
              style={{
                transform: `translateY(-${editorScrollTop}px)`,
              }}
            >
              <FragmentContent
                content={content}
                highlightTags
                onTaskToggle={toggleTask}
                selectionEnd={isEditorFocused ? selectionEnd : undefined}
                selectionStart={isEditorFocused ? selectionStart : undefined}
              />
            </div>
          ) : null}
          <Textarea
            className="shard-editor-field shard-editor-overlay-field relative z-10 h-full min-h-0 resize-none overflow-y-auto border-0 bg-transparent px-0 py-[var(--shard-space-4)] shadow-none focus-visible:border-transparent focus-visible:ring-0"
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
              syncCustomCaret()
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
              exists={activeTagExists}
              label={activeNewTag}
              left={tagPopoverPosition.left}
              onApply={() => applyTag(activeNewTag)}
              top={tagPopoverPosition.top}
            />
          ) : null}
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
                  className="shard-edge-action size-7 rounded-[var(--shard-radius-control)] text-muted-foreground"
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
