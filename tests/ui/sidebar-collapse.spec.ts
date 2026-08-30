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

test.beforeEach(async ({ page }) => {
  await installSidebarMock(page)
  await page.goto("/")
})

test("点击触发器折叠并展开侧边栏", async ({ page }) => {
  await expect.poll(() => sidebarWidth(page)).toBe(248)

  await page
    .getByRole("button", { name: "折叠侧边栏", exact: true })
    .click()
  await expect(
    page.getByRole("button", { name: "展开侧边栏", exact: true })
  ).toBeVisible()
  await expect.poll(() => sidebarWidth(page)).toBe(49)

  await page
    .getByRole("button", { name: "展开侧边栏", exact: true })
    .click()
  await expect(
    page.getByRole("button", { name: "折叠侧边栏", exact: true })
  ).toBeVisible()
  await expect.poll(() => sidebarWidth(page)).toBe(248)
})

test("ControlOrMeta+B 切换侧边栏", async ({ page }) => {
  await page.keyboard.press("ControlOrMeta+b")
  await expect(
    page.getByRole("button", { name: "展开侧边栏", exact: true })
  ).toBeVisible()
  await expect.poll(() => sidebarWidth(page)).toBe(49)

  await page.keyboard.press("ControlOrMeta+b")
  await expect(
    page.getByRole("button", { name: "折叠侧边栏", exact: true })
  ).toBeVisible()
})

test("折叠 rail 保持 route 并在 hover 与 focus 显示两行 tooltip", async ({
  page,
}) => {
  const navigation = page.getByRole("navigation", {
    name: "工作台导航",
    exact: true,
  })
  await navigation
    .getByRole("button", { name: "资料库", exact: true })
    .click()
  const expectedRoute = JSON.stringify({ space: "library", params: {} })
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("shard.workspace-route")))
    .toBe(expectedRoute)

  await page
    .getByRole("button", { name: "折叠侧边栏", exact: true })
    .click()
  const libraryItem = navigation.getByRole("button", {
    name: "工作台：资料库",
    exact: true,
  })
  await expect(libraryItem).toHaveAttribute("aria-current", "page")
  await expect.poll(() => sidebarWidth(page)).toBe(49)
  await expect(libraryItem.locator("svg")).toBeVisible()
  const initialHeight = await libraryItem.evaluate(
    (element) => element.getBoundingClientRect().height
  )

  await libraryItem.hover()
  let tooltip = page.getByRole("tooltip")
  await expect(tooltip.getByText("资料库", { exact: true })).toBeVisible()
  await expect(tooltip.getByText("工作台", { exact: true })).toBeVisible()
  await expect.poll(() => sidebarWidth(page)).toBe(49)
  await expect
    .poll(() =>
      libraryItem.evaluate((element) => element.getBoundingClientRect().height)
    )
    .toBe(initialHeight)

  await page.mouse.move(800, 400)
  await expect(
    page.getByRole("tooltip", { name: "资料库 工作台" })
  ).toBeHidden()
  // base-ui Tooltip 只在 focus-visible 打开，必须用真实键盘 Tab 聚焦
  await page.keyboard.press("Tab")
  await expect
    .poll(async () => {
      const focused = await libraryItem.evaluate(
        (element) => element === document.activeElement
      )
      if (!focused) await page.keyboard.press("Tab")
      return focused
    }, { timeout: 10000 })
    .toBe(true)
  tooltip = page.getByRole("tooltip")
  await expect(tooltip.getByText("资料库", { exact: true })).toBeVisible()
  await expect(tooltip.getByText("工作台", { exact: true })).toBeVisible()
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("shard.workspace-route")))
    .toBe(expectedRoute)
})

test("折叠状态 reload 后保持", async ({ page }) => {
  await page
    .getByRole("button", { name: "折叠侧边栏", exact: true })
    .click()
  await expect.poll(() => sidebarWidth(page)).toBe(49)
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("shard.sidebar-collapsed")))
    .toBe("true")

  await page.reload()

  await expect(
    page.getByRole("button", { name: "展开侧边栏", exact: true })
  ).toBeVisible()
  await expect.poll(() => sidebarWidth(page)).toBe(49)
})
