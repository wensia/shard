import { XIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"

interface TagBadgeProps {
  removable?: boolean
  tag: string
  onRemove?: (tag: string) => void
}

export function TagBadge({ removable = false, tag, onRemove }: TagBadgeProps) {
  const toneClass = tag === "inbox" ? "shard-tag-muted" : ""

  return (
    <Badge
      className={`shard-tag ${toneClass} border-0 py-0 font-medium shadow-none`}
      variant="secondary"
    >
      #{tag}
      {removable ? (
        <Button
          className="shard-tag-remove -mr-[3px] ml-[var(--shard-space-micro)] size-[18px] rounded-full p-0 text-current hover:text-current"
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
