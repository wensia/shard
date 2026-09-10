import { deriveKind, deriveNoteTitle } from "@/lib/content-kind"
import type { Fragment, LibraryTreeEntry } from "@/types"

export interface FragmentFilters {
  tag: string | null
  month: string | null
  pinned: boolean
}

export const EMPTY_FRAGMENT_FILTERS: FragmentFilters = { tag: null, month: null, pinned: false }

export function isPublicStreamFragment(fragment: Fragment) {
  return !fragment.archived && !fragment.lockbox && deriveKind(fragment.tags) === "fragment"
}

export function matchesFragmentFilters(fragment: Fragment, filters: FragmentFilters) {
  return isPublicStreamFragment(fragment)
    && (!filters.tag || fragment.tags.includes(filters.tag))
    && (!filters.month || fragment.createdAt.slice(0, 7) === filters.month)
    && (!filters.pinned || fragment.pinned)
}

export function conversionTitle(fragment: Fragment) {
  const text = fragment.content.replace(/!\[[^\]]*\]\([^)]*\)/gu, "").trim()
  return deriveNoteTitle(text) || "未命名文档"
}

export function libraryDirectoryOptions(entries: LibraryTreeEntry[]) {
  const options = [{ value: "notes", label: "资料库根目录" }]
  const visit = (items: LibraryTreeEntry[]) => {
    for (const entry of items) {
      if (entry.kind !== "directory") continue
      options.push({ value: entry.path, label: entry.path.replace(/^notes\//u, "") })
      visit(entry.children ?? [])
    }
  }
  visit(entries)
  return options
}
