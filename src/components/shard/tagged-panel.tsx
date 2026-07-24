import { LockKeyholeIcon, TagIcon } from "lucide-react"
import type { LockboxState } from "@/types"

export interface TaggedSummary {
  count: number
  latestAt: string
  tag: string
}

interface TaggedPanelProps {
  isLockboxActive?: boolean
  lockbox: LockboxState | null
  selectedTag: string | null
  summaries: TaggedSummary[]
  totalCount: number
  onOpenLockbox: () => void
  onSelectTag: (tag: string | null) => void
}

export function TaggedPanel({
  isLockboxActive = false,
  lockbox,
  selectedTag,
  summaries,
  totalCount,
  onOpenLockbox,
  onSelectTag,
}: TaggedPanelProps) {
  return (
    <div className="shard-content-inset pb-[var(--shard-space-4)]">
      <div className="shard-content-measure flex flex-col gap-[var(--shard-space-3)]">
        <div className="flex h-[var(--shard-chip-height)] items-center gap-[var(--shard-space-2)] text-xs font-medium text-muted-foreground">
          <TagIcon className="size-3.5 shrink-0 stroke-[1.75]" />
          <span className="tabular-nums">{summaries.length} 标签</span>
          <span aria-hidden="true">·</span>
          <span className="tabular-nums">{totalCount} 条</span>
        </div>

        <div className="shard-tag-filters flex max-h-[88px] flex-wrap content-start gap-[var(--shard-space-2)] overflow-y-auto pr-[var(--shard-space-1)]">
          <button
            aria-pressed={isLockboxActive}
            className={[
              "shard-tag shard-tag-lockbox max-w-full gap-[var(--shard-space-micro)] font-medium",
              isLockboxActive ? "shard-tag-active" : "",
            ].join(" ")}
            onClick={onOpenLockbox}
            title="密匣"
            type="button"
          >
            <LockKeyholeIcon className="size-3.5 stroke-[1.75]" />
            <span className="shard-chip-text truncate">密匣</span>
            <span className="shard-chip-text shard-tag-count">
              {lockbox?.unlocked ? "已解锁" : lockbox?.configured ? "已上锁" : "设置"}
            </span>
          </button>
          <TagFilterButton
            active={selectedTag === null}
            count={totalCount}
            label="全部"
            onClick={() => onSelectTag(null)}
          />
          {summaries.map((summary) => (
            <TagFilterButton
              active={selectedTag === summary.tag}
              count={summary.count}
              key={summary.tag}
              label={`#${summary.tag}`}
              onClick={() => onSelectTag(summary.tag)}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

interface TagFilterButtonProps {
  active: boolean
  count: number
  label: string
  onClick: () => void
}

export function TagFilterButton({
  active,
  count,
  label,
  onClick,
}: TagFilterButtonProps) {
  return (
    <button
      aria-pressed={active}
      className={[
        "shard-tag max-w-full gap-[var(--shard-space-micro)] font-medium",
        active
          ? "shard-tag-active"
          : "",
      ].join(" ")}
      onClick={onClick}
      title={label}
      type="button"
    >
      <span className="shard-chip-text truncate">{label}</span>
      <span
        className="shard-chip-text shard-tag-count"
      >
        {count}
      </span>
    </button>
  )
}
