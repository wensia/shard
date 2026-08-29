import { useEffect, useMemo, useState, type KeyboardEvent } from "react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import {
  buildFragmentSearchIndex,
  markdownToSearchText,
  searchFragmentIndex,
  toFragmentSearchDocument,
} from "@/lib/fragment-search"
import type { Fragment } from "@/types"

const CANDIDATE_LIMIT = 20
const EXCERPT_LENGTH = 72

interface FragmentLinkDialogProps {
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  /** 发起关联的片段，要从候选里排除自己 */
  source: Fragment
  fragments: Fragment[]
  onConfirm: (targetId: string) => Promise<void> | void
}

export function FragmentLinkDialog({
  isOpen,
  onOpenChange,
  source,
  fragments,
  onConfirm,
}: FragmentLinkDialogProps) {
  const [highlightedIndex, setHighlightedIndex] = useState(0)
  const [isConfirming, setIsConfirming] = useState(false)
  const [query, setQuery] = useState("")
  const candidates = useMemo(() => {
    const relatedIds = new Set(
      (source.related ?? []).map((relation) => relation.targetId)
    )

    for (const fragment of fragments) {
      if (
        fragment.related?.some((relation) => relation.targetId === source.id)
      ) {
        relatedIds.add(fragment.id)
      }
    }

    return fragments.filter(
      (fragment) =>
        fragment.id !== source.id &&
        !fragment.archived &&
        !fragment.lockbox &&
        !relatedIds.has(fragment.id)
    )
  }, [fragments, source.id, source.related])
  const candidateById = useMemo(
    () => new Map(candidates.map((fragment) => [fragment.id, fragment])),
    [candidates]
  )
  const searchIndex = useMemo(
    () =>
      buildFragmentSearchIndex(candidates.map(toFragmentSearchDocument)),
    [candidates]
  )
  const visibleCandidates = useMemo(() => {
    if (!query.trim()) {
      return [...candidates]
        .sort((first, second) =>
          second.createdAt.localeCompare(first.createdAt)
        )
        .slice(0, CANDIDATE_LIMIT)
    }

    return searchFragmentIndex(
      searchIndex,
      query,
      "active",
      CANDIDATE_LIMIT
    ).matches.flatMap((match) => {
      const fragment = candidateById.get(match.fragmentId)
      return fragment ? [fragment] : []
    })
  }, [candidateById, candidates, query, searchIndex])

  useEffect(() => {
    if (!isOpen) return
    setHighlightedIndex(0)
    setIsConfirming(false)
    setQuery("")
  }, [isOpen, source.id])

  useEffect(() => {
    setHighlightedIndex((current) =>
      Math.min(current, Math.max(visibleCandidates.length - 1, 0))
    )
  }, [visibleCandidates.length])

  async function confirm(targetId: string) {
    if (isConfirming) return

    setIsConfirming(true)
    try {
      await onConfirm(targetId)
      onOpenChange(false)
    } catch {
      // App 层统一展示 API 错误；失败时保留对话框，方便用户重试。
    } finally {
      setIsConfirming(false)
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      event.preventDefault()
      if (!isConfirming) onOpenChange(false)
      return
    }

    if (visibleCandidates.length === 0) return

    if (event.key === "ArrowDown") {
      event.preventDefault()
      setHighlightedIndex((current) =>
        Math.min(current + 1, visibleCandidates.length - 1)
      )
      return
    }

    if (event.key === "ArrowUp") {
      event.preventDefault()
      setHighlightedIndex((current) => Math.max(current - 1, 0))
      return
    }

    if (event.key === "Enter" && !isConfirming) {
      event.preventDefault()
      void confirm(visibleCandidates[highlightedIndex].id)
    }
  }

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!isConfirming) onOpenChange(open)
      }}
    >
      <DialogContent
        aria-busy={isConfirming}
        className="h-[min(calc(var(--shard-space-8)*15),calc(100svh-var(--shard-space-8)))] gap-0 overflow-hidden p-0 sm:max-w-lg"
        showCloseButton={!isConfirming}
      >
        <DialogHeader className="border-b border-border px-4 py-3">
          <DialogTitle>关联到片段</DialogTitle>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
          <label className="sr-only" htmlFor={`fragment-link-search-${source.id}`}>
            搜索片段
          </label>
          <Input
            aria-controls={`fragment-link-options-${source.id}`}
            autoFocus
            disabled={isConfirming}
            id={`fragment-link-search-${source.id}`}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="搜索片段"
            value={query}
          />

          <div
            aria-label="可关联的片段"
            className="-mr-4 flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto pr-4 [scrollbar-gutter:stable]"
            id={`fragment-link-options-${source.id}`}
            role="listbox"
          >
            {visibleCandidates.length === 0 ? (
              <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground">
                {query.trim() ? "没有匹配的片段" : "暂无可关联的片段"}
              </div>
            ) : (
              visibleCandidates.map((fragment, index) => (
                <Button
                  aria-selected={index === highlightedIndex}
                  className="h-auto w-full justify-start gap-3 px-3 py-2 text-left font-normal whitespace-normal aria-selected:bg-muted"
                  disabled={isConfirming}
                  key={fragment.id}
                  onClick={() => void confirm(fragment.id)}
                  onMouseEnter={() => setHighlightedIndex(index)}
                  role="option"
                  type="button"
                  variant="ghost"
                >
                  <time
                    className="shrink-0 text-xs text-muted-foreground tabular-nums"
                    dateTime={fragment.createdAt}
                  >
                    {formatCreatedTime(fragment.createdAt)}
                  </time>
                  <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">
                    {toExcerpt(fragment.content)}
                  </span>
                </Button>
              ))
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function formatCreatedTime(createdAt: string) {
  return new Date(createdAt).toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  })
}

function toExcerpt(content: string) {
  const plain = markdownToSearchText(content)
  if (plain.length <= EXCERPT_LENGTH) return plain || "（空片段）"
  return `${plain.slice(0, EXCERPT_LENGTH)}…`
}
