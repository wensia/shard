import { InboxIcon } from "lucide-react"

import { FragmentCard } from "@/components/shard/fragment-card"
import { ScrollArea } from "@/components/ui/scroll-area"
import type { Fragment, FragmentFilter } from "@/types"

interface FragmentTimelineProps {
  activeFilter: FragmentFilter
  fragments: Fragment[]
  isLoading: boolean
  totalCount: number
}

const filterLabels: Record<FragmentFilter, string> = {
  inbox: "Inbox",
  tagged: "Tagged",
  ai: "AI Suggestions",
  archive: "Archive",
}

export function FragmentTimeline({
  activeFilter,
  fragments,
  isLoading,
  totalCount,
}: FragmentTimelineProps) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between px-6 py-4">
        <div>
          <div className="text-sm font-semibold">
            {totalCount} 条片段
          </div>
          <div className="text-xs font-medium text-muted-foreground">
            {filterLabels[activeFilter]} · 按时间倒序
          </div>
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        {isLoading ? (
          <div className="flex h-full items-center justify-center text-sm font-medium text-muted-foreground">
            正在读取 Shard vault...
          </div>
        ) : fragments.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-muted-foreground">
            <InboxIcon className="size-8" />
            <div className="text-sm font-semibold">
              还没有片段。写下第一条，按 Cmd/Ctrl/Shift+Enter 保存。
            </div>
          </div>
        ) : (
          <div className="px-6 pb-8">
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              {fragments.map((fragment) => (
                <FragmentCard
                  fragment={fragment}
                  key={fragment.id}
                />
              ))}
            </div>
          </div>
        )}
      </ScrollArea>
    </div>
  )
}
