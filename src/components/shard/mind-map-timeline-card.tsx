import { useEffect, useRef, useState } from "react"
import { GitBranchIcon, Loader2Icon, PencilLineIcon } from "lucide-react"

import { MindMapPreview } from "@/components/shard/mind-map-preview"
import { Button } from "@/components/ui/button"
import { getApiErrorMessage, readMindMap } from "@/lib/api"
import type { MindMapReadResult, MindMapSummary } from "@/types"

interface MindMapTimelineCardProps {
  map: MindMapSummary
  onOpen?: (map: MindMapSummary) => void
}

export function MindMapTimelineCard({ map, onOpen }: MindMapTimelineCardProps) {
  const cardRef = useRef<HTMLElement | null>(null)
  const [readResult, setReadResult] = useState<MindMapReadResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const hasRequestedRef = useRef(false)
  const previewHeight = map.nodeCount > 24 ? 240 : map.nodeCount > 8 ? 210 : 180

  useEffect(() => {
    const element = cardRef.current
    if (!element) return

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting || hasRequestedRef.current) return
        hasRequestedRef.current = true
        setIsLoading(true)
        void readMindMap(map.id)
          .then((result) => {
            setReadResult(result)
            setError(null)
          })
          .catch((unknownError) => {
            setError(getApiErrorMessage(unknownError))
          })
          .finally(() => setIsLoading(false))
      },
      { rootMargin: "240px" }
    )

    observer.observe(element)
    return () => observer.disconnect()
  }, [map.id])

  return (
    <article
      className="group flex cursor-pointer flex-col rounded-[var(--shard-surface-radius)] bg-card px-[var(--shard-card-padding-x)] pt-[var(--shard-card-padding-y)] pb-[var(--shard-card-padding-bottom)]"
      onClick={() => onOpen?.(map)}
      ref={cardRef}
    >
      <div className="flex items-start gap-[var(--shard-card-gap)]">
        <div className="min-w-0 flex-1">
          <time
            className="shard-memo-meta mb-[var(--shard-space-2)] block text-muted-foreground"
            dateTime={map.createdAt}
          >
            {formatCreatedTime(map.createdAt)}
          </time>
          <div className="mb-[var(--shard-space-3)] flex flex-wrap gap-[var(--shard-space-2)]">
            <span className="shard-tag shard-tag-muted border-0 py-0 font-medium shadow-none">
              <GitBranchIcon className="size-3.5 stroke-[1.75]" />
              思维导图
            </span>
            <span className="shard-tag shard-tag-muted border-0 py-0 font-medium shadow-none">
              {map.nodeCount} 节点
            </span>
          </div>
          <h2 className="truncate text-base leading-6 font-semibold text-foreground">
            {map.title}
          </h2>
        </div>

        <Button
          aria-label="打开思维导图"
          onClick={(event) => {
            event.stopPropagation()
            onOpen?.(map)
          }}
          size="icon-sm"
          type="button"
          variant="ghost"
        >
          <PencilLineIcon className="size-4 stroke-[1.65]" />
        </Button>
      </div>

      <div className="mt-[var(--shard-space-3)]">
        {readResult ? (
          <MindMapPreview file={readResult.file} height={previewHeight} />
        ) : (
          <div
            className="flex items-center justify-center rounded-[var(--shard-radius-control)] bg-background text-xs text-muted-foreground"
            style={{ height: previewHeight }}
          >
            {isLoading ? (
              <span className="inline-flex items-center gap-[var(--shard-space-2)]">
                <Loader2Icon className="size-3.5 animate-spin" />
                正在渲染导图
              </span>
            ) : error ? (
              <span className="max-w-full truncate px-[var(--shard-space-3)]">
                无法读取导图预览
              </span>
            ) : (
              <span>准备渲染导图</span>
            )}
          </div>
        )}
      </div>

      <div className="mt-[var(--shard-space-2)] flex min-w-0 flex-wrap items-center gap-x-[var(--shard-space-2)] gap-y-1 text-xs text-muted-foreground">
        <span className="truncate">{map.path}</span>
        {map.updatedAt !== map.createdAt ? (
          <>
            <span aria-hidden="true">·</span>
            <span>编辑于 {formatCreatedTime(map.updatedAt)}</span>
          </>
        ) : null}
      </div>
    </article>
  )
}

function formatCreatedTime(value: string) {
  return new Date(value).toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  })
}
