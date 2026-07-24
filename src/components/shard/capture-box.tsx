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
} from "react"
import { Loader2Icon, SendHorizontalIcon } from "lucide-react"

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
import { Button } from "@astryxdesign/core/Button"
import { useToast } from "@astryxdesign/core/Toast"
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
  insertTagMarker,
  normalizeTag,
  normalizeTagList,
  toggleTaskLine,
  type InlineFormat,
  type LineFormat,
  type TextEdit,
} from "@/lib/editor-format"
import { getApiErrorMessage, saveFragmentImage } from "@/lib/api"
import { getEditorCaretBox, type EditorCaretBox } from "@/lib/editor-caret"
import { wantsLockbox } from "@/lib/lockbox"
import {
  buildTagSearchIndex,
  getMatchingTagsBySearchQuery,
} from "@/lib/tag-index"

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
  const toast = useToast()
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
  const containerRef = useRef<HTMLDivElement>(null)
  const editorFrameRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const tagPopoverId = useId()
  const hasSkippedInitialFocusRef = useRef(false)
  const isComposingRef = useRef(false)
  const pendingImagesRef = useRef<PendingImage[]>([])

  const activeTag = useMemo(
    () => getActiveTag(content, selectionStart),
    [content, selectionStart]
  )
  const normalizedKnownTags = useMemo(
    () => normalizeTagList(knownTags.filter((tag) => tag !== "inbox")),
    [knownTags]
  )
  const tagSearchIndex = useMemo(
    () => buildTagSearchIndex(normalizedKnownTags),
    [normalizedKnownTags]
  )
  const activeNewTag = activeTag ? normalizeTag(activeTag.query) : ""
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
  const canSubmit =
    (content.trim().length > 0 || pendingImages.length > 0) && !isCreating

  const syncTextareaGeometry = useCallback(() => {
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
  }, [isEditorExpanded])

  useEffect(() => {
    setActiveSuggestionIndex(0)
  }, [activeNewTag])

  useEffect(() => {
    pendingImagesRef.current = pendingImages
  }, [pendingImages])

  useEffect(() => {
    return () => {
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

  useLayoutEffect(() => {
    syncTextareaGeometry()
  }, [content, pendingImages.length, syncTextareaGeometry])

  useEffect(() => {
    function handleViewportResize() {
      syncTextareaGeometry()
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
  }, [syncTextareaGeometry])

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
  }, [
    content,
    editorScrollTop,
    isEditorExpanded,
    isEditorFocused,
    selectionEnd,
    selectionStart,
  ])

  useLayoutEffect(() => {
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
  }, [activeTag, content, editorScrollTop, selectionStart])

  async function submit() {
    if (isCreating) return

    const draftTags = normalizeTagList(["inbox", ...extractTags(content)])
    if (wantsLockbox(content, draftTags) && pendingImages.length > 0) {
      toast({
        body: "密匣暂不支持图片附件：请先移除图片，再保存到密匣，避免附件写入公开 assets 目录。",
        type: "error",
      })
      setIsEditorExpanded(true)
      return
    }

    try {
      const savedImages = []
      for (const image of pendingImages) {
        const path = await saveFragmentImage(image.fileName, image.bytes).catch(
          (error) => {
            toast({
              body: `图片保存失败：${getApiErrorMessage(error)}`,
              type: "error",
            })
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
        const textarea = textareaRef.current
        if (!textarea) return

        textarea.value = ""
        textarea.setSelectionRange(0, 0)
      })
    } catch {
      setIsEditorExpanded(true)
      requestAnimationFrame(() => {
        textareaRef.current?.focus()
      })
    }
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

  function insertDivider() {
    const textarea = textareaRef.current
    if (!textarea) return

    setIsEditorExpanded(true)
    applyTextEdit(
      insertHorizontalRule(
        content,
        textarea.selectionStart,
        textarea.selectionEnd
      )
    )
  }

  function openZenEditor() {
    if (!onOpenZen) return

    if (pendingImages.length > 0) {
      toast({
        body: "带图片的草稿暂不能切换到禅模式：请先保存当前片段，或移除图片后再进入禅模式。",
        type: "error",
      })
      return
    }

    const draftContent = textareaRef.current?.value ?? content
    onOpenZen(draftContent)
    setContent("")
    setIsEditorExpanded(false)
    setSelectionStart(0)
    setSelectionEnd(0)
    requestAnimationFrame(() => {
      const textarea = textareaRef.current
      if (!textarea) return

      textarea.value = ""
      textarea.setSelectionRange(0, 0)
    })
  }

  async function uploadImage(file: File) {
    const textarea = textareaRef.current
    if (!textarea) return
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
        textarea.focus()
      })
    } catch (error) {
      toast({
        body: `图片上传失败：${getApiErrorMessage(error)}`,
        type: "error",
      })
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

  function removePendingImage(id: string) {
    setPendingImages((current) => {
      const removedImage = current.find((image) => image.id === id)
      if (removedImage) {
        URL.revokeObjectURL(removedImage.previewUrl)
      }

      return current.filter((image) => image.id !== id)
    })
    requestAnimationFrame(() => {
      textareaRef.current?.focus()
    })
  }

  function syncSelection(textarea: HTMLTextAreaElement) {
    setSelectionStart(textarea.selectionStart)
    setSelectionEnd(textarea.selectionEnd)
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
            className="shard-editor-highlight-layer shard-memo-tags"
          >
            <div
              className="px-[var(--shard-composer-padding)] py-[var(--shard-composer-padding)]"
              style={{
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
          onMouseDown={showCaretImmediately}
          onPaste={handlePaste}
          onKeyUp={(event) => {
            syncSelection(event.currentTarget)
          }}
          onSelect={(event) => {
            syncSelection(event.currentTarget)
          }}
          onScroll={(event) => {
            setEditorScrollTop(event.currentTarget.scrollTop)
          }}
          onBlur={() => {
            setIsEditorFocused(false)
          }}
          placeholder="想到什么，写什么..."
          ref={textareaRef}
          value={content}
        ></textarea>
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
      </div>
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

      {pendingImages.length > 0 ? (
        <div className="shard-image-attachment-row px-[var(--shard-composer-padding)] pb-[var(--shard-space-3)]">
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

      <div className="shard-edge-action-row rounded-b-[var(--shard-surface-radius)] bg-card">
        <div className="min-w-0 flex-1">
          <EditorToolbar
            disabled={isCreating}
            onImageUpload={uploadImage}
            onInlineFormat={formatInline}
            onInsertHorizontalRule={insertDivider}
            onInsertTag={insertTag}
            onLineFormat={formatLines}
            onOpenZen={onOpenZen ? openZenEditor : undefined}
            trailing={
              <Button
                className={`shard-edge-action shard-edge-action-save rounded-full bg-[color:var(--shard-sapphire)] text-white hover:bg-[color:var(--shard-sapphire-hover)] ${
                  isCreating
                    ? "disabled:bg-[color:var(--shard-sapphire)] disabled:text-white disabled:opacity-100"
                    : "disabled:bg-transparent disabled:text-muted-foreground"
                }`}
                icon={
                  isCreating ? (
                    <Loader2Icon
                      className="animate-spin"
                      data-icon="inline-start"
                    />
                  ) : (
                    <SendHorizontalIcon data-icon="inline-start" />
                  )
                }
                isDisabled={!canSubmit}
                isIconOnly
                label={isCreating ? "保存中" : "保存片段"}
                onClick={() => void submit()}
                size="sm"
                type="button"
                variant="primary"
              />
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
  const maximumHeight = getCaptureTextareaMaxHeight(container, editorFrame)
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
  editorFrame: HTMLDivElement | null
) {
  if (!container || !editorFrame) return null

  const containerRect = container.getBoundingClientRect()
  const editorFrameRect = editorFrame.getBoundingClientRect()
  const viewportBottom = getCaptureViewportBottom(container)
  const rootStyles = window.getComputedStyle(document.documentElement)
  const bottomGap = toPixelValue(
    rootStyles.getPropertyValue("--shard-composer-bottom-gap"),
    16
  )
  const composerChromeHeight = Math.max(
    0,
    containerRect.height - editorFrameRect.height
  )

  return Math.max(
    1,
    Math.floor(
      viewportBottom - containerRect.top - bottomGap - composerChromeHeight
    )
  )
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
