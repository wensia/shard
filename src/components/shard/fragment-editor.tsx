import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react"
import { isTauri } from "@tauri-apps/api/core"
import { XIcon } from "lucide-react"
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
  normalizeTagList,
  toggleTaskLine,
  type InlineFormat,
  type LineFormat,
  type TextEdit,
} from "@/lib/editor-format"
import { saveFragmentImage, setWindowControlsHidden } from "@/lib/api"
import { getTextareaCaretBox, type TextareaCaretBox } from "@/lib/textarea-caret"
import type { Fragment } from "@/types"

interface FragmentEditorProps {
  fragment: Fragment | null
  onClose: () => void
  onSave: (id: string, content: string, tags: string[]) => Promise<Fragment>
}

type SaveState = "dirty" | "error" | "saved" | "saving"

export function FragmentEditor({
  fragment,
  onClose,
  onSave,
}: FragmentEditorProps) {
  const [content, setContent] = useState("")
  const [customCaret, setCustomCaret] = useState<TextareaCaretBox | null>(null)
  const [editorScrollTop, setEditorScrollTop] = useState(0)
  const [isEditorFocused, setIsEditorFocused] = useState(false)
  const [saveState, setSaveState] = useState<SaveState>("saved")
  const [selectionEnd, setSelectionEnd] = useState(0)
  const [selectionStart, setSelectionStart] = useState(0)
  const isComposingRef = useRef(false)
  const lastSavedContentRef = useRef("")
  const onSaveRef = useRef(onSave)
  const saveTimerRef = useRef<number | null>(null)
  const editorFrameRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    onSaveRef.current = onSave
  }, [onSave])

  useEffect(() => {
    if (!fragment) return

    const cursor = fragment.content.length
    setContent(fragment.content)
    setSelectionEnd(cursor)
    setSelectionStart(cursor)
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
  }, [content, isEditorFocused, selectionEnd, selectionStart])

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

    if (!isCloseShortcut) return

    event.preventDefault()
    void handleClose()
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
        description: String(error),
      })
      return false
    }
  }

  function insertTag() {
    const cursor = textareaRef.current?.selectionStart ?? selectionStart
    applyTextEdit(insertTagMarker(content, cursor))
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
        description: String(error),
      })
    }
  }

  function applyTextEdit(nextEdit: TextEdit) {
    setContent(nextEdit.content)
    setSelectionEnd(nextEdit.selectionEnd)
    setSelectionStart(nextEdit.selectionStart)
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

    const caret = getTextareaCaretBox(textarea, selectionStart)
    setCustomCaret(caret)
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
              className="shard-editor-highlight-layer px-0 py-[var(--shard-space-4)]"
              style={{
                transform: `translateY(-${editorScrollTop}px)`,
              }}
            >
              <FragmentContent
                content={content}
                highlightTags
                onTaskToggle={toggleTask}
              />
            </div>
          ) : null}
          <Textarea
            className="shard-editor-field shard-editor-overlay-field relative z-10 h-full min-h-0 resize-none overflow-y-auto border-0 bg-transparent px-0 py-[var(--shard-space-4)] shadow-none focus-visible:border-transparent focus-visible:ring-0"
            onChange={(event) => {
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
              style={{
                height: customCaret.height,
                left: customCaret.left,
                top: customCaret.top,
              }}
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
