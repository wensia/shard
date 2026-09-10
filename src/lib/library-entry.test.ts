import { describe, expect, it } from "vitest"

import type { LibraryTreeEntry } from "@/types"
import { libraryEntryName, libraryEntryTypeLabel, libraryNameError, sortLibraryEntries, type LibrarySortKey } from "./library-entry"

function entry(name: string, overrides: Partial<LibraryTreeEntry> = {}): LibraryTreeEntry {
  return { name, path: `notes/${name}`, kind: "markdown", size: 1, modifiedAt: "2026-09-08T00:00:00Z", ...overrides }
}

describe("new library filename limits", () => {
  it("counts Unicode characters without counting a supplied format suffix", () => {
    const name = "字".repeat(63) + "😀"
    expect(libraryNameError(name)).toBeNull()
    expect(libraryNameError(`${name}.shardtable.json`, ".shardtable.json")).toBeNull()
    expect(libraryNameError(`${name}字`, ".md")).toBe("名称最多 64 个字符（不含扩展名）。")
  })

  it("rejects names whose actual file bytes exceed the filesystem limit", () => {
    expect(libraryNameError("😀".repeat(63), ".md")).toBeNull()
    expect(libraryNameError("😀".repeat(64), ".md")).toBe("名称占用空间过长，请减少部分字符。")
  })

  it("still displays existing long filenames without changing them", () => {
    const name = "字".repeat(100)
    expect(libraryEntryName(entry(`${name}.md`))).toBe(name)
  })
})

describe("library entry display names", () => {
  it.each([
    ["项目.v2.md", "markdown", "项目.v2"],
    ["数据.CSV", "csv", "数据"],
    ["计划.shardmap.json", "mindmap", "计划"],
    ["计划.shardflow.json", "flowchart", "计划"],
    ["计划.shardcanvas.json", "canvas", "计划"],
    ["计划.shardtable.json", "table", "计划"],
    ["照片.JPEG", "image", "照片"],
    ["年度.报告.pdf", "file", "年度.报告"],
    ["资料.v2", "directory", "资料.v2"],
    ["计划.json", "mindmap", "计划.json"],
    ["文件", "file", "文件"],
    ["文件.", "file", "文件."],
    [".env", "file", ".env"],
    [".env.local", "file", ".env"],
    [".md", "markdown", ".md"],
    [".shardmap.json", "mindmap", ".shardmap.json"],
  ] as const)("shows %s without its format suffix", (name, kind, expected) => {
    expect(libraryEntryName({ name, kind })).toBe(expected)
  })

  it("keeps the existing type labels", () => {
    expect(libraryEntryTypeLabel("canvas")).toBe("旧混合画布")
    expect(libraryEntryTypeLabel("csv")).toBe("CSV 源文件")
    expect(libraryEntryTypeLabel("markdown")).toBe("Markdown")
  })
})

describe("library entry sorting", () => {
  it("sorts display names naturally without mutating the input or copying entries", () => {
    const ten = entry("项目10.md")
    const two = entry("项目2.shardtable.json", { kind: "table" })
    const one = entry("项目1.shardmap.json", { kind: "mindmap" })
    const entries = [ten, two, one]

    expect(sortLibraryEntries(entries, { key: "name", direction: "asc" })).toEqual([one, two, ten])
    expect(sortLibraryEntries(entries, { key: "name", direction: "desc" })).toEqual([ten, two, one])
    expect(entries).toEqual([ten, two, one])
    expect(sortLibraryEntries(entries, { key: "name", direction: "asc" })[0]).toBe(one)
  })

  it.each(["name", "kind", "size", "createdAt", "modifiedAt"] as LibrarySortKey[])("keeps directories first for %s in both directions", (key) => {
    const file = entry("A.md")
    const folder = entry("Z.folder", { kind: "directory", size: 0, modifiedAt: "" })
    for (const direction of ["asc", "desc"] as const) {
      expect(sortLibraryEntries([file, folder], { key, direction })).toEqual([folder, file])
    }
  })

  it("groups by the displayed type label and uses names within each type", () => {
    const csv = entry("资料.csv", { kind: "csv" })
    const markdownTen = entry("项目10.md")
    const markdownTwo = entry("项目2.md")
    const table = entry("资料.shardtable.json", { kind: "table" })
    const entries = [markdownTen, table, csv, markdownTwo]

    expect(sortLibraryEntries(entries, { key: "kind", direction: "asc" })).toEqual([table, csv, markdownTwo, markdownTen])
    expect(sortLibraryEntries(entries, { key: "kind", direction: "desc" })).toEqual([markdownTwo, markdownTen, csv, table])
  })

  it("sorts byte sizes numerically and keeps invalid sizes last in either direction", () => {
    const small = entry("小.md", { size: 2 })
    const large = entry("大.md", { size: 10 })
    const zero = entry("空.md", { size: 0 })
    const invalid = [entry("X.md", { size: Number.NaN }), entry("Y.md", { size: -1 }), entry("Z.md", { size: Number.POSITIVE_INFINITY })]

    expect(sortLibraryEntries([large, ...invalid, small, zero], { key: "size", direction: "asc" })).toEqual([zero, small, large, ...invalid])
    expect(sortLibraryEntries([large, ...invalid, small, zero], { key: "size", direction: "desc" })).toEqual([large, small, zero, ...invalid])
  })

  it.each(["createdAt", "modifiedAt"] as const)("sorts %s by actual time, keeping missing or invalid dates last", (key) => {
    const earlier = entry("早.md", { [key]: "2026-09-08T10:00:00+08:00" })
    const later = entry("晚.md", { [key]: "2026-09-08T03:00:00Z" })
    const missing = entry("X.md", { [key]: "" })
    const invalid = entry("Y.md", { [key]: "not-a-date" })
    const entries = [missing, later, invalid, earlier]

    expect(sortLibraryEntries(entries, { key, direction: "asc" })).toEqual([earlier, later, missing, invalid])
    expect(sortLibraryEntries(entries, { key, direction: "desc" })).toEqual([later, earlier, missing, invalid])
  })

  it("supports old snapshots with omitted or null creation times", () => {
    const known = entry("Z.md", { createdAt: "2026-09-08T00:00:00Z" })
    const omitted = entry("A.md")
    const empty = entry("B.md", { createdAt: null })
    expect(sortLibraryEntries([omitted, known, empty], { key: "createdAt", direction: "desc" })).toEqual([known, omitted, empty])
  })

  it("breaks equal values by name then path consistently across directions", () => {
    const alpha = entry("A.md")
    const firstPath = entry("B.md", { path: "notes/1/B.md" })
    const secondPath = entry("B.md", { path: "notes/2/B.md" })
    for (const direction of ["asc", "desc"] as const) {
      expect(sortLibraryEntries([secondPath, firstPath, alpha], { key: "size", direction })).toEqual([alpha, firstPath, secondPath])
    }
  })
})
