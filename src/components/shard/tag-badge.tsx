import { XIcon } from "@/components/icons"

import { Button } from "@/components/ui/button"
import { isTypeTag } from "@/lib/content-kind"

interface TagBadgeProps {
  removable?: boolean
  tag: string
  onOpen?: (tag: string) => void
  onRemove?: (tag: string) => void
}

/**
 * 这里的视觉完全由 `.shard-tag` / `.shard-tag-muted`（见
 * frontend-rules.css）驱动，不是语义状态徽标，所以不套本地 Badge——
 * Badge 自带的 variant 背景/文字色会和这里的自定义配色叠加冲突，
 * 普通展示渲染 span，可打开时让整个徽章成为 button。移除按钮使用本地 Button（ghost icon），
 * 18px 圆形小按钮属于"自定义精确尺寸"场景，用内联 style 而不是发明新的
 * frontend-rules.css 规则。
 */
export function TagBadge({ removable = false, tag, onOpen, onRemove }: TagBadgeProps) {
  if (isTypeTag(tag)) return null

  const toneClass = tag === "inbox" ? "shard-tag-muted" : ""

  if (onOpen && !removable) {
    return (
      <button
        aria-label={`打开标签主题页：${tag}`}
        className={`shard-tag ${toneClass}`}
        onClick={() => onOpen(tag)}
        type="button"
      >
        #{tag}
      </button>
    )
  }

  return (
    <span className={`shard-tag ${toneClass}`}>
      {onOpen ? (
        <button
          aria-label={`打开标签主题页：${tag}`}
          className="cursor-pointer border-0 bg-transparent p-0 text-inherit"
          onClick={() => onOpen(tag)}
          type="button"
        >
          #{tag}
        </button>
      ) : `#${tag}`}
      {removable ? (
        <Button
          aria-label={`移除 ${tag}`}
          className="shard-tag-remove [--shard-icon-stroke:var(--shard-icon-stroke-sm)]"
          onClick={(event) => {
            event.stopPropagation()
            onRemove?.(tag)
          }}
          size="icon-sm"
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
          {/* 标签内的极小控件：显式取 xs 图标档，触发基类的
              :not([class*='size-']) 守卫，不吃按钮的默认 md 图标尺寸。 */}
          <XIcon aria-hidden="true" className="size-(--shard-icon-size-xs)" />
          <span className="sr-only">移除 {tag}</span>
        </Button>
      ) : null}
    </span>
  )
}
