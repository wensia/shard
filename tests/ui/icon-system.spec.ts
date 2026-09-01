import { expect, test, type Page } from "@playwright/test"

// 图标系统回归网（design.md）：尺寸只能来自 --shard-icon-size-* token，
// 描边只能来自 --shard-icon-stroke token 的全局 CSS 规则。这两条断言
// 渲染结果而不是源码——五套竞争尺寸机制或散装 strokeWidth 一旦复活，
// computed 值就会偏离 token 值。

async function installIconMock(page: Page) {
  await page.addInitScript(() => {
    const fragment = {
      id: "fragment-1",
      content: "图标系统回归片段",
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
      vaultPath: "/tmp/shard-icon-test",
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

test.beforeEach(async ({ page }) => {
  await installIconMock(page)
  await page.goto("/")
  await expect(
    page.getByRole("navigation", { name: "工作台导航", exact: true })
  ).toBeVisible()
})

test("侧栏导航图标消费 nav 尺寸档与基准描边", async ({ page }) => {
  const nav = page.getByRole("navigation", { name: "工作台导航", exact: true })
  const metrics = await nav.evaluate(
    (el) =>
      Array.from(el.querySelectorAll("svg.lucide")).map((svg) => {
        const cs = getComputedStyle(svg)
        return { width: cs.width, height: cs.height, stroke: cs.strokeWidth }
      })
  )
  expect(metrics.length).toBeGreaterThan(0)
  for (const m of metrics) {
    expect(m.width).toBe("18px")
    expect(m.height).toBe("18px")
    expect(m.stroke).toBe("1.5px")
  }
})

test("片段菜单图标消费 sm 尺寸档与小尺寸补偿描边", async ({ page }) => {
  await page.getByRole("button", { name: "片段操作" }).first().click()
  const menu = page.locator('[data-slot="dropdown-menu-content"]')
  await expect(menu).toBeVisible()
  const metrics = await menu.evaluate(
    (el) =>
      Array.from(el.querySelectorAll("svg")).map((svg) => {
        const cs = getComputedStyle(svg)
        return { width: cs.width, height: cs.height, stroke: cs.strokeWidth }
      })
  )
  expect(metrics.length).toBeGreaterThan(0)
  for (const m of metrics) {
    expect(m.width).toBe("14px")
    expect(m.height).toBe("14px")
    expect(m.stroke).toBe("1.75px")
  }
})

test("全页 lucide 图标描边只有 token 两档", async ({ page }) => {
  const strokes = await page.evaluate(() =>
    Array.from(document.querySelectorAll("svg.lucide, svg[data-shard-icon]")).map(
      (svg) => getComputedStyle(svg).strokeWidth
    )
  )
  expect(strokes.length).toBeGreaterThan(0)
  for (const s of strokes) {
    expect(["1.5px", "1.75px"]).toContain(s)
  }
})
