import type { ShardDocumentLink, ShardMapFile } from "@/types"

export const CANVAS_MAX_NODES = 400
export const CANVAS_MAX_EDGES = 1600
export const CANVAS_MAX_CONTENT_NODES = 2000
export const CANVAS_MAX_BYTES = 8 * 1024 * 1024
export const CANVAS_NODE_KINDS = ["process", "decision", "terminal", "text", "reference", "mindmap"] as const
export type CanvasNodeKind = typeof CANVAS_NODE_KINDS[number]
export type CanvasHandle = "top" | "right" | "bottom" | "left"

export interface CanvasNode {
  id: string
  kind: CanvasNodeKind
  x: number
  y: number
  text: string
  width?: number
  height?: number
  link?: ShardDocumentLink
  mindMap?: ShardMapFile
}

export interface CanvasEdge {
  id: string
  source: string
  target: string
  label: string
  sourceHandle?: CanvasHandle
  targetHandle?: CanvasHandle
}

export interface CanvasFile {
  kind: "shard.flow" | "shard.canvas"
  schemaVersion: 1
  id: string
  title: string
  createdAt: string
  updatedAt: string
  revision: number
  nodes: CanvasNode[]
  edges: CanvasEdge[]
}

export interface CanvasReadResult {
  file: CanvasFile
  path: string
  lastSavedHash: string
}

export function createCanvasId(): string {
  return crypto.randomUUID()
}

export function createCanvasFile(title: string): CanvasFile {
  const now = new Date().toISOString()
  return { kind: "shard.flow", schemaVersion: 1, id: createCanvasId(), title: title.trim() || "未命名流程图", createdAt: now, updatedAt: now, revision: 0, nodes: [], edges: [] }
}

export function createCanvasMindMap(title = "中心主题"): ShardMapFile {
  const now = new Date().toISOString()
  const rootId = createCanvasId()
  return {
    kind: "shard.map", schemaVersion: 1, id: createCanvasId(), title, createdAt: now, updatedAt: now,
    savedWithAppVersion: "0.1.3", revision: 0, rootId, hasProtectedLinks: false,
    nodes: { [rootId]: { id: rootId, parentId: null, sortKey: "U", text: title, createdAt: now, updatedAt: now, links: [] } },
  }
}

export function createCanvasNode(
  kind: CanvasNodeKind,
  position: { x: number; y: number },
  options: Partial<Pick<CanvasNode, "text" | "width" | "height" | "link" | "mindMap">> = {},
): CanvasNode {
  const labels: Record<CanvasNodeKind, string> = { process: "流程", decision: "判断条件", terminal: "开始 / 结束", text: "文字", reference: "资料引用", mindmap: "中心主题" }
  const node: CanvasNode = { id: createCanvasId(), kind, ...position, text: labels[kind], ...options }
  if (kind === "mindmap") node.mindMap ??= createCanvasMindMap(node.text)
  validateNode(node)
  return cloneCanvasNode(node)
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function string(value: unknown, label: string, max: number, empty = false): asserts value is string {
  assert(typeof value === "string" && (empty || value.trim().length > 0) && (value.length <= max || codePointLengthAtMost(value, max)), `${label}无效或过长。`)
}

function codePointLengthAtMost(value: string, max: number): boolean {
  let count = 0
  for (const _character of value) { if (++count > max) return false }
  return true
}

function id(value: unknown): asserts value is string { string(value, "标识", 200); assert(!/[\u0000-\u001f\u007f]/.test(value), "标识不能包含控制字符。") }
function date(value: unknown) { assert(typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value)), "时间格式无效。") }
function dimension(value: unknown) { assert(value === undefined || (typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 10000), "节点尺寸无效。") }

// Shape validation is local; public/protected target identity is also checked by the vault backend.
export function validateCanvasLink(value: unknown): asserts value is ShardDocumentLink {
  assert(record(value), "资料引用无效。")
  id(value.id)
  if (value.targetType === "fragment" || value.targetType === "map" || value.targetType === "flow") {
    id(value.targetId)
    assert(!/[\\/\u0000]/.test(value.targetId), "资料引用目标无效。")
  } else if (value.targetType === "markdownPath") {
    string(value.path, "资料路径", 4096)
    assert(value.path.length <= 1024 || new TextEncoder().encode(value.path).byteLength <= 4096, "资料路径过长。")
    const segments = value.path.split("/")
    assert(["notes", "fragments"].includes(segments[0]) && segments.length > 1 && segments.every(part => part !== "" && part !== "." && part !== ".." && !part.startsWith(".")) && !/[\\\u0000]/.test(value.path) && /\.md$/i.test(value.path), "只能引用公开资料库中的 Markdown 文件。")
  } else throw new Error("不支持的资料引用类型。")
}

export function validateCanvasMindMap(value: unknown): asserts value is ShardMapFile {
  assert(record(value) && value.kind === "shard.map" && value.schemaVersion === 1, "导图格式无效。")
  id(value.id); id(value.rootId)
  string(value.title, "导图标题", 2000)
  date(value.createdAt); date(value.updatedAt)
  assert(typeof value.savedWithAppVersion === "string" && Number.isSafeInteger(value.revision) && Number(value.revision) >= 0, "导图元数据无效。")
  assert(value.hasProtectedLinks === false && record(value.nodes), "画布不能包含受保护导图。")
  if (value.viewport !== undefined) {
    assert(record(value.viewport) && typeof value.viewport.x === "number" && Number.isFinite(value.viewport.x) && typeof value.viewport.y === "number" && Number.isFinite(value.viewport.y) && typeof value.viewport.zoom === "number" && Number.isFinite(value.viewport.zoom) && value.viewport.zoom > 0, "导图视口无效。")
  }
  const entries = Object.entries(value.nodes)
  assert(entries.length > 0 && entries.length <= CANVAS_MAX_NODES, "单个导图最多 400 个节点。")
  const parentById = new Map<string, string | null>()
  const children = new Map<string, string[]>()
  const siblingKeys = new Set<string>()
  for (const [key, node] of entries) {
    assert(record(node) && node.id === key, "导图节点标识不一致。")
    id(key); string(node.text, "导图节点文字", 2000, true)
    string(node.sortKey, "节点排序", 1000)
    assert(/^[0-9A-Za-z]+$/.test(node.sortKey), "导图节点排序无效。")
    date(node.createdAt); date(node.updatedAt)
    assert(node.parentId === null || typeof node.parentId === "string", "导图父节点无效。")
    assert(node.collapsed === undefined || typeof node.collapsed === "boolean", "导图折叠状态无效。")
    dimension(node.width)
    if (node.note !== undefined) string(node.note, "导图备注", 20000, true)
    if (node.links !== undefined) { assert(Array.isArray(node.links), "导图引用无效。"); node.links.forEach(validateCanvasLink) }
    if (node.style !== undefined) assert(record(node.style) && (node.style.tone === undefined || ["default", "accent", "success", "warning"].includes(String(node.style.tone))), "导图样式无效。")
    parentById.set(key, node.parentId)
    const siblingKey = JSON.stringify([node.parentId, node.sortKey])
    assert(!siblingKeys.has(siblingKey), "同级导图节点排序重复。")
    siblingKeys.add(siblingKey)
    if (node.parentId !== null) children.set(node.parentId, [...(children.get(node.parentId) ?? []), key])
  }
  assert(parentById.has(value.rootId) && parentById.get(value.rootId) === null, "导图缺少有效根节点。")
  const visited = new Set<string>()
  const pending = [value.rootId]
  while (pending.length) {
    const current = pending.pop()!
    assert(!visited.has(current), "导图包含循环父子关系。")
    visited.add(current)
    pending.push(...(children.get(current) ?? []))
  }
  assert(visited.size === entries.length, "导图包含无法从根节点到达的节点。")
}

function validateNode(value: unknown): asserts value is CanvasNode {
  assert(record(value), "画布节点无效。")
  id(value.id)
  assert(CANVAS_NODE_KINDS.includes(value.kind as CanvasNodeKind), "不支持的画布节点类型。")
  assert(typeof value.x === "number" && Number.isFinite(value.x) && Math.abs(value.x) <= 1_000_000 && typeof value.y === "number" && Number.isFinite(value.y) && Math.abs(value.y) <= 1_000_000, "节点坐标无效。")
  string(value.text, "节点文字", 20000, true)
  dimension(value.width); dimension(value.height)
  if (value.kind === "reference") validateCanvasLink(value.link)
  else assert(value.link === undefined, "只有资料卡片可以包含顶层引用。")
  if (value.kind === "mindmap") validateCanvasMindMap(value.mindMap)
  else assert(value.mindMap === undefined, "只有导图对象可以包含树结构。")
}

export function validateCanvasFile(value: unknown): asserts value is CanvasFile {
  assert(record(value) && (value.kind === "shard.flow" || value.kind === "shard.canvas") && value.schemaVersion === 1, "不支持的图文件格式或版本。")
  id(value.id); string(value.title, "画布标题", 500)
  date(value.createdAt); date(value.updatedAt)
  assert(Number.isSafeInteger(value.revision) && Number(value.revision) >= 0, "画布版本无效。")
  assert(Array.isArray(value.nodes) && value.nodes.length <= CANVAS_MAX_NODES, "画布最多 400 个对象。")
  assert(Array.isArray(value.edges) && value.edges.length <= CANVAS_MAX_EDGES, "画布最多 1600 条连线。")
  const ids = new Set<string>()
  let contentCount = value.nodes.length
  for (const node of value.nodes) {
    validateNode(node)
    assert(value.kind !== "shard.flow" || node.kind !== "mindmap", "流程图只能引用独立思维导图，不能嵌入导图对象。")
    assert(!ids.has(node.id), "画布节点标识重复。")
    ids.add(node.id)
    if (node.mindMap) contentCount += Object.keys(node.mindMap.nodes).length
  }
  assert(contentCount <= CANVAS_MAX_CONTENT_NODES, "画布包含的内容节点总数不能超过 2000。")
  const edgeIds = new Set<string>()
  const handles = ["top", "right", "bottom", "left"]
  for (const edge of value.edges) {
    assert(record(edge), "画布连线无效。")
    id(edge.id); id(edge.source); id(edge.target)
    assert(!edgeIds.has(edge.id), "画布连线标识重复。")
    edgeIds.add(edge.id)
    assert(ids.has(edge.source) && ids.has(edge.target), "连线只能连接现存的顶层对象。")
    string(edge.label, "连线文字", 2000, true)
    assert((edge.sourceHandle === undefined || handles.includes(String(edge.sourceHandle))) && (edge.targetHandle === undefined || handles.includes(String(edge.targetHandle))), "连线连接点无效。")
  }
}

export function parseCanvasFile(text: string): CanvasFile {
  assert(new TextEncoder().encode(text).byteLength <= CANVAS_MAX_BYTES, "画布文件不能超过 8 MiB。")
  const file: unknown = JSON.parse(text)
  validateCanvasFile(file)
  return file
}

// Save metadata never creates an edit or an undo step. Rust may omit default tree fields.
export function isCanvasContentEqual(a: CanvasFile, b: CanvasFile): boolean {
  if (a === b) return true
  if (a.kind !== b.kind || a.title !== b.title || a.nodes.length !== b.nodes.length || a.edges.length !== b.edges.length) return false
  return a.nodes.every((node, index) => {
    const other = b.nodes[index]
    return node === other || (node.id === other.id && node.kind === other.kind && node.x === other.x && node.y === other.y && node.text === other.text && node.width === other.width && node.height === other.height && linksEqual(node.link, other.link) && mindMapsEqual(node.mindMap, other.mindMap))
  }) && a.edges.every((edge, index) => {
    const other = b.edges[index]
    return edge === other || (edge.id === other.id && edge.source === other.source && edge.target === other.target && edge.label === other.label && edge.sourceHandle === other.sourceHandle && edge.targetHandle === other.targetHandle)
  })
}

function linksEqual(a: ShardDocumentLink | undefined, b: ShardDocumentLink | undefined): boolean {
  if (a === b) return true
  if (!a || !b || a.id !== b.id || a.targetType !== b.targetType) return false
  return a.targetType === "markdownPath" && b.targetType === "markdownPath" ? a.path === b.path : "targetId" in a && "targetId" in b && a.targetId === b.targetId
}

function mindMapsEqual(a: ShardMapFile | undefined, b: ShardMapFile | undefined): boolean {
  if (a === b) return true
  if (!a || !b || a.id !== b.id || a.title !== b.title || a.rootId !== b.rootId || a.createdAt !== b.createdAt || Object.keys(a.nodes).length !== Object.keys(b.nodes).length) return false
  if (a.viewport?.x !== b.viewport?.x || a.viewport?.y !== b.viewport?.y || a.viewport?.zoom !== b.viewport?.zoom) return false
  return Object.values(a.nodes).every(node => {
    const other = b.nodes[node.id]
    if (!other) return false
    return node === other || (node.id === other.id && node.parentId === other.parentId && node.sortKey === other.sortKey && node.text === other.text && (node.note ?? "") === (other.note ?? "") && Boolean(node.collapsed) === Boolean(other.collapsed) && node.width === other.width && node.createdAt === other.createdAt && (node.style?.tone ?? "default") === (other.style?.tone ?? "default") && (node.links?.length ?? 0) === (other.links?.length ?? 0) && (node.links ?? []).every((link, index) => linksEqual(link, other.links?.[index])))
  })
}

// Copy the structure while reusing immutable JS strings. structuredClone/JSON would copy megabytes
// of unchanged text on every committed gesture and make the UI's cost depend on payload size.
export function cloneCanvasFile(file: CanvasFile): CanvasFile {
  return { ...file, nodes: file.nodes.map(cloneCanvasNode), edges: file.edges.map(edge => ({ ...edge })) }
}

export function cloneCanvasNode(node: CanvasNode): CanvasNode {
  const next = { ...node }
  if (node.link) next.link = { ...node.link }
  if (node.mindMap) next.mindMap = {
    ...node.mindMap,
    ...(node.mindMap.viewport ? { viewport: { ...node.mindMap.viewport } } : {}),
    nodes: Object.fromEntries(Object.entries(node.mindMap.nodes).map(([key, entry]) => [key, {
      ...entry,
      ...(entry.links ? { links: entry.links.map(link => ({ ...link })) } : {}),
      ...(entry.style ? { style: { ...entry.style } } : {}),
    }])),
  }
  return next
}

export function estimateCanvasMemoryBytes(file: CanvasFile): number {
  const linkBytes = (link: ShardDocumentLink) => 96 + link.id.length * 2 + (link.targetType === "markdownPath" ? link.path.length : link.targetId.length) * 2
  let bytes = 512 + file.title.length * 2
  for (const node of file.nodes) {
    bytes += 192 + (node.id.length + node.text.length) * 2
    if (node.link) bytes += linkBytes(node.link)
    if (node.mindMap) {
      bytes += 512 + node.mindMap.title.length * 2
      for (const entry of Object.values(node.mindMap.nodes)) bytes += 384 + (entry.id.length + entry.text.length + entry.sortKey.length + (entry.note?.length ?? 0)) * 2 + (entry.links ?? []).reduce((total, link) => total + linkBytes(link), 0)
    }
  }
  for (const edge of file.edges) bytes += 192 + (edge.id.length + edge.source.length + edge.target.length + edge.label.length) * 2
  return bytes
}
