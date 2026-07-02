import { useEffect, useMemo, useRef, useState } from "react"

import {
  fitMindMapLayout,
  layoutMindMap,
  shouldUseCompactMindMapText,
} from "@/lib/mind-map-layout"
import { cn } from "@/lib/utils"
import type { ShardMapFile } from "@/types"

interface MindMapPreviewProps {
  className?: string
  file: ShardMapFile
  height?: number
  onNodeClick?: (nodeId: string) => void
  selectedNodeId?: string | null
}

export function MindMapPreview({
  className,
  file,
  height = 180,
  onNodeClick,
  selectedNodeId = null,
}: MindMapPreviewProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ height, width: 640 })
  const layout = useMemo(() => layoutMindMap(file), [file])
  const fit = useMemo(
    () => fitMindMapLayout(layout, size.width, size.height, 16),
    [layout, size.height, size.width]
  )
  const compactText = shouldUseCompactMindMapText(layout, fit.scale)

  useEffect(() => {
    const element = containerRef.current
    if (!element) return

    const observer = new ResizeObserver(([entry]) => {
      setSize({
        height,
        width: Math.max(1, entry.contentRect.width),
      })
    })
    observer.observe(element)

    return () => observer.disconnect()
  }, [height])

  return (
    <div
      className={cn(
        "min-w-0 overflow-hidden rounded-[var(--shard-radius-control)] bg-background",
        className
      )}
      ref={containerRef}
      style={{ height }}
    >
      <svg
        aria-label="思维导图预览"
        className="block size-full"
        preserveAspectRatio="xMidYMid meet"
        role="img"
        viewBox={fit.viewBox}
      >
        <g fill="none" stroke="var(--border)" strokeWidth="1.4">
          {layout.edges.map((edge) => {
            const midX = (edge.x1 + edge.x2) / 2

            return (
              <path
                d={`M ${edge.x1} ${edge.y1} C ${midX} ${edge.y1}, ${midX} ${edge.y2}, ${edge.x2} ${edge.y2}`}
                key={edge.id}
              />
            )
          })}
        </g>

        {layout.nodes.map((layoutNode) => {
          const isRoot = layoutNode.id === file.rootId
          const selected = selectedNodeId === layoutNode.id

          return (
            <g
              className={onNodeClick ? "cursor-pointer" : undefined}
              key={layoutNode.id}
              onClick={() => onNodeClick?.(layoutNode.id)}
            >
              {selected ? (
                <rect
                  fill="none"
                  height={layoutNode.height}
                  rx="8"
                  stroke="rgb(var(--shard-primary-rgb) / var(--shard-alpha-8))"
                  strokeWidth="5"
                  width={layoutNode.width}
                  x={layoutNode.x}
                  y={layoutNode.y}
                />
              ) : null}
              <rect
                fill={
                  isRoot
                    ? "var(--shard-accent-soft)"
                    : selected
                      ? "rgb(var(--shard-primary-rgb) / var(--shard-alpha-5))"
                      : "var(--card)"
                }
                height={layoutNode.height}
                rx="6"
                stroke={
                  selected
                    ? "rgb(var(--shard-primary-rgb) / var(--shard-alpha-34))"
                    : isRoot
                      ? "rgb(var(--shard-primary-rgb) / var(--shard-alpha-34))"
                      : "var(--border)"
                }
                strokeWidth="1.2"
                width={layoutNode.width}
                x={layoutNode.x}
                y={layoutNode.y}
              />
              <text
                dominantBaseline="middle"
                dy="0.08em"
                fill={isRoot ? "var(--shard-accent-text)" : "var(--foreground)"}
                fontSize={compactText ? "11" : "12.5"}
                fontWeight={isRoot ? "600" : "500"}
                letterSpacing="0"
                pointerEvents="none"
                x={layoutNode.x + 12}
                y={layoutNode.y + layoutNode.height / 2}
              >
                {truncateNodeText(layoutNode.node.text, compactText)}
              </text>
            </g>
          )
        })}
      </svg>
    </div>
  )
}

function truncateNodeText(value: string, compact: boolean) {
  const text = value.trim() || "未命名"
  const limit = compact ? 10 : 18

  return text.length > limit ? `${text.slice(0, limit)}...` : text
}
