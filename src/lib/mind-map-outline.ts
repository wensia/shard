import { getMindMapChildren } from "@/lib/mind-map-tree"
import type { ShardMapFile, ShardMapNode } from "@/types"

/** 碎片正文里承载大纲导图的围栏语言标识。 */
export const MIND_MAP_FENCE_LANGUAGE = "mindmap"
/** 空围栏的会话起点文本：一个空文本根节点。 */
export const EMPTY_MIND_MAP_OUTLINE_SOURCE = "- "
/** 卡片只读预览的节点上限，超出部分截断以保证渲染成本可控。 */
export const MAX_MIND_MAP_OUTLINE_NODES = 200

// 字母表与 mind-map-tree.ts 同源：compareSortKeys 逐字符比较，定宽即可保证顺序。
const SORT_ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
// 围栏文本没有时间语义，用常量保证同一段文本解析出完全相同的对象。
const OUTLINE_TIMESTAMP = "1970-01-01T00:00:00.000Z"
const OUTLINE_FILE_ID = "outline"
const LIST_ITEM_PATTERN = /^([ \t]*)(?:[-*+]|\d+[.)])[ \t]+(.*)$/

export interface MindMapOutlineResult {
  file: ShardMapFile | null
  nodeCount: number
  truncated: boolean
}

export function isMindMapFenceLanguage(language: string): boolean {
  return language.trim().toLowerCase() === MIND_MAP_FENCE_LANGUAGE
}

export function parseMindMapOutline(source: string): MindMapOutlineResult {
  const lines = source.replace(/\r\n?/g, "\n").split("\n")
  const nodes: Record<string, ShardMapNode> = {}
  const childCounts = new Map<string, number>()
  // 缩进宽度栈：栈顶始终是可能成为下一行父节点的最近祖先。
  const stack: { width: number; id: string }[] = []
  let rootId: string | null = null
  let rootText = ""
  let nodeCount = 0
  let truncated = false

  function createNode(parentId: string | null, text: string) {
    const id = `n${nodeCount}`
    const index = parentId === null ? 0 : (childCounts.get(parentId) ?? 0)
    if (parentId !== null) childCounts.set(parentId, index + 1)
    nodes[id] = {
      id,
      parentId,
      sortKey: toSortKey(index),
      text,
      createdAt: OUTLINE_TIMESTAMP,
      updatedAt: OUTLINE_TIMESTAMP,
    }
    nodeCount += 1
    return id
  }

  for (const line of lines) {
    if (!line.trim()) continue

    const match = LIST_ITEM_PATTERN.exec(line)
    if (!match) {
      // 首行非列表纯文本作根文本；其余非列表行忽略。
      if (rootId === null) {
        rootText = line.trim()
        rootId = createNode(null, rootText)
      }
      continue
    }

    if (nodeCount >= MAX_MIND_MAP_OUTLINE_NODES) {
      truncated = true
      break
    }

    const width = indentationWidth(match[1])
    const text = match[2].trim()
    if (rootId === null) {
      rootText = text
      rootId = createNode(null, text)
      stack.push({ width, id: rootId })
      continue
    }

    while (stack.length > 0 && stack[stack.length - 1].width >= width) stack.pop()
    // 栈空说明这是又一个顶层项：按协议挂到根下，而不是产生第二棵树。
    const parentId = stack[stack.length - 1]?.id ?? rootId
    stack.push({ width, id: createNode(parentId, text) })
  }

  if (rootId === null) return { file: null, nodeCount: 0, truncated: false }

  return {
    file: {
      kind: "shard.map",
      schemaVersion: 1,
      id: OUTLINE_FILE_ID,
      title: rootText,
      createdAt: OUTLINE_TIMESTAMP,
      updatedAt: OUTLINE_TIMESTAMP,
      savedWithAppVersion: "",
      revision: 0,
      rootId,
      hasProtectedLinks: false,
      nodes,
    },
    nodeCount,
    truncated,
  }
}

/**
 * 会话树写回围栏文本：2 空格一级、`-` bullet、根节点零缩进。
 * 不能用 getMindMapRows——它跳过折叠子树，折叠只是会话状态，不该丢进正文。
 */
export function serializeMindMapOutline(file: ShardMapFile): string {
  const root = file.nodes[file.rootId]
  if (!root) return ""

  const lines: string[] = []
  appendOutlineLines(file, root, 0, lines)
  return lines.join("\n")
}

/** 把大纲文本包回 ```mindmap 围栏。 */
export function buildMindMapFence(code: string): string {
  return `\`\`\`${MIND_MAP_FENCE_LANGUAGE}\n${code}\n\`\`\``
}

/** 空围栏的会话起点：单个空文本根节点，widget 里可以直接开始输入。 */
export function createEmptyMindMapOutline(): ShardMapFile {
  return parseMindMapOutline(EMPTY_MIND_MAP_OUTLINE_SOURCE).file as ShardMapFile
}

function appendOutlineLines(
  file: ShardMapFile,
  node: ShardMapNode,
  depth: number,
  lines: string[]
) {
  lines.push(`${"  ".repeat(depth)}- ${flattenOutlineText(node.text)}`)
  for (const child of getMindMapChildren(file, node.id)) {
    appendOutlineLines(file, child, depth + 1, lines)
  }
}

/** 围栏一行只能放一个节点：Alt+Enter 产生的换行与制表符折成空格。 */
function flattenOutlineText(text: string) {
  return text.replace(/\s+/gu, " ").trim()
}

/** Tab 按 4 列制表位折算：推进到下一个制表位。 */
function indentationWidth(indent: string) {
  let width = 0
  for (const char of indent) width += char === "\t" ? 4 - (width % 4) : 1
  return width
}

function toSortKey(index: number) {
  const base = SORT_ALPHABET.length
  return (
    SORT_ALPHABET[Math.floor(index / base) % base] + SORT_ALPHABET[index % base]
  )
}
