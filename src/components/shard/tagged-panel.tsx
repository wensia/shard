import { TagIcon } from "lucide-react"

import { isTypeTag } from "@/lib/content-kind"

export interface TaggedSummary {
  count: number
  latestAt: string
  tag: string
}

interface TaggedPanelProps {
  selectedTag: string | null
  summaries: TaggedSummary[]
  totalCount: number
  onSelectTag: (tag: string | null) => void
}

export function TaggedPanel({
  selectedTag,
  summaries,
  totalCount,
  onSelectTag,
}: TaggedPanelProps) {
  const visibleSummaries = summaries.filter(
    (summary) => !isTypeTag(summary.tag)
  )

  return (
    <div
      className="shard-content-inset"
      data-tauri-drag-region
      style={{
        paddingBottom: "var(--shard-space-4)",
        paddingTop: "var(--shard-top-inset)",
      }}
    >
      <div
        className="shard-content-measure"
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "var(--shard-space-3)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--shard-space-2)",
            height: "var(--shard-chip-height)",
            fontSize: "0.75rem",
            fontWeight: 500,
            color: "var(--muted-foreground)",
          }}
        >
          <TagIcon size={14} strokeWidth={1.75} style={{ flexShrink: 0 }} />
          <span style={{ fontVariantNumeric: "tabular-nums" }}>
            {visibleSummaries.length} 标签
          </span>
          <span aria-hidden="true">·</span>
          <span style={{ fontVariantNumeric: "tabular-nums" }}>
            {totalCount} 条
          </span>
        </div>

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
          <TagFilterButton
            active={selectedTag === null}
            count={totalCount}
            label="全部"
            onClick={() => onSelectTag(null)}
          />
          {visibleSummaries.map((summary) => (
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
