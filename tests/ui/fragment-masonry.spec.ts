import { mkdirSync, writeFileSync } from "node:fs"

import { expect, test, type Page } from "@playwright/test"

import { fillEditor, readEditor, readEditorSnapshot, selectEditorText } from "./editor-helpers"
import { applyFragmentTag, openFragmentFilters } from "./fragment-filter-helpers"
import { selectOption } from "./select-helpers"
import { installSearchIpcMock } from "./search-ipc-mock"

const fragmentIds = Array.from({ length: 18 }, (_, index) => `masonry-${index}`)

async function installMasonryMock(page: Page, count = 18) {
  await installSearchIpcMock(page)
  await page.addInitScript((count: number) => {
    const longLengths = new Map([[0, 42], [2, 64], [4, 38]])
    const fragments = Array.from({ length: count }, (_, index) => {
      const createdAt = index === 0
        ? "2026-01-01T08:00:00.000Z"
        : new Date(Date.UTC(2026, 8, 7, 12, 0, -index)).toISOString()
      const paragraphs = longLengths.get(index)
      return {
        id: `masonry-${index}`,
        kind: "fragment",
        content: paragraphs
          ? Array.from({ length: paragraphs }, (_, line) =>
            `长文 ${index} 第 ${line + 1} 段：记录观察和后续行动，保持完整正文。`
          ).join("\n\n")
          : index === 17 ? "瀑布定位目标：最后一张短卡。" : `短卡 ${index}：待办与观察。`,
        createdAt,
        updatedAt: createdAt,
        tags: ["inbox", index % 2 === 0 ? "长短混排" : "短卡"],
        category: null,
        path: `fragments/2026/09/masonry-${index}.md`,
        gitStatus: "committed",
        error: null,
        archived: false,
        lockbox: false,
        pinned: index === 0,
        related: [],
      }
    }).reverse()
    const git = {
      branch: "main", shortCommit: "abc1234", hasRemote: false,
      status: "ready", error: null, ahead: 0, behind: 0,
    }
    const tree = {
      entries: [], assets: [], trashEntries: [],
      fragmentTrashEntries: [],
      fragmentStream: { totalCount: fragments.length, years: [] },
    }
    const calls: string[] = []
    Object.assign(globalThis, {
      isTauri: true,
      __SHARD_MASONRY_CALLS__: calls,
      __TAURI_INTERNALS__: {
        invoke: async (command: string) => {
          calls.push(command)
          if (command === "list_fragments") return structuredClone({
            vaultPath: "/tmp/shard-masonry-ui-mock",
            fragments,
            git,
            lockbox: {
              configured: false, unlocked: false, expiresAt: null, ttlSeconds: 900,
            },
          })
          if (command === "list_library_tree") return structuredClone(tree)
          if (command === "read_property_registry") {
            return { registry: { version: 1, properties: {} }, sha: "property-registry-empty" }
          }
          if (command === "migrate_legacy_notes") {
            return { tree: structuredClone(tree), migratedCount: 0 }
          }
          if (command === "list_mind_maps" || command === "list_csv_files") return []
          if (command === "sync_vault") return structuredClone(git)
          throw new Error(`Unexpected Tauri command in masonry test: ${command}`)
        },
      },
    })
  }, count)
}

async function openFragmentStream(page: Page) {
  await page.getByRole("button", { name: "碎片", exact: true }).click()
  await expect(page.locator(".shard-timeline-item")).toHaveCount(fragmentIds.length)
}

async function readLayout(page: Page) {
  return page.locator(".shard-timeline-layout").evaluate((element) => {
    const layout = element.getBoundingClientRect()
    const style = getComputedStyle(element)
    return {
      width: layout.width,
      height: layout.height,
      columns: Number(element.getAttribute("data-columns")),
      gap: Number.parseFloat(style.columnGap) || 0,
      threshold: Number.parseFloat(getComputedStyle(document.documentElement).fontSize) * 48,
      cards: Array.from(element.querySelectorAll<HTMLElement>(".shard-timeline-item"))
        .map((item) => {
          const box = item.getBoundingClientRect()
          return {
            id: item.querySelector("[data-shard-fragment-id]")?.getAttribute("data-shard-fragment-id"),
            x: box.left - layout.left,
            y: box.top - layout.top,
            width: box.width,
            height: box.height,
          }
        }),
    }
  })
}

async function expectPackedLayout(page: Page, expectedIds = fragmentIds) {
  await expect.poll(async () => {
    const layout = await readLayout(page)
    return layout.cards.every((card) => card.width > 0 && card.height > 0)
      && layout.height >= Math.max(...layout.cards.map((card) => card.y + card.height)) - 1
  }).toBe(true)
  await expect(async () => {
    const layout = await readLayout(page)
    expect(layout.cards.map((card) => card.id)).toEqual(expectedIds)
    const bottoms = Array.from({ length: layout.columns }, () => 0)
    for (const card of layout.cards) {
      // 每个后续条目从当前最短列底部继续，避免按奇偶分列留下大片空洞。
      const shortest = Math.min(...bottoms)
      expect(Math.abs(card.y - shortest)).toBeLessThanOrEqual(1)
      const column = layout.columns === 1 || card.x < 1 ? 0 : 1
      expect(Math.abs(card.y - bottoms[column])).toBeLessThanOrEqual(1)
      expect(card.x).toBeGreaterThanOrEqual(-1)
      expect(card.x + card.width).toBeLessThanOrEqual(layout.width + 1)
      bottoms[column] = card.y + card.height + layout.gap
    }
    expect(Math.abs(layout.height - Math.max(...bottoms) + layout.gap)).toBeLessThanOrEqual(1)
    for (let first = 0; first < layout.cards.length; first += 1) {
      for (let second = first + 1; second < layout.cards.length; second += 1) {
        const a = layout.cards[first]
        const b = layout.cards[second]
        const separated = a.x + a.width <= b.x + 1 || b.x + b.width <= a.x + 1
          || a.y + a.height <= b.y + 1 || b.y + b.height <= a.y + 1
        expect(separated, `${a.id} overlaps ${b.id}`).toBe(true)
      }
    }
  }).toPass()
}

async function readComposerCardGeometry(page: Page) {
  return page.evaluate(() => {
    const composer = document.querySelector('[data-shard-editor="composer"]')!.closest<HTMLElement>(".shard-content-measure")!
    const card = document.querySelector<HTMLElement>(".shard-timeline-item")!
    const composerBox = composer.getBoundingClientRect()
    const cardBox = card.getBoundingClientRect()
    const viewport = card.closest<HTMLElement>('[data-slot="scroll-area-viewport"]')!
    return {
      composer: { top: composerBox.top, bottom: composerBox.bottom, left: composerBox.left, right: composerBox.right },
      firstCard: { top: cardBox.top, left: cardBox.left, right: cardBox.right },
      gap: cardBox.top - composerBox.bottom,
      composerBottomPadding: Number.parseFloat(getComputedStyle(composer.parentElement!).paddingBottom),
      viewportScroll: viewport.scrollTop,
      documentScroll: document.scrollingElement?.scrollTop ?? 0,
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: innerWidth,
    }
  })
}

async function expectQuietFragmentHome(page: Page) {
  for (const name of ["筛选标签", "筛选时间", "只看置顶", "搜索碎片", "筛选碎片", "多选碎片", "多选", "清除筛选"]) {
    await expect(page.getByRole("button", { name, exact: true })).toHaveCount(0)
  }
  await expect(page.getByRole("region", { name: "当前碎片筛选", exact: true })).toHaveCount(0)
  await expect(page.getByRole("checkbox", { name: "只看置顶", exact: true })).toHaveCount(0)
  await expect(page.locator(".shard-timeline-item")).toHaveCount(fragmentIds.length)
  await expect.poll(async () => (await readComposerCardGeometry(page)).gap).toBeGreaterThan(0)
  const geometry = await readComposerCardGeometry(page)
  expect(geometry.gap).toBeCloseTo(geometry.composerBottomPadding, 1)
  expect(geometry.gap).toBeLessThanOrEqual(24)
  expect(geometry.firstCard.left).toBeCloseTo(geometry.composer.left, 1)
  expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.viewportWidth)
  expect(geometry.documentScroll).toBe(0)
  return geometry
}

async function readFilterDialogGeometry(page: Page) {
  const dialog = page.getByRole("dialog", { name: "筛选碎片", exact: true })
  return dialog.evaluate(async element => {
    await document.fonts.ready
    await Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => undefined)))
    const bounds = element.getBoundingClientRect()
    const styles = getComputedStyle(element)
    const controls = Array.from(element.querySelectorAll<HTMLElement>('[data-slot="select-trigger"], button'))
      .filter(control => control.matches('[data-slot="select-trigger"]') || ["取消", "查看碎片"].includes(control.textContent?.trim() ?? ""))
      .map(control => {
        const box = control.getBoundingClientRect()
        const style = getComputedStyle(control)
        return {
          label: control.getAttribute("aria-label") || control.textContent?.trim(),
          kind: control.getAttribute("data-slot") === "select-trigger" ? "select" : "button",
          left: box.left, right: box.right, top: box.top, bottom: box.bottom,
          height: box.height, width: box.width,
          radius: style.borderRadius, font: style.fontFamily,
        }
      })
    return {
      bounds: { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom, height: bounds.height },
      viewport: { width: innerWidth, height: innerHeight },
      radius: styles.borderRadius,
      font: styles.fontFamily,
      fontToken: styles.getPropertyValue("--font-sans").replace(/\s+/gu, " ").trim(),
      notoLoaded: Array.from(document.fonts).some(font => font.family.includes("Noto Sans SC") && font.status === "loaded"),
      controls,
    }
  })
}

function expectFilterDialogGeometry(geometry: Awaited<ReturnType<typeof readFilterDialogGeometry>>) {
  expect(geometry.bounds.left).toBeGreaterThanOrEqual(8)
  expect(geometry.bounds.right).toBeLessThanOrEqual(geometry.viewport.width - 8)
  expect(geometry.bounds.top).toBeGreaterThanOrEqual(8)
  expect(geometry.bounds.bottom).toBeLessThanOrEqual(geometry.viewport.height - 8)
  expect(geometry.radius).toBe("6px")
  expect(geometry.font).toBe(geometry.fontToken)
  expect(geometry.font).toContain('"Noto Sans SC"')
  expect(geometry.notoLoaded).toBe(true)
  expect(geometry.controls).toHaveLength(6)
  for (const control of geometry.controls) {
    expect(control.radius).toBe("4px")
    expect(control.height).toBeCloseTo(control.kind === "select" ? 28 : 32, 1)
    expect(control.font).toBe(geometry.fontToken)
    expect(control.left).toBeGreaterThan(geometry.bounds.left)
    expect(control.right).toBeLessThan(geometry.bounds.right)
    expect(control.top).toBeGreaterThan(geometry.bounds.top)
    expect(control.bottom).toBeLessThan(geometry.bounds.bottom)
  }
  const selects = geometry.controls.filter(control => control.kind === "select")
  for (const select of selects.slice(1)) {
    expect(select.left).toBeCloseTo(selects[0].left, 1)
    expect(select.right).toBeCloseTo(selects[0].right, 1)
  }
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1800, height: 900 })
  await installMasonryMock(page)
  await page.goto("/")
})

test("默认碎片首页直接从 composer 接续卡片，没有常驻筛选和多选两排控件", async ({ page }) => {
  await openFragmentStream(page)
  const geometry = await expectQuietFragmentHome(page)
  mkdirSync("tests/evidence/fragments-separation", { recursive: true })
  writeFileSync("tests/evidence/fragments-separation/fragments-home-geometry.json", JSON.stringify(geometry, null, 2))
  await page.screenshot({ path: "tests/evidence/fragments-separation/fragments-home-simplified.png", animations: "disabled" })
})

test("搜索内组合筛选支持键盘、取消草稿和应用清除，首页只展示有效条件", async ({ page }) => {
  await openFragmentStream(page)
  const before = await expectQuietFragmentHome(page)
  let dialog = await openFragmentFilters(page)
  const tag = dialog.getByRole("combobox", { name: "标签", exact: true })
  await tag.press("Space")
  await expect(page.getByRole("option", { name: "#长短混排", exact: true })).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(dialog).toBeVisible()
  await expect(tag).toBeFocused()
  await tag.press("Space")
  await expect(page.getByRole("option", { name: "#长短混排", exact: true })).toBeVisible()
  await expect(page.getByRole("option", { name: "全部标签", exact: true })).toBeFocused()
  await page.keyboard.press("End")
  await expect(page.getByRole("option", { name: "#长短混排", exact: true })).toHaveAttribute("data-highlighted", "")
  await page.keyboard.press("Enter")
  await expect(tag).toContainText("#长短混排")
  await selectOption(dialog.getByRole("combobox", { name: "时间", exact: true }), "2026-01")
  await dialog.getByRole("checkbox", { name: "只看置顶", exact: true }).press("Space")
  await expect(dialog.getByRole("checkbox", { name: "只看置顶", exact: true })).toBeChecked()
  await page.keyboard.press("Escape")
  await expect(dialog).toHaveCount(0)
  await expect(page.getByRole("button", { name: "搜索内容", exact: true })).toBeFocused()

  dialog = await openFragmentFilters(page)
  await expect(dialog.getByRole("combobox", { name: "标签", exact: true })).toContainText("全部标签")
  await expect(dialog.getByRole("combobox", { name: "时间", exact: true })).toContainText("全部时间")
  await expect(dialog.getByRole("checkbox", { name: "只看置顶", exact: true })).not.toBeChecked()
  await selectOption(dialog.getByRole("combobox", { name: "标签", exact: true }), "长短混排")
  await selectOption(dialog.getByRole("combobox", { name: "时间", exact: true }), "2026-01")
  await dialog.getByRole("checkbox", { name: "只看置顶", exact: true }).press("Space")
  const dialogGeometry = await readFilterDialogGeometry(page)
  expectFilterDialogGeometry(dialogGeometry)
  mkdirSync("tests/evidence/fragments-separation", { recursive: true })
  await page.screenshot({ path: "tests/evidence/fragments-separation/fragments-filter-dialog.png", animations: "disabled" })
  await dialog.getByRole("button", { name: "查看碎片", exact: true }).press("Enter")
  await expect(dialog).toHaveCount(0)
  const summary = page.getByRole("region", { name: "当前碎片筛选", exact: true })
  await expect(summary).toContainText("#长短混排 · 2026-01 · 只看置顶")
  await expect(page.locator(".shard-timeline-item")).toHaveCount(1)
  await expect(page.locator('[data-shard-fragment-id="masonry-0"]')).toBeVisible()
  const active = await readComposerCardGeometry(page)
  expect(active.composer.top).toBe(before.composer.top)
  expect(active.composer.bottom).toBe(before.composer.bottom)
  const summaryBounds = (await summary.boundingBox())!
  expect(active.gap).toBeCloseTo(before.gap + summaryBounds.height, 1)
  await page.screenshot({ path: "tests/evidence/fragments-separation/fragments-filter-active.png", animations: "disabled" })

  await summary.getByRole("button", { name: "清除筛选", exact: true }).click()
  const cleared = await expectQuietFragmentHome(page)
  expect(cleared.composer).toEqual(before.composer)
  expect(cleared.gap).toBe(before.gap)
  await page.screenshot({ path: "tests/evidence/fragments-separation/fragments-filter-cleared.png", animations: "disabled" })
  writeFileSync("tests/evidence/fragments-separation/fragments-filter-geometry.json", JSON.stringify({ dialog: dialogGeometry, before, active, cleared }, null, 2))
})

test("窄窗低高度仍可从搜索打开筛选，弹层与下拉菜单不越界并保留键盘焦点", async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 520 })
  await openFragmentStream(page)
  const before = await expectQuietFragmentHome(page)
  const sidebarSearch = page.getByRole("button", { name: "搜索内容", exact: true })
  const composer = page.locator('[data-shard-editor="composer"] .ProseMirror')
  const returnsToSidebar = await sidebarSearch.isVisible()
  if (!returnsToSidebar) await composer.click()
  const dialog = await openFragmentFilters(page)
  const geometry = await readFilterDialogGeometry(page)
  expectFilterDialogGeometry(geometry)
  const tag = dialog.getByRole("combobox", { name: "标签", exact: true })
  await tag.press("Space")
  const popup = page.locator('[data-slot="select-content"][data-open]')
  await expect(popup).toBeVisible()
  const popupBounds = (await popup.boundingBox())!
  expect(popupBounds.x).toBeGreaterThanOrEqual(8)
  expect(popupBounds.x + popupBounds.width).toBeLessThanOrEqual(632)
  expect(popupBounds.y).toBeGreaterThanOrEqual(8)
  expect(popupBounds.y + popupBounds.height).toBeLessThanOrEqual(512)
  await page.keyboard.press("Escape")
  await expect(dialog).toBeVisible()
  await expect(tag).toBeFocused()
  mkdirSync("tests/evidence/fragments-separation", { recursive: true })
  await page.screenshot({ path: "tests/evidence/fragments-separation/fragments-filter-narrow.png", animations: "disabled" })
  await dialog.getByRole("button", { name: "取消", exact: true }).press("Enter")
  await expect(dialog).toHaveCount(0)
  if (returnsToSidebar) await expect(sidebarSearch).toBeFocused()
  else await expect(composer).toBeFocused()
  writeFileSync("tests/evidence/fragments-separation/fragments-filter-narrow-geometry.json", JSON.stringify({ before, dialog: geometry, popup: popupBounds }, null, 2))
})

test("碎片长短卡按实测最短列填充，置顶和时间顺序保留在同一 DOM 列表", async ({ page }) => {
  await openFragmentStream(page)
  await expect(page.locator(".shard-timeline-layout")).toHaveAttribute("data-columns", "2")
  await expectPackedLayout(page)
  const { cards } = await readLayout(page)
  expect(cards[0].height).toBeGreaterThan(cards[1].height * 8)
  // 第三张长卡应跟在右侧短卡后面，不能继续堆到已有长文的左列。
  expect(cards[2].x).toBe(cards[1].x)
  expect(cards[2].y).toBeLessThan(cards[0].height)
  await page.screenshot({ path: "tests/evidence/fragment-masonry-wide.png" })
})

test("列数跟随碎片可用容器宽度，侧栏折叠无需触发窗口 resize", async ({ page }) => {
  await page.setViewportSize({ width: 1050, height: 900 })
  await openFragmentStream(page)
  const layout = page.locator(".shard-timeline-layout")
  await expect(layout).toHaveAttribute("data-columns", "1")
  let geometry = await readLayout(page)
  expect(geometry.width).toBeLessThan(geometry.threshold)
  await expectPackedLayout(page)

  await page.getByRole("button", { name: "折叠侧边栏", exact: true }).click()
  await expect(layout).toHaveAttribute("data-columns", "2")
  geometry = await readLayout(page)
  expect(geometry.width).toBeGreaterThanOrEqual(geometry.threshold)
  expect(page.viewportSize()?.width).toBe(1050)
  await expectPackedLayout(page)

  await page.setViewportSize({ width: 760, height: 900 })
  await expect(layout).toHaveAttribute("data-columns", "1")
  await expectPackedLayout(page)
})

test("编辑中的卡片跨单双列切换保留同一编辑器、草稿和选区", async ({ page }) => {
  await openFragmentStream(page)
  const card = page.locator('[data-shard-fragment-id="masonry-1"]')
  await card.getByRole("button", { name: "片段操作", exact: true }).click()
  await page.getByRole("menuitem", { name: "编辑", exact: true }).click()
  const editorId = "fragment:masonry-1"
  const editor = page.locator(`[data-shard-editor="${editorId}"] .ProseMirror`)
  await expect(editor).toBeFocused()
  const initialHeight = (await card.boundingBox())!.height
  // 富文本序列化会去掉文末空段，草稿不以空行结尾，才能逐字比较往返结果。
  const draft = ["未保存的长文草稿", ...Array(22).fill("编辑期间宽度变化仍应保留正文。")].join("\n\n")
  await fillEditor(page, editorId, draft)
  // 不改变窗口，真实编辑内容变高后仍应由观察器重新排布相邻卡片。
  await expect.poll(async () => (await card.boundingBox())!.height)
    .toBeGreaterThan(initialHeight + 300)
  await selectEditorText(page, editorId, "保存的长")
  const originalSelection = await readEditorSnapshot(page, editorId)
  expect(originalSelection.selectionEnd - originalSelection.selectionStart).toBe(4)
  const originalEditor = await editor.elementHandle()
  expect(originalEditor).not.toBeNull()
  await expectPackedLayout(page)

  for (const width of [1050, 1800]) {
    await page.setViewportSize({ width, height: 900 })
    await expect(page.locator(".shard-timeline-layout"))
      .toHaveAttribute("data-columns", width === 1050 ? "1" : "2")
    expect(await originalEditor!.evaluate((element) => element.isConnected)).toBe(true)
    await expect(editor).toBeFocused()
    expect(await readEditor(page, editorId)).toBe(draft)
    expect(await readEditorSnapshot(page, editorId)).toEqual(originalSelection)
    await expectPackedLayout(page)
  }
  const calls = await page.evaluate(() => (
    globalThis as typeof globalThis & { __SHARD_MASONRY_CALLS__: string[] }
  ).__SHARD_MASONRY_CALLS__)
  expect(calls).not.toContain("update_fragment")
})

test("滚动阅读后跨单双列重排保持当前短卡的视口位置", async ({ page }) => {
  await openFragmentStream(page)
  await expectPackedLayout(page)
  const anchor = page.locator('[data-shard-fragment-id="masonry-6"]')
  await anchor.evaluate((element) => {
    const viewport = element.closest<HTMLElement>('[data-slot="scroll-area-viewport"]')!
    viewport.scrollTop += element.getBoundingClientRect().top - viewport.getBoundingClientRect().top + 12
  })
  const readOffset = () => anchor.evaluate((element) => {
    const viewport = element.closest<HTMLElement>('[data-slot="scroll-area-viewport"]')!
    return element.getBoundingClientRect().top - viewport.getBoundingClientRect().top
  })
  await expect.poll(async () => Math.abs((await readOffset()) + 12)).toBeLessThanOrEqual(1)
  const originalOffset = await readOffset()
  const documentScroll = await page.evaluate(() => document.scrollingElement?.scrollTop)
  const readReadingPosition = () => anchor.evaluate((element) => {
    const viewport = element.closest<HTMLElement>('[data-slot="scroll-area-viewport"]')!
    const container = element.closest<HTMLElement>(".shard-timeline-layout")!
    const viewportTop = viewport.getBoundingClientRect().top
    return {
      scrollTop: viewport.scrollTop,
      scrollHeight: viewport.scrollHeight,
      viewportHeight: viewport.clientHeight,
      viewportTop,
      anchorTop: element.getBoundingClientRect().top,
      containerTop: container.getBoundingClientRect().top,
      containerHeight: container.getBoundingClientRect().height,
      overlapping: Array.from(container.children).map((item) => ({
        id: (item as HTMLElement).dataset.timelineItemId,
        top: item.getBoundingClientRect().top,
        bottom: item.getBoundingClientRect().bottom,
      })).filter((item) => item.top <= viewportTop && item.bottom > viewportTop),
    }
  })
  for (const width of [1050, 1800]) {
    const before = await readReadingPosition()
    await page.setViewportSize({ width, height: 900 })
    await expect(page.locator(".shard-timeline-layout"))
      .toHaveAttribute("data-columns", width === 1050 ? "1" : "2")
    await expectPackedLayout(page)
    await test.info().attach(`reading-position-${width}`, {
      body: JSON.stringify({ before, after: await readReadingPosition() }, null, 2),
      contentType: "application/json",
    })
    await expect.poll(async () => Math.abs((await readOffset()) - originalOffset), {
      message: `窗口改为 ${width}px 后保留阅读锚点`,
    }).toBeLessThanOrEqual(1)
    expect(await page.evaluate(() => document.scrollingElement?.scrollTop)).toBe(documentScroll)
  }
})

test("标签过滤重新紧凑排版，搜索定位只滚动碎片流 viewport", async ({ page }) => {
  await openFragmentStream(page)
  const viewer = page.locator("[data-workspace-slot]")
  const viewerTop = (await viewer.boundingBox())!.y
  const documentScroll = await page.evaluate(() => document.scrollingElement?.scrollTop)
  await applyFragmentTag(page, "长短混排")
  await expect(page.locator(".shard-timeline-item")).toHaveCount(9)
  await expectPackedLayout(page, fragmentIds.filter((_, index) => index % 2 === 0))

  await page.keyboard.press("Control+k")
  const palette = page.getByRole("dialog", { name: "搜索", exact: true })
  const search = palette.getByRole("combobox", { name: "搜索内容" })
  await search.fill("瀑布定位目标")
  await expect(palette.getByRole("option")).toHaveCount(1)
  await search.press("Enter")
  await expect(palette).toHaveCount(0)
  const target = page.locator('[data-shard-fragment-id="masonry-17"]')
  await expect(target).toBeInViewport()
  await expect.poll(() => target.evaluate((element) => {
    const viewport = element.closest<HTMLElement>('[data-slot="scroll-area-viewport"]')!
    const card = element.getBoundingClientRect()
    const bounds = viewport.getBoundingClientRect()
    return viewport.scrollTop > 0 && card.top >= bounds.top - 1 && card.bottom <= bounds.bottom + 1
  })).toBe(true)
  expect(await page.evaluate(() => document.scrollingElement?.scrollTop)).toBe(documentScroll)
  expect((await viewer.boundingBox())!.y).toBe(viewerTop)
  expect(await viewer.evaluate((element) => element.scrollTop)).toBe(0)
})

test("搜索平滑定位期间上方内容异步增高后仍完成目标定位", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" })
  await openFragmentStream(page)
  await expectPackedLayout(page)
  const viewer = page.locator("[data-workspace-slot]")
  const viewerTop = (await viewer.boundingBox())!.y
  const documentScroll = await page.evaluate(() => document.scrollingElement?.scrollTop)
  await page.keyboard.press("Control+k")
  const palette = page.getByRole("dialog", { name: "搜索", exact: true })
  const search = palette.getByRole("combobox", { name: "搜索内容" })
  await search.fill("瀑布定位目标")
  await expect(palette.getByRole("option")).toHaveCount(1)

  await page.evaluate(() => {
    const started = performance.now()
    const samples: unknown[] = []
    Object.assign(globalThis, { __SHARD_MASONRY_NAV_SAMPLES__: samples })
    const sample = () => {
      const target = document.querySelector<HTMLElement>('[data-shard-fragment-id="masonry-17"]')!
      const viewport = target.closest<HTMLElement>('[data-slot="scroll-area-viewport"]')!
      const upstream = document.querySelector<HTMLElement>('[data-shard-fragment-id="masonry-0"]')!
        .closest<HTMLElement>(".shard-timeline-item")!
      samples.push({
        ms: Math.round(performance.now() - started), scrollTop: viewport.scrollTop,
        scrollHeight: viewport.scrollHeight, viewportHeight: viewport.clientHeight,
        targetTop: target.getBoundingClientRect().top, targetBottom: target.getBoundingClientRect().bottom,
        targetOffsetTop: target.parentElement!.offsetTop, viewportTop: viewport.getBoundingClientRect().top,
        upstreamHeight: upstream.getBoundingClientRect().height, upstreamPadding: upstream.style.paddingBottom,
        containerMinHeight: target.closest<HTMLElement>(".shard-timeline-layout")!.style.minHeight,
      })
    }
    sample()
    const sampling = window.setInterval(sample, 50)
    window.setTimeout(() => window.clearInterval(sampling), 2400)
    const growDuringNavigation = () => {
      const upstream = document.querySelector<HTMLElement>('[data-shard-fragment-id="masonry-0"]')!
        .closest<HTMLElement>(".shard-timeline-item")!
      const target = document.querySelector<HTMLElement>('[data-shard-fragment-id="masonry-17"]')!
      const viewport = target.closest<HTMLElement>('[data-slot="scroll-area-viewport"]')!
      const targetTop = target.getBoundingClientRect().top
      const viewportBottom = viewport.getBoundingClientRect().bottom
      if (viewport.scrollTop <= 0 || targetTop <= viewportBottom) {
        if (performance.now() - started < 2400) {
          window.requestAnimationFrame(growDuringNavigation)
        }
        return
      }
      Object.assign(globalThis, {
        __SHARD_MASONRY_ASYNC_GROWTH__: {
          scrollTop: viewport.scrollTop,
          targetTop,
          viewportBottom,
        },
      })
      // 仅模拟图片/异步正文加载造成的几何增长；搜索及定位使用真实产品链路。
      upstream.style.paddingBottom = "960px"
      upstream.dataset.simulatedAsyncContent = "loaded"
    }
    window.requestAnimationFrame(growDuringNavigation)
  })
  await search.press("Enter")
  await expect(palette).toHaveCount(0)
  const upstream = page.locator(".shard-timeline-item")
    .filter({ has: page.locator('[data-shard-fragment-id="masonry-0"]') })
  await expect(upstream).toHaveAttribute("data-simulated-async-content", "loaded")
  const duringGrowth = await page.evaluate(() => (
    globalThis as typeof globalThis & {
      __SHARD_MASONRY_ASYNC_GROWTH__: {
        scrollTop: number; targetTop: number; viewportBottom: number
      }
    }
  ).__SHARD_MASONRY_ASYNC_GROWTH__)
  expect(duringGrowth.scrollTop).toBeGreaterThan(0)
  expect(duringGrowth.targetTop).toBeGreaterThan(duringGrowth.viewportBottom)
  await expectPackedLayout(page)

  const target = page.locator('[data-shard-fragment-id="masonry-17"]')
  await expect(target).toHaveClass(/shard-fragment-card-highlight/)
  try {
    await expect.poll(() => target.evaluate((element) => {
      const viewport = element.closest<HTMLElement>('[data-slot="scroll-area-viewport"]')!
      const card = element.getBoundingClientRect()
      const bounds = viewport.getBoundingClientRect()
      return card.top >= bounds.top - 1 && card.bottom <= bounds.bottom + 1
    })).toBe(true)
  } finally {
    await test.info().attach("navigation-during-async-growth", {
      body: JSON.stringify(await page.evaluate(() => (
        globalThis as typeof globalThis & { __SHARD_MASONRY_NAV_SAMPLES__: unknown[] }
      ).__SHARD_MASONRY_NAV_SAMPLES__), null, 2),
      contentType: "application/json",
    })
  }
  expect(await page.evaluate(() => document.scrollingElement?.scrollTop)).toBe(documentScroll)
  expect((await viewer.boundingBox())!.y).toBe(viewerTop)
  expect(await viewer.evaluate((element) => element.scrollTop)).toBe(0)
})

test("完整碎片流渐进渲染，搜索可定位第 80 条并保持 composer 在原位", async ({ page }) => {
  await installMasonryMock(page, 80)
  await page.reload()
  await expect(page.locator(".shard-timeline-item")).toHaveCount(40)
  const composer = page.locator('[data-shard-editor="composer"]')
  const composerTop = (await composer.boundingBox())!.y
  const documentScroll = await page.evaluate(() => document.scrollingElement?.scrollTop)
  await page.keyboard.press("Control+k")
  const palette = page.getByRole("dialog", { name: "搜索", exact: true })
  const search = palette.getByRole("combobox", { name: "搜索内容" })
  await search.fill("短卡 79")
  await expect(palette.getByRole("option")).toHaveCount(1)
  await search.press("Enter")
  await expect(palette).toHaveCount(0)
  const target = page.locator('[data-shard-fragment-id="masonry-79"]')
  await expect(target).toHaveClass(/shard-fragment-card-highlight/)
  await expect(target).toBeInViewport()
  await expect(page.locator(".shard-timeline-item")).toHaveCount(80)
  expect((await composer.boundingBox())!.y).toBe(composerTop)
  expect(await page.evaluate(() => document.scrollingElement?.scrollTop)).toBe(documentScroll)
})

test("切换资料库再返回碎片时恢复筛选与阅读位置", async ({ page }) => {
  await openFragmentStream(page)
  await applyFragmentTag(page, "长短混排")
  await expectPackedLayout(page, fragmentIds.filter((_, index) => index % 2 === 0))
  const anchor = page.locator('[data-shard-fragment-id="masonry-6"]')
  await anchor.evaluate(element => {
    const viewport = element.closest<HTMLElement>('[data-slot="scroll-area-viewport"]')!
    viewport.scrollTop += element.getBoundingClientRect().top - viewport.getBoundingClientRect().top
  })
  const readPosition = () => anchor.evaluate(element => {
    const viewport = element.closest<HTMLElement>('[data-slot="scroll-area-viewport"]')!
    return { scrollTop: viewport.scrollTop, offset: element.getBoundingClientRect().top - viewport.getBoundingClientRect().top }
  })
  await expect.poll(async () => (await readPosition()).scrollTop).toBeGreaterThan(0)
  const before = await readPosition()
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  await expect(page.getByRole("complementary", { name: "资料库目录" })).toBeVisible()
  await page.getByRole("button", { name: "碎片", exact: true }).click()
  await expect(page.getByRole("region", { name: "当前碎片筛选", exact: true })).toContainText("#长短混排")
  await expectPackedLayout(page, fragmentIds.filter((_, index) => index % 2 === 0))
  await expect.poll(async () => Math.abs((await readPosition()).offset - before.offset)).toBeLessThanOrEqual(1)
  await expect.poll(async () => Math.abs((await readPosition()).scrollTop - before.scrollTop)).toBeLessThanOrEqual(1)
})
