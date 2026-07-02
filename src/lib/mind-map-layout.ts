import { getMindMapChildren } from "@/lib/mind-map-tree"
import type { ShardMapFile, ShardMapNode } from "@/types"

export interface MindMapLayoutOptions {
  horizontalGap?: number
  nodeHeight?: number
  nodeWidth?: number
  verticalGap?: number
}

export interface MindMapLayoutNode {
  depth: number
  height: number
  id: string
  node: ShardMapNode
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
}

const DEFAULT_NODE_WIDTH = 168
const DEFAULT_NODE_HEIGHT = 42
const DEFAULT_HORIZONTAL_GAP = 70
const DEFAULT_VERTICAL_GAP = 16
const BOUNDS_MARGIN = 18

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

  const nodeWidth = options.nodeWidth ?? DEFAULT_NODE_WIDTH
  const nodeHeight = options.nodeHeight ?? DEFAULT_NODE_HEIGHT
  const horizontalGap = options.horizontalGap ?? DEFAULT_HORIZONTAL_GAP
  const verticalGap = options.verticalGap ?? DEFAULT_VERTICAL_GAP
  const nodes: MindMapLayoutNode[] = []
  const edges: MindMapLayoutEdge[] = []
  const tree = measureSubtree(root)

  function measureSubtree(node: ShardMapNode): MindMapSubtree {
    const children = node.collapsed
      ? []
      : getMindMapChildren(file, node.id).map(measureSubtree)

    return {
      children,
      height: Math.max(nodeHeight, getStackHeight(children)),
      node,
    }
  }

  function getStackHeight(children: MindMapSubtree[]) {
    if (children.length === 0) return 0

    return (
      children.reduce((sum, child) => sum + child.height, 0) +
      verticalGap * (children.length - 1)
    )
  }

  function placeSubtree(
    subtree: MindMapSubtree,
    depth: number,
    centerY: number
  ): MindMapLayoutNode {
    const node = subtree.node
    const x = depth * (nodeWidth + horizontalGap)
    const y = centerY - nodeHeight / 2

    const layoutNode: MindMapLayoutNode = {
      depth,
      height: nodeHeight,
      id: node.id,
      node,
      width: nodeWidth,
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
        x1: x + nodeWidth,
        x2: target.x,
        y1: centerY,
        y2: target.y + nodeHeight / 2,
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
