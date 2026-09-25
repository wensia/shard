import { expect, test, type Page } from "@playwright/test"

// 底部状态栏（借鉴 Tolaria 的 ADR 0032：git 与全局状态沉到底部，侧栏只做导航）。
// 断言一律取 computed style 而不是 class 名——条带几何是这次改动的实质。

type GitOverrides = Partial<{
  ahead: number
  behind: number
  branch: string
  error: string | null
  hasRemote: boolean
  shortCommit: string
  status: string
}>

async function installStatusBarMock(page: Page, gitOverrides: GitOverrides = {}) {
  await page.addInitScript((overrides: GitOverrides) => {
    const git = {
      ahead: 0,
      behind: 0,
      branch: "main",
      error: null as string | null,
      hasRemote: true,
      shortCommit: "abc1234",
      status: "ready",
      ...overrides,
    }
    const fragment = {
      id: "fragment-1",
      content: "状态栏测试片段",
      createdAt: "2026-09-01T08:00:00.000Z",
      updatedAt: "2026-09-01T08:00:00.000Z",
      tags: ["inbox"],
      category: null,
      path: "fragments/2026/09/fragment-1.md",
      gitStatus: "committed",
      error: null,
      archived: false,
      lockbox: false,
      pinned: false,
      related: [],
    }
    const state = {
      vaultPath: "/tmp/shard-status-bar",
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
        years: [
          { year: "2026", totalCount: 1, months: [{ month: "09", count: 1 }] },
        ],
      },
    }

    const calls: { command: string }[] = []
    Object.assign(globalThis, {
      isTauri: true,
      __SHARD_CALLS__: calls,
      __TAURI_INTERNALS__: {
        invoke: async (command: string) => {
          calls.push({ command })
          if (command === "list_fragments") return structuredClone(state)
          if (command === "list_mind_maps") return []
          if (command === "list_csv_files") return []
          if (command === "list_library_tree") return structuredClone(tree)
          if (command === "migrate_legacy_notes") {
            return { tree: structuredClone(tree), migratedCount: 0 }
          }
          if (command === "sync_vault") return structuredClone(git)
          if (command === "checkpoint_vault") {
            return {
              status: "committed",
              changes: 3,
              reason: null,
              git: { ...git, status: "ready" },
            }
          }
          throw new Error(`Unhandled Tauri test command: ${command}`)
        },
      },
    })
  }, gitOverrides)
}

const statusBar = (page: Page) =>
  page.getByRole("contentinfo", { name: "状态栏" })

const calledCommands = (page: Page) =>
  page.evaluate(
    () =>
      (
        globalThis as typeof globalThis & {
          __SHARD_CALLS__?: { command: string }[]
        }
      ).__SHARD_CALLS__?.map((call) => call.command) ?? []
  )

test("桌面渲染状态栏，窄窗交还给底部标签", async ({ page }) => {
  await installStatusBarMock(page)
  await page.goto("/")
  const bar = statusBar(page)
  await expect(bar).toBeVisible()

  // 条带几何 = kiln 三级条带契约（compact 档 36px），自身零垂直 padding
  const geometry = await bar.evaluate((el) => {
    const style = getComputedStyle(el)
    const rect = el.getBoundingClientRect()
    return {
      height: Math.round(rect.height),
      left: Math.round(rect.left),
      paddingBottom: style.paddingBottom,
      paddingTop: style.paddingTop,
      width: Math.round(rect.width),
    }
  })
  expect(geometry).toEqual({
    height: 36,
    left: 0,
    paddingBottom: "0px",
    paddingTop: "0px",
    width: 1280,
  })

  await page.setViewportSize({ height: 720, width: 820 })
  await expect(bar).toBeHidden()
  await expect(
    page.getByRole("navigation", { name: "工作台", exact: true })
  ).toBeVisible()
})

test("侧栏折叠后状态栏仍横贯全宽", async ({ page }) => {
  await installStatusBarMock(page)
  await page.goto("/")
  await page.getByRole("button", { name: "折叠侧边栏" }).click()

  const bar = statusBar(page)
  await expect(bar).toBeVisible()
  const rect = await bar.evaluate((el) => {
    const box = el.getBoundingClientRect()
    return { left: Math.round(box.left), width: Math.round(box.width) }
  })
  expect(rect).toEqual({ left: 0, width: 1280 })
})

test("分支与提交号渲染，数字用等宽字形", async ({ page }) => {
  await installStatusBarMock(page, { branch: "feature/x", shortCommit: "1a2b3c4" })
  await page.goto("/")
  const summary = statusBar(page).getByText("feature/x · 1a2b3c4")
  await expect(summary).toBeVisible()
  expect(
    await summary.evaluate((el) => getComputedStyle(el).fontVariantNumeric)
  ).toContain("tabular-nums")
})

test("同步按钮调用 sync_vault，随后显示相对时间", async ({ page }) => {
  await installStatusBarMock(page)
  await page.goto("/")
  const bar = statusBar(page)
  await bar.getByRole("button", { name: "同步", exact: true }).click()

  await expect.poll(async () => await calledCommands(page)).toContain("sync_vault")
  await expect(bar.getByText("刚刚同步")).toBeVisible()
})

test("没有远端时同步禁用并给出徽章", async ({ page }) => {
  await installStatusBarMock(page, { hasRemote: false })
  await page.goto("/")
  const bar = statusBar(page)
  await expect(bar.getByText("未连接远端")).toBeVisible()
  await expect(
    bar.getByRole("button", { name: "同步", exact: true })
  ).toBeDisabled()
})

test("未启用 Git 时只留入口，不渲染 git 组", async ({ page }) => {
  await installStatusBarMock(page, { status: "no_git" })
  await page.goto("/")
  const bar = statusBar(page)
  await expect(bar.getByText("未启用 Git")).toBeVisible()
  await expect(
    bar.getByRole("button", { name: "同步", exact: true })
  ).toHaveCount(0)
})

test("未提交更改点击触发检查点提交", async ({ page }) => {
  await installStatusBarMock(page, { status: "dirty" })
  await page.goto("/")
  const bar = statusBar(page)
  await bar.getByText("未提交更改").click()

  await expect
    .poll(async () => await calledCommands(page))
    .toContain("checkpoint_vault")
  await expect(page.getByText("已提交 3 项变更")).toBeVisible()
})

test("落后/领先提交数以等宽数字呈现", async ({ page }) => {
  await installStatusBarMock(page, { ahead: 2, behind: 1 })
  await page.goto("/")
  const divergence = statusBar(page).getByText("↑2 ↓1")
  await expect(divergence).toBeVisible()
  expect(
    await divergence.evaluate((el) => getComputedStyle(el).fontVariantNumeric)
  ).toContain("tabular-nums")
})

test("Git 出错时给出危险徽章", async ({ page }) => {
  await installStatusBarMock(page, {
    error: "远端拒绝了推送",
    status: "error",
  })
  await page.goto("/")
  await expect(statusBar(page).getByText("Git 错误")).toBeVisible()
})

test("状态栏图标遵守 design.md 的小尺寸档", async ({ page }) => {
  await installStatusBarMock(page)
  await page.goto("/")
  const metrics = await statusBar(page).evaluate((el) =>
    Array.from(el.querySelectorAll("svg.lucide")).map((svg) => {
      const style = getComputedStyle(svg)
      return { stroke: style.strokeWidth, width: style.width }
    })
  )
  expect(metrics.length).toBeGreaterThan(0)
  for (const metric of metrics) {
    expect(metric.width).toBe("14px")
    expect(metric.stroke).toBe("1.75px")
  }
})

test("更多菜单仍是设置的焦点归还点", async ({ page }) => {
  await installStatusBarMock(page)
  await page.goto("/")
  const trigger = page.locator("[data-shard-utility-menu-trigger]:visible")
  await trigger.click()
  await page.getByRole("menuitem", { name: "设置" }).click()
  await expect(page.getByRole("dialog")).toBeVisible()

  await page.keyboard.press("Escape")
  await expect(page.getByRole("dialog")).toBeHidden()
  await expect(trigger).toBeFocused()
})
