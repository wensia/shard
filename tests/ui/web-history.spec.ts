import { expect, test, type Page } from "@playwright/test"

// 网页端的版本历史与「数据与备份」：版本历史存在服务器上，只有网页端有。
// 与 mobile-web-layout.spec.ts 一样在页面里改写 fetch，把 /api/* 接到内存里的假服务端，走真实的网页代码路径。

test.use({ viewport: { width: 1280, height: 860 }, locale: "zh-CN" })

const RIDE = "20261026-073012-a1b2c3d4-0a0b0c"
const DELETED = "20261025-221500-b2c3d4e5-1a1b1c"

async function installWebServerMock(page: Page) {
  await page.addInitScript(
    ({ ride, deleted }) => {
      const now = "2026-10-26T12:00:00.000Z"
      const state = {
        vaultPath: "shard://test/history",
        fragments: [
          {
            id: ride,
            path: `fragments/2026/10/${ride}.md`,
            content: "改过的正文。#骑行\n",
            tags: ["inbox", "骑行"],
            fileSha: "sha-current",
            createdAt: now,
            updatedAt: now,
            category: null,
            gitStatus: "saved",
            error: null,
            archived: false,
            lockbox: false,
            pinned: false,
            properties: [],
            related: [],
          },
        ],
        git: { ahead: 0, behind: 0, branch: "main", error: null, hasRemote: false, shortCommit: "no git", status: "no_git" },
        lockbox: { configured: false, expiresAt: null, ttlSeconds: 900, unlocked: false },
      }
      const revisions = [
        { revId: 12, nodeId: 3, path: `fragments/2026/10/${ride}.md`, sha: "sha-current", size: 30, reason: "edit", device: "session:aaaa", createdAt: "2026-10-26T15:55:00.000Z" },
        { revId: 4, nodeId: 3, path: `fragments/2026/10/${ride}.md`, sha: "sha-old", size: 60, reason: "import", device: null, createdAt: "2026-10-26T12:13:00.000Z" },
      ]
      let deletedEntries = [
        {
          nodeId: 9,
          revId: 7,
          path: `.trash/fragments/2026/10/${deleted}.md`,
          sha: "sha-deleted",
          purgedAt: "2026-10-26T15:56:00.000Z",
          expiresAt: "2026-11-25T15:56:00.000Z",
          revisions: 3,
        },
      ]
      const calls: Array<{ command: string; args: Record<string, unknown> }> = []
      Object.assign(window, { __HISTORY_CALLS__: calls })
      const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T
      const handlers: Record<string, (args: Record<string, unknown>) => unknown> = {
        list_fragments: () => clone(state),
        list_library_tree: () => ({ entries: [], assets: [], trashEntries: [], fragmentTrashEntries: [], fragmentStream: { totalCount: 1, years: [] } }),
        list_mind_maps: () => [],
        list_csv_files: () => [],
        list_markdown_dialect_migration: () => ({ dialect: 2, sources: [] }),
        list_revisions: () => ({ nodeId: 3, path: `fragments/2026/10/${ride}.md`, revisions: clone(revisions) }),
        restore_revision: (args) => ({ path: `fragments/2026/10/${ride}.md`, sha: "sha-old", revived: args.revId === 7 }),
        list_deleted_entries: () => ({ entries: clone(deletedEntries), retentionDays: 30 }),
        erase_deleted_entries: () => {
          deletedEntries = []
          return { nodes: 1, revisions: 3, blobs: 0 }
        },
      }
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
      const realFetch = window.fetch.bind(window)
      window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href)
        if (!url.pathname.startsWith("/api/")) return realFetch(input, init)
        if (url.pathname === "/api/auth/state") {
          return json({ authenticated: true, setupRequired: false, stepUpValid: true, vaultId: state.vaultPath })
        }
        if (url.pathname === "/api/events") {
          return new Response(new ReadableStream({ start() {} }), { headers: { "content-type": "text/event-stream" } })
        }
        if (url.pathname === "/api/history/4") {
          return new Response("---\nid: x\n---\n\n早上沿江骑了 32 公里，风有点大。\n", { headers: { "content-type": "text/plain; charset=utf-8" } })
        }
        if (url.pathname.startsWith("/api/rpc/")) {
          const command = decodeURIComponent(url.pathname.slice("/api/rpc/".length))
          const args = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {}
          calls.push({ command, args })
          const handler = handlers[command]
          if (!handler) return json({ code: "UNKNOWN", message: `测试替身没有实现 ${command}` }, 400)
          return json(handler(args))
        }
        return json({ message: "not found" }, 404)
      }
    },
    { ride: RIDE, deleted: DELETED }
  )
}

function calls(page: Page, command: string) {
  return page.evaluate(
    (name) =>
      (window as unknown as { __HISTORY_CALLS__: Array<{ command: string; args: Record<string, unknown> }> }).__HISTORY_CALLS__.filter(
        (call) => call.command === name
      ),
    command
  )
}

test.beforeEach(async ({ page }) => {
  await installWebServerMock(page)
  await page.goto("/")
  await expect(page.locator("html")).toHaveAttribute("data-runtime", "web")
})

test("碎片菜单打开版本历史：预览旧版本，恢复时带当前版本作基线", async ({ page }) => {
  const card = page.locator(`[data-shard-fragment-id="${RIDE}"]`).first()
  await card.getByRole("button", { name: "片段操作" }).click()
  await page.getByRole("menuitem", { name: "版本历史" }).click()

  const dialog = page.getByRole("dialog")
  const list = dialog.getByRole("list", { name: "版本列表" })
  await expect(list.getByRole("button")).toHaveCount(2)
  await expect(list.getByRole("button").first()).toContainText("当前 · 编辑")
  // 当前版本不能「恢复」成它自己。
  await expect(dialog.getByRole("button", { name: "恢复为这个版本" })).toBeDisabled()

  await list.getByRole("button").nth(1).click()
  await expect(dialog.getByText("早上沿江骑了 32 公里，风有点大。")).toBeVisible()
  await expect(dialog.getByRole("button", { name: "下载这个版本" })).toHaveAttribute("href", "/api/history/4?download=1")
  await dialog.getByRole("button", { name: "恢复为这个版本" }).click()
  await expect(dialog).toBeHidden()
  expect(await calls(page, "restore_revision")).toEqual([{ command: "restore_revision", args: { revId: 4, expectedSha: "sha-current" } }])
  expect((await calls(page, "list_revisions"))[0].args).toEqual({ id: RIDE })
})

test("数据与备份：最近删除可找回，立即抹除要点两次", async ({ page }) => {
  await page.getByText("已连接服务器").click()
  const settings = page.getByRole("dialog")
  await expect(settings.getByText("碎片 · 10/25 22:15")).toBeVisible()
  await expect(settings.getByText(/\d+ 天后永久清除/u)).toBeVisible()

  await settings.getByRole("button", { name: "找回" }).click()
  await expect.poll(async () => (await calls(page, "restore_revision")).map((call) => call.args)).toEqual([{ revId: 7, expectedSha: null }])

  await settings.getByRole("button", { name: "立即抹除" }).click()
  await expect(settings.getByRole("button", { name: "再点一次抹除" })).toBeVisible()
  expect(await calls(page, "erase_deleted_entries")).toHaveLength(0)
  await settings.getByRole("button", { name: "再点一次抹除" }).click()
  await expect(settings.getByText("最近 30 天没有彻底删除的内容", { exact: false })).toBeVisible()
  expect((await calls(page, "erase_deleted_entries")).map((call) => call.args)).toEqual([{ nodeIds: [9] }])
})
