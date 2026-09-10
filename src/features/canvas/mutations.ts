import {
  cloneCanvasFile, createCanvasId, isCanvasContentEqual, validateCanvasFile,
  type CanvasEdge, type CanvasFile, type CanvasNode,
} from "./model"

function changed(file: CanvasFile, update: Partial<Pick<CanvasFile, "title" | "nodes" | "edges">>): CanvasFile {
  const next = { ...cloneCanvasFile({ ...file, ...update }), updatedAt: new Date().toISOString() }
  validateCanvasFile(next)
  return isCanvasContentEqual(file, next) ? file : next
}

export function updateCanvasTitle(file: CanvasFile, title: string): CanvasFile {
  return changed(file, { title: title.trim() || (file.kind === "shard.flow" ? "未命名流程图" : "未命名画布") })
}

export function addCanvasNode(file: CanvasFile, node: CanvasNode): CanvasFile {
  return changed(file, { nodes: [...file.nodes, node] })
}

export function updateCanvasNode(file: CanvasFile, nodeId: string, patch: Partial<Omit<CanvasNode, "id" | "kind">>): CanvasFile {
  return changed(file, { nodes: file.nodes.map(node => node.id === nodeId ? { ...node, ...patch } : node) })
}

export function moveCanvasNodes(file: CanvasFile, positions: Array<{ id: string; x: number; y: number }>): CanvasFile {
  const byId = new Map(positions.map(position => [position.id, position]))
  return changed(file, { nodes: file.nodes.map(node => byId.has(node.id) ? { ...node, x: byId.get(node.id)!.x, y: byId.get(node.id)!.y } : node) })
}

export function removeCanvasNodes(file: CanvasFile, ids: string[]): CanvasFile {
  const removed = new Set(ids)
  return changed(file, { nodes: file.nodes.filter(node => !removed.has(node.id)), edges: file.edges.filter(edge => !removed.has(edge.source) && !removed.has(edge.target)) })
}

export function addCanvasEdge(file: CanvasFile, edge: Omit<CanvasEdge, "id"> & { id?: string }): CanvasFile {
  return changed(file, { edges: [...file.edges, { ...edge, id: edge.id ?? createCanvasId() }] })
}

export function updateCanvasEdge(file: CanvasFile, edgeId: string, patch: Partial<Omit<CanvasEdge, "id">>): CanvasFile {
  return changed(file, { edges: file.edges.map(edge => edge.id === edgeId ? { ...edge, ...patch } : edge) })
}

export function removeCanvasEdges(file: CanvasFile, ids: string[]): CanvasFile {
  const removed = new Set(ids)
  return changed(file, { edges: file.edges.filter(edge => !removed.has(edge.id)) })
}
