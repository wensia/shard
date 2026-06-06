import { useRef, type UIEvent } from "react"
import { InboxIcon } from "lucide-react"

import { FragmentCard } from "@/components/shard/fragment-card"
import { ScrollArea } from "@/components/ui/scroll-area"
import type { Fragment } from "@/types"

interface FragmentTimelineProps {
  emptyMessage?: string
  fragments: Fragment[]
  isLoading: boolean
  onArchive?: (fragment: Fragment) => void
  onEdit?: (fragment: Fragment) => void
  onScrollDown?: () => void
  onToggleTask?: (fragment: Fragment, lineIndex: number) => void
}

export function FragmentTimeline({
  emptyMessage = "还没有片段。写下第一条，按 Cmd/Ctrl/Shift+Enter 保存。",
  fragments,
  isLoading,
  onArchive,
  onEdit,
  onScrollDown,
  onToggleTask,
}: FragmentTimelineProps) {
  const lastScrollTopRef = useRef(0)

  function handleViewportScroll(event: UIEvent<HTMLDivElement>) {
    const nextScrollTop = event.currentTarget.scrollTop

    if (nextScrollTop > lastScrollTopRef.current + 2) {
      onScrollDown?.()
    }

    lastScrollTopRef.current = nextScrollTop
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ScrollArea
        className="min-h-0 flex-1"
        onViewportScroll={handleViewportScroll}
      >
        {isLoading ? (
          <div className="flex h-full items-center justify-center text-sm font-medium text-muted-foreground">
            正在读取 Shard vault...
          </div>
        ) : fragments.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-muted-foreground">
            <InboxIcon className="size-8" />
            <div className="text-sm font-semibold">
              {emptyMessage}
            </div>
          </div>
        ) : (
          <div className="shard-content-inset pb-[var(--shard-space-8)]">
            <div className="shard-content-measure grid grid-cols-1 items-start gap-[var(--shard-card-gap)] 2xl:grid-cols-2">
              {fragments.map((fragment) => (
                <FragmentCard
                  fragment={fragment}
                  key={fragment.id}
                  onArchive={onArchive}
                  onEdit={onEdit}
                  onToggleTask={onToggleTask}
                />
              ))}
            </div>
          </div>
        )}
      </ScrollArea>
    </div>
  )
}
