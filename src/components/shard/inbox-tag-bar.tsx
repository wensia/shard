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
    <div className="shard-content-inset pb-[var(--shard-space-3)]">
      <div className="shard-content-measure">
        <div className="shard-tag-filters flex max-h-[88px] flex-wrap content-start gap-[var(--shard-space-2)] overflow-y-auto pr-[var(--shard-space-1)]">
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
              className="shard-tag max-w-full gap-[var(--shard-space-micro)] font-medium"
              onSubmit={handleSubmit}
            >
              <span aria-hidden="true" className="shard-chip-text text-muted-foreground">
                #
              </span>
              <input
                aria-label="新标签名"
                className="shard-chip-text w-[88px] min-w-0 border-none bg-transparent p-0 outline-none placeholder:text-muted-foreground"
                onBlur={() => {
                  if (!draft.trim()) closeCreator()
                }}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="新标签"
                ref={inputRef}
                value={draft}
              />
              <button
                className="shard-chip-text shrink-0 font-medium text-primary"
                type="submit"
              >
                新建
              </button>
            </form>
          ) : (
            <button
              className="shard-tag max-w-full gap-[var(--shard-space-micro)] font-medium"
              onClick={() => setIsCreating(true)}
              title="新建标签"
              type="button"
            >
              <PlusIcon className="size-3.5 shrink-0 stroke-[1.75]" />
              <span className="shard-chip-text truncate">新建标签</span>
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
