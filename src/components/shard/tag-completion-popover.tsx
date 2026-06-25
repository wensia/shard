import { useEffect, useRef } from "react"
import { HashIcon, PlusIcon } from "lucide-react"

import { getTextareaCaretBox } from "@/lib/textarea-caret"

export interface TagSuggestion {
  kind: "create" | "existing"
  tag: string
}

interface TagCompletionPopoverProps {
  activeIndex: number
  id: string
  left: number
  suggestions: TagSuggestion[]
  onHover: (index: number) => void
  onSelect: (tag: string) => void
  top: number
}

export function TagCompletionPopover({
  activeIndex,
  id,
  left,
  suggestions,
  onHover,
  onSelect,
  top,
}: TagCompletionPopoverProps) {
  const activeItemRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    activeItemRef.current?.scrollIntoView({ block: "nearest" })
  }, [activeIndex])

  return (
    <div
      aria-label="标签建议"
      className="absolute z-40 max-h-[240px] w-[200px] max-w-[calc(100%-1.5rem)] overflow-y-auto rounded-[var(--shard-surface-radius)] border border-[rgb(0_0_0/var(--shard-alpha-5))] bg-card p-[var(--shard-space-1)] text-card-foreground shadow-[0_6px_14px_rgb(0_0_0/var(--shard-alpha-5))]"
      id={id}
      role="listbox"
      style={{ left, top }}
    >
      {suggestions.length === 0 ? (
        <div className="flex min-h-8 items-center px-[var(--shard-space-2)] text-xs leading-5 font-normal text-muted-foreground">
          暂无标签
        </div>
      ) : (
        suggestions.map((item, index) => {
          const isActive = index === activeIndex
          const isCreate = item.kind === "create"

          return (
            <button
              aria-selected={isActive}
              className={[
                "flex min-h-10 w-full items-center justify-between gap-[var(--shard-space-2)] rounded-[var(--shard-radius-control)] px-[var(--shard-space-2)] text-left transition-[background-color,color,scale] duration-150 ease-out hover:bg-muted active:scale-[0.96]",
                isActive ? "bg-muted text-foreground" : "",
              ].join(" ")}
              id={getTagSuggestionOptionId(id, index)}
              key={`${item.kind}-${item.tag}`}
              onMouseDown={(event) => {
                event.preventDefault()
                onSelect(item.tag)
              }}
              onMouseEnter={() => onHover(index)}
              ref={isActive ? activeItemRef : null}
              role="option"
              type="button"
            >
              <span className="flex min-w-0 flex-1 items-center gap-[var(--shard-space-micro)] text-xs leading-5 font-normal text-foreground">
                {isCreate ? (
                  <PlusIcon className="size-3.5 shrink-0 text-muted-foreground" />
                ) : (
                  <HashIcon className="size-3.5 shrink-0 text-muted-foreground" />
                )}
                <span className="truncate">{item.tag}</span>
              </span>
              <span className="shrink-0 text-[11px] leading-none font-normal text-muted-foreground">
                {isCreate ? "新建" : "使用"}
              </span>
            </button>
          )
        })
      )}
    </div>
  )
}

export function getBoundedTagSuggestionIndex(index: number, itemCount: number) {
  if (itemCount <= 0) return 0
  return Math.min(Math.max(index, 0), itemCount - 1)
}

export function getNextTagSuggestionIndex(
  currentIndex: number,
  direction: "next" | "previous",
  itemCount: number
) {
  if (itemCount <= 0) return 0

  const offset = direction === "next" ? 1 : -1
  return (currentIndex + offset + itemCount) % itemCount
}

export function getTagSuggestionOptionId(popoverId: string, index: number) {
  return `${popoverId}-option-${index}`
}

export function getTagCompletionPopoverPosition(
  textarea: HTMLTextAreaElement,
  container: HTMLElement,
  selectionStart: number
) {
  const caret = getTextareaCaretBox(textarea, selectionStart)
  const textareaRect = textarea.getBoundingClientRect()
  const containerRect = container.getBoundingClientRect()

  const preferredLeft = textareaRect.left - containerRect.left + caret.left - 4
  const maxLeft = Math.max(
    TAG_COMPLETION_POPOVER_MARGIN,
    containerRect.width -
      TAG_COMPLETION_POPOVER_WIDTH -
      TAG_COMPLETION_POPOVER_MARGIN
  )

  return {
    left: clamp(
      preferredLeft,
      TAG_COMPLETION_POPOVER_MARGIN,
      maxLeft
    ),
    top:
      textareaRect.top -
      containerRect.top +
      caret.lineTop +
      caret.lineHeight +
      4,
  }
}

const TAG_COMPLETION_POPOVER_WIDTH = 200
const TAG_COMPLETION_POPOVER_MARGIN = 8

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}
