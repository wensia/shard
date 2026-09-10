import type { LibraryTreeEntry, LibraryTreeEntryKind } from "@/types"

export const LIBRARY_NAME_MAX_LENGTH = 64

/** Count the editable name, preserving existing filenames and format suffixes. */
export function libraryNameError(name: string, extension = ""): string | null {
  const value = name.trim()
  const stem = extension && value.toLowerCase().endsWith(extension.toLowerCase())
    ? value.slice(0, -extension.length) : value
  if (Array.from(stem).length > LIBRARY_NAME_MAX_LENGTH) {
    return `名称最多 ${LIBRARY_NAME_MAX_LENGTH} 个字符（不含扩展名）。`
  }
  if (new TextEncoder().encode(stem + extension).length > 255) {
    return "名称占用空间过长，请减少部分字符。"
  }
  return null
}

export type LibrarySortKey = "name" | "kind" | "size" | "createdAt" | "modifiedAt"

export type LibrarySort = {
  key: LibrarySortKey
  direction: "asc" | "desc"
}

const typeLabels: Record<LibraryTreeEntryKind, string> = {
  directory: "目录",
  markdown: "Markdown",
  csv: "CSV 源文件",
  mindmap: "思维导图",
  flowchart: "流程图",
  canvas: "旧混合画布",
  table: "多维表格",
  image: "图片",
  file: "文件",
}

const suffixes: Partial<Record<LibraryTreeEntryKind, RegExp>> = {
  markdown: /\.md$/i,
  csv: /\.csv$/i,
  mindmap: /\.shardmap\.json$/i,
  flowchart: /\.shardflow\.json$/i,
  canvas: /\.shardcanvas\.json$/i,
  table: /\.shardtable\.json$/i,
  image: /\.(gif|jpe?g|png|svg|webp)$/i,
  file: /\.[^.]+$/,
}

const nameCollator = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" })

export function libraryEntryName(entry: Pick<LibraryTreeEntry, "name" | "kind">): string {
  const suffix = suffixes[entry.kind]
  if (!suffix) return entry.name

  return entry.name.replace(suffix, "") || entry.name
}

export function libraryEntryTypeLabel(kind: LibraryTreeEntryKind): string {
  return typeLabels[kind]
}

function sortValue(entry: LibraryTreeEntry, key: LibrarySortKey, name: string): string | number | null {
  if (key === "name") return name
  if (key === "kind") return libraryEntryTypeLabel(entry.kind)
  if (key === "size") return Number.isFinite(entry.size) && entry.size >= 0 ? entry.size : null

  const date = entry[key]
  const timestamp = date ? Date.parse(date) : Number.NaN
  return Number.isFinite(timestamp) ? timestamp : null
}

export function sortLibraryEntries<T extends LibraryTreeEntry>(entries: T[], sort: LibrarySort): T[] {
  const direction = sort.direction === "asc" ? 1 : -1

  return entries
    .map((entry) => {
      const name = libraryEntryName(entry)
      return { entry, name, value: sortValue(entry, sort.key, name) }
    })
    .sort((left, right) => {
      const directoryOrder = Number(right.entry.kind === "directory") - Number(left.entry.kind === "directory")
      if (directoryOrder) return directoryOrder
      if (left.value === null && right.value !== null) return 1
      if (left.value !== null && right.value === null) return -1

      const valueOrder = typeof left.value === "number" && typeof right.value === "number"
        ? left.value - right.value
        : typeof left.value === "string" && typeof right.value === "string"
          ? nameCollator.compare(left.value, right.value)
          : 0
      if (valueOrder) return valueOrder * direction

      const nameOrder = nameCollator.compare(left.name, right.name)
      if (nameOrder) return nameOrder
      const pathOrder = nameCollator.compare(left.entry.path, right.entry.path)
      if (pathOrder) return pathOrder
      return left.entry.path < right.entry.path ? -1 : left.entry.path > right.entry.path ? 1 : 0
    })
    .map(({ entry }) => entry)
}
