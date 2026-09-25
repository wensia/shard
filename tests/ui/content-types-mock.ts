import { expect, type Locator, type Page } from "@playwright/test"

import { installSearchIpcMock } from "./search-ipc-mock"

/**
 * 三种内容类型共用的工作台 mock（产品框架 §2）。
 *
 * content-types.spec.ts 与 rich-surfaces.spec.ts 共用这一份：样本含碎片、大纲、
 * 文档三条，Tauri command 清单只有一处，新增命令时不会漏掉某个 spec。
 * 跑真实工作台路由 + 内存 vault；不写用户的任何文件。
 */

export interface TestCall {
  command: string
  args: Record<string, unknown>
}

/** 非规范的 `*` 列表：打开富文本再保存时应被归一为 `- `。 */
export const CARD_FRAGMENT = ["#灵感 随手记的碎片", "", "* 非规范列表"].join("\n")
export const CARD_OUTLINE = ["- 项目大纲", "  - 第一步", "  - 第二步"].join("\n")
export const CARD_DOCUMENT = [
  "# 季度复盘",
  "",
  "本季度完成了三件事。",
  "- 第一件是把速记框换成富文本",
  "- 第二件是补齐围栏块",
].join("\n")

interface MockBodies {
  documentBody: string
  fragmentBody: string
  outlineBody: string
}

export async function installContentTypesMock(page: Page) {
  await installSearchIpcMock(page)
  await page.addInitScript(
    ({ documentBody, fragmentBody, outlineBody }: MockBodies) => {
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
          id: "card-document", path: "fragments/card-document.md",
          content: documentBody, tags: ["inbox", "document"],
        },
      ].map((fragment) => ({
        ...fragment, createdAt: now, updatedAt: now, category: null,
        gitStatus: "committed", error: null, archived: false, lockbox: false,
        pinned: false, related: [],
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
      let callbackId = 0
      let createdCount = 0
      Object.assign(globalThis, {
        isTauri: true,
        __SHARD_TYPE_CALLS__: calls,
        __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener() {} },
        __TAURI_INTERNALS__: {
          metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
          transformCallback: () => ++callbackId,
          invoke: async (command: string, args: Record<string, unknown> = {}) => {
            calls.push({ command, args: clone(args) })
            switch (command) {
              case "plugin:event|listen": return ++callbackId
              case "plugin:event|unlisten":
              case "unhide_pointer":
              case "set_window_controls_hidden": return null
              case "plugin:app|version": return "0.1.3"
              case "list_fragments": return clone(state)
              case "list_csv_files":
              case "list_mind_maps": return []
              case "list_library_tree": return clone(tree)
              case "migrate_legacy_notes": return { tree: clone(tree), migratedCount: 0 }
              case "sync_vault": return clone(git)
              case "checkpoint_vault":
                return { status: "no_changes", changes: 0, reason: null, git: clone(git) }
              case "github_cli_status":
                return { installed: true, authenticated: true, login: "shard-test", protocol: "https", error: null }
              case "create_fragment": {
                const id = `typed-created-${++createdCount}`
                const created = {
                  id, path: `fragments/2026/09/${id}.md`, content: String(args.content ?? ""),
                  tags: (args.tags as string[]) ?? [], createdAt: now, updatedAt: now,
                  category: null, gitStatus: "saved", error: null,
                  archived: false, lockbox: false, pinned: false, related: [],
                }
                fragments.unshift(created)
                return clone(created)
              }
              case "update_fragment": {
                const fragment = fragments.find((item) => item.id === args.id)
                if (!fragment) throw new Error("Fragment not found")
                fragment.content = String(args.content ?? fragment.content)
                fragment.tags = (args.tags as string[]) ?? fragment.tags
                return clone(fragment)
              }
              default: throw new Error(`Unhandled Tauri test command: ${command}`)
            }
          },
        },
      })
    },
    { documentBody: CARD_DOCUMENT, fragmentBody: CARD_FRAGMENT, outlineBody: CARD_OUTLINE }
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
