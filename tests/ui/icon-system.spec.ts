import { expect, test, type Page } from "@playwright/test"
import { installSearchIpcMock } from "./search-ipc-mock"

// 图标系统回归网（design.md）：尺寸只能来自 --shard-icon-size-* token，
// 描边只能来自 --shard-icon-stroke token 的全局 CSS 规则。这两条断言
// 渲染结果而不是源码——五套竞争尺寸机制或散装 strokeWidth 一旦复活，
// computed 值就会偏离 token 值。

const DATATABLE_FRAGMENT = [
  "```datatable",
  '{ "title": "图标场景", "columns": [{ "key": "a", "label": "甲" }], "rows": [{ "a": "一" }] }',
  "```",
].join("\n")

async function installIconMock(page: Page) {
  await installSearchIpcMock(page)
  await page.addInitScript((datatable: string) => {
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
    // 数据表围栏块也要进图标回归网：它有自己的工具条与 14px 标题图标。
    const datatableFragment = { ...fragment, content: datatable, id: "fragment-datatable", path: "fragments/2026/08/fragment-datatable.md" }
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
      fragments: [fragment, datatableFragment],
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
        totalCount: 2,
        years: [{ year: "2026", totalCount: 2, months: [{ month: "08", count: 2 }] }],
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
          if (command === "sync_vault") return structuredClone(git)
          throw new Error(`Unhandled Tauri test command: ${command}`)
        },
      },
    })
  }, DATATABLE_FRAGMENT)
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

test("数据表工具条消费 md 尺寸档，14px 标题图标走补偿描边", async ({ page }) => {
  const block = page
    .locator('[data-shard-fragment-id="fragment-datatable"] [data-datatable="block"]')
  await expect(block).toBeVisible()

  const metrics = await block.evaluate((element) => {
    const read = (svg: Element) => {
      const cs = getComputedStyle(svg)
      return { width: cs.width, height: cs.height, stroke: cs.strokeWidth }
    }
    const title = element.querySelector("header > svg")!
    const buttons = Array.from(element.querySelectorAll('[data-slot="button"] svg'))
    return { title: read(title), buttons: buttons.map(read) }
  })

  expect(metrics.title).toEqual({ width: "14px", height: "14px", stroke: "1.75px" })
  expect(metrics.buttons.length).toBeGreaterThan(0)
  for (const metric of metrics.buttons) {
    expect(metric.width).toBe("16px")
    expect(metric.height).toBe("16px")
    expect(metric.stroke).toBe("1.5px")
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

// 密度档回归网（vendor/kiln/SKILL.md → Density Ladder）。Shard 走 compact 档，
// 控件几何整体降一档；字号、圆角、图标尺寸不随档变。

test("产品声明 compact 密度档，控件高度 token 取 compact 值", async ({ page }) => {
  const tier = await page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement)
    return {
      density: document.documentElement.dataset.density,
      control: cs.getPropertyValue("--control-height").trim(),
      controlSm: cs.getPropertyValue("--control-height-sm").trim(),
      controlLg: cs.getPropertyValue("--control-height-lg").trim(),
      navItem: cs.getPropertyValue("--nav-item-height").trim(),
      toolbar: cs.getPropertyValue("--toolbar-control").trim(),
    }
  })
  expect(tier.density).toBe("compact")
  expect(tier.control).toBe("32px")
  expect(tier.controlSm).toBe("28px")
  expect(tier.controlLg).toBe("36px")
  expect(tier.navItem).toBe("32px")
  expect(tier.toolbar).toBe("28px")
})

test("按钮高度绑 token 而非写死，切档即跟随", async ({ page }) => {
  // 写死 h-9 会让控件静默退出密度档；这里断言渲染高度落在档位值上，
  // 而不是 Tailwind 默认阶梯的 36/32px。
  const heights = await page.evaluate(() => {
    const allowed = new Set(
      ["--control-height", "--control-height-sm", "--control-height-lg"].map((t) =>
        getComputedStyle(document.documentElement).getPropertyValue(t).trim()
      )
    )
    return Array.from(document.querySelectorAll('[data-slot="button"]'))
      .map((el) => getComputedStyle(el).height)
      // 标签移除键等极小控件由内联 style 显式覆盖几何，不参与档位
      .filter((h) => h !== "18px")
      .map((h) => ({ h, ok: allowed.has(h) }))
  })
  expect(heights.length).toBeGreaterThan(0)
  for (const { h, ok } of heights) {
    expect(ok, `按钮高度 ${h} 不在密度档内，可能写死了 h-9/h-8`).toBe(true)
  }
})

test("密度档只改几何，不改字号与圆角", async ({ page }) => {
  const anchored = await page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement)
    return {
      body: cs.getPropertyValue("--text-body").trim(),
      meta: cs.getPropertyValue("--text-meta").trim(),
      tiny: cs.getPropertyValue("--text-tiny").trim(),
      radiusControl: cs.getPropertyValue("--radius-control").trim(),
      iconMd: cs.getPropertyValue("--shard-icon-size-md").trim(),
    }
  })
  expect(anchored.body).toBe("13px")
  expect(anchored.meta).toBe("12px")
  expect(anchored.tiny).toBe("11px") // kiln 明文字号下限，中文界面守不得
  expect(anchored.radiusControl).toBe("4px")
  expect(anchored.iconMd).toBe("16px")
})
