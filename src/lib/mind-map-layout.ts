import { getMindMapChildren } from "@/lib/mind-map-tree"
import type { ShardMapFile, ShardMapNode } from "@/types"

export interface MindMapLayoutOptions {
  horizontalGap?: number
  maxNodeLines?: number
  maxNodeWidth?: number
  minNodeWidth?: number
  nodeHeight?: number
  nodeHorizontalPadding?: number
  nodeLineHeight?: number
  nodeVerticalPadding?: number
  nodeWidth?: number
  rootMinNodeWidth?: number
  verticalGap?: number
}

export interface MindMapLayoutNode {
  depth: number
  height: number
  id: string
  node: ShardMapNode
  textLines: string[]
  width: number
  x: number
  y: number
}

export interface MindMapLayoutEdge {
  id: string
  sourceId: string
  targetId: string
  x1: number
  x2: number
  y1: number
  y2: number
}

export interface MindMapBounds {
  height: number
  width: number
  x: number
  y: number
}

export interface MindMapLayout {
  bounds: MindMapBounds
  edges: MindMapLayoutEdge[]
  nodes: MindMapLayoutNode[]
}

export interface MindMapFit {
  height: number
  scale: number
  viewBox: string
  width: number
  x: number
  y: number
}

interface MindMapSubtree {
  children: MindMapSubtree[]
  height: number
  node: ShardMapNode
  nodeHeight: number
  textLines: string[]
  width: number
}

const DEFAULT_NODE_WIDTH = 168
const DEFAULT_NODE_HEIGHT = 42
const DEFAULT_HORIZONTAL_GAP = 70
const DEFAULT_VERTICAL_GAP = 16
const DEFAULT_MIN_NODE_WIDTH = 96
const DEFAULT_ROOT_MIN_NODE_WIDTH = 152
const DEFAULT_NODE_HORIZONTAL_PADDING = 13
const DEFAULT_NODE_VERTICAL_PADDING = 13
const DEFAULT_NODE_LINE_HEIGHT = 18
const DEFAULT_MAX_NODE_LINES = 3
const BOUNDS_MARGIN = 18
const NODE_TEXT_MEASURE_TOLERANCE = 4

export function layoutMindMap(
  file: ShardMapFile,
  options: MindMapLayoutOptions = {}
): MindMapLayout {
  const root = file.nodes[file.rootId]
  if (!root) {
    return {
      bounds: { height: 1, width: 1, x: 0, y: 0 },
      edges: [],
      nodes: [],
    }
  }

  const maxNodeWidth =
    options.maxNodeWidth ?? options.nodeWidth ?? DEFAULT_NODE_WIDTH
  const minNodeWidth = Math.min(
    options.minNodeWidth ?? DEFAULT_MIN_NODE_WIDTH,
    maxNodeWidth
  )
  const rootMinNodeWidth = Math.min(
    options.rootMinNodeWidth ?? DEFAULT_ROOT_MIN_NODE_WIDTH,
    maxNodeWidth
  )
  const nodeHeight = options.nodeHeight ?? DEFAULT_NODE_HEIGHT
  const nodeHorizontalPadding =
    options.nodeHorizontalPadding ?? DEFAULT_NODE_HORIZONTAL_PADDING
  const nodeVerticalPadding =
    options.nodeVerticalPadding ?? DEFAULT_NODE_VERTICAL_PADDING
  const nodeLineHeight = options.nodeLineHeight ?? DEFAULT_NODE_LINE_HEIGHT
  const maxNodeLines = options.maxNodeLines ?? DEFAULT_MAX_NODE_LINES
  const horizontalGap = options.horizontalGap ?? DEFAULT_HORIZONTAL_GAP
  const verticalGap = options.verticalGap ?? DEFAULT_VERTICAL_GAP
  const nodes: MindMapLayoutNode[] = []
  const edges: MindMapLayoutEdge[] = []
  const tree = measureSubtree(root)
  const columnWidths = getColumnWidths(tree)
  const columnX = columnWidths.map((_, depth) =>
    columnWidths
      .slice(0, depth)
      .reduce((x, width) => x + width + horizontalGap, 0)
  )

  function measureSubtree(node: ShardMapNode): MindMapSubtree {
    const children = node.collapsed
      ? []
      : getMindMapChildren(file, node.id).map(measureSubtree)
    const measured = measureMindMapNode(node, {
      maxNodeLines,
      maxNodeWidth,
      minNodeWidth: node.parentId === null ? rootMinNodeWidth : minNodeWidth,
      nodeHeight,
      nodeHorizontalPadding,
      nodeLineHeight,
      nodeVerticalPadding,
    })

    return {
      children,
      height: Math.max(measured.height, getStackHeight(children)),
      node,
      nodeHeight: measured.height,
      textLines: measured.textLines,
      width: measured.width,
    }
  }

  function getStackHeight(children: MindMapSubtree[]) {
    if (children.length === 0) return 0

    return (
      children.reduce((sum, child) => sum + child.height, 0) +
      verticalGap * (children.length - 1)
    )
  }

  function getColumnWidths(subtree: MindMapSubtree) {
    const widths: number[] = []

    function visit(current: MindMapSubtree, depth: number) {
      widths[depth] = Math.max(widths[depth] ?? maxNodeWidth, current.width)
      current.children.forEach((child) => visit(child, depth + 1))
    }

    visit(subtree, 0)
    return widths
  }

  function placeSubtree(
    subtree: MindMapSubtree,
    depth: number,
    centerY: number
  ): MindMapLayoutNode {
    const node = subtree.node
    const x = columnX[depth] ?? 0
    const y = centerY - subtree.nodeHeight / 2

    const layoutNode: MindMapLayoutNode = {
      depth,
      height: subtree.nodeHeight,
      id: node.id,
      node,
      textLines: subtree.textLines,
      width: subtree.width,
      x,
      y,
    }

    nodes.push(layoutNode)

    const childrenHeight = getStackHeight(subtree.children)
    let childTop = centerY - childrenHeight / 2

    for (const child of subtree.children) {
      const childCenterY = childTop + child.height / 2
      const target = placeSubtree(child, depth + 1, childCenterY)

      edges.push({
        id: `${node.id}->${child.node.id}`,
        sourceId: node.id,
        targetId: child.node.id,
        x1: x + subtree.width,
        x2: target.x,
        y1: centerY,
        y2: target.y + target.height / 2,
      })

      childTop += child.height + verticalGap
    }

    return layoutNode
  }

  placeSubtree(tree, 0, 0)

  const minX = Math.min(...nodes.map((node) => node.x))
  const minY = Math.min(...nodes.map((node) => node.y))
  const maxX = Math.max(...nodes.map((node) => node.x + node.width))
  const maxY = Math.max(...nodes.map((node) => node.y + node.height))

  return {
    bounds: {
      height: maxY - minY + BOUNDS_MARGIN * 2,
      width: maxX - minX + BOUNDS_MARGIN * 2,
      x: minX - BOUNDS_MARGIN,
      y: minY - BOUNDS_MARGIN,
    },
    edges,
    nodes,
  }
}

export function fitMindMapLayout(
  layout: MindMapLayout,
  width: number,
  height: number,
  padding = 12
): MindMapFit {
  const availableWidth = Math.max(1, width - padding * 2)
  const availableHeight = Math.max(1, height - padding * 2)
  const scale = Math.min(
    availableWidth / Math.max(1, layout.bounds.width),
    availableHeight / Math.max(1, layout.bounds.height),
    1
  )
  const visibleWidth = Math.max(1, width / scale)
  const visibleHeight = Math.max(1, height / scale)
  const centerX = layout.bounds.x + layout.bounds.width / 2
  const centerY = layout.bounds.y + layout.bounds.height / 2
  const x = centerX - visibleWidth / 2
  const y = centerY - visibleHeight / 2

  return {
    height: visibleHeight,
    scale,
    viewBox: `${x} ${y} ${visibleWidth} ${visibleHeight}`,
    width: visibleWidth,
    x,
    y,
  }
}

export function shouldUseCompactMindMapText(layout: MindMapLayout, scale: number) {
  return scale < 0.62 || layout.nodes.length > 24
}

interface MindMapNodeMeasureOptions {
  maxNodeLines: number
  maxNodeWidth: number
  minNodeWidth: number
  nodeHeight: number
  nodeHorizontalPadding: number
  nodeLineHeight: number
  nodeVerticalPadding: number
}

const CUSTOM_WIDTH_MAX = 560
const CUSTOM_WIDTH_MAX_LINES = 24

function measureMindMapNode(
  node: ShardMapNode,
  options: MindMapNodeMeasureOptions
) {
  const text = normalizeMindMapNodeText(node.text)

  // 用户手动设置的宽度作为最小宽度保留；文字继续增加时节点仍会自动扩展，
  // 达到自定义宽度上限后再换行，避免编辑态被历史宽度锁死。
  if (typeof node.width === "number" && Number.isFinite(node.width)) {
    const configuredWidth = clamp(
      Math.round(node.width),
      options.minNodeWidth,
      CUSTOM_WIDTH_MAX
    )
    const desiredWidth = Math.ceil(
      estimateMindMapTextWidth(text) +
        options.nodeHorizontalPadding * 2 +
        NODE_TEXT_MEASURE_TOLERANCE
    )
    const width = clamp(
      Math.max(configuredWidth, desiredWidth),
      options.minNodeWidth,
      CUSTOM_WIDTH_MAX
    )
    const maxTextWidth = Math.max(
      1,
      width -
        options.nodeHorizontalPadding * 2 -
        NODE_TEXT_MEASURE_TOLERANCE
    )
    const textLines =
      desiredWidth > CUSTOM_WIDTH_MAX
        ? wrapMindMapText(text, maxTextWidth, CUSTOM_WIDTH_MAX_LINES)
        : [text]
    const height = Math.max(
      options.nodeHeight,
      options.nodeVerticalPadding * 2 +
        options.nodeLineHeight * textLines.length
    )

    return { height, textLines, width }
  }

  const maxTextWidth = Math.max(
    1,
    options.maxNodeWidth -
      options.nodeHorizontalPadding * 2 -
      NODE_TEXT_MEASURE_TOLERANCE
  )
  const desiredWidth = Math.ceil(
    estimateMindMapTextWidth(text) +
      options.nodeHorizontalPadding * 2 +
      NODE_TEXT_MEASURE_TOLERANCE
  )
  const width = clamp(
    desiredWidth,
    options.minNodeWidth,
    options.maxNodeWidth
  )
  const textLines =
    desiredWidth > options.maxNodeWidth
      ? wrapMindMapText(text, maxTextWidth, options.maxNodeLines)
      : [text]
  const height = Math.max(
    options.nodeHeight,
    options.nodeVerticalPadding * 2 +
      options.nodeLineHeight * textLines.length
  )

  return {
    height,
    textLines,
    width,
  }
}

function normalizeMindMapNodeText(value: string) {
  return value.trim().replace(/\s+/g, " ") || "未命名"
}

function wrapMindMapText(text: string, maxTextWidth: number, maxLines: number) {
  const lines: string[] = []
  let currentLine = ""

  for (const char of Array.from(text)) {
    const nextLine = currentLine + char
    if (
      currentLine &&
      estimateMindMapTextWidth(nextLine) > maxTextWidth
    ) {
      lines.push(currentLine)
      currentLine = char
    } else {
      currentLine = nextLine
    }
  }

  if (currentLine) {
    lines.push(currentLine)
  }

  if (lines.length <= maxLines) {
    return lines
  }

  const visibleLines = lines.slice(0, maxLines)
  visibleLines[maxLines - 1] = fitMindMapTextWithEllipsis(
    lines.slice(maxLines - 1).join(""),
    maxTextWidth
  )
  return visibleLines
}

function fitMindMapTextWithEllipsis(text: string, maxTextWidth: number) {
  const ellipsis = "..."
  let next = text

  while (
    next.length > 0 &&
    estimateMindMapTextWidth(next + ellipsis) > maxTextWidth
  ) {
    next = next.slice(0, -1)
  }

  return `${next}${ellipsis}`
}

function estimateMindMapTextWidth(text: string) {
  return Array.from(text).reduce((width, char) => {
    if (char === " ") return width + 4
    if (/^[\x00-\x7F]$/.test(char)) {
      return width + (/[A-Z0-9]/.test(char) ? 7.5 : 6.6)
    }

    return width + 13
  }, 0)
}

function clamp(value: number, min: number, max: number) {
  if (max < min) return min
  return Math.min(Math.max(value, min), max)
}
