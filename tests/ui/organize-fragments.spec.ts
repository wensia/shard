import { expect, test, type Page } from "@playwright/test"

import { readEditor } from "./editor-helpers"

interface OrganizeCall {
  args: Record<string, unknown>
  command: string
}

type OrganizeMockMode = "deferred-success" | "fail-once"

async function installOrganizeMock(page: Page, mode: OrganizeMockMode) {
  await page.addInitScript((mockMode: OrganizeMockMode) => {
    const now = "2026-08-30T12:00:00.000Z"
    const fragments = [
      {
        id: "fragment-first",
        content: "第一条公开碎片：产品访谈里的核心问题。",
        createdAt: now,
        updatedAt: now,
        tags: ["inbox", "research"],
        category: null,
        path: "fragments/2026/08/fragment-first.md",
        gitStatus: "committed",
        error: null,
        archived: false,
        lockbox: false,
        pinned: false,
        related: [],
      },
      {
        id: "fragment-second",
        content: "第二条公开碎片：后续需要整理为行动建议。",
        createdAt: "2026-08-30T11:00:00.000Z",
        updatedAt: "2026-08-30T11:00:00.000Z",
        tags: ["inbox", "research"],
        category: null,
        path: "fragments/2026/08/fragment-second.md",
        gitStatus: "committed",
        error: null,
        archived: false,
        lockbox: false,
        pinned: false,
        related: [],
      },
      {
        id: "lockbox-fragment",
        content: "密匣内容不得进入整理多选。",
        createdAt: "2026-08-30T10:00:00.000Z",
        updatedAt: "2026-08-30T10:00:00.000Z",
        tags: ["lockbox"],
        category: null,
        path: "lockbox/lockbox-fragment.md.age",
        gitStatus: "committed",
        error: null,
        archived: false,
        lockbox: true,
        pinned: false,
        related: [],
      },
    ]
    const calls: OrganizeCall[] = []
    const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T
    let organizeAttempts = 0
    let resolveDeferred: (() => void) | null = null

    const generatedNote = () => {
      const note = {
        id: "note-organized",
        content: [
          "# 访谈问题与行动建议",
          "",
          "整理后的笔记正文。",
          "",
          "## 来源",
          "",
          "- [[fragment-first]]",
          "- [[fragment-second]]",
        ].join("\n"),
        createdAt: now,
        updatedAt: now,
        tags: ["note"],
        category: null,
        path: "notes/访谈问题与行动建议.md",
        gitStatus: "untracked",
        error: null,
        archived: false,
        lockbox: false,
        pinned: false,
        related: [
          { targetId: "fragment-first", origin: "wikilink", createdAt: now },
          { targetId: "fragment-second", origin: "wikilink", createdAt: now },
        ],
      }
      fragments.unshift(note)
      return clone(note)
    }

    Object.assign(globalThis, {
      isTauri: true,
      __SHARD_ORGANIZE_CALLS__: calls,
      __SHARD_RESOLVE_ORGANIZE__: () => resolveDeferred?.(),
      __TAURI_INTERNALS__: {
        invoke: async (command: string, args: Record<string, unknown> = {}) => {
          calls.push({ command, args: clone(args) })

          if (command === "list_fragments") {
            return clone({
              vaultPath: "/tmp/shard-organize-test",
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
                configured: true,
                unlocked: false,
                expiresAt: null,
                ttlSeconds: 900,
              },
            })
          }
          if (command === "list_mind_maps") return []
          if (command === "restore_window_frame") return null
          if (command === "sync_vault") {
            return {
              branch: "main",
              shortCommit: "abc1234",
              hasRemote: false,
              status: "ready",
              error: null,
              ahead: 0,
              behind: 0,
            }
          }
          if (command === "organize_fragments") {
            organizeAttempts += 1
            if (mockMode === "fail-once" && organizeAttempts === 1) {
              throw new Error("Codex CLI 暂时不可用")
            }
            if (mockMode === "deferred-success") {
              await new Promise<void>((resolve) => {
                resolveDeferred = resolve
              })
            }
            return generatedNote()
          }

          if (command === "list_csv_files") return []
          if (command === "list_library_tree") {
            return {
              entries: fragments
                .filter((fragment) => fragment.tags.includes("note"))
                .map((fragment) => ({
                  name: "访谈问题与行动建议.md",
                  path: fragment.path,
                  kind: "markdown",
                })),
              fragmentStream: { totalCount: 0, years: [] },
            }
          }
          if (command === "migrate_legacy_notes") {
            return {
              tree: {
                entries: fragments
                  .filter((fragment) => fragment.tags.includes("note"))
                  .map((fragment) => ({
                    name: "访谈问题与行动建议.md",
                    path: fragment.path,
                    kind: "markdown",
                  })),
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
  }, mode)
}

async function enterOrganizeModeAndSelectTwo(page: Page) {
  await page.getByRole("button", { name: "整理", exact: true }).click()

  await page
    .getByRole("checkbox", { name: /选择片段：第一条公开碎片/u })
    .check()
  await page
    .getByRole("checkbox", { name: /选择片段：第二条公开碎片/u })
    .check()

  await expect(page.getByText("已选 2 条", { exact: true })).toBeVisible()
}

async function openOrganizeDialog(page: Page) {
  await page.getByRole("button", { name: "整理为笔记", exact: true }).click()
  return page.getByRole("dialog", { name: "整理为笔记" })
}

test("多选公开碎片并以模板生成笔记，生成中保持局部进度态，完成后在资料库打开", async ({
  page,
}) => {
  await installOrganizeMock(page, "deferred-success")
  await page.goto("/")

  await enterOrganizeModeAndSelectTwo(page)
  await expect(
    page.getByRole("checkbox", { name: /选择片段：密匣内容不得进入整理多选/u })
  ).toHaveCount(0)

  const dialog = await openOrganizeDialog(page)
  await expect(dialog).toBeVisible()
  await dialog.getByLabel("目标描述").fill("提炼访谈问题并给出行动建议")
  await expect(dialog.getByRole("radio", { name: /摘要/u })).toHaveAttribute(
    "aria-checked",
    "true"
  )
  await expect(dialog.getByRole("radio", { name: /周报/u })).toBeVisible()
  const articleTemplate = dialog.getByRole("radio", { name: /文章/u })
  await articleTemplate.click()
  await expect(articleTemplate).toHaveAttribute("aria-checked", "true")
  await dialog.getByRole("button", { name: "生成笔记" }).click()

  await expect(dialog).toHaveAttribute("aria-busy", "true")
  await expect(dialog.getByRole("button", { name: "正在整理…" })).toBeDisabled()
  await expect(dialog.getByLabel("目标描述")).toBeDisabled()
  await expect(articleTemplate).toBeDisabled()

  const request = await page.evaluate(() =>
    (
      globalThis as typeof globalThis & {
        __SHARD_ORGANIZE_CALLS__?: OrganizeCall[]
      }
    ).__SHARD_ORGANIZE_CALLS__?.find(
      (call) => call.command === "organize_fragments"
    )
  )
  expect(request?.args).toEqual({
    request: {
      fragmentPaths: [
        "fragments/2026/08/fragment-first.md",
        "fragments/2026/08/fragment-second.md",
      ],
      target: "提炼访谈问题并给出行动建议",
      template: "article",
    },
  })

  await page.evaluate(() =>
    (
      globalThis as typeof globalThis & {
        __SHARD_RESOLVE_ORGANIZE__?: () => void
      }
    ).__SHARD_RESOLVE_ORGANIZE__?.()
  )

  await expect(
    page
      .getByRole("complementary", { name: "资料库目录" })
      .getByRole("button", { name: /^资料库根目录/ })
  ).toBeVisible()
  await expect(
    page
      .getByRole("complementary", { name: "资料库目录" })
      .getByRole("button", {
        name: "访谈问题与行动建议.md",
        exact: true,
      })
  ).toBeVisible()
  await expect(
    page.locator('[data-shard-editor="library:note-organized"]')
  ).toBeVisible()
  await expect.poll(() => readEditor(page, "library:note-organized")).toContain(
    "## 来源\n\n- [[fragment-first]]\n- [[fragment-second]]"
  )
})

test("Codex CLI 失败后保留可重试错误条并能成功重试", async ({ page }) => {
  await installOrganizeMock(page, "fail-once")
  await page.goto("/")

  await enterOrganizeModeAndSelectTwo(page)
  const dialog = await openOrganizeDialog(page)
  await dialog.getByLabel("目标描述").fill("整理失败后重试")
  await dialog.getByRole("button", { name: "生成笔记" }).click()

  const error = page.getByRole("alert")
  await expect(error).toContainText("Codex CLI 暂时不可用")
  await expect(dialog.getByLabel("目标描述")).toHaveValue("整理失败后重试")
  await expect(error.getByRole("button", { name: "重试" })).toBeEnabled()
  await error.getByRole("button", { name: "重试" }).click()

  await expect(page.locator('[data-shard-editor="library:note-organized"]')).toBeVisible()
  await expect
    .poll(() =>
      page.evaluate(() =>
        (
          globalThis as typeof globalThis & {
            __SHARD_ORGANIZE_CALLS__?: OrganizeCall[]
          }
        ).__SHARD_ORGANIZE_CALLS__?.filter(
          (call) => call.command === "organize_fragments"
        ).length ?? 0
      )
    )
    .toBe(2)
})
