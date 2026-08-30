import { XIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { isTypeTag } from "@/lib/content-kind"

interface TagBadgeProps {
  removable?: boolean
  tag: string
  onRemove?: (tag: string) => void
}

/**
 * 这里的视觉完全由 `.shard-tag` / `.shard-tag-muted`（见
 * frontend-rules.css）驱动，不是语义状态徽标，所以不套本地 Badge——
 * Badge 自带的 variant 背景/文字色会和这里的自定义配色叠加冲突，
 * 直接渲染 span 更干净。移除按钮使用本地 Button（ghost icon），
 * 18px 圆形小按钮属于"自定义精确尺寸"场景，用内联 style 而不是发明新的
 * frontend-rules.css 规则。
 */
export function TagBadge({ removable = false, tag, onRemove }: TagBadgeProps) {
  if (isTypeTag(tag)) return null

  const toneClass = tag === "inbox" ? "shard-tag-muted" : ""

  return (
    <span className={`shard-tag ${toneClass}`}>
      #{tag}
      {removable ? (
        <Button
          aria-label={`移除 ${tag}`}
          className="shard-tag-remove"
          onClick={() => onRemove?.(tag)}
          size="icon-xs"
          style={{
            borderRadius: "9999px",
            color: "currentColor",
            height: 18,
            marginLeft: "var(--shard-space-micro)",
            marginRight: "-3px",
            padding: 0,
            width: 18,
          }}
          variant="ghost"
        >
          <XIcon aria-hidden="true" />
          <span className="sr-only">移除 {tag}</span>
        </Button>
      ) : null}
    </span>
  )
}
