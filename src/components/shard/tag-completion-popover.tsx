import { useEffect, useRef } from "react"
import { HashIcon, PlusIcon } from "lucide-react"

import { getTextareaCaretBox } from "@/lib/textarea-caret"
import { cn } from "@/lib/utils"

import styles from "./tag-completion-popover.module.css"

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
      id={id}
      role="listbox"
      style={{
        background: "var(--card)",
        border: "1px solid rgb(0 0 0 / var(--shard-alpha-5))",
        borderRadius: "var(--shard-surface-radius)",
        boxShadow: "var(--shard-shadow-popover)",
        color: "var(--card-foreground)",
        left,
        maxHeight: 240,
        maxWidth: "calc(100% - 1.5rem)",
        overflowY: "auto",
        padding: "var(--shard-space-1)",
        position: "absolute",
        top,
        width: 200,
        zIndex: 40,
      }}
    >
      {suggestions.length === 0 ? (
        <div
          style={{
            alignItems: "center",
            color: "var(--muted-foreground)",
            display: "flex",
            fontSize: 12,
            fontWeight: 400,
            lineHeight: "20px",
            minHeight: 32,
            paddingInline: "var(--shard-space-2)",
          }}
        >
          暂无标签
        </div>
      ) : (
        suggestions.map((item, index) => {
          const isActive = index === activeIndex
          const isCreate = item.kind === "create"

          return (
            <button
              aria-selected={isActive}
              className={cn(styles.item, isActive ? styles.itemActive : null)}
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
              <span
                style={{
                  alignItems: "center",
                  color: "var(--foreground)",
                  display: "flex",
                  flex: "1 1 0%",
                  fontSize: 12,
                  fontWeight: 400,
                  gap: "var(--shard-space-micro)",
                  lineHeight: "20px",
                  minWidth: 0,
                }}
              >
                {isCreate ? (
                  <PlusIcon
                    size={14}
                    style={{ color: "var(--muted-foreground)", flexShrink: 0 }}
                  />
                ) : (
                  <HashIcon
                    size={14}
                    style={{ color: "var(--muted-foreground)", flexShrink: 0 }}
                  />
                )}
                <span
                  style={{
                    display: "block",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {item.tag}
                </span>
              </span>
              <span
                style={{
                  color: "var(--muted-foreground)",
                  flexShrink: 0,
                  fontSize: 11,
                  fontWeight: 400,
                  lineHeight: 1,
                }}
              >
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
