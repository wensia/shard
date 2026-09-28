import {
  CONTENT_KIND_LABELS,
  deriveDocumentDigest,
  deriveKind,
  deriveNoteTitle,
  type ContentKind,
} from "@/lib/content-kind"
import { readFlowchartContent } from "@/lib/flowchart-content"
import { isPublicStreamFragment } from "@/lib/fragment-space"
import { readOutlineContent } from "@/lib/mind-map-outline"
import { compareDecimalText, comparablePropertyDateTime } from "@/lib/property-filter"
import {
  validatePropertyDate,
  type PropertyType,
} from "@/lib/properties"
import type {
  Fragment,
  FragmentProperty,
  PropertyRegistry,
  PropertyValue,
} from "@/types"

export type TagTopicKind = Exclude<ContentKind, "note">

export interface TagTopicCounts {
  document: number
  flowchart: number
  fragment: number
  outline: number
}

export interface TagTopicPropertyColumn {
  count: number
  key: string
  type: PropertyType | null
}

export type TagTopicSortKey =
  | "title"
  | "type"
  | "updatedAt"
  | `property:${string}`

export interface TagTopicSort {
  direction: "asc" | "desc"
  key: TagTopicSortKey
}

export type FormattedPropertyValue =
  | { kind: "empty"; text: "" }
  | { kind: "text" | "number" | "other"; text: string }
  | { checked: boolean; kind: "checkbox"; text: string }
  | { items: string[]; kind: "list"; text: string }

export function collectTagTopicFragments(
  fragments: readonly Fragment[],
  tag: string
) {
  return fragments.filter(
    (fragment) => isPublicStreamFragment(fragment) && fragment.tags.includes(tag)
  )
}

export function countTagTopicKinds(
  fragments: readonly Fragment[]
): TagTopicCounts {
  const counts: TagTopicCounts = {
    document: 0,
    flowchart: 0,
    fragment: 0,
    outline: 0,
  }

  for (const fragment of fragments) {
    const kind = deriveKind(fragment.tags)
    if (kind !== "note") counts[kind] += 1
  }
  return counts
}

export function collectTagTopicPropertyColumns(
  fragments: readonly Fragment[],
  registry?: PropertyRegistry["properties"] | null
): TagTopicPropertyColumn[] {
  const counts = new Map<string, number>()
  for (const fragment of fragments) {
    for (const key of new Set((fragment.properties ?? []).map((property) => property.key))) {
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
  }

  return Array.from(counts, ([key, count]) => ({
    count,
    key,
    type: registry?.[key]?.type ?? null,
  })).sort((left, right) =>
    right.count - left.count || left.key.localeCompare(right.key, "zh-CN")
  )
}

export function formatTagTopicPropertyValue(
  value: PropertyValue | undefined
): FormattedPropertyValue {
  if (!value || value.kind === "null") return { kind: "empty", text: "" }
  if (value.kind === "text" || value.kind === "number") {
    return { kind: value.kind, text: value.text }
  }
  if (value.kind === "bool") {
    return {
      checked: value.value,
      kind: "checkbox",
      text: value.value ? "已勾选" : "未勾选",
    }
  }
  if (value.kind === "list") {
    return { items: value.items, kind: "list", text: value.items.join("、") }
  }
  return { kind: "other", text: value.raw }
}

export function sortTagTopicFragments(
  fragments: readonly Fragment[],
  sort: TagTopicSort | null,
  registry?: PropertyRegistry["properties"] | null
) {
  if (!sort) return [...fragments]

  return fragments
    .map((fragment, index) => ({ fragment, index }))
    .sort((left, right) => {
      const comparison = compareByColumn(
        left.fragment,
        right.fragment,
        sort.key,
        registry,
        sort.direction
      )
      return comparison === 0 ? left.index - right.index : comparison
    })
    .map(({ fragment }) => fragment)
}

export function collectTagTopicBacklinks(
  fragments: readonly Fragment[],
  topicFragments: readonly Fragment[],
  tag: string
) {
  const targetIds = new Set(topicFragments.map((fragment) => fragment.id))
  return fragments
    .filter(
      (fragment) =>
        !fragment.archived &&
        !fragment.lockbox &&
        !fragment.tags.includes(tag) &&
        (fragment.related ?? []).some(
          (relation) =>
            relation.origin === "wikilink" && targetIds.has(relation.targetId)
        )
    )
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
}

export function deriveTagTopicTitle(fragment: Fragment) {
  const kind = deriveKind(fragment.tags)
  let title = ""
  if (kind === "document") {
    title = deriveDocumentDigest(fragment.content).title
  } else if (kind === "outline") {
    const outline = readOutlineContent(fragment.content)?.file
    title = outline?.nodes[outline.rootId]?.text.trim() ?? ""
  } else if (kind === "flowchart") {
    title = readFlowchartContent(fragment.content)?.file.title.trim() ?? ""
  } else {
    title = deriveNoteTitle(fragment.content)
  }

  if (title) return title
  const pathParts = fragment.path.split("/")
  return pathParts[pathParts.length - 1]?.replace(/\.md$/u, "") || "未命名内容"
}

function compareByColumn(
  left: Fragment,
  right: Fragment,
  key: TagTopicSortKey,
  registry: PropertyRegistry["properties"] | null | undefined,
  direction: TagTopicSort["direction"]
) {
  const directionFactor = direction === "asc" ? 1 : -1
  if (key === "title") {
    return directionFactor * deriveTagTopicTitle(left).localeCompare(deriveTagTopicTitle(right), "zh-CN")
  }
  if (key === "type") {
    return directionFactor * CONTENT_KIND_LABELS[deriveKind(left.tags)].localeCompare(
      CONTENT_KIND_LABELS[deriveKind(right.tags)],
      "zh-CN"
    )
  }
  if (key === "updatedAt") return directionFactor * left.updatedAt.localeCompare(right.updatedAt)

  const propertyKey = key.slice("property:".length)
  const type = registry?.[propertyKey]?.type ?? "text"
  return compareProperties(
    findProperty(left, propertyKey),
    findProperty(right, propertyKey),
    type,
    direction
  )
}

function findProperty(fragment: Fragment, key: string) {
  return (fragment.properties ?? []).find((property) => property.key === key)
}

function compareProperties(
  left: FragmentProperty | undefined,
  right: FragmentProperty | undefined,
  type: PropertyType,
  direction: TagTopicSort["direction"]
) {
  const leftValue = sortablePropertyValue(left?.value, type)
  const rightValue = sortablePropertyValue(right?.value, type)
  if (!leftValue.valid || !rightValue.valid) {
    if (leftValue.valid !== rightValue.valid) return leftValue.valid ? -1 : 1
    return 0
  }

  const comparison = type === "number"
    ? compareDecimalText(leftValue.text, rightValue.text) ?? 0
    : type === "checkbox"
      ? Number(leftValue.checked) - Number(rightValue.checked)
      : leftValue.text.localeCompare(rightValue.text, "zh-CN")
  return direction === "asc" ? comparison : -comparison
}

type SortablePropertyValue =
  | { checked: boolean; text: string; valid: true }
  | { checked: false; text: ""; valid: false }

function sortablePropertyValue(
  value: PropertyValue | undefined,
  type: PropertyType
): SortablePropertyValue {
  if (type === "checkbox") {
    return value?.kind === "bool"
      ? { checked: value.value, text: value.value ? "1" : "0", valid: true }
      : { checked: false, text: "", valid: false }
  }
  if (type === "list") {
    return value?.kind === "list"
      ? { checked: false, text: value.items.join("\u0000"), valid: true }
      : { checked: false, text: "", valid: false }
  }
  if (type === "number") {
    return value?.kind === "number" && compareDecimalText(value.text, value.text) !== null
      ? { checked: false, text: value.text, valid: true }
      : { checked: false, text: "", valid: false }
  }
  if (type === "date") {
    return value?.kind === "text" && validatePropertyDate(value.text) === null
      ? { checked: false, text: value.text, valid: true }
      : { checked: false, text: "", valid: false }
  }
  if (type === "datetime") {
    const comparable = value?.kind === "text" ? comparablePropertyDateTime(value.text) : null
    return comparable
      ? { checked: false, text: comparable, valid: true }
      : { checked: false, text: "", valid: false }
  }
  if (type === "link") {
    return value?.kind === "text" && /^\[\[[^\[\]]+\]\]$/u.test(value.text)
      ? { checked: false, text: value.text, valid: true }
      : { checked: false, text: "", valid: false }
  }
  return value?.kind === "text"
    ? { checked: false, text: value.text, valid: true }
    : { checked: false, text: "", valid: false }
}
