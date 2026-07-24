import { LockKeyholeIcon, TagIcon } from "lucide-react"

import { HStack } from "@astryxdesign/core/HStack"
import { Stack } from "@astryxdesign/core/Stack"
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
    <div
      className="shard-content-inset"
      style={{ paddingBottom: "var(--shard-space-4)" }}
    >
      <Stack className="shard-content-measure" gap={3}>
        <HStack
          gap={2}
          style={{
            height: "var(--shard-chip-height)",
            fontSize: "0.75rem",
            fontWeight: 500,
            color: "var(--muted-foreground)",
          }}
          vAlign="center"
        >
          <TagIcon size={14} strokeWidth={1.75} style={{ flexShrink: 0 }} />
          <span style={{ fontVariantNumeric: "tabular-nums" }}>
            {summaries.length} 标签
          </span>
          <span aria-hidden="true">·</span>
          <span style={{ fontVariantNumeric: "tabular-nums" }}>
            {totalCount} 条
          </span>
        </HStack>

        <div
          className="shard-tag-filters"
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignContent: "start",
            gap: "var(--shard-space-2)",
            maxHeight: 88,
            overflowY: "auto",
            paddingRight: "var(--shard-space-1)",
          }}
        >
          <button
            aria-pressed={isLockboxActive}
            className={["shard-tag", "shard-tag-lockbox", isLockboxActive ? "shard-tag-active" : ""]
              .join(" ")
              .trim()}
            onClick={onOpenLockbox}
            style={{
              maxWidth: "100%",
              gap: "var(--shard-space-micro)",
              fontWeight: 500,
            }}
            title="密匣"
            type="button"
          >
            <LockKeyholeIcon size={14} strokeWidth={1.75} />
            <span
              className="shard-chip-text"
              style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
            >
              密匣
            </span>
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
      </Stack>
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
      className={["shard-tag", active ? "shard-tag-active" : ""].join(" ").trim()}
      onClick={onClick}
      style={{
        maxWidth: "100%",
        gap: "var(--shard-space-micro)",
        fontWeight: 500,
      }}
      title={label}
      type="button"
    >
      <span
        className="shard-chip-text"
        style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
      >
        {label}
      </span>
      <span className="shard-chip-text shard-tag-count">{count}</span>
    </button>
  )
}
