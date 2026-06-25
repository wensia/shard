import { useEffect, useMemo, useRef, useState, type UIEvent } from "react"
import { InboxIcon } from "lucide-react"

import { FragmentCard } from "@/components/shard/fragment-card"
import { ScrollArea } from "@/components/ui/scroll-area"
import type { Fragment } from "@/types"

const WIDE_TIMELINE_QUERY = "(min-width: 96rem)"

interface FragmentTimelineProps {
  editingFragmentId?: string | null
  emptyMessage?: string
  fragments: Fragment[]
  isLoading: boolean
  knownTags?: string[]
  onArchive?: (fragment: Fragment) => void
  onCancelEdit?: () => void
  onEdit?: (fragment: Fragment) => void
  onExportImage?: (fragment: Fragment) => void
  onMoveToLockbox?: (fragment: Fragment) => void
  onOpenZen?: (fragment: Fragment) => void
  onPin?: (fragment: Fragment) => void
  onScrollDown?: () => void
  onSave?: (id: string, content: string, tags: string[]) => Promise<Fragment>
  onToggleTask?: (fragment: Fragment, lineIndex: number) => void
  vaultPath?: string
}

export function FragmentTimeline({
  editingFragmentId = null,
  emptyMessage = "还没有片段。写下第一条，按 Cmd/Ctrl+Enter 保存。",
  fragments,
  isLoading,
  knownTags = [],
  onArchive,
  onCancelEdit,
  onEdit,
  onExportImage,
  onMoveToLockbox,
  onOpenZen,
  onPin,
  onScrollDown,
  onSave,
  onToggleTask,
  vaultPath,
}: FragmentTimelineProps) {
  const lastScrollTopRef = useRef(0)
  const [usesWaterfallColumns, setUsesWaterfallColumns] = useState(() =>
    typeof window === "undefined"
      ? false
      : window.matchMedia(WIDE_TIMELINE_QUERY).matches
  )
  const fragmentColumns = useMemo(
    () => splitIntoColumns(fragments, usesWaterfallColumns ? 2 : 1),
    [fragments, usesWaterfallColumns]
  )

  useEffect(() => {
    const mediaQuery = window.matchMedia(WIDE_TIMELINE_QUERY)

    function handleTimelineWidthChange() {
      setUsesWaterfallColumns(mediaQuery.matches)
    }

    handleTimelineWidthChange()
    mediaQuery.addEventListener("change", handleTimelineWidthChange)

    return () => {
      mediaQuery.removeEventListener("change", handleTimelineWidthChange)
    }
  }, [])

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
              {fragmentColumns.map((column, columnIndex) => (
                <div
                  className="flex min-w-0 flex-col gap-[var(--shard-card-gap)]"
                  key={columnIndex}
                >
                  {column.map((fragment) => (
                    <FragmentCard
                      fragment={fragment}
                      isEditing={editingFragmentId === fragment.id}
                      key={fragment.id}
                      knownTags={knownTags}
                      onArchive={onArchive}
                      onCancelEdit={onCancelEdit}
                      onEdit={onEdit}
                      onExportImage={onExportImage}
                      onMoveToLockbox={onMoveToLockbox}
                      onOpenZen={onOpenZen}
                      onPin={onPin}
                      onSave={onSave}
                      onToggleTask={onToggleTask}
                      vaultPath={vaultPath}
                    />
                  ))}
                </div>
              ))}
            </div>
          </div>
        )}
      </ScrollArea>
    </div>
  )
}

function splitIntoColumns(fragments: Fragment[], columnCount: number) {
  const columns = Array.from({ length: columnCount }, () => [] as Fragment[])

  fragments.forEach((fragment, index) => {
    columns[index % columnCount].push(fragment)
  })

  return columns
}
