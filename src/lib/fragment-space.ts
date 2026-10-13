import { deriveKind, isStreamKind, type ContentKind } from "@/lib/content-kind"
import { matchesPropertyFilter, type PropertyFilter, type PropertyTypeEntries } from "@/lib/property-filter"
import type { Fragment } from "@/types"

export type FragmentFilterKind = Exclude<ContentKind, "note"> | null

export interface FragmentFilters {
  kind: FragmentFilterKind
  tag: string | null
  month: string | null
  pinned: boolean
  property: PropertyFilter | null
}

export const EMPTY_FRAGMENT_FILTERS: FragmentFilters = { kind: null, tag: null, month: null, pinned: false, property: null }

export function isPublicStreamFragment(fragment: Fragment) {
  // 碎片、大纲、文档同在一条时间线（产品框架 §3）；资料库笔记仍归资料库。
  return !fragment.archived && !fragment.lockbox && isStreamKind(deriveKind(fragment.tags))
}

export function matchesFragmentFilters(fragment: Fragment, filters: FragmentFilters, propertyTypes?: PropertyTypeEntries | null) {
  return isPublicStreamFragment(fragment)
    && (!filters.kind || deriveKind(fragment.tags) === filters.kind)
    && (!filters.tag || fragment.tags.includes(filters.tag))
    && (!filters.month || fragment.createdAt.slice(0, 7) === filters.month)
    && (!filters.pinned || fragment.pinned)
    && (!filters.property || matchesPropertyFilter(fragment, filters.property, propertyTypes))
}
