import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react"
import { PlusIcon } from "lucide-react"

import {
  TagFilterButton,
  type TaggedSummary,
} from "@/components/shard/tagged-panel"
import styles from "./inbox-tag-bar.module.css"

interface InboxTagBarProps {
  selectedTag: string | null
  summaries: TaggedSummary[]
  totalCount: number
  onCreateTag: (tag: string) => boolean
  onSelectTag: (tag: string | null) => void
}

export function InboxTagBar({
  selectedTag,
  summaries,
  totalCount,
  onCreateTag,
  onSelectTag,
}: InboxTagBarProps) {
  const [isCreating, setIsCreating] = useState(false)
  const [draft, setDraft] = useState("")
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!isCreating) return
    inputRef.current?.focus()
  }, [isCreating])

  function closeCreator() {
    setDraft("")
    setIsCreating(false)
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (onCreateTag(draft)) {
      closeCreator()
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      event.preventDefault()
      closeCreator()
    }
  }

  return (
    <div className="shard-content-inset" style={{ paddingBottom: "var(--shard-space-3)" }}>
      <div className="shard-content-measure">
        <div
          className="shard-tag-filters"
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignContent: "flex-start",
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
          {summaries.map((summary) => (
            <TagFilterButton
              active={selectedTag === summary.tag}
              count={summary.count}
              key={summary.tag}
              label={`#${summary.tag}`}
              onClick={() => onSelectTag(summary.tag)}
            />
          ))}
          {isCreating ? (
            <form
              className="shard-tag"
              onSubmit={handleSubmit}
              style={{
                maxWidth: "100%",
                gap: "var(--shard-space-micro)",
                fontWeight: 500,
              }}
            >
              <span
                aria-hidden="true"
                className="shard-chip-text"
                style={{ color: "var(--muted-foreground)" }}
              >
                #
              </span>
              <input
                aria-label="新标签名"
                className={`shard-chip-text ${styles.tagInput}`}
                onBlur={() => {
                  if (!draft.trim()) closeCreator()
                }}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="新标签"
                ref={inputRef}
                style={{
                  width: 88,
                  minWidth: 0,
                  border: "none",
                  background: "transparent",
                  padding: 0,
                  outline: "none",
                }}
                value={draft}
              />
              <button
                className="shard-chip-text"
                style={{ flexShrink: 0, fontWeight: 500, color: "var(--primary)" }}
                type="submit"
              >
                新建
              </button>
            </form>
          ) : (
            <button
              className="shard-tag"
              onClick={() => setIsCreating(true)}
              style={{
                maxWidth: "100%",
                gap: "var(--shard-space-micro)",
                fontWeight: 500,
              }}
              title="新建标签"
              type="button"
            >
              <PlusIcon size={14} strokeWidth={1.75} style={{ flexShrink: 0 }} />
              <span
                className="shard-chip-text"
                style={{
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                新建标签
              </span>
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
