import { useEffect, useMemo, useRef, useState } from "react"

import {
  fitMindMapLayout,
  layoutMindMap,
  shouldUseCompactMindMapText,
  type MindMapLayoutNode,
} from "@/lib/mind-map-layout"
import type { ShardMapFile } from "@/types"

interface MindMapPreviewProps {
  className?: string
  file: ShardMapFile
  height?: number
  onNodeClick?: (nodeId: string) => void
  selectedNodeId?: string | null
}

const NODE_TEXT_BASELINE_DY = "0.28em"

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
      className={className}
      ref={containerRef}
      style={{
        background: "var(--background)",
        borderRadius: "var(--shard-radius-control)",
        height,
        minWidth: 0,
        overflow: "hidden",
      }}
    >
      <svg
        aria-label="思维导图预览"
        preserveAspectRatio="xMidYMid meet"
        role="img"
        style={{ display: "block", height: "100%", width: "100%" }}
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
              key={layoutNode.id}
              onClick={() => onNodeClick?.(layoutNode.id)}
              style={{ cursor: onNodeClick ? "pointer" : undefined }}
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
              <MindMapPreviewNodeText
                compact={compactText}
                fill={isRoot ? "var(--shard-accent-text)" : "var(--foreground)"}
                fontWeight={isRoot ? "600" : "500"}
                layoutNode={layoutNode}
              />
            </g>
          )
        })}
      </svg>
    </div>
  )
}

function MindMapPreviewNodeText({
  compact,
  fill,
  fontWeight,
  layoutNode,
}: {
  compact: boolean
  fill: string
  fontWeight: string
  layoutNode: MindMapLayoutNode
}) {
  const fontSize = compact ? 11 : 12.5
  const lineHeight = compact ? 14 : 17
  const lines = layoutNode.textLines.length > 0 ? layoutNode.textLines : ["未命名"]
  const startY =
    layoutNode.y + layoutNode.height / 2 - ((lines.length - 1) * lineHeight) / 2

  return (
    <text
      dominantBaseline="middle"
      fill={fill}
      fontSize={fontSize}
      fontWeight={fontWeight}
      letterSpacing="0"
      pointerEvents="none"
    >
      {lines.map((line, index) => (
        <tspan
          dy={NODE_TEXT_BASELINE_DY}
          key={`${line}-${index}`}
          x={layoutNode.x + 12}
          y={startY + index * lineHeight}
        >
          {line}
        </tspan>
      ))}
    </text>
  )
}
