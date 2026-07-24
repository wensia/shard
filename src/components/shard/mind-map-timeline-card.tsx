import { useEffect, useRef, useState } from "react"
import {
  GitBranchIcon,
  Loader2Icon,
  MoreHorizontalIcon,
  PencilLineIcon,
  Share2Icon,
} from "lucide-react"

import { DropdownMenu, DropdownMenuItem } from "@astryxdesign/core/DropdownMenu"
import { HStack } from "@astryxdesign/core/HStack"
import { Stack } from "@astryxdesign/core/Stack"
import { useToast } from "@astryxdesign/core/Toast"

import { MindMapPreview } from "@/components/shard/mind-map-preview"
import { getApiErrorMessage, readMindMap } from "@/lib/api"
import type { MindMapReadResult, MindMapSummary } from "@/types"

import styles from "./mind-map-timeline-card.module.css"

interface MindMapTimelineCardProps {
  map: MindMapSummary
  onOpen?: (map: MindMapSummary) => void
}

export function MindMapTimelineCard({ map, onOpen }: MindMapTimelineCardProps) {
  const toast = useToast()
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
      toast({ body: "已复制思维导图信息" })
    } catch (unknownError) {
      toast({
        body: `分享思维导图失败：${getApiErrorMessage(unknownError)}`,
        type: "error",
      })
    }
  }

  return (
    <Stack
      as="article"
      onClick={() => onOpen?.(map)}
      ref={cardRef}
      style={{
        cursor: "pointer",
        borderRadius: "var(--shard-surface-radius)",
        background: "var(--card)",
        paddingInline: "var(--shard-card-padding-x)",
        paddingTop: "var(--shard-card-padding-y)",
        paddingBottom: "var(--shard-card-padding-bottom)",
      }}
    >
      <HStack gap={4} vAlign="start">
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
            <HStack className="shard-card-tags" gap={2} wrap="wrap">
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
            </HStack>
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
          style={{ display: "flex", flexShrink: 0, alignItems: "center" }}
        >
          <DropdownMenu
            button={{
              icon: <MoreHorizontalIcon />,
              isIconOnly: true,
              label: "思维导图操作",
              size: "sm",
              variant: "ghost",
            }}
          >
            <DropdownMenuItem
              icon={PencilLineIcon}
              label="编辑"
              onClick={() => onOpen?.(map)}
            />
            <DropdownMenuItem
              icon={Share2Icon}
              label="分享"
              onClick={() => void shareMindMap()}
            />
          </DropdownMenu>
        </div>
      </HStack>

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
    </Stack>
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
