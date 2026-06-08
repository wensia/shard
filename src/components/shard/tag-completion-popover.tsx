import { Button } from "@/components/ui/button"
import { getTextareaCaretBox } from "@/lib/textarea-caret"

interface TagCompletionPopoverProps {
  exists: boolean
  label: string
  left: number
  onApply: () => void
  top: number
}

export function TagCompletionPopover({
  exists,
  label,
  left,
  onApply,
  top,
}: TagCompletionPopoverProps) {
  return (
    <div
      className="absolute z-40 w-[168px] max-w-[calc(100%-1.5rem)] rounded-[var(--shard-surface-radius)] border border-[rgb(0_0_0/var(--shard-alpha-5))] bg-card p-[var(--shard-space-1)] text-card-foreground shadow-[0_6px_14px_rgb(0_0_0/var(--shard-alpha-5))]"
      style={{ left, top }}
    >
      <div className="flex min-h-8 items-center justify-between gap-[var(--shard-space-2)] rounded-[var(--shard-radius-control)] px-[var(--shard-space-2)] text-card-foreground transition-colors hover:bg-muted/[var(--shard-alpha-55)]">
        <div className="min-w-0 flex-1 truncate text-xs leading-5 font-normal text-foreground">
          {label || "标签"}
        </div>
        <Button
          className="h-5 min-w-9 rounded-[var(--shard-radius-control)] bg-muted px-[var(--shard-space-2)] text-[11px] leading-none font-normal text-muted-foreground hover:bg-muted hover:text-foreground disabled:bg-muted/[var(--shard-alpha-55)] disabled:text-muted-foreground/[var(--shard-alpha-55)]"
          disabled={!label}
          onMouseDown={(event) => {
            event.preventDefault()
            onApply()
          }}
          type="button"
          variant="ghost"
        >
          {exists ? "使用" : "新建"}
        </Button>
      </div>
    </div>
  )
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

const TAG_COMPLETION_POPOVER_WIDTH = 168
const TAG_COMPLETION_POPOVER_MARGIN = 8

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}
