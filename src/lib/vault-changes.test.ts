import { describe, expect, it } from "vitest"

import type { Fragment, LibraryTreeSnapshot } from "@/types"
import { planVaultChanges, type VaultFileChange } from "./vault-changes"

function fragment(path: string, fileSha: string): Fragment {
  return {
    id: path, content: "", fileSha, kind: "fragment", createdAt: "", updatedAt: "", tags: [],
    category: null, path, gitStatus: "committed", error: null, archived: false, lockbox: false,
    pinned: false,
  }
}

const tree: LibraryTreeSnapshot = {
  assets: [], trashEntries: [], fragmentStream: { totalCount: 0, years: [] },
  entries: [{
    name: "项目", path: "notes/项目", kind: "directory", size: 0, modifiedAt: "",
    children: [
      { name: "周报.md", path: "notes/项目/周报.md", kind: "markdown", size: 0, modifiedAt: "" },
      { name: "图.shardmap.json", path: "notes/项目/图.shardmap.json", kind: "mindmap", size: 0, modifiedAt: "" },
    ],
  }],
} as unknown as LibraryTreeSnapshot

const known = {
  fragments: [fragment("fragments/2026/10/a.md", "sha-a"), fragment("notes/项目/周报.md", "sha-note")],
  libraryTree: tree,
  csvFiles: [{ path: "datasets/阅读.csv" }] as never[],
}

const change = (path: string, sha: string | null, exists = sha !== null): VaultFileChange => ({ path, sha, exists })

describe("planVaultChanges", () => {
  it("ignores the app's own saves whose sha is already known", () => {
    const plan = planVaultChanges([change("fragments/2026/10/a.md", "sha-a"), change("notes/项目/周报.md", "sha-note")], known)
    expect(plan).toEqual({ fragments: false, libraryTree: false, mindMaps: false, csvFiles: false, datasets: [] })
  })

  it("reloads fragments when an external write changes content", () => {
    const plan = planVaultChanges([change("notes/项目/周报.md", "sha-new")], known)
    expect(plan.fragments).toBe(true)
    expect(plan.libraryTree).toBe(false)
  })

  it("treats new and deleted documents as structural", () => {
    expect(planVaultChanges([change("fragments/2026/10/b.md", "sha-b")], known)).toMatchObject({ fragments: true, libraryTree: true })
    expect(planVaultChanges([change("notes/项目/周报.md", null)], known)).toMatchObject({ fragments: true, libraryTree: true })
    // 已移入回收站、内存里不再在原路径的文件：删除事件不用再刷新。
    expect(planVaultChanges([change("fragments/2026/10/gone.md", null)], known)).toMatchObject({ fragments: false, libraryTree: false })
  })

  it("refreshes the tree only for structural library changes", () => {
    expect(planVaultChanges([change("notes/项目", null, true)], known).libraryTree).toBe(false)
    expect(planVaultChanges([change("notes/项目/图.shardmap.json", "sha-map")], known)).toMatchObject({ libraryTree: false, mindMaps: false })
    expect(planVaultChanges([change("notes/新目录", null, true)], known).libraryTree).toBe(true)
    expect(planVaultChanges([change("notes/项目/新图.shardmap.json", "sha")], known)).toMatchObject({ libraryTree: true, mindMaps: true })
    expect(planVaultChanges([change("notes/新目录", null, true)], { ...known, libraryTree: null }).libraryTree).toBe(false)
  })

  it("refreshes the tree when a library image is replaced in place", () => {
    const withImage = {
      ...known,
      libraryTree: {
        ...tree,
        entries: [{ name: "照片.jpg", path: "notes/照片.jpg", kind: "image", size: 1, modifiedAt: "" }],
      } as unknown as LibraryTreeSnapshot,
    }
    // 图片的 sha 不计算（null），存在即视为可能已被替换。
    expect(planVaultChanges([change("notes/照片.jpg", null, true)], withImage).libraryTree).toBe(true)
    expect(planVaultChanges([change("notes/照片.jpg", null, false)], withImage).libraryTree).toBe(true)
    expect(planVaultChanges([change("notes/说明.txt", null, false)], withImage).libraryTree).toBe(false)
  })

  it("hands csv paths to dataset views and refreshes the csv list on add or remove", () => {
    expect(planVaultChanges([change("datasets/阅读.csv", "sha")], known)).toMatchObject({ csvFiles: false, datasets: ["datasets/阅读.csv"] })
    expect(planVaultChanges([change("datasets/新.csv", "sha")], known)).toMatchObject({ csvFiles: true, datasets: ["datasets/新.csv"] })
    expect(planVaultChanges([change("datasets/阅读.csv", null)], known).csvFiles).toBe(true)
  })
})
