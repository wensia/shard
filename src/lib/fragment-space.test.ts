import { describe, expect, it } from "vitest"
import { conversionTitle, EMPTY_FRAGMENT_FILTERS, isPublicStreamFragment, matchesFragmentFilters } from "./fragment-space"
import type { Fragment } from "@/types"

const sample = (overrides: Partial<Fragment> = {}): Fragment => ({
  id: "fragment", content: "一条历史记录", kind: "fragment", createdAt: "2024-03-10T10:00:00Z", updatedAt: "2026-09-10T10:00:00Z",
  tags: ["想法"], category: null, path: "fragments/2026/09/fragment.md", gitStatus: "saved", error: null,
  archived: false, lockbox: false, pinned: false, ...overrides,
})

describe("fragment space ownership", () => {
  it("keeps historical fragments without an inbox tag and excludes documents and private or deleted content", () => {
    expect(isPublicStreamFragment(sample())).toBe(true)
    expect(isPublicStreamFragment(sample({ tags: ["inbox", "note"], kind: "note" }))).toBe(false)
    // 大纲与文档与碎片同在一条时间线（产品框架 §3）。
    expect(isPublicStreamFragment(sample({ tags: ["inbox", "outline"], kind: "outline" }))).toBe(true)
    expect(isPublicStreamFragment(sample({ tags: ["inbox", "document"], kind: "document" }))).toBe(true)
    expect(isPublicStreamFragment(sample({ lockbox: true }))).toBe(false)
    expect(isPublicStreamFragment(sample({ archived: true }))).toBe(false)
  })
  it("filters the original record month after moving back from documents", () => {
    expect(matchesFragmentFilters(sample(), { ...EMPTY_FRAGMENT_FILTERS, month: "2024-03" })).toBe(true)
    expect(matchesFragmentFilters(sample(), { ...EMPTY_FRAGMENT_FILTERS, month: "2026-09" })).toBe(false)
  })
  it("combines tags and pinned without changing ownership", () => {
    const filters = { ...EMPTY_FRAGMENT_FILTERS, tag: "想法", month: "2024-03", pinned: true }
    expect(matchesFragmentFilters(sample({ pinned: true }), filters)).toBe(true)
    expect(matchesFragmentFilters(sample(), filters)).toBe(false)
    expect(matchesFragmentFilters(sample({ tags: ["别的标签"], pinned: true }), filters)).toBe(false)
  })
  it("combines property filters with kind, tag, month, and pinned", () => {
    const candidate = sample({
      pinned: true,
      properties: [{ key: "评分", value: { kind: "number", text: "4.5" }, editable: true }],
    })
    const filters = {
      ...EMPTY_FRAGMENT_FILTERS,
      kind: "fragment" as const,
      tag: "想法",
      month: "2024-03",
      pinned: true,
      property: { key: "评分", op: "gte" as const, value: "4.5" },
    }
    const registry = { 评分: { type: "number" as const } }
    expect(matchesFragmentFilters(candidate, filters, registry)).toBe(true)
    expect(matchesFragmentFilters(candidate, { ...filters, tag: "别的标签" }, registry)).toBe(false)
    expect(matchesFragmentFilters(candidate, { ...filters, property: { key: "评分", op: "gt", value: "4.5" } }, registry)).toBe(false)
  })
  it("filters every stream content kind from type tags and keeps all as the default", () => {
    const fixtures = [
      sample(),
      sample({ id: "outline", kind: "outline", tags: ["outline"] }),
      sample({ id: "flowchart", kind: "flowchart", tags: ["flowchart"] }),
      sample({ id: "document", kind: "document", tags: ["document"] }),
    ]
    expect(fixtures.filter(fragment => matchesFragmentFilters(fragment, EMPTY_FRAGMENT_FILTERS))).toHaveLength(4)
    for (const kind of ["fragment", "outline", "flowchart", "document"] as const) {
      expect(fixtures.filter(fragment => matchesFragmentFilters(fragment, { ...EMPTY_FRAGMENT_FILTERS, kind })).map(fragment => fragment.id))
        .toEqual([kind === "fragment" ? "fragment" : kind])
    }
    expect(matchesFragmentFilters(
      sample({ tags: ["document", "flowchart"] }),
      { ...EMPTY_FRAGMENT_FILTERS, kind: "flowchart" }
    )).toBe(true)
  })
  it("uses a document title without turning an image URL into a file name", () => {
    expect(conversionTitle(sample({ content: "![图片](assets/photo.png)" }))).toBe("未命名文档")
    expect(conversionTitle(sample({ content: "![图片](assets/photo.png)\n\n# 决策记录" }))).toBe("决策记录")
  })
})
