import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react"
import { Loader2Icon, SendHorizontalIcon } from "lucide-react"
import { toast } from "sonner"

import { EditorToolbar } from "@/components/shard/editor-toolbar"
import { FragmentContent } from "@/components/shard/fragment-content"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import {
  applyInlineFormat,
  applyLineFormat,
  applyTaskMarkerDeletion,
  extractTags,
  insertMarkdownImage,
  insertTagMarker,
  isTagBoundary,
  normalizeTag,
  normalizeTagList,
  toggleTaskLine,
  type InlineFormat,
  type LineFormat,
  type TextEdit,
} from "@/lib/editor-format"
import { getTextareaCaretBox, type TextareaCaretBox } from "@/lib/textarea-caret"
import { saveFragmentImage } from "@/lib/api"

interface CaptureBoxProps {
  collapseSignal: number
  isCreating: boolean
  knownTags: string[]
  onCreate: (content: string, tags: string[]) => void | Promise<void>
}

export function CaptureBox({
  collapseSignal,
  isCreating,
  knownTags,
  onCreate,
}: CaptureBoxProps) {
  const [content, setContent] = useState("")
  const [isEditorExpanded, setIsEditorExpanded] = useState(false)
  const [selectionStart, setSelectionStart] = useState(0)
  const [tagPopoverPosition, setTagPopoverPosition] = useState({
    left: 12,
    top: 44,
  })
  const [customCaret, setCustomCaret] = useState<TextareaCaretBox | null>(null)
  const [isEditorFocused, setIsEditorFocused] = useState(false)
  const [selectionEnd, setSelectionEnd] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)
  const editorFrameRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const hasSkippedInitialFocusRef = useRef(false)
  const isComposingRef = useRef(false)

  const activeTag = useMemo(
    () => getActiveTag(content, selectionStart),
    [content, selectionStart]
  )
  const normalizedKnownTags = useMemo(
    () => normalizeTagList(knownTags.filter((tag) => tag !== "inbox")),
    [knownTags]
  )
  const activeNewTag = activeTag ? normalizeTag(activeTag.query) : ""
  const activeTagExists =
    activeNewTag.length > 0 && normalizedKnownTags.includes(activeNewTag)
  const canSubmit = content.trim().length > 0 && !isCreating

  useEffect(() => {
    if (collapseSignal === 0) return

    setIsEditorExpanded(false)
  }, [collapseSignal])

  useEffect(() => {
    const scrollPositions = new WeakMap<EventTarget, number>()
    let lastTouchY: number | null = null

    function collapseEditor() {
      setIsEditorExpanded(false)
    }

    function handleWheel(event: WheelEvent) {
      if (event.deltaY > 0) {
        collapseEditor()
      }
    }

    function handleScroll(event: Event) {
      const target = event.target
      if (!target) return

      const nextScrollTop = getScrollTop(target)
      if (nextScrollTop === null) return

      const currentScrollTop = scrollPositions.get(target) ?? nextScrollTop

      if (nextScrollTop > currentScrollTop + 2) {
        collapseEditor()
      }

      scrollPositions.set(target, nextScrollTop)
    }

    function handleTouchStart(event: TouchEvent) {
      lastTouchY = event.touches[0]?.clientY ?? null
    }

    function handleTouchMove(event: TouchEvent) {
      const nextTouchY = event.touches[0]?.clientY ?? null
      if (nextTouchY === null || lastTouchY === null) {
        lastTouchY = nextTouchY
        return
      }

      if (nextTouchY < lastTouchY - 2) {
        collapseEditor()
      }

      lastTouchY = nextTouchY
    }

    document.addEventListener("wheel", handleWheel, {
      capture: true,
      passive: true,
    })
    document.addEventListener("scroll", handleScroll, {
      capture: true,
      passive: true,
    })
    document.addEventListener("touchstart", handleTouchStart, {
      capture: true,
      passive: true,
    })
    document.addEventListener("touchmove", handleTouchMove, {
      capture: true,
      passive: true,
    })

    return () => {
      document.removeEventListener("wheel", handleWheel, { capture: true })
      document.removeEventListener("scroll", handleScroll, { capture: true })
      document.removeEventListener("touchstart", handleTouchStart, {
        capture: true,
      })
      document.removeEventListener("touchmove", handleTouchMove, {
        capture: true,
      })
    }
  }, [])

  useLayoutEffect(() => {
    resizeTextarea(textareaRef.current, isEditorExpanded)
  }, [content, isEditorExpanded])

  useLayoutEffect(() => {
    syncCustomCaret()
  }, [content, isEditorFocused, selectionEnd, selectionStart])

  useLayoutEffect(() => {
    if (!activeTag || !textareaRef.current || !containerRef.current) return

    const textarea = textareaRef.current
    const container = containerRef.current
    const caret = getTextareaCaretBox(textarea, selectionStart)
    const textareaRect = textarea.getBoundingClientRect()
    const containerRect = container.getBoundingClientRect()

    const preferredLeft = textareaRect.left - containerRect.left + caret.left - 4
    const maxLeft = Math.max(
      TAG_POPOVER_MARGIN,
      containerRect.width - TAG_POPOVER_WIDTH - TAG_POPOVER_MARGIN
    )
    const nextPosition = {
      left: clamp(preferredLeft, TAG_POPOVER_MARGIN, maxLeft),
      top:
        textareaRect.top -
        containerRect.top +
        caret.lineTop +
        caret.lineHeight +
        4,
    }

    setTagPopoverPosition((currentPosition) => {
      const isSamePosition =
        Math.abs(currentPosition.left - nextPosition.left) < 0.5 &&
        Math.abs(currentPosition.top - nextPosition.top) < 0.5

      return isSamePosition ? currentPosition : nextPosition
    })
  }, [activeTag, content, selectionStart])

  function submit() {
    const next = content.trim()
    if (!next || isCreating) return

    setContent("")
    setIsEditorExpanded(false)
    setSelectionStart(0)
    void onCreate(next, normalizeTagList(["inbox", ...extractTags(next)]))
  }

  function insertTag() {
    const cursor = textareaRef.current?.selectionStart ?? selectionStart
    const nextEdit = insertTagMarker(content, cursor)
    setIsEditorExpanded(true)
    applyTextEdit(nextEdit)
  }

  function formatLines(format: LineFormat) {
    const textarea = textareaRef.current
    if (!textarea) return

    const nextEdit = applyLineFormat(
      content,
      textarea.selectionStart,
      textarea.selectionEnd,
      format
    )

    setIsEditorExpanded(true)
    applyTextEdit(nextEdit)
  }

  function formatInline(format: InlineFormat) {
    const textarea = textareaRef.current
    if (!textarea) return

    const nextEdit = applyInlineFormat(
      content,
      textarea.selectionStart,
      textarea.selectionEnd,
      format
    )

    setIsEditorExpanded(true)
    applyTextEdit(nextEdit)
  }

  async function uploadImage(file: File) {
    const textarea = textareaRef.current
    if (!textarea) return

    try {
      const bytes = Array.from(new Uint8Array(await file.arrayBuffer()))
      const path = await saveFragmentImage(file.name, bytes)
      const nextEdit = insertMarkdownImage(
        content,
        textarea.selectionStart,
        textarea.selectionEnd,
        file.name,
        path
      )

      setIsEditorExpanded(true)
      applyTextEdit(nextEdit)
    } catch (error) {
      toast.error("图片上传失败", {
        description: String(error),
      })
    }
  }

  function applyTextEdit(nextEdit: TextEdit) {
    setContent(nextEdit.content)
    setSelectionStart(nextEdit.selectionStart)
    setSelectionEnd(nextEdit.selectionEnd)
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
      (event.metaKey || event.ctrlKey || event.shiftKey)
    const isComposing =
      isComposingRef.current ||
      nativeEvent.isComposing ||
      event.key === "Process" ||
      nativeEvent.keyCode === 229

    if (isComposing) {
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

    if (!isSaveShortcut) {
      return
    }

    event.preventDefault()
    submit()
  }

  function applyTag(tag: string) {
    const textarea = textareaRef.current
    const currentContent = textarea?.value ?? content
    const cursor = textarea?.selectionStart ?? selectionStart
    const tagAtCursor = getActiveTag(currentContent, cursor)
    const targetTag = tagAtCursor ?? activeTag
    if (!targetTag) return

    const tagEnd = getTagInputEnd(currentContent, targetTag.hashStart)
    const rawTag = currentContent.slice(targetTag.hashStart + 1, tagEnd)
    const nextTag = normalizeTag(rawTag || tag || targetTag.query)
    if (!nextTag) return

    const before = currentContent.slice(0, targetTag.hashStart)
    const after = currentContent.slice(tagEnd)
    const hasInlineSeparator = /^[^\S\r\n]/u.test(after)
    const separator = hasInlineSeparator ? "" : " "
    const nextContent = `${before}#${nextTag}${separator}${after}`
    const nextCursor = before.length + nextTag.length + 2

    setIsEditorExpanded(true)
    applyTextEdit({
      content: nextContent,
      selectionEnd: nextCursor,
      selectionStart: nextCursor,
    })
  }

  function toggleTask(lineIndex: number) {
    const nextContent = toggleTaskLine(content, lineIndex)
    if (nextContent === content) return

    const nextSelectionStart =
      textareaRef.current?.selectionStart ?? selectionStart
    const nextSelectionEnd = textareaRef.current?.selectionEnd ?? selectionEnd

    setIsEditorExpanded(true)
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

  function syncSelection(textarea: HTMLTextAreaElement) {
    setSelectionStart(textarea.selectionStart)
    setSelectionEnd(textarea.selectionEnd)
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

    const caret = getTextareaCaretBox(textarea, selectionStart)
    setCustomCaret(activeTag ? { ...caret, top: caret.lineTop } : caret)
  }

  return (
    <div
      className="shard-content-measure relative rounded-[var(--shard-surface-radius)] border border-border bg-card p-0 shadow-[var(--shard-composer-shadow)] transition-colors focus-within:border-[color:var(--shard-sapphire)]"
      ref={containerRef}
    >
      <div className="relative" ref={editorFrameRef}>
        {content ? (
          <div
            aria-hidden="true"
            className="shard-editor-highlight-layer px-[var(--shard-composer-padding)] py-[var(--shard-composer-padding)]"
          >
            <FragmentContent
              content={content}
              highlightTags
              onTaskToggle={toggleTask}
            />
          </div>
        ) : null}
        <Textarea
          autoFocus
          className="shard-editor-field shard-editor-overlay-field relative z-10 resize-none overflow-hidden rounded-t-[var(--shard-surface-radius)] rounded-b-none border-0 bg-transparent px-[var(--shard-composer-padding)] py-[var(--shard-composer-padding)] shadow-none transition-[height] duration-200 ease-in-out placeholder:text-transparent focus-visible:border-transparent focus-visible:ring-0"
          onClick={(event) => {
            setIsEditorExpanded(true)
            syncSelection(event.currentTarget)
          }}
          onChange={(event) => {
            setIsEditorExpanded(true)
            setContent(event.currentTarget.value)
            syncSelection(event.currentTarget)
          }}
          onCompositionEnd={() => {
            isComposingRef.current = false
          }}
          onCompositionStart={() => {
            isComposingRef.current = true
          }}
          onFocus={() => {
            setIsEditorFocused(true)
            if (!hasSkippedInitialFocusRef.current) {
              hasSkippedInitialFocusRef.current = true
              return
            }

            setIsEditorExpanded(true)
          }}
          onKeyDown={handleKeyDown}
          onKeyUp={(event) => {
            syncSelection(event.currentTarget)
          }}
          onSelect={(event) => {
            syncSelection(event.currentTarget)
          }}
          onBlur={() => {
            setIsEditorFocused(false)
          }}
          onScroll={syncCustomCaret}
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
            style={{
              height: customCaret.height,
              left: customCaret.left,
              top: customCaret.top,
            }}
          />
        ) : null}
      </div>
      {activeTag ? (
        <div
          className="absolute z-40 w-[168px] max-w-[calc(100%-1.5rem)] rounded-[var(--shard-surface-radius)] border border-[rgb(0_0_0/var(--shard-alpha-5))] bg-card p-[var(--shard-space-1)] text-card-foreground shadow-[0_6px_14px_rgb(0_0_0/var(--shard-alpha-5))]"
          style={{
            left: tagPopoverPosition.left,
            top: tagPopoverPosition.top,
          }}
        >
          <div className="flex h-8 items-center gap-[var(--shard-space-micro)] rounded-[calc(var(--shard-radius-control)+4px)] bg-[color:var(--shard-tag-bg)] px-[var(--shard-tag-padding-x)] shadow-[inset_0_0_0_1px_var(--shard-tag-ring)]">
            <div className="min-w-0 flex-1 truncate text-xs leading-none font-medium text-[color:var(--shard-tag-fg-strong)]">
              {activeNewTag || "标签"}
            </div>
            <Button
              className="h-[var(--shard-chip-height)] min-w-10 rounded-[var(--shard-radius-control)] bg-white/[var(--shard-alpha-55)] px-[var(--shard-space-2)] text-xs leading-none font-medium text-[color:var(--shard-tag-fg)] hover:bg-white hover:text-[color:var(--shard-tag-fg-strong)] disabled:bg-white/[var(--shard-alpha-34)] disabled:text-muted-foreground/[var(--shard-alpha-55)]"
              disabled={!activeNewTag}
              onMouseDown={(event) => {
                event.preventDefault()
                applyTag(activeNewTag)
              }}
              type="button"
              variant="ghost"
            >
              {activeTagExists ? "使用" : "新建"}
            </Button>
          </div>
        </div>
      ) : null}

      <div className="shard-edge-action-row rounded-b-[var(--shard-surface-radius)] bg-card">
        <div className="min-w-0 flex-1">
          <EditorToolbar
            disabled={isCreating}
            onImageUpload={uploadImage}
            onInlineFormat={formatInline}
            onInsertTag={insertTag}
            onLineFormat={formatLines}
            trailing={
              <Button
                className={`shard-edge-action shard-edge-action-save size-8 rounded-full bg-[color:var(--shard-sapphire)] text-white hover:bg-[color:var(--shard-sapphire-hover)] ${
                  isCreating
                    ? "disabled:bg-[color:var(--shard-sapphire)] disabled:text-white disabled:opacity-100"
                    : "disabled:bg-transparent disabled:text-muted-foreground"
                }`}
                disabled={!canSubmit}
                onClick={submit}
                size="icon-sm"
                type="button"
              >
                {isCreating ? (
                  <Loader2Icon
                    className="animate-spin"
                    data-icon="inline-start"
                  />
                ) : (
                  <SendHorizontalIcon data-icon="inline-start" />
                )}
                <span className="sr-only">
                  {isCreating ? "保存中" : "保存片段"}
                </span>
              </Button>
            }
          />
        </div>
      </div>
      {isCreating ? (
        <div className="pointer-events-none absolute top-[var(--shard-space-4)] right-[var(--shard-space-4)] flex items-center gap-[var(--shard-space-micro)] text-xs font-normal text-muted-foreground">
          <Loader2Icon className="size-3.5 animate-spin" />
          <span>保存中</span>
        </div>
      ) : null}
    </div>
  )
}

interface ActiveTag {
  hashStart: number
  query: string
}

const CAPTURE_COLLAPSED_ROWS = 2
const CAPTURE_EXPANDED_ROWS = 4
const TAG_POPOVER_WIDTH = 168
const TAG_POPOVER_MARGIN = 8
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

function resizeTextarea(
  textarea: HTMLTextAreaElement | null,
  isExpanded: boolean
) {
  if (!textarea) return

  const targetRows = isExpanded
    ? CAPTURE_EXPANDED_ROWS
    : CAPTURE_COLLAPSED_ROWS
  const minimumHeight = getTextareaRowsHeight(textarea, targetRows)
  const contentHeight = getTextareaContentHeight(textarea)
  const nextHeight = Math.max(contentHeight, minimumHeight)

  textarea.style.minHeight = `${minimumHeight}px`
  textarea.style.height = `${nextHeight}px`
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

function getScrollTop(target: EventTarget | null) {
  if (target === document) {
    return document.scrollingElement?.scrollTop ?? null
  }

  if (target instanceof Element) {
    return target.scrollTop
  }

  return null
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

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

function getActiveTag(value: string, cursor: number): ActiveTag | null {
  const beforeCursor = value.slice(0, cursor)
  const hashStart = beforeCursor.lastIndexOf("#")
  if (hashStart < 0) return null

  const previous = hashStart > 0 ? value[hashStart - 1] : ""
  if (previous && !isTagBoundary(previous)) return null

  const query = beforeCursor.slice(hashStart + 1)
  if (/\s|#/.test(query)) return null

  return { hashStart, query }
}

function getTagInputEnd(value: string, hashStart: number) {
  let end = hashStart + 1

  while (
    end < value.length &&
    !/\s/u.test(value[end]) &&
    value[end] !== "#"
  ) {
    end += 1
  }

  return end
}
