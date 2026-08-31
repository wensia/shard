export interface TaggedSummary {
  count: number
  latestAt: string
  tag: string
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
