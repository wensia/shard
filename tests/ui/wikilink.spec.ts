import { expect, test, type Page } from "@playwright/test"

import { fillEditor, readEditor, typeEditor } from "./editor-helpers"

interface WikilinkCall {
  args: Record<string, unknown>
  command: string
}

async function installWikilinkMock(page: Page) {
  await page.addInitScript(() => {
    const now = "2026-08-30T12:00:00.000Z"
    const fragments = [
      {
        id: "fragment-target",
        content: "可定位的碎片摘要",
        createdAt: now,
        updatedAt: now,
        tags: ["inbox"],
        category: null,
        path: "fragments/fragment-target.md",
        gitStatus: "committed",
        error: null,
        archived: false,
        lockbox: false,
        pinned: false,
        related: [],
      },
      {
        id: "note-source",
        content: "# 来源笔记\n正文 [[目标笔记]]",
        createdAt: now,
        updatedAt: now,
        tags: ["inbox", "note"],
        category: null,
        path: "notes/来源笔记.md",
        gitStatus: "committed",
        error: null,
        archived: false,
        lockbox: false,
        pinned: false,
        related: [
          {
            targetId: "note-target",
            origin: "wikilink",
            createdAt: now,
          },
        ],
      },
      {
        id: "note-target",
        content: "# 目标笔记\n目标正文",
        createdAt: now,
        updatedAt: "2026-08-30T11:00:00.000Z",
        tags: ["inbox", "note"],
        category: null,
        path: "notes/目标笔记.md",
        gitStatus: "committed",
        error: null,
        archived: false,
        lockbox: false,
        pinned: false,
        related: [],
      },
    ]
    const calls: WikilinkCall[] = []
    const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T

    Object.assign(globalThis, {
      isTauri: true,
      __SHARD_WIKILINK_CALLS__: calls,
      __TAURI_INTERNALS__: {
        invoke: async (command: string, args: Record<string, unknown> = {}) => {
          calls.push({ command, args: clone(args) })
          if (command === "list_fragments") {
            return clone({
              vaultPath: "/tmp/shard-wikilink-test",
              fragments,
              git: {
                branch: "main",
                shortCommit: "abc1234",
                hasRemote: false,
                status: "ready",
                error: null,
                ahead: 0,
                behind: 0,
              },
              lockbox: {
                configured: false,
                unlocked: false,
                expiresAt: null,
                ttlSeconds: 900,
              },
            })
          }
          if (command === "plugin:app|version") return "0.0.0"
          if (command === "list_csv_files") return []
          if (command === "list_mind_maps") return []
          if (command === "restore_window_frame") return null
          if (command === "update_fragment") {
            const fragment = fragments.find((item) => item.id === args.id)
            if (!fragment) throw new Error("Fragment not found")
            fragment.content = String(args.content)
            fragment.tags = args.tags as string[]
            fragment.updatedAt = now
            return clone(fragment)
          }
          if (command === "link_fragments") {
            const source = fragments.find((item) => item.id === args.sourceId)
            if (!source) throw new Error("Fragment not found")
            if (!source.related.some((item) => item.targetId === args.targetId)) {
              source.related.push({
                targetId: String(args.targetId),
                origin: String(args.origin),
                createdAt: now,
              })
            }
            return clone(source)
          }
          if (command === "unlink_fragments") {
            const source = fragments.find((item) => item.id === args.sourceId)
            if (!source) throw new Error("Fragment not found")
            source.related = source.related.filter(
              (item) => item.targetId !== args.targetId
            )
            return clone(source)
          }
          if (command === "list_library_tree") {
            return {
              entries: [
                {
                  name: "来源笔记.md",
                  path: "notes/来源笔记.md",
                  kind: "markdown",
                  size: 0,
                  modifiedAt: "",
                },
                {
                  name: "目标笔记.md",
                  path: "notes/目标笔记.md",
                  kind: "markdown",
                  size: 0,
                  modifiedAt: "",
                },
              ],
              assets: [],
              trashEntries: [],
              fragmentStream: { totalCount: 0, years: [] },
            }
          }
          if (command === "migrate_legacy_notes") {
            return {
              tree: {
                entries: [
                  {
                    name: "来源笔记.md",
                    path: "notes/来源笔记.md",
                    kind: "markdown",
                    size: 0,
                    modifiedAt: "",
                  },
                  {
                    name: "目标笔记.md",
                    path: "notes/目标笔记.md",
                    kind: "markdown",
                    size: 0,
                    modifiedAt: "",
                  },
                ],
                assets: [],
                trashEntries: [],
                fragmentStream: { totalCount: 0, years: [] },
              },
              migratedCount: 0,
            }
          }
          if (
            command === "create_library_note" ||
            command === "create_library_directory" ||
            command === "rename_library_entry" ||
            command === "move_library_entry" ||
            command === "delete_library_entry" ||
            command === "convert_fragment_to_note" ||
            command === "convert_note_to_fragment"
          ) {
            return {
              tree: {
                entries: [],
                assets: [],
                trashEntries: [],
                fragmentStream: { totalCount: 0, years: [] },
              },
              fragment: null,
              updatedLinks: 0,
            }
          }
          throw new Error(`Unhandled Tauri test command: ${command}`)
        },
      },
    })
  })
}

test.beforeEach(async ({ page }) => {
  await installWikilinkMock(page)
  await page.goto("/")
})

test("输入双左括号展示笔记标题与碎片摘要候选并写回 wikilink", async ({
  page,
}) => {
  await fillEditor(page, "composer", "[")
  await typeEditor(page, "composer", "[")

  const listbox = page.getByRole("listbox", { name: "标签建议" })
  await expect(listbox).toBeVisible()
  await expect(listbox.getByText("目标笔记", { exact: true })).toBeVisible()
  await expect(listbox.getByText("可定位的碎片摘要", { exact: true })).toBeVisible()
  await listbox.getByText("目标笔记", { exact: true }).click()

  await expect.poll(() => readEditor(page, "composer")).toBe("[[目标笔记]]")
})

test("链接点击复用资料库与时间线导航且不滚动 document", async ({ page }) => {
  await fillEditor(page, "composer", "[[目标笔记]]")
  await page.locator('[data-shard-editor="composer"] .shard-cm-wikilink').click()
  await expect(page.locator('[data-shard-editor="library:note-target"]')).toBeVisible()

  await page.getByRole("button", { name: "碎片", exact: true }).click()
  await fillEditor(page, "composer", "[[fragment-target]]")
  const documentScrollBefore = await page.evaluate(() => window.scrollY)
  await page.locator('[data-shard-editor="composer"] .shard-cm-wikilink').click()
  await expect(
    page.getByRole("complementary", { name: "资料库目录" })
  ).toBeVisible()
  await expect(
    page
      .getByRole("article", { name: "资料库查看器" })
      .locator('[data-shard-fragment-id="fragment-target"]')
  ).toHaveClass(/shard-fragment-card-highlight/u)
  expect(await page.evaluate(() => window.scrollY)).toBe(documentScrollBefore)
})

test("断链使用待建样式，点击仅提示且编辑器可继续输入", async ({ page }) => {
  const pageErrors: string[] = []
  page.on("pageerror", (error) => pageErrors.push(error.message))
  await fillEditor(page, "composer", "[[尚未创建]]")

  const missing = page.locator(
    '[data-shard-editor="composer"] .shard-cm-wikilink--missing'
  )
  await expect(missing).toBeVisible()
  await missing.click()
  await expect(page.getByText(/待建链接「尚未创建」尚不存在/u)).toBeVisible()
  await typeEditor(page, "composer", " 继续编辑")
  await expect.poll(() => readEditor(page, "composer")).toContain("继续编辑")
  expect(pageErrors).toEqual([])
})

test("资料库保存通过现有 relation 命令同步 wikilink diff", async ({ page }) => {
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  const tree = page.getByRole("complementary", { name: "资料库目录" })
  await tree.getByRole("button", { name: /^资料库根目录/ }).click()
  await page.getByRole("region", { name: "notes 目录列表", exact: true })
    .getByRole("button", { name: "打开文件 目标笔记.md", exact: true }).click()
  await fillEditor(page, "library:note-target", "# 目标笔记\n[[fragment-target]]")
  await tree.getByRole("button", { name: /^资料库根目录/ }).click()
  await page.getByRole("region", { name: "notes 目录列表", exact: true })
    .getByRole("button", { name: "打开文件 来源笔记.md", exact: true }).click()

  await expect
    .poll(() =>
      page.evaluate(() =>
        (
          globalThis as typeof globalThis & {
            __SHARD_WIKILINK_CALLS__?: WikilinkCall[]
          }
        ).__SHARD_WIKILINK_CALLS__?.filter(
          (call) => call.command === "link_fragments"
        ) ?? []
      )
    )
    .toContainEqual({
      command: "link_fragments",
      args: {
        sourceId: "note-target",
        targetId: "fragment-target",
        origin: "wikilink",
        note: null,
      },
    })
})

test("资料库第三栏展示 wikilink 反向链接分组", async ({ page }) => {
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  await page.getByRole("complementary", { name: "资料库目录" })
    .getByRole("button", { name: /^资料库根目录/ }).click()
  await page.getByRole("region", { name: "notes 目录列表", exact: true })
    .getByRole("button", { name: "打开文件 目标笔记.md", exact: true }).click()

  const inspector = page.locator("[data-library-inspector-slot]")
  await expect(inspector.getByRole("region", { name: "反向链接" })).toBeVisible()
  await expect(inspector.getByText("来源笔记", { exact: false })).toBeVisible()
})
