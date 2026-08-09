import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react"
import {
  GitBranchIcon,
  Loader2Icon,
  MoreHorizontalIcon,
  PencilLineIcon,
  Share2Icon,
} from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

import { MindMapPreview } from "@/components/shard/mind-map-preview"
import { getApiErrorMessage, readMindMap } from "@/lib/api"
import type { MindMapReadResult, MindMapSummary } from "@/types"

import styles from "./mind-map-timeline-card.module.css"

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

  async function shareMindMap() {
    try {
      const clipboard = navigator.clipboard
      if (!clipboard) {
        throw new Error("当前环境不支持复制到剪贴板")
      }

      await clipboard.writeText(`${map.title}\n${map.path}`)
      toast("已复制思维导图信息", { duration: 5000 })
    } catch (unknownError) {
      toast.error(`分享思维导图失败：${getApiErrorMessage(unknownError)}`, {
        duration: Infinity,
      })
    }
  }

  return (
    <article
      aria-label={onOpen ? `打开思维导图：${map.title}` : undefined}
      onClick={() => onOpen?.(map)}
      onKeyDown={(event: KeyboardEvent<HTMLElement>) => {
        if (!onOpen || (event.key !== "Enter" && event.key !== " ")) return
        event.preventDefault()
        onOpen(map)
      }}
      ref={cardRef}
      role={onOpen ? "button" : undefined}
      style={{
        cursor: "pointer",
        borderRadius: "var(--shard-surface-radius)",
        background: "var(--card)",
        paddingInline: "var(--shard-card-padding-x)",
        paddingTop: "var(--shard-card-padding-y)",
        paddingBottom: "var(--shard-card-padding-bottom)",
      }}
      tabIndex={onOpen ? 0 : undefined}
    >
      <div
        style={{
          alignItems: "flex-start",
          display: "flex",
          gap: "var(--shard-space-4)",
        }}
      >
        <div style={{ minWidth: 0, flex: "1 1 0%" }}>
          <div
            style={{
              marginBottom: "var(--shard-space-3)",
              display: "flex",
              minWidth: 0,
              flexWrap: "wrap",
              alignItems: "center",
              columnGap: "var(--shard-space-2)",
              rowGap: "var(--shard-space-1)",
            }}
          >
            <time
              className="shard-memo-meta"
              dateTime={map.createdAt}
              style={{ color: "var(--muted-foreground)" }}
            >
              {formatCreatedTime(map.createdAt)}
            </time>
            <div
              className="shard-card-tags"
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: "var(--shard-space-2)",
              }}
            >
              <span
                className="shard-tag shard-tag-muted"
                style={{ fontWeight: 500 }}
              >
                <GitBranchIcon strokeWidth={1.75} style={{ width: 14, height: 14 }} />
                思维导图
              </span>
              <span
                className="shard-tag shard-tag-muted"
                style={{ fontWeight: 500 }}
              >
                {map.nodeCount} 节点
              </span>
            </div>
          </div>
          <h2
            style={{
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              fontSize: 16,
              lineHeight: "24px",
              fontWeight: 600,
              color: "var(--foreground)",
            }}
          >
            {map.title}
          </h2>
        </div>

        <div
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          style={{ display: "flex", flexShrink: 0, alignItems: "center" }}
        >
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  aria-label="思维导图操作"
                  size="icon-sm"
                  type="button"
                  variant="ghost"
                />
              }
            >
              <MoreHorizontalIcon aria-hidden="true" />
              <span className="sr-only">思维导图操作</span>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" style={{ width: 144 }}>
              <DropdownMenuItem
                disabled={!onOpen}
                onClick={() => {
                  if (onOpen) window.setTimeout(() => onOpen(map), 0)
                }}
              >
                <PencilLineIcon aria-hidden="true" />
                <span>编辑</span>
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => void shareMindMap()}>
                <Share2Icon aria-hidden="true" />
                <span>分享</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div style={{ marginTop: "var(--shard-space-3)" }}>
        {readResult ? (
          <MindMapPreview file={readResult.file} height={previewHeight} />
        ) : (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              borderRadius: "var(--shard-radius-control)",
              background: "var(--background)",
              fontSize: "var(--font-size-sm)",
              color: "var(--muted-foreground)",
              height: previewHeight,
            }}
          >
            {isLoading ? (
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "var(--shard-space-2)",
                }}
              >
                <Loader2Icon className={styles.spin} style={{ width: 14, height: 14 }} />
                正在渲染导图
              </span>
            ) : error ? (
              <span
                style={{
                  maxWidth: "100%",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  paddingInline: "var(--shard-space-3)",
                }}
              >
                无法读取导图预览
              </span>
            ) : (
              <span>准备渲染导图</span>
            )}
          </div>
        )}
      </div>

      {map.updatedAt !== map.createdAt ? (
        <div
          style={{
            marginTop: "var(--shard-space-2)",
            fontSize: "var(--font-size-sm)",
            color: "var(--muted-foreground)",
          }}
        >
          编辑于 {formatCreatedTime(map.updatedAt)}
        </div>
      ) : null}
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
