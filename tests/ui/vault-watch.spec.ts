import { expect, test, type Page } from "@playwright/test"

import {
  card,
  editFragmentExternally,
  emitVaultChanged,
  installContentTypesMock,
  readTypeCalls,
  revealCard,
} from "./content-types-mock"

/**
 * vault 文件监听：终端 shard、AI 助手等在 App 之外写入后，碎片流不等切回窗口就刷新；
 * App 自己保存产生的事件 sha 与内存一致，不触发重读。
 */

const COMPOSER = '[data-shard-editor="composer"]'

async function commandCount(page: Page, command: string) {
  return (await readTypeCalls(page)).filter((call) => call.command === command).length
}

test.describe("外部写入实时刷新", () => {
  test.beforeEach(async ({ page }) => {
    await installContentTypesMock(page)
    await page.goto("/")
    await expect(page.locator(`${COMPOSER} .ProseMirror`)).toBeFocused()
    await expect(page.locator(".shard-timeline-item")).toHaveCount(6)
  })

  test("启动后开始监听当前 vault", async ({ page }) => {
    await expect.poll(() => commandCount(page, "watch_vault")).toBe(1)
    const listens = (await readTypeCalls(page)).filter(
      (call) => call.command === "plugin:event|listen" && call.args.event === "vault-changed"
    )
    expect(listens).toHaveLength(1)
  })

  test("外部改写的碎片无需切回窗口就显示新内容", async ({ page }) => {
    await expect.poll(() => commandCount(page, "watch_vault")).toBe(1)
    const before = await commandCount(page, "list_fragments")
    const changed = await editFragmentExternally(page, "card-fragment", "#灵感 来自终端的新内容")
    await emitVaultChanged(page, [{ ...changed, exists: true }])

    const target = card(page, "card-fragment")
    await revealCard(target)
    await expect(target).toContainText("来自终端的新内容")
    expect(await commandCount(page, "list_fragments")).toBe(before + 1)
  })

  test("sha 与内存一致的变化（App 自己的保存）不触发重读", async ({ page }) => {
    await expect.poll(() => commandCount(page, "watch_vault")).toBe(1)
    const before = await commandCount(page, "list_fragments")
    await emitVaultChanged(page, [
      { path: "fragments/card-fragment.md", exists: true, sha: "file-sha-card-fragment-1" },
      // 回收站移走、内存里已不在原路径的文件：删除事件也不用重读。
      { path: "fragments/2026/10/already-gone.md", exists: false, sha: null },
    ])
    // 给一次刷新留足时间，再确认确实没有发生。
    await page.waitForTimeout(300)
    expect(await commandCount(page, "list_fragments")).toBe(before)
  })

  test("一批里的多条外部变化只重读一次，CSV 交给数据集视图", async ({ page }) => {
    await expect.poll(() => commandCount(page, "watch_vault")).toBe(1)
    const datasetEvents = page.evaluate(() => new Promise<string[]>((resolve) => {
      window.addEventListener("shard:vault-files-changed", (event) => {
        resolve((event as CustomEvent<{ paths: string[] }>).detail.paths)
      }, { once: true })
    }))
    const before = await commandCount(page, "list_fragments")
    await emitVaultChanged(page, [
      { path: "fragments/2026/10/new-a.md", exists: true, sha: "sha-a" },
      { path: "fragments/2026/10/new-b.md", exists: true, sha: "sha-b" },
      { path: "datasets/阅读记录.csv", exists: true, sha: "sha-csv" },
    ])
    expect(await datasetEvents).toEqual(["datasets/阅读记录.csv"])
    await expect.poll(() => commandCount(page, "list_fragments")).toBe(before + 1)
    // 新 CSV 不在已知列表里：顺带刷新 CSV 文件列表。
    await expect.poll(() => commandCount(page, "list_csv_files")).toBeGreaterThan(1)
  })
})
