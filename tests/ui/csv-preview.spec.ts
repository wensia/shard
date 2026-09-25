import { expect, test, type Locator, type Page } from "@playwright/test"

import { fillEditor, focusEditor } from "./editor-helpers"
import { installSearchIpcMock } from "./search-ipc-mock"

interface CsvPreviewCall {
  args: Record<string, unknown>
  command: string
}

async function installCsvPreviewMock(page: Page) {
  await installSearchIpcMock(page)
  await page.addInitScript(() => {
    const now = "2026-08-30T12:00:00.000Z"
    const fragment = (id: string, content: string, tags = ["inbox"]) => ({
      id,
      content,
      createdAt: now,
      updatedAt: now,
      tags,
      category: null,
      path: `fragments/${id}.md`,
      gitStatus: "committed",
      error: null,
      archived: false,
      lockbox: false,
      pinned: false,
      related: [],
    })
    const fragments = [
      fragment("note-csv", "# CSV 资料笔记\n\n![[data/large.csv]]", [
        "inbox",
        "note",
      ]),
      fragment("timeline-large", "![[data/large.csv]]"),
      fragment("timeline-wide", "![[data/wide.csv]]"),
      fragment("timeline-missing", "![[data/missing.csv]]"),
      fragment("timeline-gbk", "![[data/gbk.csv]]"),
      fragment("timeline-link", "普通链接：[[data/large.csv]]"),
      fragment("timeline-slow", "![[data/slow.csv]]"),
    ]
    fragments[0].path = "notes/CSV 资料笔记.md"
    const csvFiles = [
      { name: "large.csv", path: "data/large.csv" },
      { name: "wide.csv", path: "data/wide.csv" },
      { name: "gbk.csv", path: "data/gbk.csv" },
      { name: "slow.csv", path: "data/slow.csv" },
    ]
    const largeCsv = [
      "序号,名称,说明",
      ...Array.from(
        { length: 60 },
        (_, index) =>
          `${index + 1},记录 ${index + 1},用于验证 CSV 行数封顶与总行数`
      ),
    ].join("\r\n")
    const wideHeaders = Array.from(
      { length: 20 },
      (_, index) => `很宽的字段 ${index + 1}`
    )
    const wideCsv = [
      wideHeaders.join(","),
      ...Array.from({ length: 12 }, (_, rowIndex) =>
        wideHeaders.map((_, columnIndex) => `R${rowIndex + 1}C${columnIndex + 1}`).join(",")
      ),
    ].join("\r\n")
    const slowCsv = "序号,状态\r\n1,完成"
    const utf8 = (value: string) => Array.from(new TextEncoder().encode(value))
    const gbk = [
      0xd0, 0xd5, 0xc3, 0xfb, 0x2c, 0xb3, 0xc7, 0xca, 0xd0, 0x0d, 0x0a,
      0xd5, 0xc5, 0xc8, 0xfd, 0x2c, 0xb1, 0xb1, 0xbe, 0xa9,
    ]
    const calls: CsvPreviewCall[] = []
    const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T

    Object.assign(globalThis, {
      isTauri: true,
      __SHARD_CSV_PREVIEW_CALLS__: calls,
      __TAURI_INTERNALS__: {
        invoke: async (command: string, args: Record<string, unknown> = {}) => {
          calls.push({ command, args: clone(args) })

          if (command === "plugin:app|version") return "0.1.3-test"
          if (command === "list_fragments") {
            return clone({
              vaultPath: "/tmp/shard-csv-preview-test",
              fragments,
              git: {
                branch: "main",
                shortCommit: "csv1234",
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
          if (command === "list_mind_maps") return []
          if (command === "list_csv_files") return clone(csvFiles)
          if (command === "set_window_controls_hidden") return null
          if (command === "read_csv_file") {
            const path = String(args.path ?? "")
            if (path === "data/large.csv") return utf8(largeCsv)
            if (path === "data/wide.csv") return utf8(wideCsv)
            if (path === "data/gbk.csv") return clone(gbk)
            if (path === "data/slow.csv") {
              await new Promise<void>((resolve) => {
                Object.assign(globalThis, { __SHARD_CSV_SLOW_RELEASE__: resolve })
              })
              return utf8(slowCsv)
            }
            throw new Error(`找不到 CSV 文件 ${path}`)
          }
          if (command === "open_csv_file") return null
          if (command === "list_library_tree") {
            return {
              entries: [
                {
                  name: "CSV 资料笔记.md",
                  path: "notes/CSV 资料笔记.md",
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
                    name: "CSV 资料笔记.md",
                    path: "notes/CSV 资料笔记.md",
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

function fragmentCard(page: Page, id: string) {
  return page.locator(`[data-shard-fragment-id="${id}"]`)
}

function csvPreview(scope: Locator, path: string) {
  return scope.locator(`section[data-csv-path="${path}"]`)
}

async function csvCalls(page: Page, command: string) {
  return page.evaluate((targetCommand) =>
    (
      globalThis as typeof globalThis & {
        __SHARD_CSV_PREVIEW_CALLS__?: CsvPreviewCall[]
      }
    ).__SHARD_CSV_PREVIEW_CALLS__?.filter(
      (call) => call.command === targetCommand
    ) ?? [],
    command
  )
}

test.beforeEach(async ({ page }) => {
  await installCsvPreviewMock(page)
  await page.goto("/")
})

test("资料库与 Zen 的 CSV 嵌入预览最多展示 50 行", async ({ page }) => {
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  const noteList = page.getByRole("complementary", { name: "资料库目录" })
  await noteList.getByRole("button", { name: /^文件（/ }).click()
  await page.getByRole("region", { name: "notes 目录列表", exact: true })
    .getByRole("button", { name: "打开文件 CSV 资料笔记.md", exact: true })
    .click()

  const libraryEditor = page.locator('[data-shard-editor="library:note-csv"]')
  await expect(csvPreview(libraryEditor, "data/large.csv")).toHaveAttribute(
    "data-visible-rows",
    "50"
  )

  await page.getByRole("button", { name: "碎片", exact: true }).click()
  await expect(
    page.locator('[data-shard-editor="composer"] .ProseMirror')
  ).toBeVisible()
  await fillEditor(page, "composer", "![[data/large.csv]]")
  await focusEditor(page, "composer")
  await page.keyboard.press("Control+Shift+f")
  const zenEditorId = await page.evaluate(() => {
    const bridge = (
      window as typeof window & {
        __shardEditorTest?: { list(): string[] }
      }
    ).__shardEditorTest
    return bridge?.list().find((id) => id.startsWith("zen:")) ?? ""
  })
  expect(zenEditorId).not.toBe("")
  await expect(
    csvPreview(
      page.locator(`[data-shard-editor="${zenEditorId}"]`),
      "data/large.csv"
    )
  ).toHaveAttribute("data-visible-rows", "50")
})

test("时间线卡片的 CSV 嵌入最多展示 10 行且页面不横向溢出", async ({
  page,
}) => {
  const preview = csvPreview(fragmentCard(page, "timeline-large"), "data/large.csv")
  await expect(preview).toHaveAttribute("data-visible-rows", "10")

  const pageDoesNotOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth <= document.documentElement.clientWidth
  )
  expect(pageDoesNotOverflow).toBe(true)
})

test("宽 CSV 仅在预览容器内双轴滚动并保持冻结表头", async ({ page }) => {
  const preview = csvPreview(fragmentCard(page, "timeline-wide"), "data/wide.csv")
  await expect(preview).toHaveAttribute("data-visible-rows", "10")
  const metrics = await preview.evaluate((element) => {
    const scroll = element.querySelector<HTMLElement>('[role="region"]')
    const header = element.querySelector<HTMLElement>("th")
    if (!scroll || !header) throw new Error("CSV scroll region or header missing")
    return {
      headerPosition: getComputedStyle(header).position,
      horizontalOverflow: scroll.scrollWidth > scroll.clientWidth,
      overflowX: getComputedStyle(scroll).overflowX,
      overflowY: getComputedStyle(scroll).overflowY,
    }
  })

  expect(metrics).toMatchObject({
    headerPosition: "sticky",
    horizontalOverflow: true,
    overflowX: "auto",
    overflowY: "auto",
  })
})

test("断链 CSV 嵌入显示读取错误且不创建 fragment 反链", async ({ page }) => {
  const preview = csvPreview(
    fragmentCard(page, "timeline-missing"),
    "data/missing.csv"
  )
  await expect(preview.getByRole("alert")).toHaveText(
    "无法预览 CSV：找不到 CSV 文件 data/missing.csv"
  )
  await expect.poll(() => csvCalls(page, "link_fragments")).toEqual([])
})

test("GBK CSV 正确转码中文并显示建议另存为 UTF-8 角标", async ({ page }) => {
  const preview = csvPreview(fragmentCard(page, "timeline-gbk"), "data/gbk.csv")
  await expect(preview.getByRole("cell", { name: "张三", exact: true })).toBeVisible()
  await expect(preview.getByRole("cell", { name: "北京", exact: true })).toBeVisible()
  await expect(
    preview.getByText("GBK · 建议另存为 UTF-8", { exact: true })
  ).toBeVisible()
})

test("普通 CSV wikilink 不嵌入表格且点击调用默认程序打开", async ({ page }) => {
  const card = fragmentCard(page, "timeline-link")
  await expect(card.locator('section[data-csv-path="data/large.csv"]')).toHaveCount(0)
  await card
    .getByRole("button", { name: "data/large.csv", exact: true })
    .click()

  await expect.poll(() => csvCalls(page, "open_csv_file")).toContainEqual({
    command: "open_csv_file",
    args: { path: "data/large.csv" },
  })
})

test("CSV 异步读取期间暴露 aria-busy 并在完成后恢复", async ({ page }) => {
  const preview = csvPreview(fragmentCard(page, "timeline-slow"), "data/slow.csv")
  await expect(preview).toHaveAttribute("aria-busy", "true")
  await page.evaluate(() => {
    (window as typeof window & { __SHARD_CSV_SLOW_RELEASE__?: () => void }).__SHARD_CSV_SLOW_RELEASE__?.()
  })
  await expect(preview).toHaveAttribute("aria-busy", "false")
  await expect(preview.getByRole("cell", { name: "完成", exact: true })).toBeVisible()
})

test("CSV 底部显示完整总行数并提供默认程序打开动作", async ({ page }) => {
  const preview = csvPreview(fragmentCard(page, "timeline-large"), "data/large.csv")
  await expect(preview.getByText("共 60 行", { exact: true })).toBeVisible()
  await preview
    .getByRole("button", { name: "用默认程序打开", exact: true })
    .click()

  await expect.poll(() => csvCalls(page, "open_csv_file")).toContainEqual({
    command: "open_csv_file",
    args: { path: "data/large.csv" },
  })
})
