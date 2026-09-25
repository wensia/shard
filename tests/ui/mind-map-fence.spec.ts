import { expect, test, type Locator, type Page } from "@playwright/test"

import { fillEditor, focusEditor } from "./editor-helpers"

// 4 个节点：根 + 两个分支 + 一片叶子；围栏外另有一行普通正文。
const OUTLINE_FRAGMENT = [
  "今天的思路",
  "```mindmap",
  "- 中心主题",
  "  - 分支一",
  "    - 叶子",
  "  - 分支二",
  "```",
].join("\n")
const OUTLINE_NODE_COUNT = 4
const MAX_PREVIEW_NODES = 200

const largeOutline = [
  "```mindmap",
  "- 超大纲",
  ...Array.from({ length: 299 }, (_, index) => `  - 节点 ${index + 1}`),
  "```",
].join("\n")

async function installFenceMock(page: Page) {
  await page.addInitScript((largeOutline: string) => {
    const now = "2026-09-10T08:00:00.000Z"
    const fragments = [
      { id: "fence-js", content: "```js\nconst answer = 42\n```" },
      { id: "fence-large", content: largeOutline },
      { id: "fence-unclosed", content: "```mindmap\n- 没有闭栏的根\n  - 甲" },
    ].map((fragment) => ({
      ...fragment,
      kind: "fragment",
      path: `fragments/${fragment.id}.md`,
      tags: ["inbox"],
      createdAt: now,
      updatedAt: now,
      category: null,
      gitStatus: "committed",
      error: null,
      archived: false,
      lockbox: false,
      pinned: false,
      related: [],
    }))
    const git = {
      branch: "main", shortCommit: "abc1234", hasRemote: false,
      status: "ready", error: null, ahead: 0, behind: 0,
    }
    const state = {
      vaultPath: "/tmp/shard-mind-map-fence-mock-vault", fragments, git,
      lockbox: { configured: false, unlocked: false, expiresAt: null, ttlSeconds: 900 },
    }
    const tree = {
      entries: [], assets: [], trashEntries: [], fragmentTrashEntries: [],
      fragmentStream: { totalCount: fragments.length, years: [] },
    }
    const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T
    let callbackId = 0
    Object.assign(globalThis, {
      isTauri: true,
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener() {} },
      __TAURI_INTERNALS__: {
        metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
        transformCallback: () => ++callbackId,
        invoke: async (command: string, args: Record<string, unknown> = {}) => {
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
              const created = {
                ...clone(fragments[0]),
                id: "fence-created",
                path: "fragments/fence-created.md",
                content: String(args.content ?? ""),
                tags: (args.tags as string[] | undefined) ?? [],
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              }
              fragments.unshift(created)
              return clone(created)
            }
            default: throw new Error(`Unhandled Tauri test command: ${command}`)
          }
        },
      },
    })
  }, largeOutline)
}

function card(page: Page, id: string) {
  return page.locator(`[data-shard-fragment-id="${id}"]`)
}

/** 只滚动碎片流 viewport；content-visibility:auto 的预览必须先进入视口才有布局。 */
async function revealCard(target: Locator) {
  await expect(target).toHaveCount(1)
  await target.evaluate((element) => {
    const viewport = element.closest<HTMLElement>('[data-slot="scroll-area-viewport"]')
    if (!viewport) return
    viewport.scrollTop += element.getBoundingClientRect().top - viewport.getBoundingClientRect().top
  })
}

async function saveOutlineFromComposer(page: Page) {
  await fillEditor(page, "composer", OUTLINE_FRAGMENT)
  await focusEditor(page, "composer")
  await expect(page.getByRole("button", { name: "保存片段", exact: true })).toBeEnabled()
  await page.keyboard.press("ControlOrMeta+Enter")
  const created = card(page, "fence-created")
  await expect(created).toBeVisible()
  return created
}

test.beforeEach(async ({ page }) => {
  await installFenceMock(page)
  await page.goto("/")
  await expect(page.locator('[data-shard-editor="composer"] .ProseMirror')).toBeFocused()
  await expect(page.locator(".shard-timeline-item")).toHaveCount(3)
})

test("编辑框保存的 mindmap 围栏在卡片上渲染为只读导图预览", async ({ page }) => {
  const created = await saveOutlineFromComposer(page)
  const preview = created.getByRole("img", { name: "思维导图预览", exact: true })

  await expect(preview).toBeVisible()
  await expect(preview.locator("css=text")).toHaveCount(OUTLINE_NODE_COUNT)
  await expect(created).toContainText("今天的思路")
  // 围栏行被预览接管，不再以源码形式出现在卡片上。
  await expect(created).not.toContainText("```mindmap")
  await expect(created).not.toContainText("- 中心主题")
  await expect(created.locator("[data-mind-map-fence]")).toHaveAttribute(
    "data-mind-map-fence",
    "preview"
  )
})

test("瀑布流双列视图里导图预览同样可见", async ({ page }) => {
  await page.setViewportSize({ width: 1800, height: 900 })
  await page.getByRole("button", { name: "碎片", exact: true }).click()
  await expect(page.locator(".shard-timeline-layout")).toHaveAttribute("data-columns", "2")

  const created = await saveOutlineFromComposer(page)
  await revealCard(created)

  await expect(page.locator(".shard-timeline-layout")).toHaveAttribute("data-columns", "2")
  await expect(created.getByRole("img", { name: "思维导图预览", exact: true })).toBeVisible()
})

test("非 mindmap 围栏保持原样文本", async ({ page }) => {
  const js = card(page, "fence-js")
  await revealCard(js)

  await expect(js).toContainText("```js")
  await expect(js).toContainText("const answer = 42")
  await expect(js.locator("[data-mind-map-fence]")).toHaveCount(0)
  await expect(js.getByRole("img", { name: "思维导图预览", exact: true })).toHaveCount(0)
})

test("超过 200 节点的围栏截断预览并提示，卡片不横向溢出", async ({ page }) => {
  const large = card(page, "fence-large")
  await revealCard(large)
  const preview = large.getByRole("img", { name: "思维导图预览", exact: true })

  await expect(preview).toBeVisible()
  await expect(preview.locator("css=text")).toHaveCount(MAX_PREVIEW_NODES)
  await expect(large).toContainText(`仅预览前 ${MAX_PREVIEW_NODES} 个节点`)

  const overflow = await large.evaluate((element) => ({
    scrollWidth: element.scrollWidth,
    clientWidth: element.clientWidth,
    documentScrollWidth: document.documentElement.scrollWidth,
    documentClientWidth: document.documentElement.clientWidth,
  }))
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth)
  expect(overflow.documentScrollWidth).toBeLessThanOrEqual(overflow.documentClientWidth)
})

test("没有闭栏的 mindmap 围栏不渲染导图", async ({ page }) => {
  const unclosed = card(page, "fence-unclosed")
  await revealCard(unclosed)

  await expect(unclosed).toContainText("```mindmap")
  await expect(unclosed).toContainText("- 没有闭栏的根")
  await expect(unclosed.locator("[data-mind-map-fence]")).toHaveCount(0)
  await expect(unclosed.getByRole("img", { name: "思维导图预览", exact: true })).toHaveCount(0)
})
