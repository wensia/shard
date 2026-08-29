import { useEffect, useRef, useState } from "react"
import {
  ChevronDownIcon,
  LinkIcon,
  Loader2Icon,
  TagIcon,
  XIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { markdownToSearchText } from "@/lib/fragment-search"
import type { RelatedFragment } from "@/lib/relations"
import type { Fragment } from "@/types"

const EXCERPT_LENGTH = 64

interface FragmentRelatedProps {
  fragment: Fragment
  isOpen: boolean
  onNavigate?: (fragmentId: string) => void
  onToggle: () => void
  onUnlinkFragment?: (
    sourceId: string,
    targetId: string
  ) => Promise<void> | void
  requestRelated?: (
    targetId: string,
    limit?: number
  ) => Promise<RelatedFragment[]>
}

export function FragmentRelated({
  fragment,
  isOpen,
  onNavigate,
  onToggle,
  onUnlinkFragment,
  requestRelated,
}: FragmentRelatedProps) {
  const [items, setItems] = useState<RelatedFragment[] | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [removingFragmentId, setRemovingFragmentId] = useState<string | null>(
    null
  )
  const mountedRef = useRef(true)

  // 已确认的边可以零成本数出来，标签共现要等展开后才算
  const linkedCount = fragment.related?.length ?? 0

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // 只在展开时请求；片段内容变化后丢弃旧结果，下次展开重新算
  useEffect(() => {
    if (!isOpen || !requestRelated) return

    let cancelled = false
    setIsLoading(true)
    void requestRelated(fragment.id)
      .then((related) => {
        if (cancelled || !mountedRef.current) return
        // score 为 0 说明只共享了全库通用标签，没有信息量
        setItems(related.filter((item) => item.score > 0))
      })
      .finally(() => {
        if (cancelled || !mountedRef.current) return
        setIsLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [fragment.id, fragment.updatedAt, isOpen, requestRelated])

  async function removeRelation(item: RelatedFragment) {
    if (!onUnlinkFragment || item.reason !== "linked") return

    const sourceId = item.linkOwnerId ?? fragment.id
    const targetId =
      sourceId === fragment.id ? item.fragment.id : fragment.id
    setRemovingFragmentId(item.fragment.id)

    try {
      await onUnlinkFragment(sourceId, targetId)
      if (!mountedRef.current) return
      setItems((current) =>
        current?.filter(
          (currentItem) => currentItem.fragment.id !== item.fragment.id
        ) ?? null
      )
    } catch {
      // App 层统一展示 API 错误；失败时保留当前关联行。
    } finally {
      if (mountedRef.current) setRemovingFragmentId(null)
    }
  }

  if (linkedCount === 0 && !isOpen) return null

  return (
    <div
      style={{
        marginTop: "var(--shard-space-3)",
        paddingTop: "var(--shard-space-2)",
        borderTop: "1px solid var(--border)",
      }}
    >
      <button
        aria-expanded={isOpen}
        className="shard-memo-meta"
        onClick={onToggle}
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--shard-space-1)",
          background: "none",
          border: "none",
          padding: 0,
          color: "var(--muted-foreground)",
          cursor: "pointer",
        }}
        type="button"
      >
        <ChevronDownIcon
          aria-hidden="true"
          size={13}
          strokeWidth={1.75}
          style={{
            transform: isOpen ? "rotate(0deg)" : "rotate(-90deg)",
            transition: "transform 120ms ease",
          }}
        />
        {linkedCount > 0 ? `${linkedCount} 条关联` : "相关片段"}
      </button>

      {isOpen ? (
        <div
          aria-busy={isLoading}
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "var(--shard-space-1)",
            marginTop: "var(--shard-space-2)",
          }}
        >
          {isLoading && items === null ? (
            <span
              className="shard-memo-meta"
              style={{
                display: "flex",
                alignItems: "center",
                gap: "var(--shard-space-1)",
                color: "var(--muted-foreground)",
              }}
            >
              <Loader2Icon
                aria-hidden="true"
                className="animate-spin"
                size={13}
                strokeWidth={1.75}
              />
              正在查找
            </span>
          ) : null}

          {items !== null && items.length === 0 && !isLoading ? (
            <span
              className="shard-memo-meta"
              style={{ color: "var(--muted-foreground)" }}
            >
              暂无相关片段
            </span>
          ) : null}

          {(items ?? []).map((item) => (
            <RelatedRow
              item={item}
              key={item.fragment.id}
              onNavigate={onNavigate}
              onRemove={onUnlinkFragment ? removeRelation : undefined}
              removing={removingFragmentId === item.fragment.id}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}

function RelatedRow({
  item,
  onNavigate,
  onRemove,
  removing,
}: {
  item: RelatedFragment
  onNavigate?: (fragmentId: string) => void
  onRemove?: (item: RelatedFragment) => void
  removing: boolean
}) {
  const isLinked = item.reason === "linked"

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--shard-space-1)",
        width: "100%",
        borderRadius: "var(--shard-radius-control)",
        marginInline: "calc(var(--shard-space-2) * -1)",
      }}
    >
      <button
        onClick={() => onNavigate?.(item.fragment.id)}
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: "var(--shard-space-2)",
          minWidth: 0,
          flex: "1 1 0%",
          background: "none",
          border: "none",
          borderRadius: "var(--shard-radius-control)",
          padding: "var(--shard-space-1) var(--shard-space-2)",
          textAlign: "left",
          cursor: "pointer",
        }}
        title={item.note}
        type="button"
      >
        <span
          aria-label={isLinked ? "已关联" : "同标签"}
          style={{
            display: "flex",
            flexShrink: 0,
            alignSelf: "center",
            color: "var(--muted-foreground)",
          }}
        >
          {isLinked ? (
            <LinkIcon aria-hidden="true" size={12} strokeWidth={1.75} />
          ) : (
            <TagIcon aria-hidden="true" size={12} strokeWidth={1.75} />
          )}
        </span>
        <span
          className="shard-memo-meta"
          style={{
            overflow: "hidden",
            flex: "1 1 0%",
            minWidth: 0,
            color: "var(--foreground)",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {toExcerpt(item.fragment.content)}
        </span>
      </button>
      {isLinked && onRemove ? (
        <Button
          aria-busy={removing}
          aria-label="移除关联"
          disabled={removing}
          onClick={(event) => {
            event.stopPropagation()
            onRemove(item)
          }}
          size="icon-sm"
          type="button"
          variant="ghost"
        >
          {removing ? (
            <Loader2Icon aria-hidden="true" className="animate-spin" />
          ) : (
            <XIcon aria-hidden="true" />
          )}
        </Button>
      ) : null}
    </div>
  )
}

function toExcerpt(content: string) {
  const plain = markdownToSearchText(content)
  if (plain.length <= EXCERPT_LENGTH) return plain || "（空片段）"

  return `${plain.slice(0, EXCERPT_LENGTH)}…`
}
