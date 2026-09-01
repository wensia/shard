import { deriveNoteTitle } from "@/lib/content-kind"
import { markdownToSearchText } from "@/lib/fragment-search"
import type { CsvFileSummary, Fragment, MindMapSummary } from "@/types"

export interface WikilinkMatch {
  alias?: string
  embed?: true
  from: number
  target: string
  to: number
}

export interface WikilinkCandidate {
  fragmentId?: string
  kind: Fragment["kind"] | "csv" | "mindmap"
  label: string
  matchKeys: string[]
  path?: string
  target: string
}

export type WikilinkWorkerRequest = {
  content: string
  requestId: string
  type: "parse"
}

export type WikilinkWorkerResponse = {
  links: WikilinkMatch[]
  requestId: string
  type: "parsed"
}

const EXCERPT_LENGTH = 56

export function parseWikilinks(content: string): WikilinkMatch[] {
  const links: WikilinkMatch[] = []
  let cursor = 0

  while (cursor < content.length - 1) {
    const from = content.indexOf("[[", cursor)
    if (from < 0) break

    const toStart = content.indexOf("]]", from + 2)
    if (toStart < 0) break

    const raw = content.slice(from + 2, toStart)
    const separator = raw.indexOf("|")
    const target = (separator < 0 ? raw : raw.slice(0, separator)).trim()
    const alias = separator < 0 ? undefined : raw.slice(separator + 1).trim()

    if (target && (separator < 0 || alias)) {
      const embed = from > 0 && content[from - 1] === "!" && isCsvWikilinkTarget(target)
      links.push({
        ...(alias ? { alias } : {}),
        ...(embed ? { embed: true as const } : {}),
        from: embed ? from - 1 : from,
        target,
        to: toStart + 2,
      })
    }

    cursor = toStart + 2
  }

  return links
}

export function buildCsvWikilinkCandidates(
  files: readonly CsvFileSummary[]
): WikilinkCandidate[] {
  return files.map((file) => ({
    kind: "csv",
    label: file.name,
    matchKeys: Array.from(
      new Set([file.path, file.name].map(normalizeWikilinkTarget).filter(Boolean))
    ),
    path: file.path,
    target: file.path,
  }))
}

export function buildMindMapWikilinkCandidates(
  maps: readonly Pick<MindMapSummary, "path" | "title">[]
): WikilinkCandidate[] {
  return maps.map((map) => ({
    kind: "mindmap",
    label: map.title,
    matchKeys: Array.from(
      new Set([map.path, map.title].map(normalizeWikilinkTarget).filter(Boolean))
    ),
    path: map.path,
    target: map.title,
  }))
}

export function buildWikilinkCandidates(
  fragments: readonly Fragment[]
): WikilinkCandidate[] {
  const prepared = fragments
    .filter((fragment) => !fragment.lockbox)
    .map((fragment) => {
      const fileName = getFileName(fragment.path)
      const fileStem = stripMarkdownExtension(fileName)
      const plain = markdownToSearchText(fragment.content).trim()
      const title = fragment.kind === "note" ? deriveNoteTitle(fragment.content) : ""

      return {
        fragment,
        fileName,
        fileStem,
        label:
          fragment.kind === "note"
            ? title || fileStem || "无标题笔记"
            : toExcerpt(plain || fileStem || "空片段"),
        preferredTarget: fragment.kind === "note" && title ? title : fileStem,
        title,
      }
    })

  const preferredCounts = new Map<string, number>()
  for (const item of prepared) {
    const key = normalizeWikilinkTarget(item.preferredTarget)
    preferredCounts.set(key, (preferredCounts.get(key) ?? 0) + 1)
  }

  return prepared.map((item) => {
    const preferredKey = normalizeWikilinkTarget(item.preferredTarget)
    const target =
      preferredCounts.get(preferredKey) === 1
        ? item.preferredTarget
        : item.fileStem || item.fileName || item.fragment.id
    const matchKeys = Array.from(
      new Set(
        [target, item.title, item.fileStem, item.fileName]
          .map(normalizeWikilinkTarget)
          .filter(Boolean)
      )
    )

    return {
      fragmentId: item.fragment.id,
      kind: item.fragment.kind,
      label: item.label,
      matchKeys,
      target,
    }
  })
}

export function resolveWikilinkTarget(
  target: string,
  candidates: readonly WikilinkCandidate[]
): WikilinkCandidate | null {
  const normalized = normalizeWikilinkTarget(target)
  if (!normalized) return null

  const matches = candidates.filter((candidate) =>
    candidate.matchKeys.includes(normalized)
  )
  return matches.length === 1 ? matches[0] : null
}

export function normalizeWikilinkTarget(value: string) {
  return value.trim().normalize("NFKC").toLocaleLowerCase("zh-CN")
}

export function isCsvWikilinkTarget(value: string) {
  return normalizeWikilinkTarget(value).endsWith(".csv")
}

function getFileName(path: string) {
  const parts = path.split(/[\\/]/u).filter(Boolean)
  return parts[parts.length - 1] ?? ""
}

function stripMarkdownExtension(fileName: string) {
  return fileName.replace(/\.md$/iu, "")
}

function toExcerpt(value: string) {
  return value.length <= EXCERPT_LENGTH
    ? value
    : `${value.slice(0, EXCERPT_LENGTH)}…`
}
