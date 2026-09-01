import { expect, test, type Page } from "@playwright/test"

async function installSidebarMock(page: Page) {
  await page.addInitScript(() => {
    const fragment = {
      id: "fragment-1",
      content: "侧边栏测试片段",
      createdAt: "2026-08-30T08:00:00.000Z",
      updatedAt: "2026-08-30T08:00:00.000Z",
      tags: ["inbox"],
      category: null,
      path: "fragments/2026/08/fragment-1.md",
      gitStatus: "committed",
      error: null,
      archived: false,
      lockbox: false,
      pinned: false,
      related: [],
    }
    const git = {
      branch: "main",
      shortCommit: "abc1234",
      hasRemote: false,
      status: "ready",
      error: null,
      ahead: 0,
      behind: 0,
    }
    const state = {
      vaultPath: "/tmp/shard-sidebar-test",
      fragments: [fragment],
      git,
      lockbox: {
        configured: false,
        unlocked: false,
        expiresAt: null,
        ttlSeconds: 900,
      },
    }
    const tree = {
      entries: [],
      assets: [],
      trashEntries: [],
      fragmentStream: {
        totalCount: 1,
        years: [{ year: "2026", totalCount: 1, months: [{ month: "08", count: 1 }] }],
      },
    }

    Object.assign(globalThis, {
      isTauri: true,
      __TAURI_INTERNALS__: {
        invoke: async (command: string) => {
          if (command === "list_fragments") return structuredClone(state)
          if (command === "list_mind_maps") return []
          if (command === "list_csv_files") return []
          if (command === "list_library_tree") return structuredClone(tree)
          if (command === "migrate_legacy_notes") {
            return { tree: structuredClone(tree), migratedCount: 0 }
          }
          if (command === "restore_window_frame") return null
          if (command === "sync_vault") return structuredClone(git)
          throw new Error(`Unhandled Tauri test command: ${command}`)
        },
      },
    })
  })
}

function sidebar(page: Page) {
  const navigation = page.getByRole("navigation", {
    name: "工作台导航",
    exact: true,
  })
  return page.locator("aside").filter({ has: navigation })
}

async function sidebarWidth(page: Page) {
  return sidebar(page).evaluate((element) => element.getBoundingClientRect().width)
}

async function leftEdge(page: Page, selector: string) {
  return page.locator(selector).evaluate((element) => element.getBoundingClientRect().left)
}

test.beforeEach(async ({ page }) => {
  await installSidebarMock(page)
  await page.goto("/")
})

test("触发器避开红绿灯且折叠后侧边栏完全退出布局", async ({ page }) => {
  await expect.poll(() => sidebarWidth(page)).toBe(248)
  const expandedTitlebar = page.locator("[data-sidebar-titlebar]")
  const collapseButton = page.getByRole("button", {
    name: "折叠侧边栏",
    exact: true,
  })
  await expect(expandedTitlebar).toHaveCSS("height", "52px")
  await expect(expandedTitlebar.locator(":scope > *")).toHaveCount(1)
  await expect.poll(async () => (await collapseButton.boundingBox())?.x).toBeGreaterThanOrEqual(80)

  await collapseButton.click()
  await expect(sidebar(page)).toHaveCount(0)
  const collapsedTitlebar = page.locator("[data-sidebar-collapsed-titlebar]")
  const expandButton = page.getByRole("button", {
    name: "展开侧边栏",
    exact: true,
  })
  await expect(collapsedTitlebar).toBeVisible()
  await expect(collapsedTitlebar).toHaveCSS("height", "52px")
  await expect.poll(async () => (await expandButton.boundingBox())?.x).toBeGreaterThanOrEqual(80)
  await expect.poll(() => leftEdge(page, "[data-workspace-slot]")).toBe(0)

  await expandButton.click()
  await expect(collapseButton).toBeVisible()
  await expect.poll(() => sidebarWidth(page)).toBe(248)
})

test("ControlOrMeta+B 切换侧边栏", async ({ page }) => {
  await page.keyboard.press("ControlOrMeta+b")
  await expect(
    page.getByRole("button", { name: "展开侧边栏", exact: true })
  ).toBeVisible()
  await expect(sidebar(page)).toHaveCount(0)

  await page.keyboard.press("ControlOrMeta+b")
  await expect(
    page.getByRole("button", { name: "折叠侧边栏", exact: true })
  ).toBeVisible()
})

test("折叠不改变当前 route", async ({ page }) => {
  const navigation = page.getByRole("navigation", {
    name: "工作台导航",
    exact: true,
  })
  await navigation.getByRole("button", { name: "资料库", exact: true }).click()
  const expectedRoute = JSON.stringify({ space: "library", params: {} })
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("shard.workspace-route")))
    .toBe(expectedRoute)

  await page
    .getByRole("button", { name: "折叠侧边栏", exact: true })
    .click()
  await expect(sidebar(page)).toHaveCount(0)
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("shard.workspace-route")))
    .toBe(expectedRoute)

  await page
    .getByRole("button", { name: "展开侧边栏", exact: true })
    .click()
  await expect(
    navigation.getByRole("button", { name: "资料库", exact: true })
  ).toHaveAttribute("aria-current", "page")
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("shard.workspace-route")))
    .toBe(expectedRoute)
})

test("折叠状态 reload 后保持", async ({ page }) => {
  await page
    .getByRole("button", { name: "折叠侧边栏", exact: true })
    .click()
  await expect(sidebar(page)).toHaveCount(0)
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("shard.sidebar-collapsed")))
    .toBe("true")

  await page.reload()

  await expect(
    page.getByRole("button", { name: "展开侧边栏", exact: true })
  ).toBeVisible()
  await expect(sidebar(page)).toHaveCount(0)
  await expect.poll(() => leftEdge(page, "[data-workspace-slot]")).toBe(0)
})
