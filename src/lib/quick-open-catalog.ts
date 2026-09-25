import {
  deriveDocumentDigest,
  deriveKind,
  deriveNoteTitle,
  isTypeTag,
} from "@/lib/content-kind"
import { libraryEntryName } from "@/lib/library-entry"
import { parseMindMapOutline } from "@/lib/mind-map-outline"
import {
  searchTargetKey,
  type SearchHit,
  type SearchKind,
  type SearchRevealHint,
  type SearchScope,
} from "@/lib/search-contract"
import type {
  CsvFileSummary,
  Fragment,
  LibraryTreeEntry,
  LibraryTreeSnapshot,
  MindMapSummary,
} from "@/types"

export interface OpenCatalogInput {
  csvFiles: readonly CsvFileSummary[]
  fragments: readonly Fragment[]
  libraryTree: LibraryTreeSnapshot | null
  mindMaps: readonly MindMapSummary[]
  scope: SearchScope
  vaultPath: string
}

export type OpenCatalogLoadState = "partial" | "ready"

interface CatalogCandidate {
  hit: SearchHit
  priority: number
}

const titleCollator = new Intl.Collator("zh-CN", {
  numeric: true,
  sensitivity: "base",
})

/** A null tree means the catalog is partial; an empty loaded tree is ready. */
export function getOpenCatalogLoadState(
  input: Pick<OpenCatalogInput, "libraryTree" | "scope">
): OpenCatalogLoadState {
  return input.scope === "public" && input.libraryTree === null ? "partial" : "ready"
}

export function buildOpenCatalog(input: OpenCatalogInput): readonly SearchHit[] {
  const candidates = new Map<string, CatalogCandidate>()

  const add = (candidate: CatalogCandidate) => {
    const current = candidates.get(candidate.hit.target.key)
    if (!current || candidate.priority > current.priority) {
      candidates.set(candidate.hit.target.key, {
        ...candidate,
        hit: mergeMissingMetadata(candidate.hit, current?.hit),
      })
      return
    }
    candidates.set(candidate.hit.target.key, {
      ...current,
      hit: mergeMissingMetadata(current.hit, candidate.hit),
    })
  }

  for (const fragment of input.fragments) {
    const scopeMatches = input.scope === "lockbox" ? fragment.lockbox : !fragment.lockbox
    if (!scopeMatches || fragment.archived) continue

    const kind = deriveKind(fragment.tags)
    if (kind === "fragment") continue
    add({ hit: fragmentHit(input, fragment, kind), priority: 40 })
  }

  if (input.scope === "public") {
    for (const entry of flattenEntries(input.libraryTree?.entries ?? [])) {
      const kind = treeSearchKind(entry)
      if (!kind) continue
      add({ hit: treeEntryHit(input, entry, kind), priority: 10 })
    }

    for (const file of input.csvFiles) {
      add({ hit: csvHit(input, file), priority: 20 })
    }

    for (const map of input.mindMaps) {
      add({ hit: mindMapHit(input, map), priority: 30 })
    }
  }

  return Array.from(candidates.values(), ({ hit }) => hit).sort((left, right) => {
    const titleOrder = titleCollator.compare(left.title, right.title)
    if (titleOrder) return titleOrder
    return left.target.path.localeCompare(right.target.path)
  })
}

function fragmentHit(
  input: OpenCatalogInput,
  fragment: Fragment,
  kind: Exclude<ReturnType<typeof deriveKind>, "fragment">
): SearchHit {
  const title = fragmentTitle(fragment, kind) || pathStem(fragment.path) || unnamedTitle(kind)
  return createHit({
    input,
    kind,
    objectId: fragment.id,
    path: fragment.path,
    revealHint: "text",
    tags: fragment.tags.filter((tag) => tag !== "inbox" && !isTypeTag(tag)),
    title,
    updatedAt: fragment.updatedAt,
  })
}

function treeEntryHit(
  input: OpenCatalogInput,
  entry: LibraryTreeEntry,
  kind: Exclude<SearchKind, "fragment" | "note" | "outline" | "document">
): SearchHit {
  return createHit({
    input,
    kind,
    objectId: kind === "mindmap" ? entry.mindMapId ?? null : null,
    path: entry.path,
    revealHint: revealHintForKind(kind),
    title: libraryEntryName(entry),
    updatedAt: entry.modifiedAt,
  })
}

function csvHit(input: OpenCatalogInput, file: CsvFileSummary): SearchHit {
  return createHit({
    input,
    kind: "csv",
    objectId: null,
    path: file.path,
    revealHint: "external",
    title: file.name.replace(/\.csv$/iu, "") || file.name,
    updatedAt: null,
  })
}

function mindMapHit(input: OpenCatalogInput, map: MindMapSummary): SearchHit {
  return createHit({
    input,
    kind: "mindmap",
    objectId: map.id,
    path: map.path,
    revealHint: "documentOnly",
    title: map.title || pathStem(map.path) || "未命名思维导图",
    updatedAt: map.updatedAt,
  })
}

function createHit(options: {
  input: OpenCatalogInput
  kind: SearchKind
  objectId: string | null
  path: string
  revealHint: SearchRevealHint
  tags?: readonly string[]
  title: string
  updatedAt: string | null
}): SearchHit {
  const { input, kind, objectId, path, revealHint, tags = [], title, updatedAt } = options
  return {
    matchedFields: [],
    preview: [{ hit: false, text: path }],
    revealHint,
    revision: null,
    tags,
    target: {
      archived: false,
      key: searchTargetKey(input.vaultPath, input.scope, path),
      kind,
      objectId,
      path,
      scope: input.scope,
      vaultPath: input.vaultPath,
    },
    title,
    titleParts: [{ hit: false, text: title }],
    updatedAt: updatedAt || null,
  }
}

function fragmentTitle(
  fragment: Fragment,
  kind: Exclude<ReturnType<typeof deriveKind>, "fragment">
) {
  if (kind === "note") return deriveNoteTitle(fragment.content)
  if (kind === "document") return deriveDocumentDigest(fragment.content).title
  const outline = parseMindMapOutline(fragment.content).file
  return outline?.nodes[outline.rootId]?.text.trim() ?? ""
}

function treeSearchKind(
  entry: LibraryTreeEntry
): Exclude<SearchKind, "fragment" | "note" | "outline" | "document"> | null {
  if (
    entry.kind === "csv" ||
    entry.kind === "mindmap" ||
    entry.kind === "flowchart" ||
    entry.kind === "canvas" ||
    entry.kind === "table"
  ) {
    return entry.kind
  }

  // A generic Markdown tree row does not prove whether this is a note,
  // outline, document or plain fragment. Confirmed Markdown objects come from
  // the Fragment state above, where deriveKind(tags) is authoritative.
  return null
}

function flattenEntries(entries: readonly LibraryTreeEntry[]): LibraryTreeEntry[] {
  const flattened: LibraryTreeEntry[] = []
  const visit = (items: readonly LibraryTreeEntry[]) => {
    for (const entry of items) {
      if (entry.kind === "directory") {
        visit(entry.children ?? [])
      } else {
        flattened.push(entry)
      }
    }
  }
  visit(entries)
  return flattened
}

function revealHintForKind(kind: SearchKind): SearchRevealHint {
  return kind === "csv" ? "external" : "documentOnly"
}

function mergeMissingMetadata(preferred: SearchHit, fallback?: SearchHit): SearchHit {
  if (!fallback) return preferred
  return {
    ...preferred,
    target: {
      ...preferred.target,
      objectId: preferred.target.objectId ?? fallback.target.objectId,
    },
    updatedAt: preferred.updatedAt ?? fallback.updatedAt,
  }
}

function pathStem(path: string) {
  const name = path.split("/").pop() ?? ""
  return name.replace(/(?:\.shard(?:map|flow|canvas|table)\.json|\.[^.]+)$/iu, "")
}

function unnamedTitle(kind: SearchKind) {
  if (kind === "outline") return "未命名大纲"
  if (kind === "document") return "未命名文档"
  if (kind === "note") return "未命名笔记"
  return "未命名项目"
}
