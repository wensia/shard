import { expect, test, type Locator, type Page } from "@playwright/test"

import { applyFragmentTag } from "./fragment-filter-helpers"

import { fillEditor, readEditor, readEditorSnapshot, selectEditorText } from "./editor-helpers"
import { selectOption } from "./select-helpers"
import { mkdirSync, writeFileSync } from "node:fs"
import type { MindMapReadResult, ShardMapFile } from "../../src/types"
import { installSearchIpcMock } from "./search-ipc-mock"

async function createLibraryEntry(page: Page, name: "新建文档" | "新建目录" | "新建数据集") {
  const directory = page.getByRole("complementary", { name: "资料库目录" })
  if (!(await directory.isVisible())) await page.getByRole("button", { name: "返回资料库目录", exact: true }).click()
  await directory.getByRole("button", { name: "新建", exact: true }).click()
  await page.getByRole("menuitem", { name, exact: true }).click()
}

async function expectKilnControl(control: Locator, height: number) {
  const metrics = await control.evaluate(async element => {
    await document.fonts.ready
    const scope = element.closest('[role="dialog"]') ?? element
    await Promise.all(scope.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => undefined)))
    const style = getComputedStyle(element)
    return {
      radius: style.borderRadius,
      height: element.getBoundingClientRect().height,
      computedHeight: style.height,
      fontFamily: style.fontFamily,
      fontToken: style.getPropertyValue("--font-sans").replace(/\s+/gu, " ").trim(),
      notoLoaded: Array.from(document.fonts).some(font => font.family.includes("Noto Sans SC") && font.status === "loaded"),
    }
  })
  expect(metrics.radius).toBe("4px")
  expect(metrics.height).toBeCloseTo(height, 1)
  expect(metrics.computedHeight).toBe(`${height}px`)
  expect(metrics.fontFamily).toBe(metrics.fontToken)
  expect(metrics.fontFamily).toContain('"Noto Sans SC"')
  expect(metrics.notoLoaded).toBe(true)
  return metrics
}

interface LibraryCall {
  args: Record<string, unknown>
  command: string
}

interface LockboxMockState {
  configured: boolean
  unlocked: boolean
  expiresAt: string | null
  ttlSeconds: number
}

// 全局默认是「密匣未配置」的初始态；需要解锁态的用例自行传入覆盖，
// 不要改这里的默认值（否则未配置引导流程的用例会拿到错误前提）。
const DEFAULT_LOCKBOX_STATE: LockboxMockState = {
  configured: false,
  unlocked: false,
  expiresAt: null,
  ttlSeconds: 900,
}

async function installLibraryTreeMock(
  page: Page,
  lockboxState: LockboxMockState = DEFAULT_LOCKBOX_STATE,
  includeAssets = true
) {
  await installSearchIpcMock(page)
  await page.addInitScript(({ includeAssets, lockbox }: {
    includeAssets: boolean
    lockbox: LockboxMockState
  }) => {
    const now = "2026-08-30T10:00:00.000Z"
    const fragments = [
      {
        id: "fragment-august",
        content: "# 八月灵感\n碎片正文",
        createdAt: "2026-08-30T08:01:02.000Z",
        updatedAt: now,
        tags: ["inbox", "灵感"],
        category: null,
        path: "fragments/2026/08/20260830-080102.md",
        gitStatus: "committed",
        error: null,
        archived: false,
        lockbox: false,
        pinned: false,
        related: [],
      },
      {
        id: "fragment-july",
        content: "七月碎片",
        createdAt: "2026-07-12T08:00:00.000Z",
        updatedAt: now,
        tags: ["inbox"],
        category: null,
        path: "fragments/2026/07/20260712-080000.md",
        gitStatus: "committed",
        error: null,
        archived: false,
        lockbox: false,
        pinned: false,
        related: [],
      },
      {
        id: "fragment-archived",
        content: "回收站碎片正文",
        createdAt: "2026-06-12T08:00:00.000Z",
        updatedAt: now,
        tags: ["inbox"],
        category: null,
        path: ".trash/fragments/2026/06/20260612-080000.md",
        gitStatus: "committed",
        error: null,
        archived: true,
        lockbox: false,
        pinned: false,
        related: [],
      },
      {
        id: "note-plan",
        content: "# 项目计划\n\n从 [[旧笔记|打开笔记]] 继续",
        createdAt: "2026-08-28T08:00:00.000Z",
        updatedAt: now,
        tags: ["inbox", "note", "工作"],
        category: null,
        path: "notes/项目/项目计划.md",
        gitStatus: "committed",
        error: null,
        archived: false,
        lockbox: false,
        pinned: false,
        related: [],
      },
      {
        id: "note-old",
        content: "# 旧笔记\n\n待重命名",
        createdAt: "2026-08-27T08:00:00.000Z",
        updatedAt: now,
        tags: ["inbox", "note"],
        category: null,
        path: "notes/旧笔记.md",
        gitStatus: "committed",
        error: null,
        archived: false,
        lockbox: false,
        pinned: false,
        related: [],
      },
    ]
    const entries = [
      {
        name: "项目",
        path: "notes/项目",
        kind: "directory",
        size: 0,
        modifiedAt: now,
        children: [
          {
            name: "项目计划.md",
            path: "notes/项目/项目计划.md",
            kind: "markdown",
            size: 1_024,
            modifiedAt: now,
          },
        ],
      },
      {
        name: "旧笔记.md",
        path: "notes/旧笔记.md",
        kind: "markdown",
        size: 512,
        modifiedAt: now,
      },
      {
        name: "项目导图.shardmap.json",
        path: "notes/项目导图.shardmap.json",
        kind: "mindmap",
        mindMapId: "map-project",
        size: 768,
        modifiedAt: now,
      },
      {
        name: "清单.csv",
        path: "notes/清单.csv",
        kind: "csv",
        size: 256,
        modifiedAt: now,
      },
    ] as Array<Record<string, unknown>>
    const trashEntries = [
      {
        name: "notes",
        path: ".trash/notes",
        kind: "directory",
        size: 0,
        modifiedAt: now,
        children: [
          {
            name: "已删除文档.md",
            path: ".trash/notes/已删除文档.md",
            kind: "markdown",
            size: 128,
            modifiedAt: now,
          },
        ],
      },
    ] as Array<Record<string, unknown>>
    const mindMapSummary = {
      id: "map-project",
      title: "项目导图",
      createdAt: now,
      updatedAt: now,
      nodeCount: 1,
      path: "notes/项目导图.shardmap.json",
    }
    const mindMapFile = {
      kind: "shard.map",
      schemaVersion: 1,
      id: mindMapSummary.id,
      title: mindMapSummary.title,
      createdAt: now,
      updatedAt: now,
      savedWithAppVersion: "0.1.3-test",
      revision: 1,
      rootId: "root",
      hasProtectedLinks: false,
      nodes: {
        root: {
          id: "root",
          parentId: null,
          sortKey: "a",
          text: mindMapSummary.title,
          createdAt: now,
          updatedAt: now,
        },
      },
    }
    const calls: LibraryCall[] = []
    const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T
    const git = {
      branch: "main",
      shortCommit: "t6abc12",
      hasRemote: false,
      status: "ready",
      error: null,
      ahead: 0,
      behind: 0,
    }
    const snapshot = () => ({
      entries: clone(entries),
      fragmentEntries: fragments.filter(item => !item.archived && !item.lockbox && item.path.startsWith("fragments/")).map(item => ({
        name: item.path.split("/").pop(), path: item.path, kind: "markdown", size: new TextEncoder().encode(item.content).length,
        createdAt: item.createdAt, modifiedAt: item.updatedAt,
      })),
      assets: includeAssets
        ? [{
            path: "assets/a3/a3f5e8c9d2aa0000000000000000000000000000000000000000000000000000.png",
            size: 2_048,
            modifiedAt: "2026-08-29T09:08:07.000Z",
            mimeType: "image/png",
          }]
        : [],
      trashEntries: clone(trashEntries),
      fragmentTrashEntries: fragments.filter(item => item.archived && !item.tags.includes("note")).map(item => ({
        name: item.path.split("/").pop(), path: item.path, kind: "markdown", size: item.content.length, modifiedAt: item.updatedAt,
      })),
      fragmentStream: {
        totalCount: fragments.filter((item) => !item.tags.includes("note") && !item.archived).length,
        years: [
          {
            year: "2026",
            totalCount: fragments.filter((item) => !item.tags.includes("note") && !item.archived).length,
            months: [
              { month: "08", count: fragments.some((item) => item.id === "fragment-august") ? 1 : 0 },
              { month: "07", count: 1 },
            ].filter((item) => item.count > 0),
          },
        ],
      },
    })
    const removeEntry = (path: string, items = entries): Record<string, unknown> | null => {
      const index = items.findIndex((item) => item.path === path)
      if (index >= 0) return items.splice(index, 1)[0]
      for (const item of items) {
        const removed = removeEntry(path, (item.children as typeof entries | undefined) ?? [])
        if (removed) return removed
      }
      return null
    }
    const findEntry = (path: string, items = entries): Record<string, unknown> | null => {
      for (const item of items) {
        if (item.path === path) return item
        const found = findEntry(path, (item.children as typeof entries | undefined) ?? [])
        if (found) return found
      }
      return null
    }
    const rebaseEntryPaths = (
      entry: Record<string, unknown>,
      oldPrefix: string,
      nextPrefix: string
    ) => {
      entry.path = String(entry.path).replace(oldPrefix, nextPrefix)
      for (const child of (entry.children as typeof entries | undefined) ?? []) {
        rebaseEntryPaths(child, oldPrefix, nextPrefix)
      }
    }
    const trashDirectoryChildren = (originalDirectory: string) => {
      let children = trashEntries
      let path = ".trash"
      for (const part of originalDirectory.split("/").filter(Boolean)) {
        path = `${path}/${part}`
        let directory = children.find((entry) => entry.path === path)
        if (!directory) {
          directory = {
            name: part,
            path,
            kind: "directory",
            size: 0,
            modifiedAt: now,
            children: [],
          }
          children.push(directory)
        }
        children = (directory.children as typeof entries | undefined) ?? []
        directory.children = children
      }
      return children
    }
    const directoryChildren = (path: string) => {
      if (path === "notes") return entries
      const directory = findEntry(path)
      if (!directory) throw new Error(`Directory not found: ${path}`)
      const children = (directory.children as typeof entries | undefined) ?? []
      directory.children = children
      return children
    }
    const result = (fragment?: (typeof fragments)[number], updatedLinks = 0) => ({
      tree: snapshot(),
      ...(fragment ? { fragment: clone(fragment) } : {}),
      updatedLinks,
    })

    Object.assign(globalThis, {
      isTauri: true,
      __SHARD_LIBRARY_TREE_CALLS__: calls,
      __TAURI_INTERNALS__: {
        // 自定义协议：真实环境由 Tauri 注入，测试里回一个可辨识的占位地址。
        convertFileSrc: (path: string, scheme?: string) =>
          `${scheme ?? "asset"}://localhost/${path}`,
        invoke: async (command: string, args: Record<string, unknown> = {}) => {
          calls.push({ command, args: clone(args) })
          if (command === "list_fragments") {
            return clone({
              vaultPath: "/tmp/shard-library-tree-test",
              fragments,
              git,
              lockbox,
            })
          }
          if (command === "list_library_tree") return snapshot()
          if (command === "migrate_legacy_notes") {
            return { tree: snapshot(), migratedCount: 0 }
          }
          if (command === "list_mind_maps") return clone([mindMapSummary])
          if (command === "read_mind_map") {
            if (
              (globalThis as typeof globalThis & {
                __SHARD_FAIL_MIND_MAP_PREVIEW__?: boolean
              }).__SHARD_FAIL_MIND_MAP_PREVIEW__
            ) {
              throw new Error("Mind map preview failed")
            }
            return {
              file: clone(mindMapFile),
              path: mindMapSummary.path,
              lastSavedHash: "map-hash",
            }
          }
          if (command === "read_csv_file") {
            return Array.from(
              new TextEncoder().encode("事项,状态\r\n搭建预览,进行中")
            )
          }
          if (command === "read_fragment_image") {
            return "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs="
          }
          if (command === "save_fragment_image") {
            return `assets/${String(args.fileName)}`
          }
          if (command === "list_csv_files") return []
          if (command === "open_csv_file") return null
          if (command === "plugin:app|version") return "0.1.3-test"
          if (command === "sync_vault") return clone(git)
          if (command === "update_fragment") {
            const fragment = fragments.find((item) => item.id === args.id)
            if (!fragment) throw new Error("Fragment not found")
            fragment.content = String(args.content ?? fragment.content)
            fragment.tags = Array.isArray(args.tags) ? (args.tags as string[]) : fragment.tags
            return clone(fragment)
          }
          if (command === "create_library_directory") {
            const parentPath = String(args.parentPath)
            const name = String(args.name)
            directoryChildren(parentPath).push({
              name,
              path: `${parentPath}/${name}`,
              kind: "directory",
              size: 0,
              modifiedAt: now,
              children: [],
            })
            return result()
          }
          if (command === "create_library_note") {
            const parentPath = String(args.parentPath)
            const title = String(args.title)
            const children = directoryChildren(parentPath)
            let name = `${title}.md`
            for (let index = 2; children.some((entry) => entry.name === name); index += 1) {
              name = `${title}-${index}.md`
            }
            const fragment = {
              ...clone(fragments[0]),
              id: `note-created-${fragments.length}`,
              content: `# ${title}`,
              tags: ["inbox", "note"],
              path: `${parentPath}/${name}`,
            }
            fragments.push(fragment)
            children.push({
              name,
              path: fragment.path,
              kind: "markdown",
              size: 0,
              modifiedAt: now,
            })
            return result(fragment)
          }
          if (command === "rename_library_entry") {
            const oldPath = String(args.path)
            const newName = String(args.newName)
            const sourceFragment = fragments.find(item => item.path === oldPath && !item.archived && !item.lockbox)
            const entry = findEntry(oldPath) ?? (sourceFragment && oldPath.startsWith("fragments/") ? {
              name: oldPath.split("/").pop(), path: oldPath, kind: "markdown",
            } : null)
            if (!entry) throw new Error("Entry not found")
            const extension = String(entry.kind) === "markdown"
              ? ".md"
              : String(entry.kind) === "csv"
                ? ".csv"
                : String(entry.kind) === "mindmap"
                  ? ".shardmap.json"
                  : ""
            const parentPath = oldPath.slice(0, oldPath.lastIndexOf("/"))
            const nextPath = `${parentPath}/${newName}${extension}`
            entry.name = `${newName}${extension}`
            entry.path = nextPath
            if (String(entry.kind) === "mindmap") mindMapSummary.path = nextPath
            const fragment = fragments.find((item) => item.path === oldPath)
            if (fragment) {
              fragment.path = nextPath
              if (fragment.id === "note-old") fragment.content = "# 新笔记\n\n待重命名"
            }
            for (const item of fragments) {
              item.content = item.content.replaceAll("[[旧笔记]]", "[[新笔记]]").replaceAll("[[旧笔记|", "[[新笔记|")
            }
            return result(fragment, oldPath === "notes/旧笔记.md" ? 1 : 0)
          }
          if (command === "move_library_entry") {
            const oldPath = String(args.path)
            const destination = String(args.destinationDirectory)
            const entry = removeEntry(oldPath)
            if (!entry) throw new Error("Entry not found")
            const nextPath = `${destination}/${String(entry.name)}`
            entry.path = nextPath
            if (String(entry.kind) === "mindmap") mindMapSummary.path = nextPath
            directoryChildren(destination).push(entry)
            const fragment = fragments.find((item) => item.path === oldPath)
            if (fragment) fragment.path = nextPath
            return result(fragment)
          }
          if (command === "delete_library_entry") {
            const oldPath = String(args.path)
            const sourceFragment = fragments.find(item => item.path === oldPath && !item.archived && !item.lockbox)
            const entry = removeEntry(oldPath) ?? (sourceFragment && oldPath.startsWith("fragments/") ? {
              name: oldPath.split("/").pop(), path: oldPath, kind: "markdown", size: 128, modifiedAt: now,
            } : null)
            if (!entry) throw new Error("Entry not found")
            rebaseEntryPaths(entry, oldPath, `.trash/${oldPath}`)
            const parentPath = oldPath.slice(0, oldPath.lastIndexOf("/"))
            if (!oldPath.startsWith("fragments/")) trashDirectoryChildren(parentPath).push(entry)
            const fragment = fragments.find((item) => item.path === oldPath)
            if (fragment) {
              fragment.path = `.trash/${oldPath}`
              fragment.archived = true
            }
            return result()
          }
          if (command === "restore_from_trash") {
            const trashPath = String(args.path)
            if (trashPath.startsWith(".trash/fragments/")) {
              const fragment = fragments.find(item => item.path === trashPath)
              if (!fragment) throw new Error("Trash fragment not found")
              fragment.path = trashPath.replace(/^\.trash\//u, "")
              fragment.archived = false
              return result(fragment)
            }
            const entry = removeEntry(trashPath, trashEntries)
            if (!entry) throw new Error("Trash entry not found")
            const originalPath = trashPath.replace(/^\.trash\//u, "")
            rebaseEntryPaths(entry, trashPath, originalPath)
            const parentPath = originalPath.slice(0, originalPath.lastIndexOf("/"))
            directoryChildren(parentPath).push(entry)
            const fragment = fragments.find((item) => item.path === trashPath)
            if (fragment) {
              fragment.path = originalPath
              fragment.archived = false
            }
            return result()
          }
          if (command === "purge_from_trash") {
            removeEntry(String(args.path), trashEntries)
            const index = fragments.findIndex(item => item.path === args.path)
            if (index >= 0) fragments.splice(index, 1)
            return result()
          }
          if (command === "empty_trash") {
            const fragmentScope = args.scope === "fragments"
            if (!fragmentScope) trashEntries.splice(0)
            for (let index = fragments.length - 1; index >= 0; index -= 1) {
              if (fragments[index].archived && (args.scope === "all" || fragments[index].tags.includes("note") !== fragmentScope)) fragments.splice(index, 1)
            }
            return result()
          }
          if (command === "convert_fragment_to_note") {
            const fragment = fragments.find((item) => item.id === args.id)
            if (!fragment) throw new Error("Fragment not found")
            fragment.tags = [...fragment.tags, "note"]
            const directory = String(args.destinationDirectory ?? "notes")
            const title = String(args.title ?? "八月灵感")
            fragment.path = `${directory}/${title}.md`
            directoryChildren(directory).push({
              name: `${title}.md`,
              path: fragment.path,
              kind: "markdown",
              size: 0,
              modifiedAt: now,
            })
            return result(fragment)
          }
          if (command === "convert_note_to_fragment") {
            const fragment = fragments.find((item) => item.id === args.id)
            if (!fragment) throw new Error("Fragment not found")
            removeEntry(fragment.path)
            fragment.tags = fragment.tags.filter((tag) => tag !== "note")
            fragment.path = "fragments/2026/08/20260830-100000.md"
            const testState = globalThis as typeof globalThis & { __SHARD_REVERSE_FAIL_AFTER_MOVE__?: boolean }
            if (testState.__SHARD_REVERSE_FAIL_AFTER_MOVE__) {
              delete testState.__SHARD_REVERSE_FAIL_AFTER_MOVE__
              throw new Error("Response lost after note moved to fragments")
            }
            return result(fragment)
          }
          if (command === "move_fragment_to_lockbox") {
            const fragment = fragments.find((item) => item.id === args.id)
            if (!fragment) throw new Error("Fragment not found")
            removeEntry(fragment.path)
            fragment.path = fragment.path
              .replace(/^notes\//u, "lockbox/notes/")
              .replace(/\.md$/iu, ".shard")
            fragment.lockbox = true
            return clone({
              vaultPath: "/tmp/shard-library-tree-test",
              fragments,
              git,
              lockbox,
            })
          }
          throw new Error(`Unhandled Tauri test command: ${command}`)
        },
      },
    })
  }, { includeAssets, lockbox: lockboxState })
}

async function commandCalls(page: Page, command: string) {
  return page.evaluate((target) =>
    (
      globalThis as typeof globalThis & {
        __SHARD_LIBRARY_TREE_CALLS__?: LibraryCall[]
      }
    ).__SHARD_LIBRARY_TREE_CALLS__?.filter((call) => call.command === target) ?? [],
  command)
}

async function installGraphImportMock(
  page: Page,
  preloaded: { map?: boolean; flow?: boolean } = {}
) {
  await page.addInitScript(({ preloaded }) => {
    const runtime = window as unknown as {
      __TAURI_INTERNALS__: { invoke(command: string, args?: Record<string, unknown>): Promise<any> }
      __SHARD_LIBRARY_TREE_CALLS__: LibraryCall[]
      __graphImport: { fail: boolean; importedMap: boolean; importedFlow: boolean }
    }
    const original = runtime.__TAURI_INTERNALS__.invoke
    const now = "2026-09-28T08:00:00.000Z"
    const mapFile = {
      kind: "shard.map", schemaVersion: 1, id: "map-project", title: "项目导图",
      createdAt: now, updatedAt: now, savedWithAppVersion: "0.1.3-test", revision: 1,
      rootId: "root", hasProtectedLinks: false,
      nodes: { root: { id: "root", parentId: null, sortKey: "a", text: "项目导图", createdAt: now, updatedAt: now } },
    }
    const flowFile = {
      kind: "shard.flow", schemaVersion: 1, id: "flow-project", title: "审批流程",
      createdAt: now, updatedAt: now, revision: 1,
      nodes: [{ id: "start", kind: "process", x: 0, y: 0, text: "开始" }], edges: [],
    }
    const fragment = (kind: "outline" | "flowchart") => {
      const file = kind === "outline" ? mapFile : flowFile
      return {
        id: file.id,
        content: `\`\`\`${kind === "outline" ? "shardmap" : "shardflow"}\n${JSON.stringify(file, null, 2)}\n\`\`\``,
        fileSha: `${kind}-sha`, createdAt: now, updatedAt: now,
        tags: ["inbox", kind], category: null,
        path: `fragments/2026/09/${file.id}.md`, gitStatus: "committed", error: null,
        aiStatus: "none", archived: false, lockbox: false, pinned: false, related: [],
      }
    }
    const state = {
      fail: false,
      importedMap: Boolean(preloaded.map),
      importedFlow: Boolean(preloaded.flow),
    }
    runtime.__graphImport = state
    const filterEntries = (items: any[]): any[] => items
      .filter(entry => !(state.importedMap && entry.path === "notes/项目导图.shardmap.json"))
      .filter(entry => !(state.importedFlow && entry.path === "notes/审批流程.shardflow.json"))
      .map(entry => ({ ...entry, ...(entry.children ? { children: filterEntries(entry.children) } : {}) }))
    runtime.__TAURI_INTERNALS__.invoke = async (command, args = {}) => {
      if (command === "list_diagram_documents") return []
      if (command === "import_graph_file_to_timeline") {
        runtime.__SHARD_LIBRARY_TREE_CALLS__.push({ command, args: structuredClone(args) })
        if (state.fail) throw new Error("模拟加入时间线失败")
        const isMap = String(args.path).endsWith(".shardmap.json")
        if (isMap) state.importedMap = true
        else state.importedFlow = true
        return structuredClone(fragment(isMap ? "outline" : "flowchart"))
      }
      if (command === "read_graph_fragment") {
        const kind = args.id === "map-project" ? "outline" : "flowchart"
        return { fragment: structuredClone(fragment(kind)), graph: structuredClone(kind === "outline" ? mapFile : flowFile) }
      }
      const result = await original(command, args)
      if (command === "list_fragments") {
        const next = structuredClone(result)
        if (state.importedMap && !next.fragments.some((item: any) => item.id === mapFile.id)) next.fragments.push(fragment("outline"))
        if (state.importedFlow && !next.fragments.some((item: any) => item.id === flowFile.id)) next.fragments.push(fragment("flowchart"))
        return next
      }
      if (command === "list_library_tree") {
        const next = structuredClone(result)
        if (!next.entries.some((entry: any) => entry.path === "notes/审批流程.shardflow.json") && !state.importedFlow) {
          next.entries.push({ name: "审批流程.shardflow.json", path: "notes/审批流程.shardflow.json", kind: "flowchart", size: 512, modifiedAt: now })
        }
        if (!next.entries.some((entry: any) => entry.path === "notes/旧画布.shardcanvas.json")) {
          next.entries.push({ name: "旧画布.shardcanvas.json", path: "notes/旧画布.shardcanvas.json", kind: "canvas", size: 512, modifiedAt: now })
        }
        next.entries = filterEntries(next.entries)
        for (const [included, kind] of [[state.importedMap, "outline"], [state.importedFlow, "flowchart"]] as const) {
          if (!included) continue
          const item = fragment(kind)
          next.fragmentEntries.push({ name: `${item.id}.md`, path: item.path, kind: "markdown", size: 512, modifiedAt: now, createdAt: now })
        }
        const trashNotes = next.trashEntries.find((entry: any) => entry.path === ".trash/notes")
        if (trashNotes) {
          if (state.importedMap && !trashNotes.children.some((entry: any) => entry.path === ".trash/notes/项目导图.shardmap.json")) {
            trashNotes.children.push({ name: "项目导图.shardmap.json", path: ".trash/notes/项目导图.shardmap.json", kind: "mindmap", size: 768, modifiedAt: now })
          }
          if (state.importedFlow && !trashNotes.children.some((entry: any) => entry.path === ".trash/notes/审批流程.shardflow.json")) {
            trashNotes.children.push({ name: "审批流程.shardflow.json", path: ".trash/notes/审批流程.shardflow.json", kind: "flowchart", size: 512, modifiedAt: now })
          }
        }
        return next
      }
      return result
    }
  }, { preloaded })
  await page.reload()
}

interface MindMapRenameMock {
  disk: MindMapReadResult
  failSave: boolean
  holdSave: boolean
  events: string[]
  readPaths: string[]
  release(): void
}

type MindMapRenameRuntime = Window & { __mindMapRename: MindMapRenameMock }

async function installMindMapRenameMock(page: Page) {
  await page.addInitScript(() => {
    const runtime = window as unknown as MindMapRenameRuntime & {
      __TAURI_INTERNALS__: { invoke(command: string, args?: Record<string, unknown>): Promise<unknown> }
      __SHARD_LIBRARY_TREE_CALLS__: LibraryCall[]
    }
    const original = runtime.__TAURI_INTERNALS__.invoke
    const waiters: (() => void)[] = []
    const ready = original("read_mind_map", { id: "map-project" }).then(value => {
      const disk = value as MindMapReadResult
      disk.file.nodes["branch-1"] = {
        ...disk.file.nodes[disk.file.rootId], id: "branch-1", parentId: disk.file.rootId,
        text: "原始子主题", sortKey: "a",
      }
      const state: MindMapRenameMock = {
        disk, failSave: false, holdSave: false, events: [], readPaths: [],
        release() { state.holdSave = false; waiters.splice(0).forEach(resolve => resolve()) },
      }
      runtime.__mindMapRename = state
      return state
    })
    const tree = async () => {
      const state = await ready
      const result = await original("list_library_tree") as { entries: Record<string, unknown>[] }
      result.entries = result.entries.map(entry => entry.mindMapId === "map-project"
        ? { ...entry, path: state.disk.path, name: state.disk.path.split("/").pop() }
        : entry)
      return result
    }
    runtime.__TAURI_INTERNALS__.invoke = async (command, args = {}) => {
      const state = await ready
      if (command === "list_library_tree") return tree()
      if (command === "migrate_legacy_notes") return { tree: await tree(), migratedCount: 0 }
      if (command === "list_mind_maps") {
        const summaries = await original(command, args) as Record<string, unknown>[]
        return summaries.map(summary => summary.id === "map-project" ? { ...summary, path: state.disk.path } : summary)
      }
      if (command === "read_mind_map" && args.id === "map-project") {
        runtime.__SHARD_LIBRARY_TREE_CALLS__.push({ command, args: structuredClone(args) })
        state.readPaths.push(state.disk.path)
        return structuredClone(state.disk)
      }
      if (command === "write_mind_map" && args.id === "map-project") {
        runtime.__SHARD_LIBRARY_TREE_CALLS__.push({ command, args: structuredClone(args) })
        state.events.push("write:start")
        if (state.holdSave) await new Promise<void>(resolve => waiters.push(resolve))
        if (state.failSave) throw new Error("导图重命名测试：保存失败")
        if (args.expectedRevision !== state.disk.file.revision || args.lastSavedHash !== state.disk.lastSavedHash) {
          throw new Error("导图重命名测试：保存基线已过期")
        }
        const file = structuredClone(args.file as ShardMapFile)
        file.revision = state.disk.file.revision + 1
        state.disk = { ...state.disk, file, lastSavedHash: String(file.revision).padStart(64, "0") }
        state.events.push("write:done")
        return structuredClone(state.disk)
      }
      if (command === "rename_library_entry" && args.path === state.disk.path) {
        runtime.__SHARD_LIBRARY_TREE_CALLS__.push({ command, args: structuredClone(args) })
        state.events.push("rename")
        if (args.newName === "已有导图") throw new Error("目标名称已存在。")
        const name = String(args.newName)
        const fileName = name.endsWith(".shardmap.json") ? name : `${name}.shardmap.json`
        state.disk.path = `${state.disk.path.slice(0, state.disk.path.lastIndexOf("/"))}/${fileName}`
        // 真实结构命令只改路径，返回 fragment:null，不改导图正文或根主题。
        return { tree: await tree(), fragment: null, updatedLinks: 0 }
      }
      return original(command, args)
    }
  })
  await page.reload()
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  await page.getByRole("button", { name: /^文件（/u, exact: true }).click()
  await page.getByRole("button", { name: "打开文件 项目导图.shardmap.json", exact: true }).click()
  await page.getByRole("tab", { name: "大纲", exact: true }).click()
  await expect(page.getByRole("textbox", { name: "导图节点", exact: true })).toHaveValue("原始子主题")
}

async function installLibrarySortMock(page: Page) {
  await page.addInitScript(() => {
    const runtime = window as unknown as {
      __TAURI_INTERNALS__: { invoke(command: string, args?: unknown): Promise<unknown> }
    }
    const original = runtime.__TAURI_INTERNALS__.invoke
    const entries = [
      { name: "10 项目.md", kind: "markdown", size: 100, createdAt: "2026-08-04T00:00:00Z", modifiedAt: "2026-08-02T00:00:00Z" },
      { name: "2 数据.csv", kind: "csv", size: 400, createdAt: "2026-08-02T00:00:00Z", modifiedAt: "2026-08-01T00:00:00Z" },
      { name: "30 导图.shardmap.json", kind: "mindmap", size: 200, createdAt: "2026-08-01T00:00:00Z", modifiedAt: "2026-08-04T00:00:00Z" },
      { name: "4 流程.shardflow.json", kind: "flowchart", size: 300, createdAt: "2026-08-03T00:00:00Z", modifiedAt: "2026-08-03T00:00:00Z" },
      { name: "1 历史.md", kind: "markdown", size: 50, modifiedAt: "2026-08-05T00:00:00Z" },
      { name: "Z 目录", kind: "directory", size: 0, modifiedAt: "2026-08-06T00:00:00Z", children: [] },
    ].map(entry => ({ ...entry, path: `notes/${entry.name}` }))
    runtime.__TAURI_INTERNALS__.invoke = async (command, args) => {
      const result = await original(command, args)
      if (command === "list_library_tree") return { ...(result as object), entries }
      if (command === "migrate_legacy_notes") {
        const migration = result as { tree: object }
        return { ...migration, tree: { ...migration.tree, entries } }
      }
      return result
    }
  })
  await page.reload()
}

async function installLibrarySidebarMock(page: Page, directoryCount = 0) {
  await page.addInitScript((directoryCount) => {
    type Entry = { name: string; path: string; kind: string; children?: Entry[] }
    const runtime = window as unknown as {
      __TAURI_INTERNALS__: { invoke(command: string, args?: unknown): Promise<unknown> }
    }
    const original = runtime.__TAURI_INTERNALS__.invoke
    const patchTree = (tree: { entries: Entry[] }) => {
      const directory = (name: string, parent = "notes"): Entry => ({
        name, path: `${parent}/${name}`, kind: "directory", children: [],
      })
      const project = tree.entries.find(entry => entry.path === "notes/项目")!
      const child = directory("子目录", project.path)
      child.children!.push(directory("孙目录", child.path))
      project.children!.push(child)
      tree.entries.push(
        { name: "任务.csv", path: "notes/任务.csv", kind: "csv" },
        { name: "流程.shardflow.json", path: "notes/流程.shardflow.json", kind: "flowchart" },
        ...Array.from({ length: directoryCount }, (_, index) => directory(`目录 ${String(index + 1).padStart(2, "0")}`)),
      )
      return tree
    }
    runtime.__TAURI_INTERNALS__.invoke = async (command, args) => {
      const result = await original(command, args)
      if (command === "list_library_tree") return patchTree(result as { entries: Entry[] })
      if (command === "migrate_legacy_notes") {
        const migration = result as { tree: { entries: Entry[] } }
        return { ...migration, tree: patchTree(migration.tree) }
      }
      return result
    }
  }, directoryCount)
  await page.reload()
  await page.getByRole("button", { name: "资料库", exact: true }).click()
}

test.beforeEach(async ({ page }) => {
  await installLibraryTreeMock(page)
  await page.goto("/")
})

test("文件入口递归统计所有文件格式且排除文件夹，新建菜单包含统一操作", async ({ page }) => {
  await installLibrarySidebarMock(page)
  const sidebar = page.getByRole("complementary", { name: "资料库目录" })
  const files = sidebar.getByRole("button", { name: "文件（6）", exact: true })
  await expect(files).toBeVisible()
  await expect(sidebar.getByText("全部笔记", { exact: true })).toHaveCount(0)
  await files.click()
  await expect(page.getByRole("article", { name: "资料库查看器" })
    .getByRole("button", { name: "文件", exact: true })).toBeVisible()
  await expect(sidebar.getByRole("tree", { name: "文件夹", exact: true })).toBeVisible()
  await sidebar.getByRole("button", { name: "新建", exact: true }).click()
  for (const name of ["新建文档", "新建数据集", "新建思维导图", "新建流程图", "新建目录", "从 CSV / Excel 导入…"]) {
    await expect(page.getByRole("menuitem", { name, exact: true })).toBeVisible()
  }
  await page.keyboard.press("Escape")
  await expect(sidebar.getByRole("button", { name: "新建", exact: true })).toBeFocused()
  expect(await commandCalls(page, "create_library_note")).toHaveLength(0)
})

test("目录展开箭头和目录选择相互独立，折叠不改变当前内容", async ({ page }) => {
  await installLibrarySidebarMock(page)
  const sidebar = page.getByRole("complementary", { name: "资料库目录" })
  await sidebar.getByRole("button", { name: "文件（6）", exact: true }).click()
  await sidebar.getByRole("button", { name: "展开 项目", exact: true }).click()
  await expect(page.getByRole("region", { name: "notes 目录列表", exact: true })).toBeVisible()
  await expect(sidebar.getByRole("button", { name: "子目录", exact: true })).toBeVisible()
  await sidebar.getByRole("button", { name: "项目", exact: true }).click()
  await expect(page.getByRole("region", { name: "notes/项目 目录列表", exact: true })).toBeVisible()
  await expect(sidebar.getByRole("button", { name: "子目录", exact: true })).toBeVisible()
  await sidebar.getByRole("button", { name: "折叠 项目", exact: true }).click()
  await expect(sidebar.getByRole("button", { name: "子目录", exact: true })).toHaveCount(0)
  await expect(page.getByRole("region", { name: "notes/项目 目录列表", exact: true })).toBeVisible()
  await expect(sidebar.getByRole("button", { name: "项目", exact: true })).toHaveAttribute("aria-current", "page")
  // 从文件浏览器进入子目录时只展开祖先，保留当前目录自己的折叠状态。
  await page.getByRole("button", { name: "打开目录 子目录", exact: true }).click()
  await expect(sidebar.getByRole("button", { name: "子目录", exact: true })).toHaveAttribute("aria-current", "page")
  await expect(sidebar.getByRole("button", { name: "孙目录", exact: true })).toHaveCount(0)
  await sidebar.getByRole("button", { name: "项目", exact: true }).click()
  await page.getByRole("button", { name: "打开文件 项目计划.md", exact: true }).click()
  await expect(page.getByRole("textbox", { name: "资料库文档编辑器", exact: true })).toBeVisible()
  await expect(sidebar.getByRole("button", { name: "项目", exact: true })).toHaveAttribute("aria-current", "page")
})

test("侧栏整行悬浮与选中使用单层背景且选中没有描边", async ({ page }) => {
  await installLibrarySidebarMock(page)
  const sidebar = page.getByRole("complementary", { name: "资料库目录" })
  const files = sidebar.getByRole("button", { name: "文件（6）", exact: true })
  const project = sidebar.getByRole("button", { name: "项目", exact: true })
  const row = project.locator("..")
  await files.click()
  await expect(files).toHaveAttribute("aria-current", "page")
  await page.mouse.move(1100, 400)
  await files.evaluate(async element => {
    getComputedStyle(element).backgroundColor
    await Promise.all(element.getAnimations().map(animation => animation.finished))
  })
  const selectedBackground = await files.evaluate(element => getComputedStyle(element).backgroundColor)
  expect(selectedBackground).not.toBe("rgba(0, 0, 0, 0)")
  await files.hover()
  await expect(files).toHaveCSS("background-color", selectedBackground)
  await expect(files).toHaveCSS("border-top-width", "0px")
  await project.hover()
  await expect(project).toHaveCSS("background-color", "rgba(0, 0, 0, 0)")
  const hoverBackground = await row.evaluate(async element => {
    getComputedStyle(element).backgroundColor
    await Promise.all(element.getAnimations().map(animation => animation.finished))
    return getComputedStyle(element).backgroundColor
  })
  expect(hoverBackground).not.toBe("rgba(0, 0, 0, 0)")
  await project.click()
  await expect(row).toHaveAttribute("data-selected", "true")
  await page.mouse.move(1100, 400)
  await row.evaluate(async element => {
    getComputedStyle(element).backgroundColor
    await Promise.all(element.getAnimations().map(animation => animation.finished))
  })
  const selectedRowBackground = await row.evaluate(element => getComputedStyle(element).backgroundColor)
  await project.hover()
  await expect(row).toHaveCSS("background-color", selectedRowBackground)
  await expect(row).toHaveCSS("border-top-width", "0px")
  await expect(project).toHaveCSS("background-color", "rgba(0, 0, 0, 0)")
  const rowBox = await row.boundingBox()
  const rootBox = await files.boundingBox()
  expect(rowBox!.x).toBeCloseTo(rootBox!.x, 0)
  expect(rowBox!.width).toBeCloseTo(rootBox!.width, 0)
  await files.click()
  await sidebar.getByRole("button", { name: "项目 操作", exact: true }).click()
  await page.getByRole("menuitem", { name: "重命名", exact: true }).hover()
  await expect(row).toHaveCSS("background-color", hoverBackground)
  await expect(project).toHaveCSS("background-color", "rgba(0, 0, 0, 0)")
  await page.keyboard.press("Escape")
})

test("高矮窗口都让目录树占满剩余高度，长目录独立滚动并固定入口和页脚", async ({ page }) => {
  await installLibrarySidebarMock(page, 60)
  const sidebar = page.getByRole("complementary", { name: "资料库目录" })
  const viewport = sidebar.locator('[data-library-tree-viewport="true"]')
  const root = sidebar.getByRole("button", { name: "文件（6）", exact: true })
  const images = sidebar.getByRole("button", { name: "图片（1）", exact: true })
  const footer = sidebar.locator('[data-library-footer="true"]')
  const heights: number[] = []
  for (const height of [1100, 560]) {
    await page.setViewportSize({ width: 1280, height })
    await viewport.evaluate(element => { element.scrollTop = 0 })
    const [paneBox, treeBox, rootBox, imagesBox, footerBox] = await Promise.all([
      sidebar.boundingBox(), viewport.boundingBox(), root.boundingBox(), images.boundingBox(), footer.boundingBox(),
    ])
    heights.push(treeBox!.height)
    expect(treeBox!.height).toBeGreaterThan(200)
    expect(treeBox!.y).toBeGreaterThanOrEqual(rootBox!.y + rootBox!.height)
    expect(Math.abs(treeBox!.y + treeBox!.height - footerBox!.y)).toBeLessThanOrEqual(12)
    expect(Math.abs(footerBox!.y + footerBox!.height - paneBox!.y - paneBox!.height)).toBeLessThanOrEqual(1)
    expect(await viewport.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true)
    await viewport.hover()
    await page.mouse.wheel(0, 10000)
    await expect.poll(() => viewport.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
    await expect(sidebar.getByRole("button", { name: "目录 60", exact: true })).toBeInViewport()
    await expect(root).toBeInViewport()
    await expect(images).toBeInViewport()
    await expect(sidebar.getByRole("button", { name: "回收站（3）", exact: true })).toBeInViewport()
    await expect(sidebar.getByRole("button", { name: "密匣（上锁空间）", exact: true })).toBeInViewport()
    expect((await root.boundingBox())!.y).toBeCloseTo(rootBox!.y, 0)
    expect((await images.boundingBox())!.y).toBeCloseTo(imagesBox!.y, 0)
    expect((await footer.boundingBox())!.y).toBeCloseTo(footerBox!.y, 0)
    expect(await page.evaluate(() => window.scrollY)).toBe(0)
  }
  expect(heights[0] - heights[1]).toBeCloseTo(540, 0)
})

test("桌面标题和目录表头不产生文本选区，正文与编辑器仍可选词", async ({ page }) => {
  const editor = page.locator('[data-shard-editor="composer"] .ProseMirror')
  await expect(editor).toBeVisible()
  await expect(editor).toHaveCSS("user-select", "text")
  await expect(page.locator(".shard-fragment-content").first()).toHaveCSS("user-select", "text")
  await fillEditor(page, "composer", "selection survives")
  await editor.locator("p").first().dblclick({ position: { x: 20, y: 10 } })
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("selection")
  const selected = await readEditorSnapshot(page, "composer")
  expect(selected.selectionEnd - selected.selectionStart).toBe("selection".length)
  await fillEditor(page, "composer", "")

  await page.getByRole("button", { name: "资料库", exact: true }).click()
  await page.getByRole("button", { name: /^文件（/u, exact: true }).click()
  const viewer = page.getByRole("article", { name: "资料库查看器" })
  const list = viewer.getByRole("region", { name: "notes 目录列表", exact: true })
  const title = viewer.getByRole("button", { name: "文件", exact: true })
  await expect(title).toHaveCSS("user-select", "none")
  await expect(list.locator("th").first()).toHaveCSS("user-select", "none")
  await expect(list.locator("tbody td").nth(1)).toHaveCSS("user-select", "none")
  await title.dblclick()
  await list.getByRole("button", { name: "按名称排序", exact: true }).dblclick()
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("")

  const header = await list.locator("thead").boundingBox()
  if (!header) throw new Error("目录表头不可见")
  await page.mouse.move(header.x + 12, header.y + header.height / 2)
  await page.mouse.down()
  await page.mouse.move(header.x + header.width - 12, header.y + header.height / 2, { steps: 10 })
  await page.mouse.up()
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("")
})

test("目录五个表头可切换排序方向，创建时间缺失显示未知并始终排在文件末尾", async ({ page }) => {
  await installLibrarySortMock(page)
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  await page.getByRole("button", { name: /^文件（/u, exact: true }).click()
  const list = page.getByRole("region", { name: "notes 目录列表", exact: true })
  const rows = list.locator("tbody tr")
  const paths = (names: string[]) => ["notes/Z 目录", ...names.map(name => `notes/${name}`)]
  const expectOrder = async (names: string[]) => {
    await expect.poll(() => rows.evaluateAll(elements => elements.map(element => element.getAttribute("data-path")))).toEqual(paths(names))
  }
  const unknown = list.locator('tr[data-path="notes/1 历史.md"]')
  await expect(unknown.getByRole("cell").nth(4)).toHaveText("未知")
  await expect(list.locator('tr[data-path="notes/10 项目.md"]').getByRole("cell").nth(4)).toContainText("2026/08/04")
  await expect(list.locator('th[aria-sort="ascending"]')).toHaveCount(1)
  await expectOrder(["1 历史.md", "2 数据.csv", "4 流程.shardflow.json", "10 项目.md", "30 导图.shardmap.json"])

  const cases = [
    { label: "名称", first: "descending", order: ["30 导图.shardmap.json", "10 项目.md", "4 流程.shardflow.json", "2 数据.csv", "1 历史.md"], reverse: ["1 历史.md", "2 数据.csv", "4 流程.shardflow.json", "10 项目.md", "30 导图.shardmap.json"] },
    { label: "类型", first: "ascending", order: ["4 流程.shardflow.json", "30 导图.shardmap.json", "2 数据.csv", "1 历史.md", "10 项目.md"], reverse: ["1 历史.md", "10 项目.md", "2 数据.csv", "30 导图.shardmap.json", "4 流程.shardflow.json"] },
    { label: "大小", first: "descending", order: ["2 数据.csv", "4 流程.shardflow.json", "30 导图.shardmap.json", "10 项目.md", "1 历史.md"], reverse: ["1 历史.md", "10 项目.md", "30 导图.shardmap.json", "4 流程.shardflow.json", "2 数据.csv"] },
    { label: "创建时间", first: "descending", order: ["10 项目.md", "4 流程.shardflow.json", "2 数据.csv", "30 导图.shardmap.json", "1 历史.md"], reverse: ["30 导图.shardmap.json", "2 数据.csv", "4 流程.shardflow.json", "10 项目.md", "1 历史.md"] },
    { label: "修改时间", first: "descending", order: ["1 历史.md", "30 导图.shardmap.json", "4 流程.shardflow.json", "10 项目.md", "2 数据.csv"], reverse: ["2 数据.csv", "10 项目.md", "4 流程.shardflow.json", "30 导图.shardmap.json", "1 历史.md"] },
  ]
  for (const { label, first, order, reverse } of cases) {
    const button = list.getByRole("button", { name: `按${label}排序`, exact: true })
    const header = list.getByRole("columnheader").filter({ has: page.getByRole("button", { name: `按${label}排序`, exact: true }) })
    await button.click()
    await expect(header).toHaveAttribute("aria-sort", first)
    await expect(list.locator('th[aria-sort]:not([aria-sort="none"])')).toHaveCount(1)
    await expectOrder(order)
    await button.click()
    await expect(header).toHaveAttribute("aria-sort", first === "ascending" ? "descending" : "ascending")
    await expectOrder(reverse)
  }
})

test("排序菜单与列表宫格共享顺序，字段方向和视图在刷新后保持", async ({ page }) => {
  await installLibrarySortMock(page)
  const openRoot = async () => {
    await page.getByRole("button", { name: "资料库", exact: true }).click()
    await page.getByRole("button", { name: /^文件（/u, exact: true }).click()
  }
  await openRoot()
  const viewer = page.getByRole("article", { name: "资料库查看器" })
  await viewer.getByRole("button", { name: "按创建时间排序", exact: true }).click()
  const listOrder = await viewer.locator("tbody tr").evaluateAll(rows => rows.map(row => row.getAttribute("data-path")?.replace(/^notes\//, "")))
  await viewer.getByRole("button", { name: "宫格视图", exact: true }).click()
  const grid = viewer.getByRole("list", { name: "notes 目录宫格", exact: true })
  const gridOrder = () => grid.locator('button[aria-label^="打开"]').evaluateAll(buttons => buttons.map(button => button.getAttribute("aria-label")?.replace(/^打开(?:目录|文件) /, "")))
  await expect.poll(gridOrder).toEqual(listOrder)
  await viewer.getByRole("button", { name: "排序：创建时间，降序", exact: true }).click()
  await page.getByRole("menuitemradio", { name: "大小", exact: true }).click()
  await expect(page.getByRole("menuitemradio", { name: "大小", exact: true })).toHaveAttribute("aria-checked", "true")
  await page.getByRole("menuitemradio", { name: "升序", exact: true }).click()
  await expect(page.getByRole("menuitemradio", { name: "升序", exact: true })).toHaveAttribute("aria-checked", "true")
  await page.keyboard.press("Escape")
  const ascending = ["Z 目录", "1 历史.md", "10 项目.md", "30 导图.shardmap.json", "4 流程.shardflow.json", "2 数据.csv"]
  await expect.poll(gridOrder).toEqual(ascending)
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("shard.library-directory-sort") ?? "null"))).toEqual({ key: "size", direction: "asc" })

  await page.reload()
  await openRoot()
  await expect(viewer.getByRole("button", { name: "排序：大小，升序", exact: true })).toBeVisible()
  await expect(viewer.getByRole("button", { name: "宫格视图", exact: true })).toHaveAttribute("aria-pressed", "true")
  await expect.poll(gridOrder).toEqual(ascending)
  await viewer.getByRole("button", { name: "列表视图", exact: true }).click()
  await expect.poll(() => viewer.locator("tbody tr").evaluateAll(rows => rows.map(row => row.getAttribute("data-path")?.replace(/^notes\//, "")))).toEqual(ascending)
  await expect(viewer.getByRole("columnheader").filter({ has: page.getByRole("button", { name: "按大小排序", exact: true }) })).toHaveAttribute("aria-sort", "ascending")
})

test("列表和宫格隐藏已知格式后缀，名称提示与打开命令保留真实文件身份", async ({ page }) => {
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  await page.getByRole("button", { name: /^文件（/u, exact: true }).click()
  const viewer = page.getByRole("article", { name: "资料库查看器" })
  for (const mode of ["列表", "宫格"]) {
    if (mode === "宫格") await viewer.getByRole("button", { name: "宫格视图", exact: true }).click()
    const surface = mode === "列表"
      ? viewer.getByRole("region", { name: "notes 目录列表", exact: true })
      : viewer.getByRole("list", { name: "notes 目录宫格", exact: true })
    for (const [file, name] of [["旧笔记.md", "旧笔记"], ["清单.csv", "清单"], ["项目导图.shardmap.json", "项目导图"]]) {
      const button = surface.getByRole("button", { name: `打开文件 ${file}`, exact: true })
      await expect(button.locator(`[title="${file}"]`)).toHaveText(name)
      await expect(button.getByText(file, { exact: true })).toHaveCount(0)
      await expect(surface.getByRole("button", { name: `${file} 操作`, exact: true })).toHaveCount(1)
    }
  }
  await viewer.getByRole("button", { name: "打开文件 项目导图.shardmap.json", exact: true }).click()
  await expect(page.getByLabel("思维导图编辑器", { exact: true })).toBeVisible()
  await expect.poll(() => commandCalls(page, "read_mind_map")).not.toHaveLength(0)
  expect((await commandCalls(page, "read_mind_map")).at(-1)?.args).toEqual({ id: "map-project" })
})

test("点击树目录在第三栏浏览内容", async ({ page }) => {
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  const treePane = page.getByRole("complementary", { name: "资料库目录" })
  const viewer = page.getByRole("article", { name: "资料库查看器" })

  await treePane.getByRole("button", { name: "项目", exact: true }).click()

  await expect(
    treePane.getByRole("button", { name: "项目计划.md", exact: true })
  ).toHaveCount(0)
  const directoryList = viewer.getByRole("region", {
    name: "notes/项目 目录列表",
    exact: true,
  })
  await expect(directoryList).toBeVisible()
  await expect(
    directoryList.getByRole("button", {
      name: "打开文件 项目计划.md",
      exact: true,
    })
  ).toBeVisible()
  await expect(
    page.getByRole("button", { name: "进入禅模式", exact: true })
  ).toHaveCount(0)
  const inspector = page.getByRole("complementary", { name: "笔记检查器" })
  await expect(inspector.locator("button, input, textarea, [role=list]")).toHaveCount(0)
})

test("目录列表与宫格切换会持久化，宫格可进入子目录并打开笔记", async ({ page }) => {
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  const treePane = page.getByRole("complementary", { name: "资料库目录" })
  await treePane.getByRole("button", {
    name: /^文件（/u,
    exact: true,
  }).click()
  const viewer = page.getByRole("article", { name: "资料库查看器" })
  const gridButton = viewer.getByRole("button", { name: "宫格视图", exact: true })

  await expect(
    viewer.getByRole("button", { name: "列表视图", exact: true })
  ).toHaveAttribute("aria-pressed", "true")
  const rootList = viewer.getByRole("region", {
    name: "notes 目录列表",
    exact: true,
  })
  await expect(
    rootList.getByRole("button", { name: "打开文件 旧笔记.md", exact: true })
  ).toBeVisible()
  await expect(
    rootList.getByRole("button", {
      name: "打开文件 项目导图.shardmap.json",
      exact: true,
    })
  ).toBeVisible()
  await gridButton.click()
  await expect(gridButton).toHaveAttribute("aria-pressed", "true")
  const rootGrid = viewer.getByRole("list", {
    name: "notes 目录宫格",
    exact: true,
  })
  await expect(
    rootGrid.getByRole("button", { name: "打开文件 旧笔记.md", exact: true })
  ).toBeVisible()
  await expect(
    rootGrid.getByRole("button", {
      name: "打开文件 项目导图.shardmap.json",
      exact: true,
    })
  ).toBeVisible()
  await expect.poll(() => page.evaluate(() =>
    localStorage.getItem("shard.library-directory-view")
  )).toBe("grid")

  await viewer.getByRole("button", { name: "打开目录 项目", exact: true }).click()
  await expect(viewer.getByRole("list", { name: "notes/项目 目录宫格", exact: true })).toBeVisible()
  await viewer.getByRole("button", {
    name: "打开文件 项目计划.md",
    exact: true,
  }).click()
  await expect(page.locator('[data-shard-editor="library:note-plan"]')).toBeVisible()

  await page.reload()
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  await page.getByRole("complementary", { name: "资料库目录" })
    .getByRole("button", { name: /^文件（/u, exact: true })
    .click()
  await expect(
    page.getByRole("article", { name: "资料库查看器" })
      .getByRole("button", { name: "宫格视图", exact: true })
  ).toHaveAttribute("aria-pressed", "true")
})

test("目录宫格按文件类型显示内容缩略图，列表视图保持密集元数据", async ({ page }) => {
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  const treePane = page.getByRole("complementary", { name: "资料库目录" })
  await treePane.getByRole("button", {
    name: /^文件（/u,
    exact: true,
  }).click()
  const viewer = page.getByRole("article", { name: "资料库查看器" })
  const rootList = viewer.getByRole("region", {
    name: "notes 目录列表",
    exact: true,
  })
  await expect(rootList).toBeVisible()
  await expect(rootList.locator('[data-library-preview], img')).toHaveCount(0)
  await expect(rootList.getByText("待重命名", { exact: true })).toHaveCount(0)

  await viewer.getByRole("button", { name: "宫格视图", exact: true }).click()
  const rootGrid = viewer.getByRole("list", {
    name: "notes 目录宫格",
    exact: true,
  })
  const markdownCard = rootGrid.getByRole("button", {
    name: "打开文件 旧笔记.md",
    exact: true,
  })
  await expect(markdownCard.getByText("待重命名", { exact: true })).toBeVisible()
  await expect(markdownCard.locator('[data-kind="markdown"]')).toHaveCount(0)

  // 缩略图吃的是解析后的语义块，不是 Markdown 源码：标题成标题，# 不露出来
  const markdownThumb = markdownCard.locator('[data-library-preview="text"]')
  await expect(markdownThumb.getByText("旧笔记", { exact: true })).toBeVisible()
  expect(await markdownThumb.innerText()).not.toContain("#")

  const mindMapCard = rootGrid.getByRole("button", {
    name: "打开文件 项目导图.shardmap.json",
    exact: true,
  })
  const mindMapPreview = mindMapCard.locator(
    'svg[data-library-preview="mindmap"]'
  )
  await expect(mindMapPreview.locator("rect")).toHaveCount(1)
  await expect(mindMapPreview.locator("text")).toHaveCount(0)

  const csvCard = rootGrid.getByRole("button", {
    name: "打开文件 清单.csv",
    exact: true,
  })
  await expect(
    csvCard.locator('table[data-library-preview="table"]')
  ).toBeVisible()
  await expect(csvCard.getByText("事项", { exact: true })).toBeVisible()
})

test("异步缩略图读取失败时保留类型图标且不抛页面错误", async ({ page }) => {
  const pageErrors: Error[] = []
  page.on("pageerror", (error) => pageErrors.push(error))
  await page.evaluate(() => {
    const runtime = globalThis as typeof globalThis & {
      __SHARD_FAIL_MIND_MAP_PREVIEW__?: boolean
    }
    runtime.__SHARD_FAIL_MIND_MAP_PREVIEW__ = true
  })

  await page.getByRole("button", { name: "资料库", exact: true }).click()
  const treePane = page.getByRole("complementary", { name: "资料库目录" })
  await treePane.getByRole("button", {
    name: /^文件（/u,
    exact: true,
  }).click()
  const viewer = page.getByRole("article", { name: "资料库查看器" })
  await viewer.getByRole("button", { name: "宫格视图", exact: true }).click()
  const mindMapCard = viewer.getByRole("list", {
    name: "notes 目录宫格",
    exact: true,
  }).getByRole("button", {
    name: "打开文件 项目导图.shardmap.json",
    exact: true,
  })

  await expect(mindMapCard.locator('[data-kind="mindmap"]')).toBeVisible()
  await expect(
    mindMapCard.locator('[data-library-preview="mindmap"]')
  ).toHaveCount(0)
  expect(pageErrors).toEqual([])
})

test("空目录显示目录空态", async ({ page }) => {
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  const treePane = page.getByRole("complementary", { name: "资料库目录" })
  await createLibraryEntry(page, "新建目录")
  const input = treePane.getByRole("textbox", { name: "新目录名称", exact: true })
  await input.fill("待整理")
  await input.press("Enter")
  await treePane.getByRole("button", { name: "待整理", exact: true }).click()

  await expect(
    page.getByRole("article", { name: "资料库查看器" })
      .getByText("这个目录还是空的", { exact: true })
  ).toBeVisible()
})

test("脏笔记进入目录前先保存草稿", async ({ page }) => {
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  const treePane = page.getByRole("complementary", { name: "资料库目录" })
  await treePane.getByRole("button", {
    name: /^文件（/u,
    exact: true,
  }).click()
  await page.getByRole("region", { name: "notes 目录列表", exact: true })
    .getByRole("button", { name: "打开文件 旧笔记.md", exact: true })
    .click()
  await fillEditor(page, "library:note-old", "# 旧笔记\n\n先保存再浏览目录")
  await treePane.getByRole("button", { name: "项目", exact: true }).click()

  await expect.poll(() => commandCalls(page, "update_fragment")).toHaveLength(1)
  await expect(
    page.getByRole("region", { name: "notes/项目 目录列表", exact: true })
  ).toBeVisible()
})

test("资料库默认显示文件，目录树与查看器均不再暴露碎片流", async ({ page }) => {
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  const treePane = page.getByRole("complementary", { name: "资料库目录" })

  await expect(treePane.getByRole("button", { name: "项目", exact: true })).toBeVisible()
  await expect(treePane.getByRole("button", { name: "旧笔记.md", exact: true })).toHaveCount(0)
  await expect(
    treePane.getByRole("button", {
      name: "项目导图.shardmap.json",
      exact: true,
    })
  ).toHaveCount(0)
  await expect(treePane.getByRole("button", { name: "清单.csv", exact: true })).toHaveCount(0)
  await expect(treePane.getByRole("button", { name: /^碎片流/ })).toHaveCount(0)
  await expect(treePane.getByRole("button", { name: "图片（1）", exact: true })).toBeVisible()
  await expect(treePane.getByRole("button", { name: "密匣（上锁空间）", exact: true })).toBeVisible()
  await expect(
    treePane.getByRole("button", { name: /^思维导图（/ })
  ).toHaveCount(0)
  await expect(treePane.getByText("assets", { exact: true })).toHaveCount(0)
  await expect(treePane.getByText("八月灵感", { exact: true })).toHaveCount(0)

  // 资料库不再提供碎片流或年月子树，默认直接浏览文件。
  await expect(page.getByRole("region", { name: "notes 目录列表", exact: true })).toBeVisible()
  await expect(treePane.getByRole("tree", { name: "碎片流年月" })).toHaveCount(0)
  await expect(treePane.getByRole("button", { name: /^2026（/ })).toHaveCount(0)

  await expect(
    treePane.getByRole("button", { name: "回收站（3）", exact: true })
  ).toBeVisible()
  await expect(treePane.getByRole("button", { name: /^归档（/ })).toHaveCount(0)

  await expect(page.locator('[data-shard-fragment-id]')).toHaveCount(0)
  await expect(page.getByText("碎片正文", { exact: true })).toHaveCount(0)
  await expect(page.getByText("回收站碎片正文", { exact: true })).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => localStorage.getItem("shard.workspace-route"))).toBe(
    JSON.stringify({ space: "library", params: {} })
  )
  await expect(page.getByRole("button", { name: "进入禅模式", exact: true })).toHaveCount(0)
  const createControl = await expectKilnControl(treePane.getByRole("button", { name: "新建", exact: true }), 28)
  mkdirSync("tests/evidence/fragments-separation", { recursive: true })
  writeFileSync("tests/evidence/fragments-separation/library-computed-styles.json", JSON.stringify({ createControl }, null, 2))
  await page.screenshot({ path: "tests/evidence/fragments-separation/library-documents-only.png", animations: "disabled" })
})

test("碎片筛选只在碎片空间工作，资料库回收站仍支持列表宫格和恢复菜单", async ({ page }) => {
  await expect(page.locator('[data-shard-fragment-id="fragment-august"]')).toBeVisible()
  await expect(page.locator('[data-shard-fragment-id="fragment-july"]')).toBeVisible()
  await applyFragmentTag(page, "灵感")
  await expect(page.locator('[data-shard-fragment-id="fragment-august"]')).toBeVisible()
  await expect(page.locator('[data-shard-fragment-id="fragment-july"]')).toHaveCount(0)
  await page.getByRole("button", { name: "清除筛选", exact: true }).click()
  await expect(page.locator('[data-shard-fragment-id="fragment-july"]')).toBeVisible()

  await page.getByRole("button", { name: "资料库", exact: true }).click()
  const treePane = page.getByRole("complementary", { name: "资料库目录" })
  const viewer = page.getByRole("article", { name: "资料库查看器" })
  await expect(viewer.locator('[data-shard-fragment-id]')).toHaveCount(0)
  await treePane.getByRole("button", { name: "回收站（3）", exact: true }).click()
  const trashList = viewer.getByRole("region", {
    name: ".trash 目录列表",
    exact: true,
  })
  await expect(trashList).toBeVisible()
  await expect(trashList.getByText("fragments", { exact: true })).toHaveCount(0)
  await expect(trashList.locator('tr[data-path=".trash/fragments/2026/06/20260612-080000.md"]')).toContainText("20260612-080000")
  await trashList.getByRole("button", { name: "notes 操作", exact: true }).click()
  await expect(page.getByRole("menuitem", { name: "恢复", exact: true })).toBeVisible()
  await expect(page.getByRole("menuitem", { name: "彻底删除", exact: true })).toBeVisible()
  for (const forbidden of ["重命名", "移动到…", "转回碎片", "移入密匣"]) {
    await expect(page.getByRole("menuitem", { name: forbidden, exact: true })).toHaveCount(0)
  }
  await page.keyboard.press("Escape")

  await viewer.getByRole("button", { name: "宫格视图", exact: true }).click()
  const trashGrid = viewer.getByRole("list", { name: ".trash 目录宫格", exact: true })
  await expect(trashGrid).toBeVisible()
  await expect(trashGrid.getByText("回收站碎片正文", { exact: true })).toBeVisible()
  await viewer.getByRole("button", { name: "列表视图", exact: true }).click()
  await expect(trashList).toBeVisible()
  await expect(viewer.getByRole("button", { name: "进入禅模式", exact: true })).toHaveCount(0)
})

test("删除笔记移入回收站并可从原位置恢复", async ({ page }) => {
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  const treePane = page.getByRole("complementary", { name: "资料库目录" })
  const viewer = page.getByRole("article", { name: "资料库查看器" })
  await treePane.getByRole("button", {
    name: /^文件（/u,
    exact: true,
  }).click()
  const rootList = viewer.getByRole("region", { name: "notes 目录列表", exact: true })
  await rootList.getByRole("button", { name: "旧笔记.md 操作", exact: true }).click()
  await page.getByRole("menuitem", { name: "删除", exact: true }).click()
  const deleteDialog = page.getByRole("dialog", { name: "确认删除", exact: true })
  await expect(deleteDialog).toContainText("将移入回收站，之后仍可恢复")
  await deleteDialog.getByRole("button", { name: "删除", exact: true }).click()
  await expect(rootList.getByRole("button", { name: "打开文件 旧笔记.md", exact: true })).toHaveCount(0)

  await treePane.getByRole("button", { name: "回收站（4）", exact: true }).click()
  await viewer.getByRole("button", { name: "打开目录 notes", exact: true }).click()
  const trashNotes = viewer.getByRole("region", {
    name: ".trash/notes 目录列表",
    exact: true,
  })
  await expect(trashNotes.getByText("旧笔记", { exact: true })).toBeVisible()
  await trashNotes.getByRole("button", { name: "旧笔记.md 操作", exact: true }).click()
  await page.getByRole("menuitem", { name: "恢复", exact: true }).click()

  await expect.poll(() => commandCalls(page, "restore_from_trash")).toHaveLength(1)
  await treePane.getByRole("button", {
    name: /^文件（/u,
    exact: true,
  }).click()
  await expect(
    viewer.getByRole("region", { name: "notes 目录列表", exact: true })
      .getByRole("button", { name: "打开文件 旧笔记.md", exact: true })
  ).toBeVisible()
})

test("资料库统一回收站二次确认后清空全部已删除内容", async ({ page }) => {
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  const treePane = page.getByRole("complementary", { name: "资料库目录" })
  await treePane.getByRole("button", { name: "回收站（3）", exact: true }).click()
  const trashList = page.getByRole("region", { name: ".trash 目录列表", exact: true })
  await expect(trashList.getByText("20260612-080000", { exact: true })).toBeVisible()
  await expect(trashList.getByText("notes", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "清空回收站", exact: true }).click()

  const dialog = page.getByRole("dialog", { name: "确认清空回收站", exact: true })
  await expect(dialog).toContainText("碎片、文档和文件")
  await expect(dialog).toContainText("永久删除，此操作不可恢复")
  await expect.poll(() => commandCalls(page, "empty_trash")).toHaveLength(0)
  await dialog.getByRole("button", { name: "清空回收站", exact: true }).click()
  await expect.poll(() => commandCalls(page, "empty_trash")).toHaveLength(1)
  expect((await commandCalls(page, "empty_trash"))[0].args).toEqual({ scope: "all" })
  await expect(treePane.getByRole("button", { name: "回收站（0）", exact: true })).toBeVisible()
  await expect(page.getByText("回收站是空的", { exact: true })).toBeVisible()
  await expect(page.getByText("回收站碎片正文", { exact: true })).toHaveCount(0)
  await page.getByRole("button", { name: "碎片", exact: true }).click()
  await expect(page.locator('[data-shard-fragment-id="fragment-august"]')).toBeVisible()
  await expect(page.locator('[data-shard-fragment-id="fragment-archived"]')).toHaveCount(0)
})

test("取消清空统一回收站保留碎片与文档且不调用命令", async ({ page }) => {
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  const treePane = page.getByRole("complementary", { name: "资料库目录" })
  await treePane.getByRole("button", { name: "回收站（3）", exact: true }).click()
  await page.getByRole("button", { name: "清空回收站", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "确认清空回收站", exact: true })
  await dialog.getByRole("button", { name: "取消", exact: true }).click()
  await expect(dialog).toBeHidden()
  expect(await commandCalls(page, "empty_trash")).toHaveLength(0)
  await expect(treePane.getByRole("button", { name: "回收站（3）", exact: true })).toBeVisible()
  await expect(page.getByRole("region", { name: ".trash 目录列表", exact: true }).getByText("20260612-080000", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "打开目录 notes", exact: true }).click()
  await expect(page.getByRole("region", { name: ".trash/notes 目录列表", exact: true }).getByText("已删除文档", { exact: true })).toBeVisible()
})

test("统一回收站恢复碎片后保留当前目录，手动进入碎片查看恢复内容", async ({ page }) => {
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  const treePane = page.getByRole("complementary", { name: "资料库目录" })
  await treePane.getByRole("button", { name: "回收站（3）", exact: true }).click()
  const trash = page.getByRole("region", { name: ".trash 目录列表", exact: true })
  await trash.getByRole("button", { name: "20260612-080000.md 操作", exact: true }).click()
  await page.getByRole("menuitem", { name: "恢复", exact: true }).click()
  await expect.poll(() => commandCalls(page, "restore_from_trash")).toHaveLength(1)
  expect((await commandCalls(page, "restore_from_trash"))[0].args).toEqual({ path: ".trash/fragments/2026/06/20260612-080000.md" })
  await expect(trash).toBeVisible()
  await expect(treePane.getByRole("button", { name: "回收站（2）", exact: true })).toHaveAttribute("aria-current", "page")
  await expect(trash.getByText("20260612-080000", { exact: true })).toHaveCount(0)
  await page.getByRole("button", { name: "碎片", exact: true }).click()
  await expect(page.locator('[data-shard-fragment-id="fragment-archived"]')).toBeVisible()
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  await expect(page.locator('[data-shard-fragment-id]')).toHaveCount(0)
  await expect(page.getByText("回收站碎片正文", { exact: true })).toHaveCount(0)
})

test("统一回收站彻底删除碎片需确认并使用碎片原路径", async ({ page }) => {
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  const treePane = page.getByRole("complementary", { name: "资料库目录" })
  await treePane.getByRole("button", { name: "回收站（3）", exact: true }).click()
  const trash = page.getByRole("region", { name: ".trash 目录列表", exact: true })
  const menu = trash.getByRole("button", { name: "20260612-080000.md 操作", exact: true })
  await menu.click()
  await page.getByRole("menuitem", { name: "彻底删除", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "确认彻底删除", exact: true })
  await expect(dialog).toContainText("永久删除，此操作不可恢复")
  expect(await commandCalls(page, "purge_from_trash")).toHaveLength(0)
  await dialog.getByRole("button", { name: "取消", exact: true }).click()
  await expect(dialog).toBeHidden()
  expect(await commandCalls(page, "purge_from_trash")).toHaveLength(0)
  await expect(trash.getByText("20260612-080000", { exact: true })).toBeVisible()
  await menu.click()
  await page.getByRole("menuitem", { name: "彻底删除", exact: true }).click()
  await dialog.getByRole("button", { name: "彻底删除", exact: true }).click()
  await expect.poll(() => commandCalls(page, "purge_from_trash")).toHaveLength(1)
  expect((await commandCalls(page, "purge_from_trash"))[0].args).toEqual({ path: ".trash/fragments/2026/06/20260612-080000.md" })
  await expect(treePane.getByRole("button", { name: "回收站（2）", exact: true })).toBeVisible()
  await expect(trash.getByText("20260612-080000", { exact: true })).toHaveCount(0)
  await expect(trash.getByText("notes", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "碎片", exact: true }).click()
  await expect(page.locator('[data-shard-fragment-id="fragment-archived"]')).toHaveCount(0)
})

test("跨空间恢复资料库子目录，失效目录会回退文件根目录", async ({ page }) => {
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  await page.getByRole("complementary", { name: "资料库目录" }).getByRole("button", { name: "项目", exact: true }).click()
  const project = page.getByRole("region", { name: "notes/项目 目录列表", exact: true })
  await expect(project).toBeVisible()
  await page.getByRole("button", { name: "碎片", exact: true }).click()
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  await expect(project).toBeVisible()
  await page.getByRole("button", { name: "碎片", exact: true }).click()
  await page.evaluate(() => sessionStorage.setItem("shard.library-selection:/tmp/shard-library-tree-test", JSON.stringify({ kind: "directory", path: "notes/已移除的目录" })))
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  await expect(page.getByRole("region", { name: "notes 目录列表", exact: true })).toBeVisible()
  await expect(page.getByRole("complementary", { name: "资料库目录" }).getByRole("button", { name: /^文件（/ })).toHaveAttribute("aria-current", "page")
})

test("脏文档进入碎片空间前先保存草稿，返回后恢复同一文档", async ({ page }) => {
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  const treePane = page.getByRole("complementary", { name: "资料库目录" })
  await treePane.getByRole("button", {
    name: /^文件（/u,
    exact: true,
  }).click()
  await page.getByRole("region", { name: "notes 目录列表", exact: true })
    .getByRole("button", { name: "打开文件 旧笔记.md", exact: true })
    .click()
  await fillEditor(page, "library:note-old", "# 旧笔记\n\n先保存再看碎片")
  await page.getByRole("navigation", { name: "工作台导航" }).getByRole("button", { name: "碎片", exact: true }).click()

  await expect.poll(() => commandCalls(page, "update_fragment")).toHaveLength(1)
  await expect(
    page.locator('[data-shard-fragment-id="fragment-august"]')
  ).toBeVisible()
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  await expect(page.getByRole("textbox", { name: "资料库文档编辑器", exact: true })).toBeVisible()
  await expect.poll(() => readEditor(page, "library:note-old")).toBe("# 旧笔记\n\n先保存再看碎片")
  await expect(page.locator('[data-shard-fragment-id]')).toHaveCount(0)
})

test("资料库普通导图条目在第三栏打开并保留侧栏与目录树", async ({ page }) => {
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  const treePane = page.getByRole("complementary", { name: "资料库目录" })
  const sidebar = page.getByRole("navigation", { name: "工作台导航" })

  for (const name of ["碎片", "日历", "资料库"]) {
    await expect(sidebar.getByRole("button", { name, exact: true })).toBeVisible()
  }
  await expect(sidebar.getByRole("button", { name: /^全部碎片 \d+$/u })).toBeVisible()
  await expect(sidebar.getByRole("button", { name: /^回收站 \d+$/u })).toHaveCount(0)
  await expect(
    treePane.getByRole("button", { name: /^思维导图（/ })
  ).toHaveCount(0)
  await treePane.getByRole("button", {
    name: /^文件（/u,
    exact: true,
  }).click()
  const rootList = page.getByRole("region", {
    name: "notes 目录列表",
    exact: true,
  })
  const mapEntry = rootList.getByRole("button", {
    name: "打开文件 项目导图.shardmap.json",
    exact: true,
  })
  await expect(mapEntry).toBeVisible()
  await expect(
    rootList.getByRole("button", {
      name: "项目导图.shardmap.json 操作",
      exact: true,
    })
  ).toBeVisible()

  await mapEntry.click()
  await expect(page.getByLabel("思维导图编辑器", { exact: true })).toBeVisible()
  await expect(sidebar).toBeVisible()
  await expect(treePane).toBeVisible()
  await expect(
    sidebar.getByRole("button", { name: "资料库", exact: true })
  ).toHaveAttribute("aria-current", "page")
  await expect(
    treePane.getByRole("button", { name: "项目导图.shardmap.json", exact: true })
  ).toHaveCount(0)
  await expect(
    page.getByRole("button", { name: "退出思维导图", exact: true })
  ).toHaveCount(0)
})

test("资料库文档禅模式进出后保留同一份草稿", async ({ page }) => {
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  const treePane = page.getByRole("complementary", { name: "资料库目录" })
  await treePane.getByRole("button", { name: "项目", exact: true }).click()
  await page.getByRole("region", { name: "notes/项目 目录列表", exact: true })
    .getByRole("button", { name: "打开文件 项目计划.md", exact: true })
    .click()

  const editorId = "library:note-plan"
  const zenDraft = "# 项目计划\n\n禅模式共用草稿"
  await fillEditor(page, editorId, zenDraft)
  await page.getByRole("button", { name: "进入禅模式", exact: true }).click()

  const zenSurface = page.getByLabel("资料库文档禅模式", { exact: true })
  await expect(zenSurface).toBeVisible()
  await expect.poll(() => readEditor(page, editorId)).toBe(zenDraft)
  // 资料库文档的禅模式同样有操作条：文件名作标题，字数只数正文纯文本。
  const bar = zenSurface.locator("[data-zen-bar]")
  await expect(bar.locator("[data-zen-title]")).toHaveText("项目计划")
  await expect(bar.locator("[data-zen-word-count]")).toHaveText("11 字")
  await expect(bar.getByRole("button", { name: "退出禅模式", exact: true })).toBeVisible()

  const editedInZen = `${zenDraft}\n\n退出后仍然存在`
  await fillEditor(page, editorId, editedInZen)
  await page.keyboard.press("Escape")

  await expect(zenSurface).toHaveCount(0)
  await expect(treePane).toBeVisible()
  await expect(page.locator(`[data-shard-editor="${editorId}"]`)).toBeVisible()
  await expect.poll(() => readEditor(page, editorId)).toBe(editedInZen)
})

test("思维导图标题支持确认、失焦与取消改名，保留扩展名和根主题", async ({ page }, testInfo) => {
  await installMindMapRenameMock(page)
  const title = page.getByRole("button", { name: "重命名文件", exact: true })
  const input = page.getByRole("textbox", { name: "重命名名称", exact: true })
  await expect(title).toHaveText("项目导图")
  const titlebarControls = async () => ({
    back: await page.getByRole("button", { name: "返回所在目录", exact: true }).boundingBox(),
    zen: await page.getByRole("button", { name: "进入禅模式", exact: true }).boundingBox(),
  })
  const beforeEditing = await titlebarControls()
  expect(beforeEditing.back).not.toBeNull()
  expect(beforeEditing.zen).not.toBeNull()
  const titleLeft = (await title.boundingBox())!.x
  const titleStyles = await title.evaluate(element => {
    const style = getComputedStyle(element)
    return { font: style.fontFamily, size: style.fontSize, weight: style.fontWeight,
      expectedSize: style.getPropertyValue("--text-section-title").trim(),
      expectedWeight: style.getPropertyValue("--weight-semibold").trim() }
  })
  expect(titleStyles.size).toBe(titleStyles.expectedSize)
  expect(titleStyles.weight).toBe(titleStyles.expectedWeight)
  await title.click()
  await expect(input).toHaveValue("项目导图")
  await expect(input).toBeFocused()
  expect(await titlebarControls()).toEqual(beforeEditing)
  expect((await input.boundingBox())!.x).toBe(titleLeft)
  const inputStyles = await input.evaluate(async element => {
    await Promise.all(element.getAnimations().map(animation => animation.finished))
    const style = getComputedStyle(element)
    return { font: style.fontFamily, radius: style.borderTopLeftRadius,
      expectedRadius: style.getPropertyValue("--shard-radius-control").trim(),
      borderWidth: style.borderTopWidth, borderStyle: style.borderTopStyle, borderColor: style.borderTopColor }
  })
  expect(inputStyles.font).toBe(titleStyles.font)
  expect(inputStyles.radius).toBe(inputStyles.expectedRadius)
  expect(inputStyles.borderWidth).toBe("1px")
  expect(inputStyles.borderStyle).toBe("solid")
  expect(inputStyles.borderColor).not.toBe("rgba(0, 0, 0, 0)")
  await testInfo.attach("title-rename-computed-styles", { body: JSON.stringify({ titleStyles, inputStyles }, null, 2), contentType: "application/json" })
  await page.screenshot({ path: `tests/evidence/title-rename/${testInfo.project.name}-input.png` })
  expect(await input.evaluate(element => {
    const field = element as HTMLInputElement
    return field.value.slice(field.selectionStart ?? 0, field.selectionEnd ?? 0)
  })).toBe("项目导图")
  const shortNameWidth = (await input.boundingBox())!.width
  expect(shortNameWidth).toBe(240)
  const longName = "开头定位标记—" + "用于验证文件名在固定宽度输入框内横向滚动的长名称".repeat(3) + "—结尾定位标记"
  await input.fill(longName)
  await input.press("ControlOrMeta+a")
  await input.press("ArrowLeft")
  const beginning = await input.screenshot({ caret: "hide" })
  await input.press("ControlOrMeta+a")
  await input.press("ArrowRight")
  expect(await input.evaluate(element => (element as HTMLInputElement).selectionStart)).toBe(longName.length)
  // Compare visible text at both caret positions without relying on native input scrollLeft behavior.
  expect((await input.screenshot({ caret: "hide" })).equals(beginning)).toBe(false)
  expect((await input.boundingBox())!.width).toBe(shortNameWidth)
  expect(await titlebarControls()).toEqual(beforeEditing)
  await page.screenshot({ path: `tests/evidence/title-rename/${testInfo.project.name}-long-name-scroll.png` })
  await input.fill("放弃的名称")
  await input.press("Escape")
  await expect(title).toHaveText("项目导图")
  expect(await titlebarControls()).toEqual(beforeEditing)
  await title.click()
  await input.press("Enter")
  await expect(title).toHaveText("项目导图")
  expect(await commandCalls(page, "rename_library_entry")).toHaveLength(0)

  await title.click()
  await input.fill("架构设计.shardmap.json")
  for (const event of [{ key: "Enter", isComposing: true }, { key: "Enter", keyCode: 229 }]) {
    await input.dispatchEvent("keydown", event)
    await expect(input).toBeVisible()
    expect(await commandCalls(page, "rename_library_entry")).toHaveLength(0)
  }
  await input.press("Enter")
  await expect(title).toHaveText("架构设计")
  expect(await titlebarControls()).toEqual(beforeEditing)
  expect((await commandCalls(page, "rename_library_entry")).map(call => call.args)).toEqual([
    { path: "notes/项目导图.shardmap.json", newName: "架构设计.shardmap.json" },
  ])
  await expect(page.getByRole("textbox", { name: "根节点", exact: true })).toHaveValue("项目导图")

  await page.setViewportSize({ width: 640, height: 720 })
  const narrowControls = await titlebarControls()
  await title.click()
  await input.fill("架构定稿")
  const bounds = await input.boundingBox()
  expect(bounds).not.toBeNull()
  expect(bounds!.width).toBe(shortNameWidth)
  expect(bounds!.x).toBeGreaterThanOrEqual(0)
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(640)
  expect(await titlebarControls()).toEqual(narrowControls)
  await page.screenshot({ path: `tests/evidence/title-rename/${testInfo.project.name}-input-640.png` })
  await page.getByRole("tab", { name: "大纲", exact: true }).focus()
  await expect(title).toHaveText("架构定稿")
  expect(await titlebarControls()).toEqual(narrowControls)
  await page.screenshot({ path: `tests/evidence/title-rename/${testInfo.project.name}-renamed-640.png` })
  expect((await commandCalls(page, "rename_library_entry")).map(call => call.args)).toEqual([
    { path: "notes/项目导图.shardmap.json", newName: "架构设计.shardmap.json" },
    { path: "notes/架构设计.shardmap.json", newName: "架构定稿" },
  ])
  const disk = await page.evaluate(() => (window as MindMapRenameRuntime).__mindMapRename.disk)
  expect(disk.path).toBe("notes/架构定稿.shardmap.json")
  expect(disk.file.title).toBe("项目导图")
  expect(disk.file.nodes[disk.file.rootId].text).toBe("项目导图")
  await page.getByRole("button", { name: "返回所在目录", exact: true }).click()
  await expect(page.getByRole("button", { name: "打开文件 架构定稿.shardmap.json", exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "打开文件 项目导图.shardmap.json", exact: true })).toHaveCount(0)
})

test("文件名编辑外点关闭，拖动标题栏也能提交且返回操作等待改名完成", async ({ page }) => {
  await installMindMapRenameMock(page)
  const title = page.getByRole("button", { name: "重命名文件", exact: true })
  const input = page.getByRole("textbox", { name: "重命名名称", exact: true })
  const heading = page.locator('[data-tauri-drag-region]').filter({ has: title }).last()
  // Native Tauri titlebar dragging prevents mousedown's default focus transfer.
  await page.evaluate(() => document.addEventListener("mousedown", event => {
    if (event.target instanceof Element && event.target.hasAttribute("data-tauri-drag-region")) event.preventDefault()
  }))
  const headingBounds = (await heading.boundingBox())!
  const clickTitlebarBlank = () => page.mouse.click(headingBounds.x + headingBounds.width - 12, headingBounds.y + headingBounds.height / 2)
  await title.click()
  await input.click({ position: { x: 20, y: 10 } })
  await expect(input).toBeFocused()
  await clickTitlebarBlank()
  await expect(input).toHaveCount(0)
  expect(await commandCalls(page, "rename_library_entry")).toHaveLength(0)

  await title.click()
  await input.fill("外点改名")
  await clickTitlebarBlank()
  await expect(title).toHaveText("外点改名")
  expect(await commandCalls(page, "rename_library_entry")).toHaveLength(1)

  await title.click()
  await input.press("Tab")
  await expect(input).toHaveCount(0)
  await page.getByRole("tab", { name: "思维导图", exact: true }).click()
  await title.click()
  await page.getByRole("application", { name: "思维导图编辑器", exact: true }).click({ position: { x: 10, y: 10 } })
  await expect(input).toHaveCount(0)
  await title.click()
  await page.getByRole("button", { name: "进入禅模式", exact: true }).click()
  await expect(input).toHaveCount(0)
  await expect(page.getByLabel("资料库思维导图禅模式", { exact: true })).toBeVisible()
  await page.keyboard.press("Escape")

  await page.getByRole("tab", { name: "大纲", exact: true }).click()
  await page.evaluate(() => { (window as MindMapRenameRuntime).__mindMapRename.holdSave = true })
  await page.getByRole("textbox", { name: "导图节点", exact: true }).fill("外点前的草稿")
  await title.click()
  await input.fill("改名后返回")
  await page.getByRole("button", { name: "返回所在目录", exact: true }).click()
  await expect(input).toBeDisabled()
  await page.evaluate(() => (window as MindMapRenameRuntime).__mindMapRename.release())
  await expect(page.getByRole("button", { name: "打开文件 改名后返回.shardmap.json", exact: true })).toBeVisible()
  expect(await commandCalls(page, "rename_library_entry")).toHaveLength(2)
  expect(await page.evaluate(() => (window as MindMapRenameRuntime).__mindMapRename.disk.file.nodes["branch-1"].text)).toBe("外点前的草稿")
})

test("文件名失焦改名失败时，松开返回按钮仍保留可修正的名称", async ({ page }) => {
  await installMindMapRenameMock(page)
  const title = page.getByRole("button", { name: "重命名文件", exact: true })
  const input = page.getByRole("textbox", { name: "重命名名称", exact: true })
  await title.click()
  await input.fill("已有导图")
  await page.getByRole("button", { name: "返回所在目录", exact: true }).hover()
  await page.mouse.down()
  await expect(page.locator('[data-sonner-toast][data-type="error"]').filter({ hasText: "重命名失败" })).toBeVisible()
  await page.mouse.up()
  await expect(input).toBeVisible()
  await expect(input).toHaveValue("已有导图")
  expect(await commandCalls(page, "rename_library_entry")).toHaveLength(1)
  await input.press("Escape")
  await title.click()
  await page.getByRole("button", { name: "返回所在目录", exact: true }).click()
  await expect(page.getByRole("button", { name: "打开文件 项目导图.shardmap.json", exact: true })).toBeVisible()
})

test("思维导图标题改名前等待草稿落盘，改名后继续编辑并按新路径重开", async ({ page }) => {
  await installMindMapRenameMock(page)
  const branch = page.getByRole("textbox", { name: "导图节点", exact: true })
  const title = page.getByRole("button", { name: "重命名文件", exact: true })
  await page.evaluate(() => { (window as MindMapRenameRuntime).__mindMapRename.holdSave = true })
  await branch.fill("改名前的草稿")
  await title.click()
  const input = page.getByRole("textbox", { name: "重命名名称", exact: true })
  await input.fill("持续编辑")
  await input.press("Enter")
  await expect.poll(() => commandCalls(page, "write_mind_map")).toHaveLength(1)
  expect(await commandCalls(page, "rename_library_entry")).toHaveLength(0)
  await expect(input).toBeDisabled()
  await page.evaluate(() => (window as MindMapRenameRuntime).__mindMapRename.release())
  await expect(title).toHaveText("持续编辑")
  expect(await page.evaluate(() => (window as MindMapRenameRuntime).__mindMapRename.events)).toEqual([
    "write:start", "write:done", "rename",
  ])
  await expect(branch).toHaveValue("改名前的草稿")

  await branch.fill("改名后继续编辑")
  await page.getByRole("button", { name: "保存思维导图", exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as MindMapRenameRuntime).__mindMapRename.disk.file.nodes["branch-1"].text)).toBe("改名后继续编辑")
  await page.getByRole("button", { name: "返回所在目录", exact: true }).click()
  await page.getByRole("button", { name: "打开文件 持续编辑.shardmap.json", exact: true }).click()
  await page.getByRole("tab", { name: "大纲", exact: true }).click()
  await expect(title).toHaveText("持续编辑")
  await expect(branch).toHaveValue("改名后继续编辑")
  await expect(page.getByRole("textbox", { name: "根节点", exact: true })).toHaveValue("项目导图")
  expect(await page.evaluate(() => (window as MindMapRenameRuntime).__mindMapRename.readPaths)).toContain("notes/持续编辑.shardmap.json")
  expect((await commandCalls(page, "write_mind_map")).every(call => call.args.id === "map-project")).toBe(true)
})

test("导图自动保存完成后改名输入仍可编辑并确认", async ({ page }) => {
  await installMindMapRenameMock(page)
  const branch = page.getByRole("textbox", { name: "导图节点", exact: true })
  const title = page.getByRole("button", { name: "重命名文件", exact: true })
  await page.evaluate(() => { (window as MindMapRenameRuntime).__mindMapRename.holdSave = true })
  await branch.fill("自动保存中的修改")
  await title.click()
  const input = page.getByRole("textbox", { name: "重命名名称", exact: true })
  await expect(input).toBeFocused()
  await expect.poll(() => commandCalls(page, "write_mind_map")).toHaveLength(1)
  await page.evaluate(() => (window as MindMapRenameRuntime).__mindMapRename.release())
  await expect.poll(() => page.evaluate(() => (window as MindMapRenameRuntime).__mindMapRename.events)).toContain("write:done")
  await expect(input).toBeVisible()
  await expect(input).toBeFocused()
  expect(await commandCalls(page, "rename_library_entry")).toHaveLength(0)
  await input.fill("自动保存后改名")
  await input.press("Enter")
  await expect(title).toHaveText("自动保存后改名")
  await expect(branch).toHaveValue("自动保存中的修改")
})

test("思维导图标题改名保存失败或名称冲突时保留草稿与输入，可修正后重试", async ({ page }) => {
  await installMindMapRenameMock(page)
  const branch = page.getByRole("textbox", { name: "导图节点", exact: true })
  await page.evaluate(() => { (window as MindMapRenameRuntime).__mindMapRename.failSave = true })
  await branch.fill("失败后仍需保留的草稿")
  await page.getByRole("button", { name: "重命名文件", exact: true }).click()
  const input = page.getByRole("textbox", { name: "重命名名称", exact: true })
  await input.fill("已有导图")
  await input.press("Enter")
  await expect(page.locator("[data-sonner-toast]").filter({ hasText: "思维导图保存失败" })).toHaveAttribute("data-type", "error")
  await expect(input).toBeEnabled()
  await expect(input).toHaveValue("已有导图")
  await expect(branch).toHaveValue("失败后仍需保留的草稿")
  expect(await commandCalls(page, "rename_library_entry")).toHaveLength(0)
  expect(await page.evaluate(() => (window as MindMapRenameRuntime).__mindMapRename.disk.path)).toBe("notes/项目导图.shardmap.json")

  await page.evaluate(() => { (window as MindMapRenameRuntime).__mindMapRename.failSave = false })
  await input.press("Enter")
  await expect(page.locator('[data-sonner-toast][data-type="error"]').filter({ hasText: "重命名失败" })).toBeVisible()
  await expect(input).toBeEnabled()
  await expect(input).toHaveValue("已有导图")
  await expect(branch).toHaveValue("失败后仍需保留的草稿")
  expect(await page.evaluate(() => (window as MindMapRenameRuntime).__mindMapRename.disk.path)).toBe("notes/项目导图.shardmap.json")
  await input.fill("修正后的名称")
  await input.press("Enter")
  await expect(page.getByRole("button", { name: "重命名文件", exact: true })).toHaveText("修正后的名称")
  const disk = await page.evaluate(() => (window as MindMapRenameRuntime).__mindMapRename.disk)
  expect(disk.path).toBe("notes/修正后的名称.shardmap.json")
  expect(disk.file.nodes["branch-1"].text).toBe("失败后仍需保留的草稿")
  expect((await commandCalls(page, "rename_library_entry")).map(call => call.args.newName)).toEqual(["已有导图", "修正后的名称"])
})

test("资料库思维导图可进入并退出禅模式", async ({ page }) => {
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  const treePane = page.getByRole("complementary", { name: "资料库目录" })
  await treePane.getByRole("button", {
    name: /^文件（/u,
    exact: true,
  }).click()
  await page.getByRole("region", { name: "notes 目录列表", exact: true })
    .getByRole("button", {
      name: "打开文件 项目导图.shardmap.json",
      exact: true,
    })
    .click()
  await expect(page.getByLabel("思维导图编辑器", { exact: true })).toBeVisible()

  await page.getByRole("button", { name: "进入禅模式", exact: true }).click()
  const zenSurface = page.getByLabel("资料库思维导图禅模式", { exact: true })
  await expect(zenSurface).toBeVisible()
  await expect(
    zenSurface.getByLabel("思维导图编辑器", { exact: true })
  ).toBeVisible()

  await page.keyboard.press("Escape")
  await expect(zenSurface).toHaveCount(0)
  await expect(treePane).toBeVisible()
  await expect(page.getByLabel("思维导图编辑器", { exact: true })).toBeVisible()
})

test("碎片禅编辑器仍可打开并通过 Escape 关闭", async ({ page }) => {
  const fragmentCard = page.locator('[data-shard-fragment-id="fragment-august"]')
  await fragmentCard.getByRole("button", { name: "片段操作", exact: true }).click()
  await page.getByRole("menuitem", { name: "禅模式", exact: true }).click()

  const zenEditor = page.getByLabel("禅模式片段编辑器", { exact: true })
  await expect(zenEditor).toBeVisible()
  await page.keyboard.press("Escape")

  await expect(zenEditor).toHaveCount(0)
  await expect(fragmentCard).toBeVisible()
})

test("更多操作菜单不再提供思维导图入口", async ({ page }) => {
  const sidebar = page.getByRole("navigation", { name: "工作台导航" })
  await expect(sidebar.getByRole("button", { name: /思维导图/ })).toHaveCount(0)
  await page.locator("[data-shard-utility-menu-trigger]:visible").click()
  await expect(page.getByRole("menuitem", { name: "设置", exact: true })).toBeVisible()
  await expect(page.getByRole("menuitem", { name: "思维导图", exact: true })).toHaveCount(0)
})

test("资料库文档粘贴图片会调用共享上传命令", async ({ page }) => {
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  const treePane = page.getByRole("complementary", { name: "资料库目录" })
  await treePane.getByRole("button", { name: "项目", exact: true }).click()
  await page.getByRole("region", { name: "notes/项目 目录列表", exact: true })
    .getByRole("button", { name: "打开文件 项目计划.md", exact: true })
    .click()

  const editor = page.locator('[data-shard-editor="library:note-plan"]')
  await editor.locator(".ProseMirror").evaluate((element) => {
    const clipboardData = new DataTransfer()
    clipboardData.items.add(
      new File([new Uint8Array([137, 80, 78, 71])], "library-paste.png", {
        type: "image/png",
      })
    )
    element.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData,
      })
    )
  })

  await expect.poll(() => commandCalls(page, "save_fragment_image")).toHaveLength(1)
  expect((await commandCalls(page, "save_fragment_image"))[0].args).toEqual({
    bytes: [137, 80, 78, 71],
    fileName: "library-paste.png",
  })
})

test("转回碎片已移动后响应丢失会核对当前类型，不重试转换或留下旧文档编辑器", async ({ page }) => {
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  await page.getByRole("button", { name: "打开文件 旧笔记.md", exact: true }).click()
  await fillEditor(page, "library:note-old", "# 转换前已保存\n保留这段最新正文")
  await page.getByRole("button", { name: "返回所在目录", exact: true }).click()
  await expect.poll(() => commandCalls(page, "update_fragment")).toHaveLength(1)
  await page.evaluate(() => { (globalThis as typeof globalThis & { __SHARD_REVERSE_FAIL_AFTER_MOVE__?: boolean }).__SHARD_REVERSE_FAIL_AFTER_MOVE__ = true })
  await page.getByRole("button", { name: "旧笔记.md 操作", exact: true }).click()
  await page.getByRole("menuitem", { name: "转回碎片", exact: true }).click()

  await expect(page.locator('[data-sonner-toast][data-type="success"]').filter({ hasText: "内容已转回碎片" })).toBeVisible()
  const fragment = page.locator('[data-shard-fragment-id="note-old"]')
  await expect(fragment).toBeVisible()
  await expect(fragment).toContainText("保留这段最新正文")
  expect(await commandCalls(page, "convert_note_to_fragment")).toHaveLength(1)
  await expect(page.locator('[data-shard-editor="library:note-old"]')).toHaveCount(0)
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  await expect(page.getByRole("region", { name: "notes 目录列表", exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "打开文件 旧笔记.md", exact: true })).toHaveCount(0)
  expect(await commandCalls(page, "update_fragment")).toHaveLength(1)
})

test("未配置密匣时点击树上挂载点直接进入设置流程", async ({ page }) => {
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  const treePane = page.getByRole("complementary", { name: "资料库目录" })

  const mount = treePane.getByRole("button", {
    name: "密匣（上锁空间）",
    exact: true,
  })
  await expect(mount).toBeVisible()
  // 挂载点是一扇门不是文件夹：无展开箭头、不列子文件
  await expect(mount.locator("svg")).toHaveCount(1)
  await mount.click()
  await expect(page.getByRole("heading", { name: "设置密匣" })).toBeVisible()
})

test("解锁密匣后从资料库菜单移入笔记并刷新资料库树", async ({ page }) => {
  // 本用例需要已配置且解锁的密匣：局部覆盖全局的「未配置」默认 mock
  await installLibraryTreeMock(page, {
    configured: true,
    unlocked: true,
    expiresAt: null,
    ttlSeconds: 900,
  })
  await page.goto("/")
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  const treePane = page.getByRole("complementary", { name: "资料库目录" })
  await treePane.getByRole("button", {
    name: /^文件（/u,
    exact: true,
  }).click()
  const rootList = page.getByRole("region", { name: "notes 目录列表", exact: true })
  const note = rootList.getByRole("button", { name: "打开文件 旧笔记.md", exact: true })
  await expect(note).toBeVisible()

  page.once("dialog", (dialog) => dialog.accept())
  await rootList
    .getByRole("button", { name: "旧笔记.md 操作", exact: true })
    .click()
  await page.getByRole("menuitem", { name: "移入密匣", exact: true }).click()

  await expect.poll(() => commandCalls(page, "move_fragment_to_lockbox")).toHaveLength(1)
  expect((await commandCalls(page, "move_fragment_to_lockbox"))[0].args).toEqual({
    id: "note-old",
  })
  await expect(note).toHaveCount(0)
})

test("目录列表里的文件可重命名、移动和删除", async ({ page }) => {
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  const treePane = page.getByRole("complementary", { name: "资料库目录" })
  await treePane.getByRole("button", {
    name: /^文件（/u,
    exact: true,
  }).click()
  const rootList = page.getByRole("region", { name: "notes 目录列表", exact: true })
  await expect(rootList.getByRole("button", {
    name: "打开文件 项目导图.shardmap.json",
    exact: true,
  })).toHaveText("项目导图")

  await rootList.getByRole("button", {
    name: "项目导图.shardmap.json 操作",
    exact: true,
  }).click()
  await page.getByRole("menuitem", { name: "重命名", exact: true }).click()
  const renameInput = rootList.getByRole("textbox", {
    name: "重命名名称",
    exact: true,
  })
  await expect(renameInput).toHaveValue("项目导图")
  await renameInput.fill("架构总览")
  await renameInput.press("Enter")
  await expect(
    rootList.getByRole("button", {
      name: "打开文件 架构总览.shardmap.json",
      exact: true,
    })
  ).toHaveText("架构总览")

  const originalViewport = page.viewportSize()!
  await page.setViewportSize({ width: 960, height: originalViewport.height })
  await rootList.getByRole("button", {
    name: "架构总览.shardmap.json 操作",
    exact: true,
  }).click()
  await page.getByRole("menuitem", { name: "移动到…", exact: true }).hover()
  const parentMenu = page.locator('[data-slot="dropdown-menu-content"]')
  const moveMenu = page.locator('[data-slot="dropdown-menu-sub-content"]')
  await expect(moveMenu).toBeVisible()
  await expect(moveMenu).toHaveAttribute("data-side", "left")
  // 等入场缩放结束后测量，左翻子菜单也必须紧邻父菜单外侧。
  await Promise.all([parentMenu, moveMenu].map(menu => menu.evaluate(async element => {
    await Promise.all(element.getAnimations().map(animation => animation.finished))
  })))
  const [parentBounds, moveBounds] = await Promise.all([parentMenu.boundingBox(), moveMenu.boundingBox()])
  expect(parentBounds).not.toBeNull()
  expect(moveBounds).not.toBeNull()
  const menuGap = parentBounds!.x - (moveBounds!.x + moveBounds!.width)
  expect(menuGap).toBeGreaterThanOrEqual(0)
  expect(menuGap).toBeLessThanOrEqual(4)
  await page.getByRole("menuitem", { name: "项目", exact: true }).click()
  await page.setViewportSize(originalViewport)
  await treePane.getByRole("button", { name: "项目", exact: true }).click()
  const projectList = page.getByRole("region", {
    name: "notes/项目 目录列表",
    exact: true,
  })
  await expect(
    projectList.getByRole("button", {
      name: "打开文件 架构总览.shardmap.json",
      exact: true,
    })
  ).toBeVisible()

  await projectList.getByRole("button", {
    name: "架构总览.shardmap.json 操作",
    exact: true,
  }).click()
  await page.getByRole("menuitem", { name: "删除", exact: true }).click()
  await page.getByRole("dialog", { name: "确认删除" })
    .getByRole("button", { name: "删除", exact: true })
    .click()

  await expect.poll(() => commandCalls(page, "rename_library_entry")).toHaveLength(1)
  await expect.poll(() => commandCalls(page, "move_library_entry")).toHaveLength(1)
  await expect.poll(() => commandCalls(page, "delete_library_entry")).toHaveLength(1)
  expect((await commandCalls(page, "rename_library_entry"))[0].args).toEqual({
    newName: "架构总览",
    path: "notes/项目导图.shardmap.json",
  })
  expect((await commandCalls(page, "move_library_entry"))[0].args).toEqual({
    destinationDirectory: "notes/项目",
    path: "notes/架构总览.shardmap.json",
  })
  expect((await commandCalls(page, "delete_library_entry"))[0].args).toEqual({
    path: "notes/项目/架构总览.shardmap.json",
  })
  await expect(
    projectList.getByRole("button", {
      name: "打开文件 架构总览.shardmap.json",
      exact: true,
    })
  ).toHaveCount(0)
})

test("目录宫格里的文件可重命名、移动和删除，操作菜单在顶栏常驻", async ({ page }) => {
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  const treePane = page.getByRole("complementary", { name: "资料库目录" })
  await treePane.getByRole("button", {
    name: /^文件（/u,
    exact: true,
  }).click()
  const viewer = page.getByRole("article", { name: "资料库查看器" })
  await viewer.getByRole("button", { name: "宫格视图", exact: true }).click()
  const rootGrid = viewer.getByRole("list", { name: "notes 目录宫格", exact: true })
  const noteCard = rootGrid.getByRole("button", {
    name: "打开文件 旧笔记.md",
    exact: true,
  })
  const noteMenu = rootGrid.getByRole("button", {
    name: "旧笔记.md 操作",
    exact: true,
  })

  await expect(noteMenu.locator("..")).toHaveCSS("opacity", "1")
  await noteCard.hover()
  await expect(noteMenu.locator("..")).toHaveCSS("opacity", "1")
  await noteMenu.click()
  await expect(page.getByRole("menuitem", { name: "转回碎片", exact: true })).toBeVisible()
  await expect(page.getByRole("menuitem", { name: "移入密匣", exact: true })).toBeVisible()
  await page.getByRole("menuitem", { name: "重命名", exact: true }).click()
  const renameInput = rootGrid.getByRole("textbox", {
    name: "重命名名称",
    exact: true,
  })
  await renameInput.fill("宫格笔记")
  await renameInput.press("Enter")

  await treePane.getByRole("button", {
    name: /^文件（/u,
    exact: true,
  }).click()
  const renamedMenu = viewer.getByRole("list", {
    name: "notes 目录宫格",
    exact: true,
  }).getByRole("button", { name: "宫格笔记.md 操作", exact: true })
  await renamedMenu.focus()
  await expect(renamedMenu.locator("..")).toHaveCSS("opacity", "1")
  await renamedMenu.click()
  await page.getByRole("menuitem", { name: "移动到…", exact: true }).hover()
  await page.getByRole("menuitem", { name: "项目", exact: true }).click()

  await treePane.getByRole("button", { name: "项目", exact: true }).click()
  const projectGrid = viewer.getByRole("list", {
    name: "notes/项目 目录宫格",
    exact: true,
  })
  const projectMenu = projectGrid.getByRole("button", {
    name: "宫格笔记.md 操作",
    exact: true,
  })
  // 操作按钮在独立顶栏中常驻，并保持键盘可达。
  await projectMenu.focus()
  await projectMenu.click()
  await page.getByRole("menuitem", { name: "删除", exact: true }).click()
  await page.getByRole("dialog", { name: "确认删除" })
    .getByRole("button", { name: "删除", exact: true })
    .click()

  await expect.poll(() => commandCalls(page, "rename_library_entry")).toHaveLength(1)
  await expect.poll(() => commandCalls(page, "move_library_entry")).toHaveLength(1)
  await expect.poll(() => commandCalls(page, "delete_library_entry")).toHaveLength(1)
  await expect(projectGrid.getByRole("button", {
    name: "打开文件 宫格笔记.md",
    exact: true,
  })).toHaveCount(0)
})

test("第三栏菜单只给 Markdown 提供转碎片和移入密匣", async ({ page }) => {
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  const treePane = page.getByRole("complementary", { name: "资料库目录" })
  await treePane.getByRole("button", {
    name: /^文件（/u,
    exact: true,
  }).click()
  const rootList = page.getByRole("region", { name: "notes 目录列表", exact: true })

  await rootList.getByRole("button", { name: "旧笔记.md 操作", exact: true }).click()
  await expect(page.getByRole("menuitem", { name: "转回碎片", exact: true })).toBeVisible()
  await expect(page.getByRole("menuitem", { name: "移入密匣", exact: true })).toBeVisible()
  await page.keyboard.press("Escape")
  // 菜单需完全卸载再开下一个，否则两个菜单并存会撞 strict mode。
  await expect(page.getByRole("menu")).toHaveCount(0)

  for (const name of ["清单.csv", "项目导图.shardmap.json", "项目"]) {
    await rootList.getByRole("button", { name: `${name} 操作`, exact: true }).click()
    await expect(page.getByRole("menuitem", { name: "重命名", exact: true })).toBeVisible()
    await expect(page.getByRole("menuitem", { name: "移动到…", exact: true })).toBeVisible()
    await expect(page.getByRole("menuitem", { name: "删除", exact: true })).toBeVisible()
    await expect(page.getByRole("menuitem", { name: "转回碎片", exact: true })).toHaveCount(0)
    await expect(page.getByRole("menuitem", { name: "移入密匣", exact: true })).toHaveCount(0)
    await page.keyboard.press("Escape")
    await expect(page.getByRole("menu")).toHaveCount(0)
  }
})

test("子目录新建文档直接聚焦正文，键盘输入后可保存", async ({ page }) => {
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  await page.getByRole("complementary", { name: "资料库目录" })
    .getByRole("button", { name: "项目", exact: true }).click()
  await createLibraryEntry(page, "新建文档")

  const editor = page.getByRole("textbox", { name: "资料库文档编辑器", exact: true })
  await expect(editor).toBeFocused()
  await expect(page.getByRole("textbox", { name: "重命名名称", exact: true })).toHaveCount(0)
  await expect.poll(() => readEditor(page, "library:note-created-5")).toBe("# 未命名")
  await page.keyboard.press("ControlOrMeta+End")
  await page.keyboard.press("Enter")
  await page.keyboard.insertText("直接写入子目录笔记")
  await expect.poll(() => readEditor(page, "library:note-created-5")).toBe("# 未命名\n\n直接写入子目录笔记")
  await page.keyboard.press("ControlOrMeta+s")
  await expect.poll(async () => (await commandCalls(page, "update_fragment"))
    .some(call => call.args.id === "note-created-5" && call.args.content === "# 未命名\n\n直接写入子目录笔记")).toBe(true)
  expect((await commandCalls(page, "create_library_note"))[0].args).toEqual({ parentPath: "notes/项目", title: "未命名" })
  await page.getByRole("button", { name: "返回所在目录", exact: true }).click()
  await expect(page.getByRole("region", { name: "notes/项目 目录列表", exact: true })
    .getByRole("button", { name: "打开文件 未命名.md", exact: true })).toBeVisible()
})

test("已有笔记草稿保存完成后再新建，连续新建均直接接受键盘输入", async ({ page }) => {
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  await page.getByRole("button", { name: /^文件（/u, exact: true }).click()
  await page.getByRole("button", { name: "打开文件 旧笔记.md", exact: true }).click()
  await page.evaluate(() => {
    const runtime = window as typeof window & {
      __TAURI_INTERNALS__: { invoke(command: string, args?: Record<string, unknown>): Promise<unknown> }
      __newNoteSaveGate?: { entered: boolean; release(): void }
    }
    const original = runtime.__TAURI_INTERNALS__.invoke
    let release = () => {}
    const pending = new Promise<void>(resolve => { release = resolve })
    const gate = { entered: false, release }
    runtime.__newNoteSaveGate = gate
    runtime.__TAURI_INTERNALS__.invoke = async (command, args = {}) => {
      if (command === "update_fragment" && args.id === "note-old") {
        gate.entered = true
        await pending
      }
      return original(command, args)
    }
  })
  await fillEditor(page, "library:note-old", "# 原有笔记\n\n创建前必须保存的草稿")
  await createLibraryEntry(page, "新建文档")
  await expect.poll(() => page.evaluate(() => (window as any).__newNoteSaveGate.entered)).toBe(true)
  expect(await commandCalls(page, "create_library_note")).toHaveLength(0)
  await expect.poll(() => readEditor(page, "library:note-old")).toBe("# 原有笔记\n\n创建前必须保存的草稿")
  await page.evaluate(() => (window as any).__newNoteSaveGate.release())

  const editor = page.getByRole("textbox", { name: "资料库文档编辑器", exact: true })
  for (const [index, text] of ["第一篇正文", "第二篇正文"].entries()) {
    const editorId = `library:note-created-${5 + index}`
    await expect(page.locator(`[data-shard-editor="${editorId}"]`)).toBeVisible()
    await expect(editor).toBeFocused()
    await page.keyboard.press("ControlOrMeta+End")
    await page.keyboard.press("Enter")
    await page.keyboard.insertText(text)
    await expect.poll(() => readEditor(page, editorId)).toBe(`# 未命名\n\n${text}`)
    if (index === 0) await createLibraryEntry(page, "新建文档")
  }
  await page.keyboard.press("ControlOrMeta+s")
  const writes = await commandCalls(page, "update_fragment")
  expect(writes.some(call => call.args.id === "note-old" && call.args.content === "# 原有笔记\n\n创建前必须保存的草稿")).toBe(true)
  expect(writes.some(call => call.args.id === "note-created-5" && call.args.content === "# 未命名\n\n第一篇正文")).toBe(true)
  await expect.poll(async () => (await commandCalls(page, "update_fragment"))
    .some(call => call.args.id === "note-created-6" && call.args.content === "# 未命名\n\n第二篇正文")).toBe(true)
  await expect(page.getByRole("button", { name: "重命名文件", exact: true })).toHaveText("未命名-2")
  expect(await commandCalls(page, "create_library_note")).toHaveLength(2)
})

test("窄屏新建文档直接显示并聚焦编辑器", async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 720 })
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  await createLibraryEntry(page, "新建文档")
  const editor = page.getByRole("textbox", { name: "资料库文档编辑器", exact: true })
  await expect(editor).toBeVisible()
  await expect(editor).toBeFocused()
  await page.keyboard.press("ControlOrMeta+End")
  await page.keyboard.press("Enter")
  await page.keyboard.insertText("窄屏直接输入")
  await expect.poll(() => readEditor(page, "library:note-created-5")).toBe("# 未命名\n\n窄屏直接输入")
})

test("新建前保存失败会保留原笔记草稿且不创建文件", async ({ page }) => {
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  await page.getByRole("button", { name: /^文件（/u, exact: true }).click()
  await page.getByRole("button", { name: "打开文件 旧笔记.md", exact: true }).click()
  await page.evaluate(() => {
    const runtime = window as typeof window & {
      __TAURI_INTERNALS__: { invoke(command: string, args?: Record<string, unknown>): Promise<unknown> }
    }
    const original = runtime.__TAURI_INTERNALS__.invoke
    runtime.__TAURI_INTERNALS__.invoke = async (command, args = {}) => {
      if (command === "update_fragment") throw new Error("新建文档测试：保存失败")
      return original(command, args)
    }
  })
  await fillEditor(page, "library:note-old", "# 保留草稿\n\n尚未保存")
  await createLibraryEntry(page, "新建文档")
  await expect(page.locator('[data-sonner-toast][data-type="error"]').filter({ hasText: "文档保存失败" })).toBeVisible()
  await expect.poll(() => readEditor(page, "library:note-old")).toBe("# 保留草稿\n\n尚未保存")
  await expect(page.getByRole("button", { name: "重命名文件", exact: true })).toHaveText("旧笔记")
  expect(await commandCalls(page, "create_library_note")).toHaveLength(0)
})

test("目录树 MVP 支持新建、重命名、菜单移动和非空目录整棵移入回收站", async ({ page }) => {
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  const treePane = page.getByRole("complementary", { name: "资料库目录" })

  await createLibraryEntry(page, "新建目录")
  const dirInput = treePane.getByRole("textbox", {
    name: "新目录名称",
    exact: true,
  })
  await dirInput.fill("空目录")
  await dirInput.press("Enter")
  await expect(treePane.getByRole("button", { name: "空目录", exact: true })).toBeVisible()

  await createLibraryEntry(page, "新建文档")
  const viewer = page.getByRole("article", { name: "资料库查看器" })
  await expect(viewer.getByRole("textbox", { name: "资料库文档编辑器", exact: true })).toBeFocused()
  await expect(viewer.getByRole("textbox", { name: "重命名名称", exact: true })).toHaveCount(0)

  await page.getByRole("button", { name: "重命名文件", exact: true }).click()
  const editorRenameInput = page.getByRole("textbox", {
    name: "重命名名称",
    exact: true,
  })
  await editorRenameInput.fill("已改名")
  await editorRenameInput.press("Enter")
  await expect(page.getByRole("button", { name: "重命名文件", exact: true })).toHaveText(
    "已改名"
  )
  await expect.poll(() => readEditor(page, "library:note-created-5")).toBe("# 未命名")

  await treePane.getByRole("button", {
    name: /^文件（/u,
    exact: true,
  }).click()
  await viewer.getByRole("region", { name: "notes 目录列表", exact: true })
    .getByRole("button", { name: "已改名.md 操作", exact: true })
    .click()
  await page.getByRole("menuitem", { name: "移动到…", exact: true }).hover()
  await page.getByRole("menuitem", { name: "项目", exact: true }).click()
  await treePane.getByRole("button", { name: "项目", exact: true }).click()
  await expect(viewer.getByRole("region", { name: "notes/项目 目录列表", exact: true })
    .getByRole("button", { name: "打开文件 已改名.md", exact: true })).toBeVisible()

  await treePane.getByRole("button", {
    name: /^文件（/u,
    exact: true,
  }).click()
  await viewer.getByRole("region", { name: "notes 目录列表", exact: true })
    .getByRole("button", { name: "项目 操作", exact: true })
    .click()
  await page.getByRole("menuitem", { name: "删除", exact: true }).click()
  const projectDialog = page.getByRole("dialog", { name: "确认删除", exact: true })
  await projectDialog.getByRole("button", { name: "删除", exact: true }).click()
  await expect.poll(() => commandCalls(page, "delete_library_entry")).toHaveLength(1)
  await expect(treePane.getByRole("button", { name: "项目", exact: true })).toHaveCount(0)

  await treePane.getByRole("button", { name: "空目录 操作", exact: true }).click()
  await page.getByRole("menuitem", { name: "删除", exact: true }).last().click()
  const dialog = page.getByRole("dialog", { name: "确认删除" })
  await dialog.getByRole("button", { name: "删除", exact: true }).click()
  await expect.poll(() => commandCalls(page, "delete_library_entry")).toHaveLength(2)
  await expect(treePane.getByRole("button", { name: "空目录", exact: true })).toHaveCount(0)
  expect((await commandCalls(page, "create_library_directory"))[0].args).toEqual({
    name: "空目录",
    parentPath: "notes",
  })
  expect((await commandCalls(page, "create_library_note"))[0].args).toEqual({
    parentPath: "notes",
    title: "未命名",
  })
  expect((await commandCalls(page, "rename_library_entry"))[0].args).toEqual({
    newName: "已改名",
    path: "notes/未命名.md",
  })
  expect((await commandCalls(page, "move_library_entry"))[0].args).toEqual({
    destinationDirectory: "notes/项目",
    path: "notes/已改名.md",
  })
})

test("重命名批量更新旧 wikilink 后仍可从别名链接导航", async ({ page }) => {
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  const treePane = page.getByRole("complementary", { name: "资料库目录" })
  await treePane.getByRole("button", {
    name: /^文件（/u,
    exact: true,
  }).click()
  const rootList = page.getByRole("region", { name: "notes 目录列表", exact: true })

  await rootList.getByRole("button", { name: "旧笔记.md 操作", exact: true }).click()
  await page.getByRole("menuitem", { name: "重命名", exact: true }).click()
  const renameInput = rootList.getByRole("textbox", {
    name: "重命名名称",
    exact: true,
  })
  await renameInput.fill("新笔记")
  await renameInput.press("Enter")
  await expect(page.locator('[data-sonner-toast][data-type="success"]').filter({ hasText: "1 处双链引用已更新" })).toBeVisible()
  expect((await commandCalls(page, "rename_library_entry"))[0].args).toEqual({
    newName: "新笔记",
    path: "notes/旧笔记.md",
  })

  await treePane.getByRole("button", { name: "项目", exact: true }).click()
  await page.getByRole("region", { name: "notes/项目 目录列表", exact: true })
    .getByRole("button", { name: "打开文件 项目计划.md", exact: true })
    .click()
  const sourceEditor = page.locator('[data-shard-editor="library:note-plan"]')
  await expect.poll(() => readEditor(page, "library:note-plan")).toContain(
    "[[新笔记|打开笔记]]"
  )
  const aliasChip = sourceEditor.getByRole("link", {
    name: "双链：新笔记",
    exact: true,
  })
  await expect(aliasChip).toHaveText("打开笔记")
  await aliasChip.click()
  await expect(page.locator('[data-shard-editor="library:note-old"]')).toBeVisible()
})

test("回收站与密匣钉在列底常驻条，不随笔记树滚动", async ({ page }) => {
  await page.goto("/")
  await page.getByRole("button", { name: "资料库", exact: true }).click()

  // 两个出口都住在底部常驻条里；只要它们在这条里，就必然不在可滚动的树中
  const footer = page.locator("[data-library-footer]")
  await expect(footer).toBeVisible()
  await expect(footer.getByRole("button", { name: /^回收站/ })).toBeVisible()
  await expect(
    footer.getByRole("button", { name: "密匣（上锁空间）", exact: true })
  ).toBeVisible()

  // 常驻条贴在这一列底边，且排在可滚动区之后
  const geometry = await page.evaluate(() => {
    const footerEl = document.querySelector("[data-library-footer]")
    const pane = footerEl?.parentElement
    if (!footerEl || !pane) return null
    const f = footerEl.getBoundingClientRect()
    const p = pane.getBoundingClientRect()
    return { gapToBottom: Math.round(p.bottom - f.bottom) }
  })
  expect(geometry?.gapToBottom).toBe(0)
})

test("资料库图片分组在第三栏打开网格并保留侧栏与目录树", async ({ page }) => {
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  const treePane = page.getByRole("complementary", { name: "资料库目录" })
  const sidebar = page.getByRole("navigation", { name: "工作台导航" })

  const group = treePane.getByRole("button", { name: "图片（1）", exact: true })
  await expect(group).toBeVisible()
  await group.click()

  // 网格就地展示，不接管窗口——侧栏与目录树都还在。
  await expect(page.getByRole("list", { name: "图片列表" })).toBeVisible()
  await expect(
    page.getByRole("list", { name: "图片列表" }).locator("img")
  ).toHaveAttribute(
    "src",
    "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs="
  )
  await expect(sidebar).toBeVisible()
  await expect(treePane).toBeVisible()

  // 网格是列表视图，没有「专注编辑」语义。
  await expect(
    page.getByRole("button", { name: "进入禅模式", exact: true })
  ).toHaveCount(0)
})

test("图片网格可进单张视图并返回", async ({ page }) => {
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  const treePane = page.getByRole("complementary", { name: "资料库目录" })
  await treePane.getByRole("button", { name: "图片（1）", exact: true }).click()

  await page.getByRole("list", { name: "图片列表" }).getByRole("button").first().click()
  await expect(
    page.getByRole("button", { name: "返回图片列表", exact: true })
  ).toBeVisible()

  // 单张大图有专注语义，禅按钮回来了。
  await expect(
    page.getByRole("button", { name: "进入禅模式", exact: true })
  ).toBeVisible()

  await page.getByRole("button", { name: "返回图片列表", exact: true }).click()
  await expect(page.getByRole("list", { name: "图片列表" })).toBeVisible()
})

test("没有图片时保留稳定入口并显示图片空态", async ({ page }) => {
  await installLibraryTreeMock(page, DEFAULT_LOCKBOX_STATE, false)
  await page.goto("/")

  await page.getByRole("button", { name: "资料库", exact: true }).click()
  const treePane = page.getByRole("complementary", { name: "资料库目录" })
  const pictures = treePane.getByRole("button", { name: "图片（0）", exact: true })
  await expect(pictures).toBeVisible()
  await pictures.click()
  await expect(page.getByRole("article", { name: "资料库查看器" })).toContainText("还没有图片附件")
  // 空集合不改变文件和特殊入口的位置或含义。
  await expect(
    treePane.getByRole("button", {
      name: "项目导图.shardmap.json",
      exact: true,
    })
  ).toHaveCount(0)
  await expect(
    treePane.getByRole("button", { name: /^思维导图（/ })
  ).toHaveCount(0)
})

type CloseGuardState = { close(): Promise<void>; listeners: number; destroyed: number; checkpoints: number; holdCheckpoint: boolean; failDestroy: boolean; failSave: boolean; release(): void }
const closeGuard = (page: Page) => page.evaluate(() => {
  const { destroyed, checkpoints } = (window as unknown as { __closeGuardTest: CloseGuardState }).__closeGuardTest
  return { destroyed, checkpoints }
})
const requestClose = (page: Page) => page.evaluate(() => (window as unknown as { __closeGuardTest: CloseGuardState }).__closeGuardTest.close())

/** 窗口关闭、检查点与同步守卫：以资料库文档的保存失败作为「草稿未落盘」来源。 */
async function installCloseGuardMock(page: Page, withSyncActions = false) {
  await page.addInitScript(({ withSyncActions }) => {
    const runtime = window as unknown as {
      __TAURI_INTERNALS__: { invoke(command: string, args?: unknown): Promise<unknown>; metadata: unknown; transformCallback(callback: (event: unknown) => unknown): number };
      __closeGuardTest: CloseGuardState;
    }
    const original = runtime.__TAURI_INTERNALS__.invoke
    const callbacks = new Map<number, (event: unknown) => unknown>()
    const listeners = new Map<number, { event: string; handler: number }>()
    let next = 0
    let release = () => {}
    const held = new Promise<void>(resolve => { release = resolve })
    const state = runtime.__closeGuardTest = {
      async close() { for (const [id, entry] of [...listeners]) if (entry.event === "tauri://close-requested") await callbacks.get(entry.handler)?.({ event: entry.event, id, payload: null }) },
      listeners: 0, destroyed: 0, checkpoints: 0, holdCheckpoint: false, failDestroy: false, failSave: false, release,
    }
    runtime.__TAURI_INTERNALS__.metadata = { currentWindow: { label: "main" }, currentWebview: { label: "main" } }
    runtime.__TAURI_INTERNALS__.transformCallback = callback => { callbacks.set(++next, callback); return next }
    Object.assign(window, { __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener() {} } })
    runtime.__TAURI_INTERNALS__.invoke = async (command, raw) => {
      if (command === "plugin:event|listen") {
        const entry = raw as { event: string; handler: number }
        listeners.set(++next, entry)
        state.listeners = [...listeners.values()].filter(item => item.event === "tauri://close-requested").length
        return next
      }
      if (command === "plugin:event|unlisten") {
        listeners.delete((raw as { eventId: number }).eventId)
        state.listeners = [...listeners.values()].filter(item => item.event === "tauri://close-requested").length
        return
      }
      if (command === "plugin:window|destroy") {
        if (state.failDestroy) throw new Error("测试窗口关闭失败")
        state.destroyed++
        return
      }
      if (command === "checkpoint_vault") {
        state.checkpoints++
        if (state.holdCheckpoint) await held
        throw new Error("测试检查点失败不应阻止已落盘内容退出")
      }
      if (command === "update_fragment" && state.failSave) throw new Error("测试：文档保存失败")
      if (command === "list_fragments" && withSyncActions) {
        const result = await original(command, raw) as { git: Record<string, unknown> }
        return { ...result, git: { ...result.git, status: "dirty", hasRemote: true } }
      }
      return original(command, raw)
    }
  }, { withSyncActions })
  await page.reload()
  await expect.poll(() => page.evaluate(() => (window as unknown as { __closeGuardTest: CloseGuardState }).__closeGuardTest.listeners)).toBe(1)
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  await page.getByRole("button", { name: /^文件（/u, exact: true }).click()
  await page.getByRole("button", { name: "打开文件 旧笔记.md", exact: true }).click()
  await expect(page.getByRole("button", { name: "重命名文件", exact: true })).toHaveText("旧笔记")
}

async function failingDraft(page: Page, content: string) {
  await page.evaluate(() => { (window as unknown as { __closeGuardTest: CloseGuardState }).__closeGuardTest.failSave = true })
  await fillEditor(page, "library:note-old", content)
}

test("保存失败取消退出保留文档草稿，明确放弃后才关闭", async ({ page }) => {
  await installCloseGuardMock(page)
  await failingDraft(page, "# 旧笔记\n\n退出前没能保存的草稿")
  page.once("dialog", dialog => dialog.dismiss())
  await requestClose(page)
  await expect.poll(() => readEditor(page, "library:note-old")).toBe("# 旧笔记\n\n退出前没能保存的草稿")
  expect(await closeGuard(page)).toEqual({ destroyed: 0, checkpoints: 0 })
  page.once("dialog", dialog => dialog.accept())
  await requestClose(page)
  expect((await closeGuard(page)).destroyed).toBe(1)
})

test("重复退出请求不能越过正在执行的检查点，关闭失败后可以重试", async ({ page }) => {
  await installCloseGuardMock(page)
  const before = await readEditor(page, "library:note-old")
  await page.evaluate(() => {
    const state = (window as unknown as { __closeGuardTest: CloseGuardState }).__closeGuardTest
    state.holdCheckpoint = true
    state.failDestroy = true
    void state.close()
  })
  await expect.poll(async () => (await closeGuard(page)).checkpoints).toBe(1)
  await expect(page.locator("main[inert]")).toHaveAttribute("aria-busy", "true")
  // 不能对 inert 元素强点：Playwright 会等到检查点的 5 秒兜底超时之后才返回。
  await expect(page.locator('[data-shard-editor="library:note-old"] .ProseMirror')).toHaveAttribute("contenteditable", "false")
  await page.keyboard.type("late-input")
  expect(await readEditor(page, "library:note-old")).toBe(before)
  await page.locator('[aria-label="Shard 侧边栏"]').getByRole("button", { name: "碎片", exact: true, includeHidden: true }).click({ force: true })
  // inert 子树不在无障碍树里，用 DOM 定位确认仍停在这篇文档。
  await expect(page.locator('[data-shard-editor="library:note-old"]')).toBeVisible()
  await requestClose(page)
  expect((await closeGuard(page)).destroyed).toBe(0)
  await page.evaluate(() => (window as unknown as { __closeGuardTest: CloseGuardState }).__closeGuardTest.release())
  await expect(page.locator('[data-sonner-toast][data-type="error"]').filter({ hasText: "退出失败" }).filter({ hasText: "当前窗口已保留。" })).toBeVisible()
  await expect(page.locator("main[inert]")).toHaveCount(0)
  await page.evaluate(async () => {
    const state = (window as unknown as { __closeGuardTest: CloseGuardState }).__closeGuardTest
    state.failDestroy = false
    await state.close()
  })
  expect((await closeGuard(page)).destroyed).toBe(1)
})

test("文档保存失败时阻止切目录与切碎片空间", async ({ page }) => {
  await installCloseGuardMock(page)
  await failingDraft(page, "# 旧笔记\n\n导航前没能保存的草稿")

  await page.getByRole("complementary", { name: "资料库目录" }).getByRole("button", { name: /^文件（/u, exact: true }).click()
  await expect(page.locator('[data-sonner-toast][data-type="error"]').filter({ hasText: "文档保存失败" }).first()).toBeVisible()
  await expect(page.getByRole("region", { name: "notes 目录列表", exact: true })).toHaveCount(0)
  await expect.poll(() => readEditor(page, "library:note-old")).toBe("# 旧笔记\n\n导航前没能保存的草稿")

  await page.getByRole("button", { name: "碎片", exact: true }).click()
  await expect(page.getByRole("button", { name: "重命名文件", exact: true })).toHaveText("旧笔记")
  await expect.poll(() => readEditor(page, "library:note-old")).toBe("# 旧笔记\n\n导航前没能保存的草稿")
  await expect.poll(() => page.evaluate(() => localStorage.getItem("shard.workspace-route"))).toBe(JSON.stringify({ space: "library", params: {} }))
})

test("文档保存失败时阻止手动同步与检查点调用", async ({ page }) => {
  await installCloseGuardMock(page, true)
  await failingDraft(page, "# 旧笔记\n\n同步前没能保存的草稿")
  const syncCallsBefore = (await commandCalls(page, "sync_vault")).length
  const checkpointsBefore = (await closeGuard(page)).checkpoints
  const statusBar = page.getByRole("contentinfo", { name: "状态栏" })

  await statusBar.getByRole("button", { name: "同步", exact: true }).click()
  await expect(page.locator('[data-sonner-toast][data-type="error"]').filter({ hasText: "草稿保存失败" }).filter({ hasText: "已取消同步。" })).toBeVisible()
  expect(await commandCalls(page, "sync_vault")).toHaveLength(syncCallsBefore)

  await statusBar.getByRole("button", { name: "未提交更改", exact: true }).click()
  await expect(page.locator('[data-sonner-toast][data-type="error"]').filter({ hasText: "草稿保存失败" }).filter({ hasText: "已取消提交。" })).toBeVisible()
  expect((await closeGuard(page)).checkpoints).toBe(checkpointsBefore)
  await expect.poll(() => readEditor(page, "library:note-old")).toBe("# 旧笔记\n\n同步前没能保存的草稿")
})

async function installCanvasLibraryMock(page: Page) {
  await page.addInitScript(() => {
    const runtime = window as unknown as {
      __TAURI_INTERNALS__: { invoke(command: string, args?: unknown): Promise<unknown> }
      __canvasLibrary: { disk: Record<string, unknown> | null; fail: boolean; writes: number }
    }
    const original = runtime.__TAURI_INTERNALS__.invoke
    const state = { disk: null as Record<string, unknown> | null, fail: false, writes: 0 }
    runtime.__canvasLibrary = state
    const addEntry = (tree: { entries: unknown[] }) => {
      if (state.disk) {
        const path = String(state.disk.path)
        const parent = path.slice(0, path.lastIndexOf("/"))
        const target = parent === "notes" ? tree.entries : (tree.entries as any[]).find(entry => entry.path === parent)?.children
        target?.push({ name: path.split("/").pop(), path, kind: "flowchart", size: 256, modifiedAt: "2026-09-07T00:00:00Z" })
      }
      return tree
    }
    runtime.__TAURI_INTERNALS__.invoke = async (command, args) => {
      const raw = args instanceof Uint8Array
      const request = (raw ? JSON.parse(new TextDecoder().decode(args)) : args) as Record<string, unknown>
      const response = (value: unknown) => raw ? new TextEncoder().encode(JSON.stringify(value)).buffer : structuredClone(value)
      if (command === "create_canvas") {
        state.disk ??= { path: `${request.parentPath}/未命名流程图.shardflow.json`, file: { ...(request.file as object), revision: 1 }, lastSavedHash: "a".repeat(64) }
        return response(state.disk)
      }
      if (command === "read_canvas") return response(state.disk)
      if (command === "write_canvas") {
        state.writes++
        if (state.fail) throw new Error("画布测试保存失败")
        const revision = (request.expectedRevision as number) + 1
        state.disk = { path: request.path, file: { ...(request.file as object), revision }, lastSavedHash: revision.toString().padStart(64, "0") }
        return response(state.disk)
      }
      const result = await original(command, args)
      if (command === "list_library_tree") return addEntry(result as { entries: unknown[] })
      if (command === "migrate_legacy_notes") addEntry((result as { tree: { entries: unknown[] } }).tree)
      return result
    }
  })
  await page.reload()
}

test("流程图从资料库创建并保存，失败时阻止返回目录", async ({ page }) => {
  await installCanvasLibraryMock(page)
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  await page.getByRole("button", { name: "新建", exact: true }).click()
  await page.getByRole("menuitem", { name: "新建流程图", exact: true }).click()
  const canvas = page.locator(".shard-canvas-workspace")
  await expect(canvas).toBeVisible()
  await canvas.getByRole("button", { name: "添加对象", exact: true }).click()
  await page.getByRole("menuitem", { name: "流程", exact: true }).click()
  await canvas.locator('[data-canvas-kind="process"]').dblclick()
  await canvas.getByRole("textbox", { name: "节点文字", exact: true }).fill("资料库中的真实编辑器")
  await page.evaluate(() => { (window as unknown as { __canvasLibrary: { fail: boolean } }).__canvasLibrary.fail = true })
  await page.getByRole("button", { name: "返回所在目录", exact: true }).click()
  await expect(canvas.getByRole("alert")).toContainText("画布测试保存失败")
  await expect(canvas).toBeVisible()
  await page.evaluate(() => { (window as unknown as { __canvasLibrary: { fail: boolean } }).__canvasLibrary.fail = false })
  await canvas.getByRole("button", { name: "重试保存", exact: true }).click()
  await expect(canvas).toHaveAttribute("data-save-state", "saved")
  await page.screenshot({ path: "tests/evidence/canvas-library-workspace.png" })
  await page.getByRole("button", { name: "返回所在目录", exact: true }).click()
  await expect(canvas).toHaveCount(0)
  await expect(page.getByRole("article", { name: "资料库查看器" })).toContainText("未命名流程图")
  const file = await page.evaluate(() => (window as unknown as { __canvasLibrary: { disk: { file: { nodes: { text: string }[] } } } }).__canvasLibrary.disk.file)
  expect(file.nodes[0].text).toBe("资料库中的真实编辑器")
})


type LibraryDatasetCall = { command: string; args?: Record<string, unknown> }
const libraryDatasetCalls = (page: Page, command: string) => page.evaluate(name => (window as unknown as {
  __libraryDatasetCalls: LibraryDatasetCall[]
}).__libraryDatasetCalls.filter(call => call.command === name), command)

/** 资料库建数据集：CSV 落 datasets/，说明文档复用基础 mock 的新建文档。 */
async function installLibraryDatasetMock(page: Page) {
  await page.addInitScript(() => {
    const runtime = window as unknown as {
      __TAURI_INTERNALS__: { invoke(command: string, args?: unknown): Promise<unknown> }
      __libraryDatasetCalls: LibraryDatasetCall[]
    }
    const original = runtime.__TAURI_INTERNALS__.invoke
    runtime.__libraryDatasetCalls = []
    let dataset = { path: "", table: { header: [] as string[], rows: [] as string[][] } }
    const snapshot = () => ({
      ...dataset, sha: "sha-0", schemaSha: "schema-sha", editable: true, readOnlyReason: null,
      schema: { schemaVersion: 1, datasetId: "ds_0123456789abcdef0123456789abcdef", title: "", primaryKey: "id" },
    })
    runtime.__TAURI_INTERNALS__.invoke = async (command, raw) => {
      const args = (raw ?? {}) as Record<string, unknown>
      runtime.__libraryDatasetCalls.push({ command, args: JSON.parse(JSON.stringify(args)) })
      if (command === "plugin:dialog|open") return "/tmp/导入/库存.xlsx"
      if (command === "read_import_csv_file") return Array.from(new TextEncoder().encode("名称,状态\n保留原始CSV,待办\n"))
      if (command === "read_import_xlsx_file") {
        return { sheetName: "库存表", sheetCount: 2, records: [["名称", "数量"], ["苹果", "3"], ["梨", "0012"]], warnings: ["1 个公式单元格只导入计算结果"] }
      }
      if (command === "create_library_dataset") {
        dataset = { path: `datasets/${String(args.title)}.csv`, table: { header: args.header as string[], rows: args.rows as string[][] } }
        const library = await original("create_library_note", { parentPath: args.parentPath, title: args.title })
        return { dataset: snapshot(), library }
      }
      if (command === "read_dataset") return snapshot()
      return original(command, raw)
    }
  })
  await page.reload()
}

test("CSV 源文件进入数据集导入预览，取消不创建数据集", async ({ page }) => {
  await installLibraryDatasetMock(page)
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  await page.getByRole("button", { name: /^文件（/u, exact: true }).click()
  await page.getByRole("button", { name: "清单.csv 操作", exact: true }).click()
  await page.getByRole("menuitem", { name: "导入为数据集", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "导入 CSV 为数据集", exact: true })
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText("清单.csv · 编码：UTF-8 · 1 行 · 2 列")
  await expect(dialog.getByRole("cell", { name: "保留原始CSV", exact: true })).toBeVisible()
  expect(await libraryDatasetCalls(page, "read_import_csv_file")).toEqual([
    { command: "read_import_csv_file", args: { path: "/tmp/shard-library-tree-test/notes/清单.csv" } },
  ])
  expect(await libraryDatasetCalls(page, "plugin:dialog|open")).toHaveLength(0)
  await dialog.getByRole("button", { name: "取消", exact: true }).click()
  await expect(dialog).toHaveCount(0)
  expect(await libraryDatasetCalls(page, "create_library_dataset")).toHaveLength(0)
  await expect(page.getByRole("button", { name: "清单.csv 操作", exact: true })).toBeVisible()
  await page.getByRole("button", { name: "新建", exact: true }).click()
  await expect(page.getByRole("menuitem", { name: "新建数据集", exact: true })).toBeVisible()
  await expect(page.getByRole("menuitem", { name: "新建多维表格", exact: true })).toHaveCount(0)
  await expect(page.getByRole("menuitem", { name: "从 CSV / Excel 导入…", exact: true })).toBeVisible()
})

test("新建数据集先起名，再建 CSV 与说明文档并直接打开编辑", async ({ page }) => {
  await installLibraryDatasetMock(page)
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  await createLibraryEntry(page, "新建数据集")
  const dialog = page.getByRole("dialog", { name: "新建数据集", exact: true })
  const input = dialog.getByRole("textbox", { name: "数据集名称", exact: true })
  await expect(input).toHaveValue("未命名数据集")
  await input.fill("书单")
  await input.press("Enter")
  await expect(dialog).toHaveCount(0)
  await expect(page.getByRole("region", { name: "数据集禅模式" })).toBeVisible()
  expect((await libraryDatasetCalls(page, "create_library_dataset")).map(call => call.args)).toEqual([
    { parentPath: "notes", title: "书单", header: ["id", "名称"], rows: [], primaryKey: "id" },
  ])
  expect(await commandCalls(page, "create_library_note")).toHaveLength(1)
})

test("从 Excel 导入只取第一个工作表并提示转换说明，导入后生成说明文档", async ({ page }) => {
  await installLibraryDatasetMock(page)
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  await page.getByRole("complementary", { name: "资料库目录" }).getByRole("button", { name: "新建", exact: true }).click()
  await page.getByRole("menuitem", { name: "从 CSV / Excel 导入…", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "导入 Excel 为数据集", exact: true })
  await expect(dialog).toContainText("库存.xlsx · 工作表：库存表（共 2 个，只导入第一个） · 2 行 · 2 列")
  await expect(dialog.getByText("1 个公式单元格只导入计算结果", { exact: true })).toBeVisible()
  await expect(dialog.getByRole("cell", { name: "0012", exact: true })).toBeVisible()
  expect((await libraryDatasetCalls(page, "read_import_xlsx_file")).map(call => call.args)).toEqual([{ path: "/tmp/导入/库存.xlsx" }])
  await dialog.getByRole("button", { name: "导入", exact: true }).click()
  await expect(dialog).toHaveCount(0)
  const [created] = await libraryDatasetCalls(page, "create_library_dataset")
  expect(created.args).toMatchObject({ parentPath: "notes", title: "库存", header: ["id", "名称", "数量"], primaryKey: "id" })
  expect((created.args!.rows as string[][]).map(row => row.slice(1))).toEqual([["苹果", "3"], ["梨", "0012"]])
  expect((created.args!.rows as string[][]).every(row => /^r_[0-9a-f]{12}$/u.test(row[0]))).toBe(true)
  await expect(page.getByRole("button", { name: "重命名文件", exact: true })).toHaveText("库存")
})

async function installDiagramDocumentsMock(page: Page) {
  await installCanvasLibraryMock(page)
  await page.addInitScript(() => {
    const runtime = window as unknown as {
      __TAURI_INTERNALS__: { invoke(command: string, args?: unknown): Promise<unknown> }
      __canvasLibrary: { disk: { path: string; file: { id: string; title: string; nodes: unknown[] } } | null }
      __SHARD_LIBRARY_TREE_CALLS__: LibraryCall[]
      __diagramLinks: { failNoteSave: boolean; copied: string; createdMap: any }
    }
    const original = runtime.__TAURI_INTERNALS__.invoke
    const state = { failNoteSave: false, copied: "", createdMap: null as any }
    runtime.__diagramLinks = state
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
      writeText: async (text: string) => { state.copied = text },
    } })
    const addMap = (tree: { entries: any[] }) => {
      if (!state.createdMap) return tree
      const { path, file } = state.createdMap
      const parent = path.slice(0, path.lastIndexOf("/"))
      const children = parent === "notes" ? tree.entries : tree.entries.find(entry => entry.path === parent)?.children
      children?.push({ name: path.split("/").pop(), path, kind: "mindmap", mindMapId: file.id, size: 768, modifiedAt: file.updatedAt })
      return tree
    }
    runtime.__TAURI_INTERNALS__.invoke = async (command, args) => {
      const request = (args ?? {}) as Record<string, unknown>
      if (command === "list_diagram_documents") {
        const maps = await original("list_mind_maps") as any[]
        const flow = runtime.__canvasLibrary.disk
        return [...maps.map(map => ({ ...map, kind: "mindmap" })), ...(state.createdMap ? [{ id: state.createdMap.file.id, title: state.createdMap.file.title, path: state.createdMap.path, kind: "mindmap", nodeCount: 1 }] : []),
          ...(flow ? [{ id: flow.file.id, title: flow.file.title, path: flow.path, kind: "flowchart", nodeCount: flow.file.nodes.length }] : [])]
      }
      if (command === "update_fragment" && state.failNoteSave) throw new Error("文档跳转测试：笔记保存失败")
      if (command === "create_mind_map") {
        runtime.__SHARD_LIBRARY_TREE_CALLS__.push({ command, args: structuredClone(request) })
        const template = await original("read_mind_map", { id: "map-project" }) as any
        const title = String(request.title)
        state.createdMap = { ...template, path: `${request.parentPath}/${title}.shardmap.json`, file: { ...template.file, id: "map-created", title } }
        return structuredClone(state.createdMap)
      }
      if (command === "read_mind_map" && request.id === "map-created") return structuredClone(state.createdMap)
      const flow = runtime.__canvasLibrary.disk
      if (command === "rename_library_entry" && request.path === flow?.path) {
        runtime.__SHARD_LIBRARY_TREE_CALLS__.push({ command, args: structuredClone(request) })
        const name = String(request.newName)
        flow.path = `${flow.path.slice(0, flow.path.lastIndexOf("/"))}/${name}.shardflow.json`
        return { tree: await original("list_library_tree"), updatedLinks: 0 }
      }
      if (command === "move_library_entry" && request.path === flow?.path) {
        runtime.__SHARD_LIBRARY_TREE_CALLS__.push({ command, args: structuredClone(request) })
        flow.path = `${request.destinationDirectory}/${flow.path.split("/").pop()}`
        return { tree: await original("list_library_tree"), updatedLinks: 0 }
      }
      const result = await original(command, args)
      if (command === "list_library_tree") return addMap(result as { entries: any[] })
      return result
    }
  })
  await page.reload()
}

async function createLibraryFlow(page: Page) {
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  await page.getByRole("button", { name: "新建", exact: true }).click()
  await expect(page.getByRole("menuitem", { name: "新建画布", exact: true })).toHaveCount(0)
  await page.getByRole("menuitem", { name: "新建流程图", exact: true }).click()
  await expect(page.locator(".shard-canvas-workspace")).toBeVisible()
  return page.evaluate(() => (window as any).__canvasLibrary.disk.file.id as string)
}

test("新建思维导图保留当前目录，直接进入独立主题编辑器", async ({ page }) => {
  await installDiagramDocumentsMock(page)
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  await page.getByRole("complementary", { name: "资料库目录" }).getByRole("button", { name: "项目", exact: true }).click()
  await page.getByRole("button", { name: "新建", exact: true }).click()
  await page.getByRole("menuitem", { name: "新建思维导图", exact: true }).click()
  await expect.poll(() => commandCalls(page, "create_mind_map")).toHaveLength(1)
  expect((await commandCalls(page, "create_mind_map"))[0].args.parentPath).toBe("notes/项目")
  await expect(page.locator(".shard-canvas-workspace")).toHaveCount(0)
  await expect(page.getByRole("article", { name: "资料库查看器" })).toContainText("未命名思维导图")
  await expect(page.getByRole("button", { name: "返回所在目录", exact: true })).toBeVisible()
  await page.getByRole("button", { name: "返回所在目录", exact: true }).click()
  await expect(page.getByRole("button", { name: "打开文件 未命名思维导图.shardmap.json", exact: true })).toBeVisible()
})

test("图文档链接可以复制到笔记，并在跳转前保存正文", async ({ page }) => {
  await installDiagramDocumentsMock(page)
  const id = await createLibraryFlow(page)
  await page.getByRole("button", { name: "返回所在目录", exact: true }).click()
  await page.getByRole("button", { name: "未命名流程图.shardflow.json 操作", exact: true }).click()
  await page.getByRole("menuitem", { name: "复制文档链接", exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as any).__diagramLinks.copied)).toBe(`[未命名流程图](shard://flow/${id})`)
  await page.getByRole("button", { name: "打开文件 旧笔记.md", exact: true }).click()
  const content = `# 项目说明\n\n[需求导图](shard://map/map-project)\n\n[审批流程](shard://flow/${id})\n\n跳转前的草稿`
  await fillEditor(page, "library:note-old", content)
  await page.locator(`[data-shard-editor="library:note-old"] a[href="shard://flow/${id}"]`).click()
  await expect(page.locator(".shard-canvas-workspace")).toBeVisible()
  const writes = await commandCalls(page, "update_fragment")
  expect(writes.some(call => call.args.content === content)).toBe(true)
  await expect(page.getByRole("button", { name: "新建画布", exact: true })).toHaveCount(0)
})

test("笔记保存失败时文档链接不跳走，成功后按稳定 ID 打开导图", async ({ page }) => {
  await installDiagramDocumentsMock(page)
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  await page.getByRole("button", { name: /^文件（/u }).click()
  await page.getByRole("button", { name: "打开文件 旧笔记.md", exact: true }).click()
  await fillEditor(page, "library:note-old", "# 未保存草稿\n\n[打开需求](shard://map/map-project)")
  await page.evaluate(() => { (window as any).__diagramLinks.failNoteSave = true })
  await page.locator('[data-shard-editor="library:note-old"] a[href="shard://map/map-project"]').click()
  await expect(page.getByRole("textbox", { name: "资料库文档编辑器" })).toBeVisible()
  const saveFailure = page.locator('[data-sonner-toast][data-type="error"]').filter({ hasText: "文档保存失败" })
  await expect(saveFailure).toBeVisible()
  await saveFailure.getByRole("button", { name: "详情", exact: true }).click()
  await expect(saveFailure).toContainText("文档跳转测试：笔记保存失败")
  await page.evaluate(() => { (window as any).__diagramLinks.failNoteSave = false })
  await page.locator('[data-shard-editor="library:note-old"] a[href="shard://map/map-project"]').click()
  await expect(page.getByRole("textbox", { name: "资料库文档编辑器" })).toHaveCount(0)
  await expect(page.getByRole("article", { name: "资料库查看器" })).toContainText("项目导图")
})

test("流程图重命名并移动后，笔记中的 ID 链接仍打开新路径", async ({ page }) => {
  await installDiagramDocumentsMock(page)
  const id = await createLibraryFlow(page)
  await page.getByRole("button", { name: "重命名文件", exact: true }).click()
  const input = page.getByRole("textbox", { name: "重命名名称" })
  await input.fill("审批流程")
  await input.press("Enter")
  await expect(page.getByRole("button", { name: "重命名文件", exact: true })).toHaveText("审批流程")
  await page.getByRole("button", { name: "返回所在目录", exact: true }).click()
  await page.getByRole("button", { name: "审批流程.shardflow.json 操作", exact: true }).click()
  await page.getByRole("menuitem", { name: "移动到…", exact: true }).hover()
  await page.getByRole("menuitem", { name: "项目", exact: true }).click()
  await expect.poll(() => commandCalls(page, "move_library_entry")).toHaveLength(1)
  await page.getByRole("button", { name: "打开文件 旧笔记.md", exact: true }).click()
  await fillEditor(page, "library:note-old", `# 项目说明\n\n[原流程链接](shard://flow/${id})`)
  await page.locator(`[data-shard-editor="library:note-old"] a[href="shard://flow/${id}"]`).click()
  await expect(page.locator(".shard-canvas-workspace")).toBeVisible()
  await expect(page.getByRole("button", { name: "重命名文件", exact: true })).toHaveText("审批流程")
  expect(await page.evaluate(() => (window as any).__canvasLibrary.disk.path)).toBe("notes/项目/审批流程.shardflow.json")
})

test("独立导图与流程图菜单可确认加入时间线并从 toast 打开图形宿主", async ({ page }) => {
  await installGraphImportMock(page)
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  await page.getByRole("button", { name: /^文件（/u, exact: true }).click()

  await page.getByRole("button", { name: "项目导图.shardmap.json 操作", exact: true }).click()
  await expect(page.getByRole("menuitem", { name: "加入时间线", exact: true })).toBeVisible()
  await page.getByRole("menuitem", { name: "加入时间线", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "确认加入时间线", exact: true })
  await expect(dialog).toContainText("将生成一篇同名的大纲，原文件移入回收站，之后仍可从回收站恢复。")
  await dialog.getByRole("button", { name: "取消", exact: true }).click()
  await expect.poll(() => commandCalls(page, "import_graph_file_to_timeline")).toHaveLength(0)

  await page.getByRole("button", { name: "项目导图.shardmap.json 操作", exact: true }).click()
  await page.getByRole("menuitem", { name: "加入时间线", exact: true }).click()
  await dialog.getByRole("button", { name: "加入时间线", exact: true }).click()
  await expect.poll(() => commandCalls(page, "import_graph_file_to_timeline")).toEqual([
    { command: "import_graph_file_to_timeline", args: { path: "notes/项目导图.shardmap.json" } },
  ])
  await expect(page.getByText("已加入时间线", { exact: true })).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole("button", { name: "项目导图.shardmap.json 操作", exact: true })).toHaveCount(0)
  await page.getByRole("button", { name: "打开", exact: true }).click()
  await expect(page.getByRole("region", { name: "思维导图工作区", exact: true })).toBeVisible()
  await expect(page.getByRole("textbox", { name: "根节点", exact: true })).toHaveValue("项目导图")
})

test("加入时间线失败保留资料库图文件且普通文件没有菜单项", async ({ page }) => {
  await installGraphImportMock(page)
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  await page.getByRole("button", { name: /^文件（/u, exact: true }).click()

  for (const name of ["旧笔记.md", "清单.csv", "旧画布.shardcanvas.json"]) {
    await page.getByRole("button", { name: `${name} 操作`, exact: true }).click()
    const menu = page.getByRole("menu", { name: "文件操作", exact: true })
    await expect(menu).toBeVisible()
    await expect(menu.getByRole("menuitem", { name: "加入时间线", exact: true })).toHaveCount(0)
    await page.keyboard.press("Escape")
    await expect(menu).toHaveCount(0)
  }
  await page.getByRole("button", { name: "审批流程.shardflow.json 操作", exact: true }).click()
  await expect(page.getByRole("menuitem", { name: "加入时间线", exact: true })).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(page.getByRole("menuitem", { name: "加入时间线", exact: true })).toHaveCount(0)

  await page.getByRole("button", { name: "多选文件", exact: true }).click()
  await page.getByRole("checkbox", { name: "选择 项目导图.shardmap.json", exact: true }).click()
  await page.getByRole("checkbox", { name: "选择 审批流程.shardflow.json", exact: true }).click()
  await page.getByRole("button", { name: "项目导图.shardmap.json 操作", exact: true }).click()
  const batchMenu = page.getByRole("menu", { name: "文件操作", exact: true })
  await expect(batchMenu).toBeVisible()
  await expect(batchMenu.getByRole("menuitem", { name: "加入时间线", exact: true })).toHaveCount(0)
  await page.keyboard.press("Escape")
  await expect(batchMenu).toHaveCount(0)
  await page.getByRole("toolbar", { name: "文件批量操作", exact: true })
    .getByRole("button", { name: "完成", exact: true }).click()

  await page.evaluate(() => { (window as any).__graphImport.fail = true })
  await page.getByRole("button", { name: "项目导图.shardmap.json 操作", exact: true }).click()
  await page.getByRole("menuitem", { name: "加入时间线", exact: true }).click()
  await page.getByRole("dialog", { name: "确认加入时间线", exact: true })
    .getByRole("button", { name: "加入时间线", exact: true }).click()
  await expect(page.getByText("加入时间线失败", { exact: true })).toBeVisible({ timeout: 15_000 })
  const failedDialog = page.getByRole("dialog", { name: "确认加入时间线", exact: true })
  await expect(failedDialog).toBeVisible()
  await failedDialog.getByRole("button", { name: "取消", exact: true }).click()
  await expect(page.getByRole("button", { name: "项目导图.shardmap.json 操作", exact: true })).toBeVisible()
})

test("独立图缺失时链接回退到同 ID 的时间线图，全部缺失仍提示", async ({ page }) => {
  await installGraphImportMock(page, { map: true, flow: true })
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  await page.getByRole("button", { name: /^文件（/u, exact: true }).click()
  await page.getByRole("button", { name: "打开文件 旧笔记.md", exact: true }).click()
  const content = "# 图引用\n\n[时间线大纲](shard://map/map-project)\n\n[时间线流程](shard://flow/flow-project)\n\n[缺失图](shard://map/missing-map)"
  await fillEditor(page, "library:note-old", content)

  await page.locator('[data-shard-editor="library:note-old"] a[href="shard://map/map-project"]').click()
  await expect(page.getByRole("region", { name: "思维导图工作区", exact: true })).toBeVisible()
  await page.getByRole("button", { name: "退出思维导图", exact: true }).click()
  await expect(page.getByRole("textbox", { name: "资料库文档编辑器", exact: true })).toBeVisible()

  await page.locator('[data-shard-editor="library:note-old"] a[href="shard://flow/flow-project"]').click()
  await expect(page.locator(".shard-canvas-workspace")).toBeVisible()
  await page.getByRole("button", { name: "退出流程图", exact: true }).click()
  await expect(page.getByRole("textbox", { name: "资料库文档编辑器", exact: true })).toBeVisible()

  await page.locator('[data-shard-editor="library:note-old"] a[href="shard://map/missing-map"]').click()
  await expect(page.getByText("引用的图文档已不存在", { exact: true })).toBeVisible({ timeout: 15_000 })
})


test("碎片文件分类：文件视图与时间线共享正文和身份，返回分类并恢复会话", async ({ page }) => {
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  const pane = page.getByRole("complementary", { name: "资料库目录" })
  const category = pane.getByRole("button", { name: "碎片（2）", exact: true })
  await category.click()
  await expect(category).toHaveAttribute("aria-current", "page")
  await expect(pane.getByRole("button", { name: /^文件（/ })).not.toHaveAttribute("aria-current", "page")
  const list = page.getByRole("region", { name: "fragments 目录列表", exact: true })
  await expect(list.getByRole("button", { name: "打开文件 20260830-080102.md", exact: true })).toBeVisible()
  await expect(list.getByRole("button", { name: "打开文件 20260712-080000.md", exact: true })).toBeVisible()
  await expect(list.getByText("项目计划", { exact: true })).toHaveCount(0)
  await expect(list.getByText("20260612-080000", { exact: true })).toHaveCount(0)
  await list.getByRole("button", { name: "打开文件 20260830-080102.md", exact: true }).click()
  await expect(page.getByRole("textbox", { name: "资料库碎片编辑器", exact: true })).toBeVisible()
  await fillEditor(page, "library:fragment-august", "# 八月灵感\n\n在文件视图中更新")
  await page.getByRole("button", { name: "返回所在目录", exact: true }).click()
  await expect(list).toBeVisible()
  const updates = await commandCalls(page, "update_fragment")
  expect(updates.at(-1)?.args).toMatchObject({ id: "fragment-august", tags: ["inbox", "灵感"] })
  expect(updates.at(-1)?.args.tags).not.toContain("note")
  await page.getByRole("button", { name: /^全部碎片 / }).click()
  await expect(page.locator('[data-shard-fragment-id="fragment-august"]')).toContainText("在文件视图中更新")
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  await expect(list).toBeVisible()
  await page.reload()
  // Cold start still opens the capture space; library restores its own selection.
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  await expect(list).toBeVisible()
  await expect(page.getByRole("button", { name: "碎片（2）", exact: true })).toHaveAttribute("aria-current", "page")
})

test("碎片文件分类：宫格、排序和多选沿用文件操作，切换分类清空选择", async ({ page }) => {
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  const pane = page.getByRole("complementary", { name: "资料库目录" })
  await pane.getByRole("button", { name: "碎片（2）", exact: true }).click()
  await page.getByRole("button", { name: "宫格视图", exact: true }).click()
  const grid = page.getByRole("list", { name: "fragments 目录宫格", exact: true })
  await expect(grid.locator(':scope > li')).toHaveCount(2)
  await expect(grid.getByText("八月灵感", { exact: true })).toBeVisible()
  await grid.getByRole("button", { name: "20260830-080102.md 操作", exact: true }).click()
  await expect(page.getByRole("menuitem", { name: "转回碎片", exact: true })).toHaveCount(0)
  await expect(page.getByRole("menuitem", { name: "移动到…", exact: true })).toHaveCount(0)
  await expect(page.getByRole("menuitem", { name: "移入密匣", exact: true })).toBeVisible()
  await page.keyboard.press("Escape")
  await page.getByRole("button", { name: "多选文件", exact: true }).click()
  await grid.getByRole("checkbox", { name: "选择 20260830-080102.md", exact: true }).click()
  const dock = page.getByRole("toolbar", { name: "文件批量操作", exact: true })
  await expect(dock).toBeVisible()
  await expect(dock.getByRole("button", { name: "移动到…", exact: true })).toHaveCount(0)
  await expect(dock.getByText("已选 1 项", { exact: true })).toBeVisible()
  await pane.getByRole("button", { name: /^文件（/ }).click()
  await expect(dock).toBeHidden()
  await pane.getByRole("button", { name: "碎片（2）", exact: true }).click()
  await expect(page.getByRole("button", { name: "多选文件", exact: true })).toHaveAttribute("aria-pressed", "false")
})

test("碎片文件分类：重命名保留 ID 与碎片类型，删除进入统一回收站", async ({ page }) => {
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  const pane = page.getByRole("complementary", { name: "资料库目录" })
  await pane.getByRole("button", { name: "碎片（2）", exact: true }).click()
  const list = page.getByRole("region", { name: "fragments 目录列表", exact: true })
  await list.getByRole("button", { name: "20260830-080102.md 操作", exact: true }).click()
  await page.getByRole("menuitem", { name: "重命名", exact: true }).click()
  await page.getByRole("textbox", { name: "重命名名称", exact: true }).fill("八月灵感文件")
  await page.getByRole("textbox", { name: "重命名名称", exact: true }).press("Enter")
  // Existing rename behavior opens the updated file while keeping the stable ID.
  await expect(page.getByRole("button", { name: "重命名文件", exact: true })).toHaveText("八月灵感文件")
  await expect.poll(() => readEditor(page, "library:fragment-august")).toContain("八月灵感")
  await page.getByRole("button", { name: "返回所在目录", exact: true }).click()
  await expect(list.getByRole("button", { name: "打开文件 八月灵感文件.md", exact: true })).toBeVisible()
  await list.getByRole("button", { name: "八月灵感文件.md 操作", exact: true }).click()
  await page.getByRole("menuitem", { name: "删除", exact: true }).click()
  await page.getByRole("dialog").getByRole("button", { name: "删除", exact: true }).click()
  await expect(pane.getByRole("button", { name: "碎片（1）", exact: true })).toHaveAttribute("aria-current", "page")
  await expect(list.getByRole("button", { name: "打开文件 八月灵感文件.md", exact: true })).toHaveCount(0)
  await pane.getByRole("button", { name: "回收站（4）", exact: true }).click()
  const trash = page.getByRole("region", { name: ".trash 目录列表", exact: true })
  await expect(trash.locator('tr[data-path=".trash/fragments/2026/08/八月灵感文件.md"]')).toContainText("八月灵感")
  await expect(trash.getByRole("button", { name: "八月灵感文件.md 操作", exact: true })).toBeVisible()
})

test("碎片文件分类：批量删除与空态保持分类", async ({ page }) => {
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  const pane = page.getByRole("complementary", { name: "资料库目录" })
  await pane.getByRole("button", { name: "碎片（2）", exact: true }).click()
  await page.getByRole("checkbox", { name: "全选当前目录", exact: true }).click()
  await page.getByRole("button", { name: "批量删除", exact: true }).click()
  await page.getByRole("dialog").getByRole("button", { name: "删除 2 项", exact: true }).click()
  await expect(pane.getByRole("button", { name: "碎片（0）", exact: true })).toHaveAttribute("aria-current", "page")
  await expect(page.getByText("暂无碎片", { exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "多选文件", exact: true })).toBeDisabled()
  await expect(page.getByRole("toolbar", { name: "文件批量操作", exact: true })).toBeHidden()
})


test("碎片文件分类：默认、悬停和键盘焦点遵守 Kiln，普通及短窗口布局稳定", async ({ page }) => {
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  const pane = page.getByRole("complementary", { name: "资料库目录" })
  const category = pane.getByRole("button", { name: "碎片（2）", exact: true })
  await category.click()
  const list = page.getByRole("region", { name: "fragments 目录列表", exact: true })
  const before = await category.boundingBox()
  const defaultStyle = await category.evaluate(element => {
    const style = getComputedStyle(element)
    return { radius: style.borderRadius, font: style.fontFamily, color: style.color, background: style.backgroundColor, outline: style.outlineStyle }
  })
  expect(defaultStyle.radius).toBe("4px")
  expect(defaultStyle.font).toContain("Noto Sans SC")
  expect(defaultStyle.outline).toBe("none")
  await category.hover()
  expect(await category.boundingBox()).toEqual(before)
  expect(await category.evaluate(element => getComputedStyle(element).backgroundColor)).toBe(defaultStyle.background)
  await page.keyboard.press("F6")
  await expect(page.locator("html")).toHaveAttribute("data-focus-mode", "keyboard")
  await category.focus()
  expect(await category.evaluate(element => getComputedStyle(element).outlineStyle)).toBe("solid")
  expect(await category.boundingBox()).toEqual(before)
  await expectKilnControl(page.getByRole("button", { name: "多选文件", exact: true }), 28)
  await page.getByRole("button", { name: "按创建时间排序", exact: true }).click()
  await expect(list.locator('th[aria-sort="descending"]')).toHaveText(/创建时间/)
  await expect(list.locator('tbody tr').first()).toHaveAttribute("data-path", "fragments/2026/08/20260830-080102.md")
  await page.getByRole("button", { name: "宫格视图", exact: true }).click()
  const grid = page.getByRole("list", { name: "fragments 目录宫格", exact: true })
  await expect(grid).toBeVisible()
  mkdirSync("tests/evidence/fragment-files", { recursive: true })
  for (const viewport of [{ width: 1280, height: 720 }, { width: 1100, height: 480 }]) {
    await page.setViewportSize(viewport)
    const metrics = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth }))
    expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.width)
    await expect(category).toBeVisible()
    await expect(grid).toBeVisible()
    await page.screenshot({ path: `tests/evidence/fragment-files/grid-${viewport.width}x${viewport.height}.png` })
  }
})


for (const kind of ["document", "outline"] as const) {
  test(`碎片文件分类：编辑 ${kind} 保留类型与标签`, async ({ page }) => {
    await page.addInitScript(({ kind }) => {
      const runtime = window as unknown as { __TAURI_INTERNALS__: { invoke(command: string, args?: unknown): Promise<any> } }
      const original = runtime.__TAURI_INTERNALS__.invoke
      runtime.__TAURI_INTERNALS__.invoke = async (command, args) => {
        const result = await original(command, args)
        if (command === "list_fragments") {
          const item = result.fragments.find((fragment: any) => fragment.id === "fragment-august")
          item.tags = ["inbox", kind, "灵感"]
          if (kind === "outline") item.content = "- 根节点\n  - 子节点"
        }
        return result
      }
    }, { kind })
    await page.reload()
    await page.getByRole("button", { name: "资料库", exact: true }).click()
    await page.getByRole("button", { name: "碎片（2）", exact: true }).click()
    await page.getByRole("button", { name: "打开文件 20260830-080102.md", exact: true }).click()
    await fillEditor(page, "library:fragment-august", kind === "outline" ? "- 根节点\n  - 更新子节点" : "# 更新文档\n\n正文")
    await page.getByRole("button", { name: "返回所在目录", exact: true }).click()
    await expect(page.getByRole("region", { name: "fragments 目录列表", exact: true })).toBeVisible()
    expect((await commandCalls(page, "update_fragment")).at(-1)?.args).toMatchObject({ id: "fragment-august", tags: ["inbox", kind, "灵感"] })
  })
}

test("碎片文件分类：受管大纲与流程图打开原图编辑器，关闭返回文件列表", async ({ page }) => {
  await installGraphImportMock(page, { map: true, flow: true })
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  await page.getByRole("button", { name: "碎片（4）", exact: true }).click()
  await page.getByRole("button", { name: "打开文件 map-project.md", exact: true }).click()
  await expect(page.getByRole("region", { name: "思维导图工作区", exact: true })).toBeVisible()
  await page.getByRole("button", { name: "退出思维导图", exact: true }).click()
  await expect(page.getByRole("region", { name: "fragments 目录列表", exact: true })).toBeVisible()
  await page.getByRole("button", { name: "打开文件 flow-project.md", exact: true }).click()
  await expect(page.locator(".shard-canvas-workspace")).toBeVisible()
  await page.getByRole("button", { name: "退出流程图", exact: true }).click()
  await expect(page.getByRole("region", { name: "fragments 目录列表", exact: true })).toBeVisible()
  expect(await commandCalls(page, "update_fragment")).toHaveLength(0)
})

test.describe("文档内查找（Cmd+F）", () => {
  const editorId = "library:note-old"
  const lines = Array.from({ length: 80 }, (_, index) =>
    index % 20 === 5 ? `第${index}行 停顿 在这里` : `第${index}行 普通内容`
  )
  const longDocument = `# 旧笔记\n\n${lines.join("\n\n")}`

  async function openLongNote(page: Page) {
    await page.getByRole("button", { name: "资料库", exact: true }).click()
    await page.getByRole("button", { name: /^文件（/u, exact: true }).click()
    await page.getByRole("button", { name: "打开文件 旧笔记.md", exact: true }).click()
    await expect(page.getByRole("textbox", { name: "资料库文档编辑器", exact: true })).toBeVisible()
    await fillEditor(page, editorId, longDocument)
    await expect.poll(() => readEditor(page, editorId)).toBe(longDocument)
  }

  function findBar(page: Page) {
    const bar = page.getByRole("search", { name: "文档内查找", exact: true })
    return {
      bar,
      count: bar.locator(".shard-rich-find-count"),
      input: bar.getByRole("textbox", { name: "查找文档内容", exact: true }),
    }
  }

  test("打开查找条，逐个跳到命中并滚进视口，Esc 关闭后选中当前命中", async ({ page }) => {
    await openLongNote(page)
    const { bar, count, input } = findBar(page)
    await page.keyboard.press("ControlOrMeta+f")
    await expect(input).toBeFocused()
    await input.fill("停顿")
    await expect(count).toHaveText("1/4")
    await expect(page.locator('[data-find-hit]')).toHaveCount(4)
    await expect(page.locator('[data-find-hit="active"]')).toHaveText("停顿")

    await page.keyboard.press("Enter")
    await page.keyboard.press("Enter")
    await expect(count).toHaveText("3/4")
    const active = page.locator('[data-find-hit="active"]')
    await expect(active).toBeInViewport()
    // 查找条吸在视口顶上，跟着正文滚下来仍然看得见。
    await expect(bar).toBeInViewport()
    expect(await page.locator('[data-shard-editor="library:note-old"]').evaluate(element => {
      let current = element.parentElement
      while (current && getComputedStyle(current).overflowY !== "auto") current = current.parentElement
      return current?.scrollTop ?? 0
    })).toBeGreaterThan(0)

    await page.keyboard.press("Shift+Enter")
    await expect(count).toHaveText("2/4")
    await page.keyboard.press("ControlOrMeta+g")
    await expect(count).toHaveText("3/4")
    await page.keyboard.press("ControlOrMeta+Shift+g")
    await expect(count).toHaveText("2/4")
    await page.keyboard.press("ArrowUp")
    await bar.getByRole("button", { name: "下一处", exact: true }).click()
    await expect(count).toHaveText("3/4")
    await expect(input).toBeFocused()

    await page.keyboard.press("Escape")
    await expect(bar).toHaveCount(0)
    await expect(page.locator("[data-find-hit]")).toHaveCount(0)
    await expect(page.getByRole("textbox", { name: "资料库文档编辑器", exact: true })).toBeFocused()
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("停顿")

    // 再按 Cmd+F 回到上次的查找词，整段选中方便直接改。
    await page.keyboard.press("ControlOrMeta+f")
    await expect(input).toHaveValue("停顿")
    expect(await input.evaluate((element: HTMLInputElement) => element.selectionEnd! - element.selectionStart!)).toBe(2)
  })

  test("选中文字后按 Cmd+F 用它查找，当前命中就是选中的那一处", async ({ page }) => {
    await openLongNote(page)
    await selectEditorText(page, editorId, "普通内容", { occurrence: 3 })
    await page.keyboard.press("ControlOrMeta+f")
    const { count, input } = findBar(page)
    await expect(input).toHaveValue("普通内容")
    await expect(count).toHaveText("4/76")
  })

  test("开着查找条改正文，计数跟着更新；查不到时显示无结果", async ({ page }) => {
    await openLongNote(page)
    const { bar, count, input } = findBar(page)
    await page.keyboard.press("ControlOrMeta+f")
    await input.fill("停顿")
    await expect(count).toHaveText("1/4")
    await fillEditor(page, editorId, "# 旧笔记\n\n停顿 停顿\n\n停顿")
    await expect(count).toHaveText(/^\d\/3$/u)
    // 查找坞零高度、不参与编辑面的纵向伸展：短文档里正文也不被它往下推。
    expect(await page.locator(`[data-shard-editor="${editorId}"]`).evaluate(element => {
      const body = element.querySelector(".ProseMirror")!
      return Math.round(body.getBoundingClientRect().top - element.getBoundingClientRect().top)
    })).toBe(0)

    await input.fill("不存在的词")
    await expect(count).toHaveText("无结果")
    await expect(page.locator("[data-find-hit]")).toHaveCount(0)
    await expect(bar.getByRole("button", { name: "下一处", exact: true })).toBeDisabled()
    await bar.getByRole("button", { name: "关闭查找", exact: true }).click()
    await expect(bar).toHaveCount(0)
  })

  test("禅模式里同样可查找，Esc 先关查找条、再按才退出禅模式", async ({ page }) => {
    await openLongNote(page)
    await page.getByRole("button", { name: "进入禅模式", exact: true }).click()
    const zen = page.getByRole("region", { name: "资料库文档禅模式", exact: true })
    await expect(zen).toBeVisible()
    const { bar, count, input } = findBar(page)
    await page.keyboard.press("ControlOrMeta+f")
    await expect(input).toBeFocused()
    await input.fill("停顿")
    await expect(count).toHaveText("1/4")
    await page.keyboard.press("Escape")
    await expect(bar).toHaveCount(0)
    await expect(zen).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(zen).toHaveCount(0)
  })

  test("搜索面板开着时 Cmd+F 不抢焦点", async ({ page }) => {
    await openLongNote(page)
    await page.keyboard.press("ControlOrMeta+k")
    const palette = page.getByRole("dialog", { name: "搜索", exact: true })
    await expect(palette).toBeVisible()
    await page.keyboard.press("ControlOrMeta+f")
    await expect(findBar(page).bar).toHaveCount(0)
    await expect(palette).toBeVisible()
  })
})
