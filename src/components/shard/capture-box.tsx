import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react"
import {
  HashIcon,
  ListIcon,
  ListOrderedIcon,
  ListTodoIcon,
  Loader2Icon,
  SendHorizontalIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"

interface CaptureBoxProps {
  isCreating: boolean
  knownTags: string[]
  onCreate: (content: string, tags: string[]) => void | Promise<void>
}

export function CaptureBox({
  isCreating,
  knownTags,
  onCreate,
}: CaptureBoxProps) {
  const [content, setContent] = useState("")
  const [selectionStart, setSelectionStart] = useState(0)
  const [tagPopoverPosition, setTagPopoverPosition] = useState({
    left: 12,
    top: 44,
  })
  const containerRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const isComposingRef = useRef(false)

  const activeTag = useMemo(
    () => getActiveTag(content, selectionStart),
    [content, selectionStart]
  )
  const normalizedKnownTags = useMemo(
    () => normalizeTagList(knownTags.filter((tag) => tag !== "inbox")),
    [knownTags]
  )
  const extractedTags = useMemo(() => extractTags(content), [content])
  const activeNewTag = activeTag ? normalizeTag(activeTag.query) : ""
  const activeTagExists =
    activeNewTag.length > 0 && normalizedKnownTags.includes(activeNewTag)
  const canSubmit = content.trim().length > 0 && !isCreating

  useLayoutEffect(() => {
    if (!activeTag || !textareaRef.current || !containerRef.current) return

    const textarea = textareaRef.current
    const container = containerRef.current
    const caret = getTextareaCaretPosition(textarea, selectionStart)
    const textareaRect = textarea.getBoundingClientRect()
    const containerRect = container.getBoundingClientRect()

    const preferredLeft = textareaRect.left - containerRect.left + caret.left - 4
    const maxLeft = Math.max(
      TAG_POPOVER_MARGIN,
      containerRect.width - TAG_POPOVER_WIDTH - TAG_POPOVER_MARGIN
    )
    const nextPosition = {
      left: clamp(preferredLeft, TAG_POPOVER_MARGIN, maxLeft),
      top: textareaRect.top - containerRect.top + caret.top + caret.height + 4,
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
    setSelectionStart(0)
    void onCreate(next, normalizeTagList(["inbox", ...extractTags(next)]))
  }

  function insertTagMarker() {
    const cursor = selectionStart
    const previous = cursor > 0 ? content[cursor - 1] : ""
    const marker = previous && !isTagBoundary(previous) ? " #" : "#"
    const nextContent =
      content.slice(0, cursor) + marker + content.slice(cursor)
    const nextCursor = cursor + marker.length

    setContent(nextContent)
    setSelectionStart(nextCursor)
    requestAnimationFrame(() => {
      textareaRef.current?.focus()
      textareaRef.current?.setSelectionRange(nextCursor, nextCursor)
    })
  }

  function applyLineFormat(format: LineFormat) {
    const textarea = textareaRef.current
    if (!textarea) return

    const nextEdit = formatSelectedLines(
      content,
      textarea.selectionStart,
      textarea.selectionEnd,
      format
    )

    setContent(nextEdit.content)
    setSelectionStart(nextEdit.selectionStart)
    requestAnimationFrame(() => {
      textarea.focus()
      textarea.setSelectionRange(nextEdit.selectionStart, nextEdit.selectionEnd)
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

    if (!isSaveShortcut || isComposing) {
      return
    }

    event.preventDefault()
    submit()
  }

  function applyTag(tag: string) {
    if (!activeTag) return

    const nextTag = normalizeTag(tag)
    if (!nextTag) return

    const before = content.slice(0, activeTag.hashStart)
    const after = content.slice(selectionStart)
    const nextContent = `${before}#${nextTag} ${after}`
    const nextCursor = before.length + nextTag.length + 2

    setContent(nextContent)
    setSelectionStart(nextCursor)
    requestAnimationFrame(() => {
      textareaRef.current?.focus()
      textareaRef.current?.setSelectionRange(nextCursor, nextCursor)
    })
  }

  return (
    <div
      className="relative mx-auto w-full max-w-[620px] rounded-[var(--shard-surface-radius)] border border-border bg-card p-0 shadow-[var(--shard-composer-shadow)] transition-colors focus-within:border-[color:var(--shard-sapphire)]"
      ref={containerRef}
    >
      <Textarea
        autoFocus
        className="min-h-[124px] resize-none rounded-t-[var(--shard-surface-radius)] rounded-b-none border-0 bg-card px-4 py-4 text-sm leading-[1.8] tracking-[0.1px] text-foreground shadow-none placeholder:text-muted-foreground focus-visible:border-transparent focus-visible:ring-0 md:text-sm"
        onClick={(event) => {
          setSelectionStart(event.currentTarget.selectionStart)
        }}
        onChange={(event) => {
          setContent(event.currentTarget.value)
          setSelectionStart(event.currentTarget.selectionStart)
        }}
        onCompositionEnd={() => {
          isComposingRef.current = false
        }}
        onCompositionStart={() => {
          isComposingRef.current = true
        }}
        onKeyDown={handleKeyDown}
        onKeyUp={(event) => {
          setSelectionStart(event.currentTarget.selectionStart)
        }}
        onSelect={(event) => {
          setSelectionStart(event.currentTarget.selectionStart)
        }}
        placeholder="想到什么，写什么..."
        ref={textareaRef}
        value={content}
      />
      {activeTag ? (
        <div
          className="absolute z-10 w-[168px] max-w-[calc(100%-1.5rem)] rounded-[12px] border border-black/[0.06] bg-card p-1 text-card-foreground shadow-[0_6px_14px_rgba(0,0,0,0.05)]"
          style={{
            left: tagPopoverPosition.left,
            top: tagPopoverPosition.top,
          }}
        >
          <div className="flex h-[30px] items-center gap-1.5 rounded-[8px] bg-[color:var(--shard-chip-bg)] px-2.5">
            <div className="min-w-0 flex-1 truncate text-xs leading-none font-normal text-[color:var(--shard-sapphire)]">
              {activeNewTag || "标签"}
            </div>
            <Button
              className="h-6 min-w-10 rounded-[6px] bg-card/60 px-2 text-xs leading-none font-normal text-muted-foreground hover:bg-card hover:text-foreground disabled:bg-card/50 disabled:text-muted-foreground/60"
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

      <div className="shard-edge-action-row flex items-center justify-between gap-3 rounded-b-[var(--shard-surface-radius)] bg-card">
        <div className="flex min-w-0 items-center gap-1">
          <Button
            className="shard-edge-action size-7 rounded-md text-muted-foreground"
            onMouseDown={(event) => {
              event.preventDefault()
              insertTagMarker()
            }}
            size="icon-sm"
            title="插入标签"
            type="button"
            variant="ghost"
          >
            <HashIcon data-icon="inline-start" />
            <span className="sr-only">插入标签</span>
          </Button>
          <Button
            className="shard-edge-action size-7 rounded-md text-muted-foreground"
            onMouseDown={(event) => {
              event.preventDefault()
              applyLineFormat("unordered")
            }}
            size="icon-sm"
            title="无序列表"
            type="button"
            variant="ghost"
          >
            <ListIcon data-icon="inline-start" />
            <span className="sr-only">无序列表</span>
          </Button>
          <Button
            className="shard-edge-action size-7 rounded-md text-muted-foreground"
            onMouseDown={(event) => {
              event.preventDefault()
              applyLineFormat("ordered")
            }}
            size="icon-sm"
            title="有序列表"
            type="button"
            variant="ghost"
          >
            <ListOrderedIcon data-icon="inline-start" />
            <span className="sr-only">有序列表</span>
          </Button>
          <Button
            className="shard-edge-action size-7 rounded-md text-muted-foreground"
            onMouseDown={(event) => {
              event.preventDefault()
              applyLineFormat("task")
            }}
            size="icon-sm"
            title="任务复选列表"
            type="button"
            variant="ghost"
          >
            <ListTodoIcon data-icon="inline-start" />
            <span className="sr-only">任务复选列表</span>
          </Button>
          {extractedTags.length > 0 ? (
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              {extractedTags.map((tag) => (
                <span
                  className="inline-flex h-6 items-center rounded-full bg-[color:var(--shard-chip-bg)] px-2.5 text-xs leading-none font-normal text-[color:var(--shard-chip-fg)]"
                  key={tag}
                >
                  #{tag}
                </span>
              ))}
            </div>
          ) : (
            null
          )}
        </div>

        <div className="flex shrink-0 items-center">
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
              <Loader2Icon className="animate-spin" data-icon="inline-start" />
            ) : (
              <SendHorizontalIcon data-icon="inline-start" />
            )}
            <span className="sr-only">
              {isCreating ? "保存中" : "保存片段"}
            </span>
          </Button>
        </div>
      </div>
      {isCreating ? (
        <div className="pointer-events-none absolute top-4 right-4 flex items-center gap-1.5 text-xs font-normal text-muted-foreground">
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

type LineFormat = "ordered" | "task" | "unordered"

const TAG_POPOVER_WIDTH = 168
const TAG_POPOVER_MARGIN = 8
const TAG_PATTERN = /(^|[\s([{<"'“‘，。！？；：、,.!?;:])#([^\s#]+)/g
const TRAILING_TAG_PUNCTUATION = /[),.?!;:，。！？；：、\]}>"'”’]+$/g
const LIST_MARKER_PATTERN =
  /^(\s*)(?:[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+)/
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

interface CaretPosition {
  left: number
  top: number
  height: number
}

function getTextareaCaretPosition(
  textarea: HTMLTextAreaElement,
  selectionStart: number
): CaretPosition {
  const styles = window.getComputedStyle(textarea)
  const mirror = document.createElement("div")
  const marker = document.createElement("span")

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

  mirror.textContent = textarea.value.slice(0, selectionStart)
  marker.textContent = "\u200b"
  mirror.appendChild(marker)
  document.body.appendChild(mirror)

  const fontSize = toPixelValue(styles.fontSize, 14)
  const lineHeight = toPixelValue(styles.lineHeight, fontSize * 1.8)
  const borderLeft = toPixelValue(styles.borderLeftWidth, 0)
  const borderTop = toPixelValue(styles.borderTopWidth, 0)
  const position = {
    left: marker.offsetLeft + borderLeft - textarea.scrollLeft,
    top: marker.offsetTop + borderTop - textarea.scrollTop,
    height: lineHeight,
  }

  mirror.remove()
  return position
}

function toPixelValue(value: string, fallback: number) {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

interface TextEdit {
  content: string
  selectionEnd: number
  selectionStart: number
}

function formatSelectedLines(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  format: LineFormat
): TextEdit {
  const lineStart =
    selectionStart === 0 ? 0 : value.lastIndexOf("\n", selectionStart - 1) + 1
  const selectedThroughLineBreak =
    selectionEnd > selectionStart && value[selectionEnd - 1] === "\n"
  const effectiveSelectionEnd = selectedThroughLineBreak
    ? selectionEnd - 1
    : selectionEnd
  const nextLineBreak = value.indexOf("\n", effectiveSelectionEnd)
  const lineEnd = nextLineBreak === -1 ? value.length : nextLineBreak
  const selectedBlock = value.slice(lineStart, lineEnd)
  const formattedBlock = selectedBlock
    .split("\n")
    .map((line, index) => formatLine(line, format, index))
    .join("\n")

  const nextContent =
    value.slice(0, lineStart) + formattedBlock + value.slice(lineEnd)

  if (selectionStart === selectionEnd) {
    const nextCursor =
      selectionStart + formattedBlock.length - selectedBlock.length

    return {
      content: nextContent,
      selectionEnd: nextCursor,
      selectionStart: nextCursor,
    }
  }

  return {
    content: nextContent,
    selectionEnd: lineStart + formattedBlock.length,
    selectionStart: lineStart,
  }
}

function formatLine(line: string, format: LineFormat, index: number) {
  const indentation = line.match(/^\s*/)?.[0] ?? ""
  const contentWithoutMarker = line.replace(
    LIST_MARKER_PATTERN,
    (_, currentIndentation: string) => currentIndentation
  )
  const body = contentWithoutMarker.slice(indentation.length)

  return `${indentation}${getLinePrefix(format, index)}${body}`
}

function getLinePrefix(format: LineFormat, index: number) {
  switch (format) {
    case "ordered":
      return `${index + 1}. `
    case "task":
      return "- [ ] "
    case "unordered":
    default:
      return "- "
  }
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

function extractTags(value: string) {
  return normalizeTagList(
    Array.from(value.matchAll(TAG_PATTERN), (match) => match[2])
  )
}

function normalizeTagList(tags: string[]) {
  const seen = new Set<string>()
  const normalizedTags: string[] = []

  for (const tag of tags) {
    const normalized = normalizeTag(tag)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    normalizedTags.push(normalized)
  }

  return normalizedTags
}

function normalizeTag(tag: string) {
  return tag
    .trim()
    .replace(/^#+/, "")
    .replace(TRAILING_TAG_PUNCTUATION, "")
    .replace(/\s+/g, "-")
}

function isTagBoundary(char: string) {
  return /[\s([{<"'“‘，。！？；：、,.!?;:]/.test(char)
}
