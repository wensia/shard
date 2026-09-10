import type { ShardMapFile, ShardMapNode } from "@/types"

// updateDraft 的操作元数据：文本编辑传 mergeKey（如 text:{nodeId}），
// 连续击键合并为一条历史；结构操作不传，每次独立入栈。
export interface MindMapChangeMeta {
  mergeKey?: string
}

const SORT_ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
const FIRST_SORT_CHAR = SORT_ALPHABET[0]
const NODE_ID_PREFIX = "node"

export interface MindMapOutlineRow {
  node: ShardMapNode
  depth: number
}

export type MindMapDropMode = "before" | "after" | "inside"

export interface MindMapDropTarget {
  mode: MindMapDropMode
  nodeId: string
}

export function cloneMindMapFile(file: ShardMapFile): ShardMapFile {
  return structuredClone(file)
}

export function getMindMapRows(file: ShardMapFile): MindMapOutlineRow[] {
  const root = file.nodes[file.rootId]
  if (!root) return []

  const rows: MindMapOutlineRow[] = [{ node: root, depth: 0 }]
  appendChildRows(file, root.id, 1, rows)
  return rows
}

export function getMindMapChildren(
  file: ShardMapFile,
  parentId: string
): ShardMapNode[] {
  return Object.values(file.nodes)
    .filter((node) => node.parentId === parentId)
    .sort(compareMindMapNodes)
}

export function updateMindMapTitle(
  file: ShardMapFile,
  title: string
): ShardMapFile {
  const next = cloneMindMapFile(file)
  next.title = title
  const root = next.nodes[next.rootId]
  if (root) {
    root.text = title
    root.updatedAt = new Date().toISOString()
  }
  return touchFile(next)
}

export function updateMindMapNodeText(
  file: ShardMapFile,
  nodeId: string,
  text: string
): ShardMapFile {
  const next = cloneMindMapFile(file)
  const node = next.nodes[nodeId]
  if (!node) return file

  node.text = text
  node.updatedAt = new Date().toISOString()
  if (node.id === next.rootId) {
    next.title = text.trim() || "未命名思维导图"
  }
  return touchFile(next)
}

export function updateMindMapNodeNote(
  file: ShardMapFile,
  nodeId: string,
  note: string
): ShardMapFile {
  const node = file.nodes[nodeId]
  if (!node || node.note === note) return file

  const next = cloneMindMapFile(file)
  next.nodes[nodeId].note = note
  next.nodes[nodeId].updatedAt = new Date().toISOString()
  return touchFile(next)
}

export function addMindMapChild(
  file: ShardMapFile,
  parentId: string
): { file: ShardMapFile; nodeId: string } {
  const next = cloneMindMapFile(file)
  const siblings = getMindMapChildren(next, parentId)
  const sortKey = getSortKeyBetween(
    siblings[siblings.length - 1]?.sortKey ?? null,
    null
  )
  const node = createMindMapNode(parentId, sortKey)
  next.nodes[node.id] = node
  return { file: touchFile(next), nodeId: node.id }
}

export function addMindMapSibling(
  file: ShardMapFile,
  nodeId: string,
  placement: "before" | "after" = "after"
): { file: ShardMapFile; nodeId: string } {
  const node = file.nodes[nodeId]
  if (!node || node.parentId === null) {
    return addMindMapChild(file, file.rootId)
  }

  const next = cloneMindMapFile(file)
  const siblings = getMindMapChildren(next, node.parentId)
  const index = siblings.findIndex((sibling) => sibling.id === nodeId)
  const insertionIndex = placement === "before" ? index : index + 1
  const previous = siblings[insertionIndex - 1]?.sortKey ?? null
  const nextSibling = siblings[insertionIndex]?.sortKey ?? null
  const newNode = createMindMapNode(
    node.parentId,
    getSortKeyBetween(previous, nextSibling)
  )
  next.nodes[newNode.id] = newNode
  // Imported keys can leave no lexical gap (for example before "0").
  // Re-key this sibling list only when the requested insertion cannot fit.
  if (
    placement === "before" &&
    nextSibling !== null &&
    compareSortKeys(newNode.sortKey, nextSibling) >= 0
  ) {
    siblings.splice(insertionIndex, 0, newNode)
    let previousSortKey: string | null = null
    for (const sibling of siblings) {
      sibling.sortKey = getSortKeyBetween(previousSortKey, null)
      sibling.updatedAt = newNode.updatedAt
      previousSortKey = sibling.sortKey
    }
  }
  return { file: touchFile(next), nodeId: newNode.id }
}

export function addMindMapParent(
  file: ShardMapFile,
  nodeId: string
): { file: ShardMapFile; nodeId: string } {
  const node = file.nodes[nodeId]
  if (!node || node.id === file.rootId || node.parentId === null) {
    return { file, nodeId: file.rootId }
  }

  const next = cloneMindMapFile(file)
  const parent = createMindMapNode(node.parentId, node.sortKey)
  const target = next.nodes[nodeId]
  target.parentId = parent.id
  target.sortKey = getSortKeyBetween(null, null)
  target.updatedAt = parent.updatedAt
  next.nodes[parent.id] = parent
  return { file: touchFile(next), nodeId: parent.id }
}

export function deleteMindMapNode(
  file: ShardMapFile,
  nodeId: string
): { file: ShardMapFile; focusNodeId: string } {
  const node = file.nodes[nodeId]
  if (!node || node.id === file.rootId) {
    return { file, focusNodeId: file.rootId }
  }

  const siblings = node.parentId ? getMindMapChildren(file, node.parentId) : []
  const index = siblings.findIndex((sibling) => sibling.id === nodeId)
  const focusNodeId =
    siblings[index + 1]?.id ??
    siblings[index - 1]?.id ??
    node.parentId ??
    file.rootId
  const next = cloneMindMapFile(file)
  const descendants = new Set([nodeId])
  let changed = true
  while (changed) {
    changed = false
    for (const candidate of Object.values(next.nodes)) {
      if (
        candidate.parentId &&
        descendants.has(candidate.parentId) &&
        !descendants.has(candidate.id)
      ) {
        descendants.add(candidate.id)
        changed = true
      }
    }
  }

  for (const id of descendants) {
    delete next.nodes[id]
  }

  return { file: touchFile(next), focusNodeId }
}

// 只删除节点本身（对应 XMind 的「删除单个主题」/ MindNode 的 ⌥+⌫）：
// 子节点保持相对顺序上提到被删节点的位置，挂到祖父节点下。
export function deleteMindMapNodeOnly(
  file: ShardMapFile,
  nodeId: string
): { file: ShardMapFile; focusNodeId: string } {
  const node = file.nodes[nodeId]
  if (!node || node.id === file.rootId || !node.parentId) {
    return { file, focusNodeId: file.rootId }
  }

  const siblings = getMindMapChildren(file, node.parentId)
  const index = siblings.findIndex((sibling) => sibling.id === nodeId)
  const children = getMindMapChildren(file, nodeId)
  const focusNodeId =
    children[0]?.id ??
    siblings[index + 1]?.id ??
    siblings[index - 1]?.id ??
    node.parentId

  const next = cloneMindMapFile(file)
  const updatedAt = new Date().toISOString()
  let previousSortKey = siblings[index - 1]?.sortKey ?? null
  const followingSortKey = siblings[index + 1]?.sortKey ?? null
  for (const child of children) {
    const movedChild = next.nodes[child.id]
    if (!movedChild) continue

    movedChild.parentId = node.parentId
    movedChild.sortKey = getSortKeyBetween(previousSortKey, followingSortKey)
    movedChild.updatedAt = updatedAt
    previousSortKey = movedChild.sortKey
  }

  delete next.nodes[nodeId]
  return { file: touchFile(next), focusNodeId }
}

export function toggleMindMapNodeCollapsed(
  file: ShardMapFile,
  nodeId: string
): ShardMapFile {
  const node = file.nodes[nodeId]
  if (!node || node.id === file.rootId) return file

  const next = cloneMindMapFile(file)
  const target = next.nodes[nodeId]
  if (!target) return file

  target.collapsed = !target.collapsed
  target.updatedAt = new Date().toISOString()
  return touchFile(next)
}

export function indentMindMapNode(
  file: ShardMapFile,
  nodeId: string
): ShardMapFile {
  const node = file.nodes[nodeId]
  if (!node?.parentId) return file

  const siblings = getMindMapChildren(file, node.parentId)
  const index = siblings.findIndex((sibling) => sibling.id === nodeId)
  const previousSibling = siblings[index - 1]
  if (!previousSibling) return file

  const next = cloneMindMapFile(file)
  const target = next.nodes[nodeId]
  if (!target) return file

  const newSiblings = getMindMapChildren(next, previousSibling.id)
  target.parentId = previousSibling.id
  target.sortKey = getSortKeyBetween(
    newSiblings[newSiblings.length - 1]?.sortKey ?? null,
    null
  )
  target.updatedAt = new Date().toISOString()
  return touchFile(next)
}

export function outdentMindMapNode(
  file: ShardMapFile,
  nodeId: string
): ShardMapFile {
  const node = file.nodes[nodeId]
  if (!node?.parentId) return file

  const parent = file.nodes[node.parentId]
  if (!parent?.parentId) return file

  const next = cloneMindMapFile(file)
  const target = next.nodes[nodeId]
  if (!target) return file

  const parentSiblings = getMindMapChildren(next, parent.parentId)
  const parentIndex = parentSiblings.findIndex((sibling) => sibling.id === parent.id)
  target.parentId = parent.parentId
  target.sortKey = getSortKeyBetween(
    parentSiblings[parentIndex]?.sortKey ?? null,
    parentSiblings[parentIndex + 1]?.sortKey ?? null
  )
  target.updatedAt = new Date().toISOString()
  return touchFile(next)
}

export function moveMindMapNode(
  file: ShardMapFile,
  nodeId: string,
  direction: "up" | "down"
): ShardMapFile {
  const node = file.nodes[nodeId]
  if (!node?.parentId) return file

  const siblings = getMindMapChildren(file, node.parentId)
  const index = siblings.findIndex((sibling) => sibling.id === nodeId)
  const targetIndex = direction === "up" ? index - 1 : index + 1
  if (index < 0 || targetIndex < 0 || targetIndex >= siblings.length) return file

  const next = cloneMindMapFile(file)
  const current = next.nodes[nodeId]
  const target = next.nodes[siblings[targetIndex].id]
  if (!current || !target) return file

  const currentSortKey = current.sortKey
  current.sortKey = target.sortKey
  target.sortKey = currentSortKey
  current.updatedAt = new Date().toISOString()
  target.updatedAt = current.updatedAt
  return touchFile(next)
}

export function canMoveMindMapNodeToTarget(
  file: ShardMapFile,
  nodeId: string,
  target: MindMapDropTarget
): boolean {
  return canMoveMindMapNodesToTarget(file, [nodeId], target)
}

export function canMoveMindMapNodesToTarget(
  file: ShardMapFile,
  nodeIds: string[],
  target: MindMapDropTarget
): boolean {
  const movingNodeIds = getMovableMindMapNodeIds(file, nodeIds)
  const targetNode = file.nodes[target.nodeId]
  if (movingNodeIds.length === 0 || !targetNode) return false
  if (target.mode !== "inside" && targetNode.parentId === null) return false

  for (const movingNodeId of movingNodeIds) {
    if (movingNodeId === targetNode.id) return false
    if (isMindMapDescendant(file, targetNode.id, movingNodeId)) return false
  }

  return true
}

export function moveMindMapNodeToTarget(
  file: ShardMapFile,
  nodeId: string,
  target: MindMapDropTarget
): ShardMapFile {
  return moveMindMapNodesToTarget(file, [nodeId], target)
}

export function moveMindMapNodesToTarget(
  file: ShardMapFile,
  nodeIds: string[],
  target: MindMapDropTarget
): ShardMapFile {
  const movingNodeIds = getMovableMindMapNodeIds(file, nodeIds)
  if (!canMoveMindMapNodesToTarget(file, movingNodeIds, target)) return file

  const targetNode = file.nodes[target.nodeId]
  if (!targetNode) return file

  const next = cloneMindMapFile(file)
  let parentId: string
  let previousSortKey: string | null
  let followingSortKey: string | null

  if (target.mode === "inside") {
    const children = getMindMapChildren(next, targetNode.id).filter(
      (child) => !movingNodeIds.includes(child.id)
    )
    parentId = targetNode.id
    previousSortKey = children[children.length - 1]?.sortKey ?? null
    followingSortKey = null
  } else {
    if (!targetNode.parentId) return file

    const siblings = getMindMapChildren(next, targetNode.parentId).filter(
      (sibling) => !movingNodeIds.includes(sibling.id)
    )
    const targetIndex = siblings.findIndex((sibling) => sibling.id === target.nodeId)
    if (targetIndex < 0) return file

    parentId = targetNode.parentId
    previousSortKey =
      target.mode === "before"
        ? siblings[targetIndex - 1]?.sortKey ?? null
        : siblings[targetIndex]?.sortKey ?? null
    followingSortKey =
      target.mode === "before"
        ? siblings[targetIndex]?.sortKey ?? null
        : siblings[targetIndex + 1]?.sortKey ?? null
  }

  const updatedAt = new Date().toISOString()
  for (const movingNodeId of movingNodeIds) {
    const movedNode = next.nodes[movingNodeId]
    if (!movedNode) continue

    movedNode.parentId = parentId
    movedNode.sortKey = getSortKeyBetween(previousSortKey, followingSortKey)
    movedNode.updatedAt = updatedAt
    previousSortKey = movedNode.sortKey
  }

  return touchFile(next)
}

export function getMovableMindMapNodeIds(
  file: ShardMapFile,
  nodeIds: string[]
): string[] {
  const selectedIds = new Set(
    nodeIds.filter((nodeId) => nodeId !== file.rootId && file.nodes[nodeId])
  )
  if (selectedIds.size === 0) return []

  const orderedIds = getMindMapRows(file).map(({ node }) => node.id)
  for (const nodeId of Object.keys(file.nodes)) {
    if (!orderedIds.includes(nodeId)) {
      orderedIds.push(nodeId)
    }
  }

  return orderedIds.filter((nodeId) => {
    if (!selectedIds.has(nodeId)) return false
    return !hasMindMapAncestorInSet(file, nodeId, selectedIds)
  })
}

// 撤销回到已保存内容时，文件/节点的 updatedAt 时间戳已被 touchFile 刷新，
// 直接 JSON 比对会永远 dirty。归一化掉时间戳后比较内容是否一致。
export function isMindMapFileContentEqual(a: ShardMapFile, b: ShardMapFile) {
  return (
    JSON.stringify(normalizeMindMapFileForCompare(a)) ===
    JSON.stringify(normalizeMindMapFileForCompare(b))
  )
}

function normalizeMindMapFileForCompare(file: ShardMapFile) {
  return {
    ...file,
    updatedAt: "",
    nodes: Object.fromEntries(
      Object.entries(file.nodes).map(([nodeId, node]) => [
        nodeId,
        { ...node, updatedAt: "" },
      ])
    ),
  }
}

export function findFirstEditableNodeId(file: ShardMapFile): string {
  const rootChildren = getMindMapChildren(file, file.rootId)
  return rootChildren[0]?.id ?? file.rootId
}

export function compareMindMapNodes(a: ShardMapNode, b: ShardMapNode) {
  return compareSortKeys(a.sortKey, b.sortKey) || a.createdAt.localeCompare(b.createdAt)
}

function compareSortKeys(a: string, b: string) {
  const maxLength = Math.max(a.length, b.length)

  for (let index = 0; index < maxLength; index += 1) {
    const aDigit =
      index < a.length ? SORT_ALPHABET.indexOf(a[index]) : -1
    const bDigit =
      index < b.length ? SORT_ALPHABET.indexOf(b[index]) : -1

    if (aDigit !== bDigit) return aDigit - bDigit
  }

  return 0
}

function appendChildRows(
  file: ShardMapFile,
  parentId: string,
  depth: number,
  rows: MindMapOutlineRow[]
) {
  for (const child of getMindMapChildren(file, parentId)) {
    rows.push({ node: child, depth })
    if (!child.collapsed) {
      appendChildRows(file, child.id, depth + 1, rows)
    }
  }
}

function createMindMapNode(parentId: string, sortKey: string): ShardMapNode {
  const now = new Date().toISOString()
  return {
    id: `${NODE_ID_PREFIX}-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 8)}`,
    parentId,
    sortKey,
    text: "",
    collapsed: false,
    createdAt: now,
    updatedAt: now,
    links: [],
  }
}

function isMindMapDescendant(
  file: ShardMapFile,
  nodeId: string,
  possibleAncestorId: string
): boolean {
  let current = file.nodes[nodeId]

  while (current?.parentId) {
    if (current.parentId === possibleAncestorId) return true
    current = file.nodes[current.parentId]
  }

  return false
}

function hasMindMapAncestorInSet(
  file: ShardMapFile,
  nodeId: string,
  ancestorIds: Set<string>
): boolean {
  let current = file.nodes[nodeId]

  while (current?.parentId) {
    if (ancestorIds.has(current.parentId)) return true
    current = file.nodes[current.parentId]
  }

  return false
}

function touchFile(file: ShardMapFile): ShardMapFile {
  file.updatedAt = new Date().toISOString()
  return file
}

function getSortKeyBetween(previous: string | null, next: string | null) {
  const prev = previous ?? ""
  const following = next ?? ""
  let prefix = ""
  let index = 0

  while (true) {
    const prevDigit =
      index < prev.length ? SORT_ALPHABET.indexOf(prev[index]) : -1
    const nextDigit =
      index < following.length
        ? SORT_ALPHABET.indexOf(following[index])
        : SORT_ALPHABET.length

    if (nextDigit - prevDigit > 1) {
      const middle = Math.floor((prevDigit + nextDigit) / 2)
      return `${prefix}${SORT_ALPHABET[middle]}`
    }

    prefix += index < prev.length ? prev[index] : FIRST_SORT_CHAR
    index += 1
  }
}
