import { devices, expect, test, type Page } from "@playwright/test"

// 手机网页（iPhone 宽度、触屏、网页传输）的外壳与资料库形态。
// 网页端走 HTTP：这里不装 Tauri 替身，而是在页面里改写 fetch，把 /api/* 接到一个内存里的假服务端，
// 于是 isWebRuntime() 为真、<html data-runtime="web">，与真机上的网页版走同一条代码路径。

const iPhone = devices["iPhone 13"]
test.use({
  viewport: iPhone.viewport,
  userAgent: iPhone.userAgent,
  deviceScaleFactor: iPhone.deviceScaleFactor,
  isMobile: true,
  hasTouch: true,
  locale: "zh-CN",
})

async function installWebServerMock(page: Page) {
  await page.addInitScript(() => {
    const now = "2026-10-26T12:00:00.000Z"
    const fragment = (id: string, path: string, content: string, tags: string[]) => ({
      id,
      path,
      content,
      tags,
      fileSha: `${id}-sha`,
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
    })
    const state = {
      vaultPath: "shard://test/mobile",
      fragments: [
        fragment("fragment-1", "fragments/2026/10/fragment-1.md", "早上沿江骑了 32 公里。#骑行\n", ["inbox", "骑行"]),
        fragment("note-book", "notes/读书/置身事内.md", "# 置身事内\n\n兰小欢，2021。\n\n## 要点\n\n- 地方政府是经济发展的重要参与者\n- 土地财政与土地金融\n\n#读书\n", ["inbox", "note", "读书"]),
        fragment("note-list", "notes/读书/书单.md", "# 书单\n\n今年读过和想读的书。\n", ["inbox", "note"]),
      ],
      git: { ahead: 0, behind: 0, branch: "main", error: null, hasRemote: false, shortCommit: "no git", status: "no_git" },
      lockbox: { configured: false, expiresAt: null, ttlSeconds: 900, unlocked: false },
    }
    const file = (name: string, size: number) => ({
      name,
      path: `notes/读书/${name}`,
      kind: "markdown",
      size,
      createdAt: "2026-10-01T12:00:00.000Z",
      modifiedAt: "2026-10-26T12:00:00.000Z",
    })
    const tree = {
      entries: [{
        name: "读书",
        path: "notes/读书",
        kind: "directory",
        size: 0,
        createdAt: "2026-10-01T12:00:00.000Z",
        modifiedAt: "2026-10-26T12:00:00.000Z",
        children: [file("书单.md", 316), file("置身事内.md", 474)],
      }],
      assets: [],
      trashEntries: [],
      fragmentTrashEntries: [],
      fragmentStream: { totalCount: 1, years: [] },
    }
    const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T
    const handlers: Record<string, (args: Record<string, unknown>) => unknown> = {
      list_fragments: () => clone(state),
      list_library_tree: () => clone(tree),
      list_mind_maps: () => [],
      list_csv_files: () => [],
      list_markdown_dialect_migration: () => ({ dialect: 2, sources: [] }),
      update_fragment: (args) => {
        const target = state.fragments.find((item) => item.id === args.id)
        if (!target) throw new Error("not found")
        target.content = String(args.content ?? target.content)
        return clone(target)
      },
    }
    const unknownCommands: string[] = []
    Object.assign(window, { __SHARD_WEB_UNKNOWN__: unknownCommands })
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
    const realFetch = window.fetch.bind(window)
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href)
      if (!url.pathname.startsWith("/api/")) return realFetch(input, init)
      if (url.pathname === "/api/auth/state") {
        return json({ authenticated: true, setupRequired: false, stepUpValid: false, vaultId: state.vaultPath })
      }
      // 实时通道：一直不结束的事件流，状态栏保持「已连接」。
      if (url.pathname === "/api/events") {
        return new Response(new ReadableStream({ start() {} }), { headers: { "content-type": "text/event-stream" } })
      }
      if (url.pathname.startsWith("/api/rpc/")) {
        const command = decodeURIComponent(url.pathname.slice("/api/rpc/".length))
        const handler = handlers[command]
        if (!handler) {
          unknownCommands.push(command)
          return json({ code: "UNKNOWN", message: `测试替身没有实现 ${command}` }, 400)
        }
        const args = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {}
        try { return json(handler(args)) } catch (error) { return json({ message: String(error) }, 400) }
      }
      return json({ message: "not found" }, 404)
    }
  })
}

async function openReadingFolder(page: Page) {
  await page.goto("/")
  await expect(page.locator("html")).toHaveAttribute("data-runtime", "web")
  await page.getByRole("navigation", { name: "工作台" }).getByRole("button", { name: "资料库" }).tap()
  const viewer = page.getByRole("article", { name: "资料库查看器" })
  await expect(viewer).toBeVisible()
  await page.getByRole("button", { name: "返回资料库目录", exact: true }).tap()
  await page.getByRole("complementary", { name: "资料库目录" }).getByRole("button", { name: "读书", exact: true }).tap()
  const list = viewer.getByRole("region", { name: "notes/读书 目录列表", exact: true })
  await expect(list).toBeVisible()
  return { list, viewer }
}

test.beforeEach(async ({ page }) => {
  await installWebServerMock(page)
})

test("目录列表在手机宽度收成单列卡片，不横向溢出，「…」在屏内", async ({ page }) => {
  const { list } = await openReadingFolder(page)

  await expect(list).toHaveAttribute("data-layout", "cards")
  await expect(list.locator("thead")).toHaveCount(0)
  const overflow = await list.evaluate((element) => ({
    list: element.scrollWidth - element.clientWidth,
    page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  }))
  expect(overflow).toEqual({ list: 0, page: 0 })

  const row = list.locator('tr[data-path="notes/读书/书单.md"]')
  await expect(row).toContainText("书单")
  await expect(row).toContainText(/Markdown · \d{4}\/\d{2}\/\d{2}/)
  expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(56)

  const menu = page.getByRole("button", { name: "书单.md 操作", exact: true })
  await expect(menu).toBeVisible()
  const box = (await menu.boundingBox())!
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width)
  await menu.tap()
  await expect(page.getByRole("menuitem", { name: "移动到…" })).toBeVisible()
})

test("打开笔记后标题栏只有一个返回，逐级回到目录与目录树", async ({ page }) => {
  const { viewer } = await openReadingFolder(page)
  await page.getByRole("button", { name: "打开文件 置身事内.md", exact: true }).tap()
  await expect(viewer.locator('[data-shard-editor="library:note-book"]')).toBeVisible()

  const backs = viewer.locator('button[aria-label^="返回"]')
  await expect(backs).toHaveCount(1)
  await expect(backs).toHaveAccessibleName("返回所在目录")

  await backs.tap()
  await expect(viewer.getByRole("region", { name: "notes/读书 目录列表", exact: true })).toBeVisible()
  await expect(viewer.locator('button[aria-label^="返回"]')).toHaveCount(1)
  await page.getByRole("button", { name: "返回资料库目录", exact: true }).tap()
  await expect(page.getByRole("complementary", { name: "资料库目录" })).toBeVisible()
})

test("底部导航只有一行：没有品牌行与单选项二级页签，「更多」与空间页签同高", async ({ page }) => {
  await page.goto("/")
  const footer = page.locator("footer").filter({ has: page.getByRole("navigation", { name: "工作台" }) })
  await expect(footer).toBeVisible()
  await expect(footer).not.toContainText("Shard")
  await expect(page.getByRole("navigation", { name: "碎片视图" })).toHaveCount(0)

  const nav = footer.getByRole("navigation", { name: "工作台" })
  await expect(nav.getByRole("button")).toHaveCount(3)
  const heights = await nav.getByRole("button").evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().height))
  expect(new Set(heights).size).toBe(1)
  expect(heights[0]).toBeGreaterThanOrEqual(44)
  expect((await footer.boundingBox())!.height).toBeLessThanOrEqual(heights[0] + 2)

  await nav.getByRole("button", { name: "更多操作" }).tap()
  await expect(page.getByRole("menuitem", { name: "搜索笔记" })).toBeVisible()
})

test("触屏打开笔记不抢焦点，点正文才进入编辑；编辑区字号不小于 16px", async ({ page }) => {
  const { viewer } = await openReadingFolder(page)
  await page.getByRole("button", { name: "打开文件 置身事内.md", exact: true }).tap()
  const editor = viewer.locator('[data-shard-editor="library:note-book"] .ProseMirror')
  await expect(editor).toContainText("土地财政与土地金融")

  // 等编辑器挂载后的自动聚焦时机过去，再确认焦点没有进编辑区（真机上就是不弹键盘）。
  await page.waitForTimeout(300)
  expect(await page.evaluate(() => document.activeElement?.closest(".ProseMirror") !== null)).toBe(false)

  await editor.getByText("土地财政与土地金融").tap()
  await expect(editor).toBeFocused()
  expect(await editor.evaluate((element) => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(16)
})

test("触屏长按目录条目打开同一个菜单，不会打开条目，抬手后菜单仍在", async ({ page }) => {
  await openReadingFolder(page)
  const row = page.getByRole("button", { name: "打开文件 书单.md", exact: true })
  const box = (await row.boundingBox())!
  const cdp = await page.context().newCDPSession(page)
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: box.x + 40, y: box.y + box.height / 2 }] })
  await page.waitForTimeout(700)
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })

  const menu = page.getByRole("menu", { name: "文件操作" })
  await expect(menu).toBeVisible()
  await page.waitForTimeout(300)
  await expect(menu).toBeVisible()
  await expect(menu.getByRole("menuitem", { name: "移动到…" })).toBeVisible()
  await expect(page.getByRole("region", { name: "notes/读书 目录列表", exact: true })).toBeVisible()
})

test("软键盘弹出时外壳收缩到可视区、底部导航让位，光标留在键盘上方", async ({ page }) => {
  const { viewer } = await openReadingFolder(page)
  await page.getByRole("button", { name: "打开文件 置身事内.md", exact: true }).tap()
  const editor = viewer.locator('[data-shard-editor="library:note-book"] .ProseMirror')
  await editor.getByText("#读书").tap()
  await expect(editor).toBeFocused()

  // Chromium 没有软键盘：把 visualViewport 高度改成键盘弹出后的可视高度并派发 resize。
  const visible = 364
  await page.evaluate((height) => {
    Object.defineProperty(window.visualViewport!, "height", { configurable: true, get: () => height })
    window.visualViewport!.dispatchEvent(new Event("resize"))
  }, visible)
  await expect(page.locator("html")).toHaveAttribute("data-keyboard-open", "true")
  await expect(page.getByRole("navigation", { name: "工作台" })).toBeHidden()
  await expect.poll(() => viewer.evaluate((element) => Math.round(element.getBoundingClientRect().bottom))).toBeLessThanOrEqual(visible)
  await expect.poll(() => page.evaluate(() => {
    const selection = getSelection()
    return selection && selection.rangeCount ? selection.getRangeAt(0).getBoundingClientRect().bottom : Infinity
  })).toBeLessThanOrEqual(visible)

  await page.evaluate(() => {
    delete (window.visualViewport as unknown as { height?: number }).height
    window.visualViewport!.dispatchEvent(new Event("resize"))
  })
  await expect(page.locator("html")).not.toHaveAttribute("data-keyboard-open", "true")
  await expect(page.getByRole("navigation", { name: "工作台" })).toBeVisible()
})

test.afterEach(async ({ page }) => {
  // 替身没实现的命令要么补上，要么说明页面调了不该调的接口。
  expect(await page.evaluate(() => (window as unknown as { __SHARD_WEB_UNKNOWN__?: string[] }).__SHARD_WEB_UNKNOWN__ ?? [])).toEqual([])
})
