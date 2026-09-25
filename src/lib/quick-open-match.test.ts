import { describe, expect, it } from "vitest"

import {
  rankOpenItems,
  rankOpenItemsInBatches,
  rankOpenItemsWithStatus,
} from "@/lib/quick-open-match"
import { searchTargetKey, type SearchHit } from "@/lib/search-contract"

const vaultPath = "/vault"

function hit(title: string, path: string, updatedAt = "2026-09-01T00:00:00.000Z"): SearchHit {
  return {
    matchedFields: [],
    preview: [{ hit: false, text: path }],
    revealHint: "documentOnly",
    revision: null,
    tags: [],
    target: {
      archived: false,
      key: searchTargetKey(vaultPath, "public", path),
      kind: "document",
      objectId: path,
      path,
      scope: "public",
      vaultPath,
    },
    title,
    titleParts: [{ hit: false, text: title }],
    updatedAt,
  }
}

describe("rankOpenItems", () => {
  it("exact_title_beats_recent_weak_match", () => {
    const exact = hit("Project", "notes/exact.md")
    const weak = hit("Archive", "notes/project-archive.md")
    const recent = new Map([[weak.target.key, 10_000]])

    expect(rankOpenItems([weak, exact], "project", recent).map(({ title }) => title)).toEqual([
      "Project",
      "Archive",
    ])
  })

  it("worst_tier_tie_uses_total_quality", () => {
    const strongerTotal = hit("alpha beta notes", "notes/older.md", "2025-01-01T00:00:00.000Z")
    const weakerTotal = hit("x alpha beta", "notes/newer.md", "2026-09-01T00:00:00.000Z")
    const recent = new Map([[weakerTotal.target.key, 10_000]])

    expect(
      rankOpenItems([weakerTotal, strongerTotal], "alpha beta", recent).map(({ title }) => title)
    ).toEqual(["alpha beta notes", "x alpha beta"])
  })

  it("uses AND terms, maps pinyin hits to title parts and highlights path-only hits", () => {
    const report = hit("周报日记", "notes/weekly.md")
    const unrelated = hit("周会", "notes/daily.md")
    const pathOnly = hit("归档", "notes/weekly-project.md")

    const pinyin = rankOpenItems([report, unrelated], "zbrj", new Map())
    expect(pinyin).toHaveLength(1)
    expect(pinyin[0].titleParts).toEqual([{ hit: true, text: "周报日记" }])

    const path = rankOpenItems([pathOnly], "weekly project", new Map())
    expect(path).toHaveLength(1)
    expect(path[0].matchedFields).toEqual(["path"])
    expect(path[0].preview.filter(({ hit: isHit }) => isHit).map(({ text }) => text)).toEqual([
      "weekly",
      "project",
    ])
  })

  it("ranks a large catalog in yielding batches without changing order", async () => {
    const items = Array.from({ length: 450 }, (_, index) =>
      hit(`项目 ${index}`, `notes/${index}.md`)
    )
    const sync = rankOpenItems(items, "项目 42", new Map())
    const batched = await rankOpenItemsInBatches(items, "项目 42", new Map(), 50)

    expect(batched.pinyinDegraded).toBe(false)
    expect(batched.hits.map(({ target }) => target.key)).toEqual(
      sync.map(({ target }) => target.key)
    )
  })

  it("preserves explicit pinyin degradation when the fixed work budget is exhausted", () => {
    const pathological = hit("重".repeat(2_000), "notes/pathological.md")

    expect(rankOpenItemsWithStatus([pathological], "x", new Map())).toEqual({
      hits: [],
      pinyinDegraded: true,
    })
  })
})
