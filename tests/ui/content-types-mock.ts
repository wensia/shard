import { expect, type Locator, type Page } from "@playwright/test"
import type { CanvasFile } from "../../src/features/canvas/model"
import type {
  OutlineUpgradePreflightItem,
  OutlineUpgradeRunResult,
  ShardMapFile,
} from "../../src/types"

import { installSearchIpcMock } from "./search-ipc-mock"

/**
 * 内容类型工作台共用 mock（产品框架 §2）。
 *
 * content-types.spec.ts 与 rich-surfaces.spec.ts 共用这一份：样本同时保留旧式大纲
 * 与 JSON 大纲，Tauri command 清单只有一处，新增命令时不会漏掉某个 spec。
 * 跑真实工作台路由 + 内存 vault；不写用户的任何文件。
 */

export interface TestCall {
  command: string
  args: Record<string, unknown>
}

/** 非规范的 `*` 列表：打开富文本再保存时应被归一为 `- `。 */
export const CARD_FRAGMENT = ["#灵感 随手记的碎片", "", "* 非规范列表"].join("\n")
export const CARD_OUTLINE = ["- 项目大纲", "  - 第一步", "  - 第二步"].join("\n")
const OUTLINE_STAMP = "2026-09-10T08:00:00.000Z"
export const CARD_JSON_OUTLINE_FILE: ShardMapFile = {
  kind: "shard.map",
  schemaVersion: 1,
  id: "card-json-outline",
  title: "JSON 项目大纲",
  createdAt: OUTLINE_STAMP,
  updatedAt: OUTLINE_STAMP,
  savedWithAppVersion: "0.1.3",
  revision: 1,
  rootId: "json-root",
  hasProtectedLinks: false,
  nodes: {
    "json-root": {
      id: "json-root",
      parentId: null,
      sortKey: "00",
      text: "JSON 项目大纲",
      createdAt: OUTLINE_STAMP,
      updatedAt: OUTLINE_STAMP,
    },
    "json-child": {
      id: "json-child",
      parentId: "json-root",
      sortKey: "00",
      text: "JSON 第一步",
      createdAt: OUTLINE_STAMP,
      updatedAt: OUTLINE_STAMP,
    },
  },
}
export const CARD_JSON_OUTLINE = [
  "```shardmap",
  JSON.stringify(CARD_JSON_OUTLINE_FILE),
  "```",
].join("\n")
export const CARD_JSON_FLOWCHART_FILE: CanvasFile = {
  kind: "shard.flow",
  schemaVersion: 1,
  id: "card-json-flowchart",
  title: "发布流程",
  createdAt: OUTLINE_STAMP,
  updatedAt: OUTLINE_STAMP,
  revision: 1,
  nodes: [
    { id: "flow-start", kind: "terminal", x: 80, y: 80, text: "开始" },
    { id: "flow-review", kind: "process", x: 320, y: 80, text: "审核" },
  ],
  edges: [{ id: "flow-edge", source: "flow-start", target: "flow-review", label: "" }],
}
export const CARD_JSON_FLOWCHART = [
  "```shardflow",
  JSON.stringify(CARD_JSON_FLOWCHART_FILE),
  "```",
].join("\n")
export const CARD_DOCUMENT = [
  "# 季度复盘",
  "",
  "本季度完成了三件事。",
  "- 第一件是把速记框换成富文本",
  "- 第二件是补齐围栏块",
].join("\n")

interface MockBodies {
  documentBody: string
  flowchartBody: string
  flowchartFile: CanvasFile
  fragmentBody: string
  jsonOutlineBody: string
  jsonOutlineFile: ShardMapFile
  outlineBody: string
}

interface ContentTypesMockControl {
  nextGraphCreateError: boolean
  nextFragmentWriteStale: null | {
    content: string
    id: string
    tags?: string[]
  }
  nextGraphWriteStale: null | {
    file: ShardMapFile | CanvasFile
    id: string
  }
}

export async function installContentTypesMock(page: Page) {
  await installSearchIpcMock(page)
  await page.addInitScript(
    ({ documentBody, flowchartBody, flowchartFile, fragmentBody, jsonOutlineBody, jsonOutlineFile, outlineBody }: MockBodies) => {
      const now = "2026-09-10T08:00:00.000Z"
      const fragments = [
        {
          id: "card-fragment", path: "fragments/card-fragment.md",
          content: fragmentBody, tags: ["inbox", "灵感"],
        },
        {
          id: "card-outline", path: "fragments/card-outline.md",
          content: outlineBody, tags: ["inbox", "outline"],
        },
        {
          id: "card-json-outline", path: "fragments/card-json-outline.md",
          content: jsonOutlineBody, tags: ["inbox", "outline"],
        },
        {
          id: "card-document", path: "fragments/card-document.md",
          content: documentBody, tags: ["inbox", "document"],
        },
        {
          id: "card-json-flowchart", path: "fragments/card-json-flowchart.md",
          content: flowchartBody, tags: ["inbox", "flowchart"],
        },
        {
          id: "card-invalid-flowchart", path: "fragments/card-invalid-flowchart.md",
          content: "流程图原始正文", tags: ["inbox", "flowchart"],
        },
      ].map((fragment) => ({
        ...fragment, createdAt: now, updatedAt: now, category: null,
        gitStatus: "committed", error: null, archived: false, lockbox: false,
        pinned: false, related: [], fileSha: `file-sha-${fragment.id}-1`,
      }))
      const git = {
        branch: "main", shortCommit: "abc1234", hasRemote: false,
        status: "ready", error: null, ahead: 0, behind: 0,
      }
      const state = {
        vaultPath: "/tmp/shard-content-types-mock-vault", fragments, git,
        lockbox: { configured: false, unlocked: false, expiresAt: null, ttlSeconds: 900 },
      }
      const tree = {
        entries: [], assets: [], trashEntries: [], fragmentTrashEntries: [],
        fragmentStream: { totalCount: fragments.length, years: [] },
      }
      const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T
      const calls: TestCall[] = []
      const graphFiles: Record<string, ShardMapFile | CanvasFile> = {
        "card-json-outline": clone(jsonOutlineFile),
        "card-json-flowchart": clone(flowchartFile),
      }
      const control: ContentTypesMockControl = {
        nextGraphCreateError: false,
        nextFragmentWriteStale: null,
        nextGraphWriteStale: null,
      }
      let callbackId = 0
      let createdCount = 0
      let createdGraphCount = 0
      let savedRevision = 1
      const graphBody = (file: ShardMapFile | CanvasFile) =>
        [file.kind === "shard.map" ? "```shardmap" : "```shardflow", JSON.stringify(file), "```"].join("\n")
      const outlineUpgradeItems = (): OutlineUpgradePreflightItem[] => {
        const legacyOutline = fragments.find((fragment) => fragment.id === "card-outline")
        return [
          ...(legacyOutline && !legacyOutline.content.includes("```shardmap") ? [{
            id: legacyOutline.id,
            path: legacyOutline.path,
            title: "项目大纲",
            fileSha: legacyOutline.fileSha,
            nodeCount: 3,
            status: "lossless" as const,
            issues: [],
            reason: null,
          }] : []),
          {
            id: "card-outline-lossy",
            path: "fragments/card-outline-lossy.md",
            title: "带备注的大纲",
            fileSha: "file-sha-card-outline-lossy-1",
            nodeCount: 2,
            status: "lossy",
            issues: [{
              kind: "discardedNonListLine",
              count: 1,
              samples: ["这行备注会被丢弃"],
            }],
            reason: null,
          },
          {
            id: "card-outline-blocked",
            path: "fragments/card-outline-blocked.md",
            title: "空大纲",
            fileSha: "file-sha-card-outline-blocked-1",
            nodeCount: 0,
            status: "blocked",
            issues: [],
            reason: "没有任何有效行",
          },
        ]
      }
      Object.assign(globalThis, {
        isTauri: true,
        __SHARD_TYPE_CALLS__: calls,
        __SHARD_TYPE_CONTROL__: control,
        __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener() {} },
        __TAURI_INTERNALS__: {
          metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
          transformCallback: () => ++callbackId,
          invoke: async (command: string, args: Record<string, unknown> = {}) => {
            calls.push({ command, args: clone(args) })
            switch (command) {
              case "plugin:event|listen": return ++callbackId
              case "plugin:event|unlisten":
              case "set_canvas_grab_cursor":
              case "set_reminder_schedule":
              case "unhide_pointer":
              case "set_window_controls_hidden": return null
              case "plugin:app|version": return "0.1.3"
              case "list_fragments": return clone(state)
              case "list_csv_files":
              case "list_mind_maps":
              case "list_diagram_documents": return []
              case "list_library_tree": return clone(tree)
              case "migrate_legacy_notes": return { tree: clone(tree), migratedCount: 0 }
              case "sync_vault": return clone(git)
              case "checkpoint_vault":
                return { status: "no_changes", changes: 0, reason: null, git: clone(git) }
              case "preflight_outline_upgrade": return clone(outlineUpgradeItems())
              case "run_outline_upgrade": {
                const requested = (args.items ?? []) as Array<{ id: string; fileSha: string }>
                const preflightById = new Map(outlineUpgradeItems().map((item) => [item.id, item]))
                const results: OutlineUpgradeRunResult["results"] = []
                for (const item of requested) {
                  const preflight = preflightById.get(item.id)
                  const fragment = fragments.find((candidate) => candidate.id === item.id)
                  if (!preflight || !fragment) {
                    results.push({
                      id: item.id,
                      path: preflight?.path ?? null,
                      status: "skipped",
                      reason: "碎片不存在",
                      issues: preflight?.issues ?? [],
                    })
                    continue
                  }
                  if (item.fileSha !== fragment.fileSha) {
                    results.push({
                      id: item.id,
                      path: fragment.path,
                      status: "skipped",
                      reason: "已被修改",
                      issues: preflight.issues,
                    })
                    continue
                  }
                  const graph: ShardMapFile = {
                    kind: "shard.map",
                    schemaVersion: 1,
                    id: fragment.id,
                    title: "项目大纲",
                    createdAt: fragment.createdAt,
                    updatedAt: now,
                    savedWithAppVersion: "0.1.3",
                    revision: 1,
                    rootId: "n0",
                    hasProtectedLinks: false,
                    nodes: {
                      n0: { id: "n0", parentId: null, sortKey: "00", text: "项目大纲", createdAt: fragment.createdAt, updatedAt: now },
                      n1: { id: "n1", parentId: "n0", sortKey: "00", text: "第一步", createdAt: fragment.createdAt, updatedAt: now },
                      n2: { id: "n2", parentId: "n0", sortKey: "01", text: "第二步", createdAt: fragment.createdAt, updatedAt: now },
                    },
                  }
                  graphFiles[fragment.id] = graph
                  fragment.content = graphBody(graph)
                  fragment.updatedAt = now
                  fragment.fileSha = `file-sha-${fragment.id}-upgraded`
                  results.push({
                    id: fragment.id,
                    path: fragment.path,
                    status: "upgraded",
                    reason: null,
                    issues: preflight.issues,
                  })
                }
                return clone({
                  results,
                  backupPath: null,
                  checkpointStatus: "committed",
                  commitError: null,
                } satisfies OutlineUpgradeRunResult)
              }
              case "github_cli_status":
                return { installed: true, authenticated: true, login: "shard-test", protocol: "https", error: null }
              case "create_fragment": {
                const id = `typed-created-${++createdCount}`
                const created = {
                  id, path: `fragments/2026/09/${id}.md`, content: String(args.content ?? ""),
                  tags: (args.tags as string[]) ?? [], createdAt: now, updatedAt: now,
                  category: null, gitStatus: "saved", error: null,
                  archived: false, lockbox: false, pinned: false, related: [],
                  fileSha: `file-sha-${id}-1`,
                }
                fragments.unshift(created)
                return clone(created)
              }
              case "create_graph_fragment": {
                if (control.nextGraphCreateError) {
                  control.nextGraphCreateError = false
                  throw new Error("模拟流程图创建失败")
                }
                const id = `typed-graph-created-${++createdGraphCount}`
                const kind = String(args.kind ?? "")
                const graph = args.graph
                  ? clone(args.graph as ShardMapFile | CanvasFile)
                  : {
                      kind: "shard.flow" as const,
                      schemaVersion: 1 as const,
                      id,
                      title: "未命名流程图",
                      createdAt: now,
                      updatedAt: now,
                      revision: 0,
                      nodes: [],
                      edges: [],
                    }
                graph.id = id
                const tags = (args.tags as string[]) ?? []
                const created = {
                  id, path: `fragments/2026/09/${id}.md`, content: graphBody(graph),
                  tags: tags.includes(kind) ? tags : [...tags, kind], createdAt: now, updatedAt: now,
                  category: null, gitStatus: "saved", error: null,
                  archived: false, lockbox: false, pinned: false, related: [],
                  fileSha: `file-sha-${id}-1`,
                }
                graphFiles[id] = graph
                fragments.unshift(created)
                return clone({ fragment: created, graph })
              }
              case "read_graph_fragment": {
                const fragment = fragments.find((item) => item.id === args.id)
                const graph = graphFiles[String(args.id)]
                if (!fragment || !graph) throw new Error("Graph fragment not found")
                return clone({ fragment, graph })
              }
              case "write_graph_fragment": {
                const id = String(args.id)
                const fragment = fragments.find((item) => item.id === id)
                if (!fragment || !graphFiles[id]) throw new Error("Graph fragment not found")
                if (control.nextGraphWriteStale?.id === id) {
                  const remote = clone(control.nextGraphWriteStale.file)
                  control.nextGraphWriteStale = null
                  graphFiles[id] = remote
                  fragment.content = graphBody(remote)
                  fragment.fileSha = `file-sha-${id}-remote`
                  throw new Error("STALE_BASE:磁盘上的笔记内容已变化（可能来自同步或外部编辑），保存已中止")
                }
                if (args.expectedFileSha !== undefined && args.expectedFileSha !== fragment.fileSha) {
                  throw new Error("STALE_BASE:磁盘上的笔记内容已变化（可能来自同步或外部编辑），保存已中止")
                }
                const requested = clone(args.graph as ShardMapFile | CanvasFile)
                const current = graphFiles[id]
                const graph = requested.kind === "shard.map"
                  ? requested
                  : {
                      ...requested,
                      createdAt: current.createdAt,
                      updatedAt: now,
                      revision: current.revision + 1,
                    }
                graphFiles[id] = graph
                fragment.content = graphBody(graph)
                fragment.fileSha = `file-sha-${id}-${++savedRevision}`
                return clone({ fragment, graph })
              }
              case "update_fragment": {
                const fragment = fragments.find((item) => item.id === args.id)
                if (!fragment) throw new Error("Fragment not found")
                if (control.nextFragmentWriteStale?.id === fragment.id) {
                  const remote = control.nextFragmentWriteStale
                  control.nextFragmentWriteStale = null
                  fragment.content = remote.content
                  fragment.tags = remote.tags ?? fragment.tags
                  fragment.fileSha = `file-sha-${fragment.id}-remote`
                  throw new Error("STALE_BASE:磁盘上的笔记内容已变化（可能来自同步或外部编辑），保存已中止")
                }
                if (args.expectedFileSha !== undefined && args.expectedFileSha !== fragment.fileSha) {
                  throw new Error("STALE_BASE:磁盘上的笔记内容已变化（可能来自同步或外部编辑），保存已中止")
                }
                fragment.content = String(args.content ?? fragment.content)
                fragment.tags = (args.tags as string[]) ?? fragment.tags
                fragment.fileSha = `file-sha-${fragment.id}-${++savedRevision}`
                return clone(fragment)
              }
              default: throw new Error(`Unhandled Tauri test command: ${command}`)
            }
          },
        },
      })
    },
    {
      documentBody: CARD_DOCUMENT,
      flowchartBody: CARD_JSON_FLOWCHART,
      flowchartFile: CARD_JSON_FLOWCHART_FILE,
      fragmentBody: CARD_FRAGMENT,
      jsonOutlineBody: CARD_JSON_OUTLINE,
      jsonOutlineFile: CARD_JSON_OUTLINE_FILE,
      outlineBody: CARD_OUTLINE,
    }
  )
}

export function readTypeCalls(page: Page) {
  return page.evaluate(() => {
    const calls = (globalThis as typeof globalThis & { __SHARD_TYPE_CALLS__: TestCall[] })
      .__SHARD_TYPE_CALLS__
    return calls.map((call) => ({ command: call.command, args: call.args }))
  })
}

export async function createdFragments(page: Page) {
  const calls = await readTypeCalls(page)
  return calls
    .filter((call) => call.command === "create_fragment")
    .map((call) => ({
      content: String(call.args.content ?? ""),
      tags: (call.args.tags as string[]) ?? [],
    }))
}

export async function createdGraphFragments(page: Page) {
  const calls = await readTypeCalls(page)
  return calls
    .filter((call) => call.command === "create_graph_fragment")
    .map((call) => ({
      graph: call.args.graph as ShardMapFile,
      kind: String(call.args.kind ?? ""),
      operationId: String(call.args.operationId ?? ""),
      tags: (call.args.tags as string[]) ?? [],
    }))
}

export async function lastGraphWrite(page: Page, fragmentId: string) {
  const calls = await readTypeCalls(page)
  return calls
    .filter((call) => call.command === "write_graph_fragment" && call.args.id === fragmentId)
    .at(-1) ?? null
}

export async function graphWrites(page: Page, fragmentId: string) {
  const calls = await readTypeCalls(page)
  return calls.filter(
    (call) => call.command === "write_graph_fragment" && call.args.id === fragmentId
  )
}

export async function lastFragmentWrite(page: Page, fragmentId: string) {
  const calls = await readTypeCalls(page)
  return calls
    .filter((call) => call.command === "update_fragment" && call.args.id === fragmentId)
    .at(-1) ?? null
}

export async function queueFragmentStale(
  page: Page,
  id: string,
  content: string,
  tags?: string[]
) {
  await page.evaluate(({ content, id, tags }) => {
    const root = globalThis as typeof globalThis & {
      __SHARD_TYPE_CONTROL__: ContentTypesMockControl
    }
    root.__SHARD_TYPE_CONTROL__.nextFragmentWriteStale = { content, id, tags }
  }, { content, id, tags })
}

export async function queueGraphStale(page: Page, id: string, file: ShardMapFile | CanvasFile) {
  await page.evaluate(({ file, id }) => {
    const root = globalThis as typeof globalThis & {
      __SHARD_TYPE_CONTROL__: ContentTypesMockControl
    }
    root.__SHARD_TYPE_CONTROL__.nextGraphWriteStale = { file, id }
  }, { file, id })
}

export async function failNextGraphCreate(page: Page) {
  await page.evaluate(() => {
    const root = globalThis as typeof globalThis & {
      __SHARD_TYPE_CONTROL__: ContentTypesMockControl
    }
    root.__SHARD_TYPE_CONTROL__.nextGraphCreateError = true
  })
}

/** 某条碎片最近一次落盘的正文与标签。 */
export async function lastSavedFragment(page: Page, fragmentId: string) {
  const calls = await readTypeCalls(page)
  const save = calls
    .filter((call) => call.command === "update_fragment" && call.args.id === fragmentId)
    .at(-1)
  if (!save) return null
  return {
    content: String(save.args.content ?? ""),
    tags: (save.args.tags as string[]) ?? [],
  }
}

/** 只滚动碎片流 viewport；content-visibility:auto 的卡片必须先进视口才有布局。 */
export async function revealCard(target: Locator) {
  await expect(target).toHaveCount(1)
  await target.evaluate((element) => {
    const viewport = element.closest<HTMLElement>('[data-slot="scroll-area-viewport"]')
    if (!viewport) return
    viewport.scrollTop += element.getBoundingClientRect().top - viewport.getBoundingClientRect().top
  })
}

export function card(page: Page, id: string) {
  return page.locator(`[data-shard-fragment-id="${id}"]`)
}
