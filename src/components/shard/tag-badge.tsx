import { XIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"

interface TagBadgeProps {
  removable?: boolean
  tag: string
  onRemove?: (tag: string) => void
}

export function TagBadge({ removable = false, tag, onRemove }: TagBadgeProps) {
  return (
    <Badge
      className="h-6 rounded-full border-0 bg-[color:var(--shard-chip-bg)] px-2.5 py-0 text-xs leading-none font-normal text-[color:var(--shard-chip-fg)] hover:bg-[color:var(--shard-chip-hover)]"
      variant="secondary"
    >
      #{tag}
      {removable ? (
        <Button
          className="-mr-1 ml-0.5 size-4 rounded-full p-0 hover:bg-[color:var(--shard-chip-hover)]"
          onClick={() => onRemove?.(tag)}
          size="icon-xs"
          type="button"
          variant="ghost"
        >
          <XIcon data-icon="inline-start" />
          <span className="sr-only">移除 {tag}</span>
        </Button>
      ) : null}
    </Badge>
  )
}
