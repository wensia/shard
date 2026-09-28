import { describe, expect, it } from "vitest"

import {
  buildOpenCatalog,
  getOpenCatalogLoadState,
  type OpenCatalogInput,
} from "@/lib/quick-open-catalog"
import { parseMindMapOutline } from "@/lib/mind-map-outline"
import type { CanvasFile } from "@/features/canvas/model"
import type { Fragment, LibraryTreeEntry, LibraryTreeSnapshot } from "@/types"

const vaultPath = "/vault"

function fragment(overrides: Partial<Fragment> = {}): Fragment {
  return {
    archived: false,
    category: null,
    content: "正文",
    createdAt: "2026-09-01T00:00:00.000Z",
    error: null,
    gitStatus: "saved",
    id: "fragment-id",
    kind: "fragment",
    lockbox: false,
    path: "fragments/2026/09/fragment.md",
    pinned: false,
    tags: [],
    updatedAt: "2026-09-02T00:00:00.000Z",
    ...overrides,
  }
}

function entry(overrides: Partial<LibraryTreeEntry> = {}): LibraryTreeEntry {
  return {
    kind: "markdown",
    modifiedAt: "2026-09-03T00:00:00.000Z",
    name: "文档.md",
    path: "notes/文档.md",
    size: 12,
    ...overrides,
  }
}

function tree(
  entries: LibraryTreeEntry[] = [],
  trashEntries: LibraryTreeEntry[] = []
): LibraryTreeSnapshot {
  return {
    assets: [],
    entries,
    fragmentStream: { totalCount: 0, years: [] },
    fragmentTrashEntries: [],
    trashEntries,
  }
}

function input(overrides: Partial<OpenCatalogInput> = {}): OpenCatalogInput {
  return {
    csvFiles: [],
    fragments: [],
    libraryTree: tree(),
    mindMaps: [],
    scope: "public",
    vaultPath,
    ...overrides,
  }
}

describe("buildOpenCatalog", () => {
  it("open_catalog_excludes_fragments_and_trash", () => {
    const hits = buildOpenCatalog(input({
      fragments: [
        fragment({ id: "plain", kind: "document", tags: [] }),
        fragment({
          archived: true,
          id: "trash-document",
          path: ".trash/fragments/document.md",
          tags: ["document"],
        }),
        fragment({
          id: "private-document",
          lockbox: true,
          path: "lockbox/fragments/private.shard",
          tags: ["document"],
        }),
        fragment({
          content: "# 公开笔记",
          id: "note",
          path: "notes/public.md",
          tags: ["note"],
        }),
      ],
      libraryTree: tree(
        [
          entry({ name: "无法确认.md", path: "notes/unknown.md" }),
          entry({ kind: "csv", name: "数据.csv", path: "notes/数据.csv" }),
        ],
        [entry({ kind: "csv", name: "回收.csv", path: ".trash/回收.csv" })]
      ),
    }))

    expect(hits.map(({ target }) => target.path)).toEqual([
      "notes/public.md",
      "notes/数据.csv",
    ])
    expect(hits.every(({ target }) => !target.archived)).toBe(true)
  })

  it("open_catalog_keeps_outline_and_document", () => {
    const hits = buildOpenCatalog(input({
      fragments: [
        fragment({
          content: "- 产品路线\n  - 搜索改版",
          id: "outline-id",
          kind: "fragment",
          path: "fragments/2026/09/outline.md",
          tags: ["outline"],
        }),
        fragment({
          content: "# 搜索设计\n\n正文",
          id: "document-id",
          kind: "fragment",
          path: "fragments/2026/09/document.md",
          tags: ["document"],
        }),
      ],
      libraryTree: tree([
        entry({ name: "错误泛型.md", path: "fragments/2026/09/outline.md" }),
      ]),
    }))

    expect(hits.map(({ target, title }) => ({
      id: target.objectId,
      kind: target.kind,
      title,
    }))).toEqual([
      { id: "outline-id", kind: "outline", title: "产品路线" },
      { id: "document-id", kind: "document", title: "搜索设计" },
    ])
  })

  it("uses JSON outline roots and preserves legacy fallback semantics", () => {
    const jsonFile = parseMindMapOutline("- JSON 根标题\n  - 子节点").file
    expect(jsonFile).not.toBeNull()

    const oversizedLegacy = [
      "- 旧式根标题",
      ...Array.from({ length: 201 }, (_, index) => `  - 子节点 ${index}`),
    ].join("\n")
    const hits = buildOpenCatalog(input({
      fragments: [
        fragment({
          content: `- 不能当标题的前置正文\n\n\`\`\`shardmap\n${JSON.stringify(jsonFile)}\n\`\`\``,
          id: "json-outline",
          path: "fragments/2026/09/json-outline.md",
          tags: ["outline"],
        }),
        fragment({
          content: "```shardmap\n{not json}\n```",
          id: "invalid-outline",
          path: "fragments/2026/09/非法大纲.md",
          tags: ["outline"],
        }),
        fragment({
          content: oversizedLegacy,
          id: "legacy-outline",
          path: "fragments/2026/09/legacy-outline.md",
          tags: ["outline"],
        }),
      ],
    }))

    expect(Object.fromEntries(hits.map(({ target, title }) => [target.objectId, title])))
      .toEqual({
        "invalid-outline": "非法大纲",
        "json-outline": "JSON 根标题",
        "legacy-outline": "旧式根标题",
      })
  })

  it("uses the embedded JSON flowchart title", () => {
    const file: CanvasFile = {
      kind: "shard.flow",
      schemaVersion: 1,
      id: "flow-file",
      title: "发布流程",
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
      revision: 0,
      nodes: [],
      edges: [],
    }
    const [hit] = buildOpenCatalog(input({
      fragments: [fragment({
        content: `\`\`\`shardflow\n${JSON.stringify(file)}\n\`\`\``,
        id: "flowchart-id",
        path: "fragments/2026/09/flowchart.md",
        tags: ["flowchart"],
      })],
    }))

    expect(hit).toMatchObject({
      target: { kind: "flowchart", objectId: "flowchart-id" },
      title: "发布流程",
    })
  })

  it("deduplicates summaries by vault, scope and path without losing semantic metadata", () => {
    const hits = buildOpenCatalog(input({
      csvFiles: [{ name: "客户.csv", path: "notes/客户.csv" }],
      libraryTree: tree([
        entry({ kind: "csv", name: "客户.csv", path: "notes/客户.csv" }),
        entry({
          kind: "mindmap",
          mindMapId: "tree-map",
          name: "路线.shardmap.json",
          path: "notes/路线.shardmap.json",
        }),
      ]),
      mindMaps: [{
        createdAt: "2026-09-01T00:00:00.000Z",
        id: "map-id",
        nodeCount: 3,
        path: "notes/路线.shardmap.json",
        title: "产品路线",
        updatedAt: "2026-09-04T00:00:00.000Z",
      }],
    }))

    expect(hits).toHaveLength(2)
    expect(hits.find(({ target }) => target.kind === "csv")?.updatedAt).toBe(
      "2026-09-03T00:00:00.000Z"
    )
    expect(hits.find(({ target }) => target.kind === "mindmap")).toMatchObject({
      target: { objectId: "map-id" },
      title: "产品路线",
    })
  })

  it("builds a lockbox catalog only from unlocked private fragment state", () => {
    const hits = buildOpenCatalog(input({
      fragments: [
        fragment({ id: "public", path: "notes/public.md", tags: ["note"] }),
        fragment({
          id: "private",
          lockbox: true,
          path: "lockbox/notes/private.shard",
          tags: ["document"],
        }),
      ],
      libraryTree: tree([
        entry({ kind: "csv", name: "公开.csv", path: "notes/public.csv" }),
      ]),
      scope: "lockbox",
    }))

    expect(hits.map(({ target }) => ({ path: target.path, scope: target.scope }))).toEqual([
      { path: "lockbox/notes/private.shard", scope: "lockbox" },
    ])
  })

  it("distinguishes an unloaded directory from a loaded empty directory", () => {
    expect(getOpenCatalogLoadState({ libraryTree: null, scope: "public" })).toBe("partial")
    expect(getOpenCatalogLoadState({ libraryTree: tree(), scope: "public" })).toBe("ready")
    expect(getOpenCatalogLoadState({ libraryTree: null, scope: "lockbox" })).toBe("ready")
  })
})
