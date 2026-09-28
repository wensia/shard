import { expect, test, type Page } from "@playwright/test"

import { fillEditor, readEditorSnapshot, selectDocRange, selectEditorText } from "./editor-helpers"
import { installSearchIpcMock } from "./search-ipc-mock"

interface ScrollCounters {
  rootRenders: number
  masonryObserverStarts: number
  masonryObserverDisconnects: number
  cardMeasurements: number
  layoutMeasurements: number
  dateFormats: number
  scrollEvents: number
  composerCollapses: number
}

interface ScrollProbe {
  active: boolean
  counters: ScrollCounters
  start(): void
  stop(): ScrollCounters
  bump(key: keyof ScrollCounters): void
}

type ProbeWindow = Window & { __fragmentScrollProbe: ScrollProbe }

async function installScrollMock(page: Page) {
  await installSearchIpcMock(page)
  await page.addInitScript(() => {
    const fragments = Array.from({ length: 40 }, (_, index) => ({
      id: `scroll-${index}`,
      kind: "fragment",
      content: index === 39 ? "合成定位终点，只用于滚动回归。" : index < 6 && index % 2 === 0
        ? Array.from({ length: 42 }, (_, line) => `合成长卡 ${index} 第 ${line + 1} 段，观察滚动与排版。`).join("\n\n")
        : `合成短卡 ${index}，保持原始时间顺序。`,
      createdAt: new Date(Date.UTC(2026, 8, 7, 12, 0, -index)).toISOString(),
      updatedAt: "2026-09-07T12:00:00.000Z",
      tags: ["inbox", "滚动回归"], category: null,
      path: `fragments/2026/09/scroll-${index}.md`,
      gitStatus: "committed", error: null, archived: false, lockbox: false,
      pinned: false, related: [],
    }))
    const git = { branch: "main", shortCommit: "test", hasRemote: false, status: "ready", error: null, ahead: 0, behind: 0 }
    const tree = { entries: [], assets: [], trashEntries: [], fragmentTrashEntries: [], fragmentStream: { totalCount: 40, years: [] } }
    Object.assign(globalThis, {
      isTauri: true,
      __TAURI_INTERNALS__: { invoke: async (command: string) => {
        if (command === "list_fragments") return structuredClone({
          vaultPath: "/tmp/shard-scroll-regression", fragments, git,
          lockbox: { configured: false, unlocked: false, expiresAt: null, ttlSeconds: 900 },
        })
        if (command === "list_library_tree") return structuredClone(tree)
        if (command === "migrate_legacy_notes") return { tree: structuredClone(tree), migratedCount: 0 }
        if (command === "list_mind_maps" || command === "list_csv_files") return []
        if (command === "plugin:app|version") return "0.1.3"
        if (command === "sync_vault") return structuredClone(git)
        throw new Error(`Unexpected scroll regression command: ${command}`)
      } },
    })
  })
}

async function installScrollProbe(page: Page) {
  // Instrument only this browser response. Product code and its behavior stay intact.
  await page.route("**/src/workspace/workbench-shell.tsx*", async route => {
    const response = await route.fetch()
    const source = await response.text()
    const marker = "export function WorkbenchShell({ route, setRoute }) {"
    expect(source).toContain(marker)
    await route.fulfill({ response, body: source.replace(marker,
      `${marker}\nwindow.__fragmentScrollProbe.bump("rootRenders");`) })
  })
  await page.addInitScript(() => {
    const empty = (): ScrollCounters => ({ rootRenders: 0, masonryObserverStarts: 0,
      masonryObserverDisconnects: 0, cardMeasurements: 0, layoutMeasurements: 0,
      dateFormats: 0, scrollEvents: 0, composerCollapses: 0 })
    const probe: ScrollProbe = {
      active: false, counters: empty(),
      start() { this.counters = empty(); this.active = true },
      stop() { this.active = false; return { ...this.counters } },
      bump(key) { if (this.active) this.counters[key] += 1 },
    }
    ;(window as ProbeWindow).__fragmentScrollProbe = probe
    const rect = Element.prototype.getBoundingClientRect
    Element.prototype.getBoundingClientRect = function () {
      if (this.classList.contains("shard-timeline-item")) probe.bump("cardMeasurements")
      if (this.classList.contains("shard-timeline-layout")) probe.bump("layoutMeasurements")
      return rect.call(this)
    }
    const format = Date.prototype.toLocaleString
    Date.prototype.toLocaleString = function (...args) {
      probe.bump("dateFormats")
      return format.apply(this, args)
    }
    const NativeObserver = window.ResizeObserver
    window.ResizeObserver = class extends NativeObserver {
      masonry = false
      observe(target: Element, options?: ResizeObserverOptions) {
        if (target.classList.contains("shard-timeline-layout")) {
          this.masonry = true
          probe.bump("masonryObserverStarts")
        }
        super.observe(target, options)
      }
      disconnect() {
        if (this.masonry) probe.bump("masonryObserverDisconnects")
        super.disconnect()
      }
    }
    document.addEventListener("scroll", event => {
      const element = event.target
      if (element instanceof Element && element.matches('[data-slot="scroll-area-viewport"]')
        && element.querySelector(".shard-timeline-layout")) probe.bump("scrollEvents")
    }, true)
    new MutationObserver(records => {
      for (const record of records) {
        const element = record.target as Element
        if (record.oldValue === "true" && element.getAttribute("data-expanded") !== "true"
          && element.querySelector('[data-shard-editor="composer"]')) probe.bump("composerCollapses")
      }
    }).observe(document, { subtree: true, attributes: true, attributeOldValue: true, attributeFilter: ["data-expanded"] })
  })
}

const composerFrame = (page: Page) => page.locator('[data-shard-editor="composer"]').locator('xpath=ancestor::*[contains(@class,"codeMirrorViewport")]')
const viewport = (page: Page) => page.locator(".shard-timeline-layout").locator('xpath=ancestor::*[@data-slot="scroll-area-viewport"]')

async function settleGeometry(page: Page) {
  await page.evaluate(async () => {
    await document.fonts.ready
    const composer = document.querySelector('[data-shard-editor="composer"]')!.closest(".shard-content-measure")!
    const finiteAnimations = composer.getAnimations({ subtree: true }).filter(animation =>
      Number.isFinite(Number(animation.effect?.getComputedTiming().endTime))
    )
    await Promise.all(finiteAnimations.map(animation => animation.finished.catch(() => undefined)))
    // ResizeObserver callbacks and their scheduled measurement get separate frames.
    for (let frame = 0; frame < 4; frame++) await new Promise(requestAnimationFrame)
  })
}

async function wheelTimeline(page: Page, delta: number, count: number) {
  const bounds = (await viewport(page).boundingBox())!
  await page.mouse.move(bounds.x + Math.min(250, bounds.width / 2), bounds.y + Math.min(250, bounds.height / 2))
  for (let index = 0; index < count; index++) {
    await page.mouse.wheel(0, delta)
    await page.evaluate(() => new Promise(requestAnimationFrame))
  }
  await settleGeometry(page)
}

async function readGeometry(page: Page) {
  return page.evaluate(() => {
    const composer = document.querySelector('[data-shard-editor="composer"]')!.closest(".shard-content-measure")!
    const list = document.querySelector(".shard-timeline-layout")!
    const scroll = list.closest<HTMLElement>('[data-slot="scroll-area-viewport"]')!
    const rect = composer.getBoundingClientRect()
    return { composerTop: rect.top, composerHeight: rect.height, scrollTop: scroll.scrollTop,
      cardCount: list.children.length, documentTop: document.scrollingElement?.scrollTop ?? 0 }
  })
}

async function startProbe(page: Page) { await page.evaluate(() => (window as ProbeWindow).__fragmentScrollProbe.start()) }
async function stopProbe(page: Page) { return page.evaluate(() => (window as ProbeWindow).__fragmentScrollProbe.stop()) }

function expectNoScrollRebuild(counters: ScrollCounters) {
  expect(counters.scrollEvents).toBeGreaterThan(0)
  for (const key of ["rootRenders", "masonryObserverStarts", "masonryObserverDisconnects", "cardMeasurements", "layoutMeasurements", "dateFormats", "composerCollapses"] as const) {
    expect(counters[key], `${key} should stay idle during already-collapsed scrolling`).toBe(0)
  }
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1800, height: 900 })
  await installScrollMock(page)
  await installScrollProbe(page)
  await page.goto("/")
  await expect(page.locator(".shard-timeline-item")).toHaveCount(40)
  await expect(page.locator(".shard-timeline-layout")).toHaveAttribute("data-columns", "2")
  await settleGeometry(page)
})

test("输入框已折叠后的连续真实下滚和上滚不重渲染工作区或重建瀑布流", async ({ page }, testInfo) => {
  await wheelTimeline(page, 120, 2)
  await expect(composerFrame(page)).not.toHaveAttribute("data-expanded", "true")
  const before = await readGeometry(page)
  await startProbe(page)
  await wheelTimeline(page, 100, 12)
  const downward = await stopProbe(page)
  const afterDown = await readGeometry(page)
  expectNoScrollRebuild(downward)
  expect(afterDown.scrollTop).toBeGreaterThan(before.scrollTop + 1000)
  expect(afterDown.cardCount).toBe(40)
  expect(afterDown.composerTop).toBe(before.composerTop)
  expect(afterDown.composerHeight).toBe(before.composerHeight)
  expect(afterDown.documentTop).toBe(0)

  await startProbe(page)
  await wheelTimeline(page, -100, 12)
  const upward = await stopProbe(page)
  const afterUp = await readGeometry(page)
  expectNoScrollRebuild(upward)
  expect(afterUp.scrollTop).toBeLessThan(afterDown.scrollTop - 1000)
  expect(afterUp.cardCount).toBe(40)
  expect(afterUp.documentTop).toBe(0)
  await testInfo.attach("scroll-work-counts", { body: JSON.stringify({ downward, upward, before, afterDown, afterUp }, null, 2), contentType: "application/json" })
})

test("展开后下滚只折叠一次，重新展开可再次折叠且保留草稿与选区", async ({ page }, testInfo) => {
  const editor = page.locator('[data-shard-editor="composer"] .ProseMirror')
  const draft = "保留这段草稿，不要被折叠更改。\n第二行继续记录。"
  await editor.click()
  await fillEditor(page, "composer", draft)
  await selectEditorText(page, "composer", "草稿，不要被")
  await expect(composerFrame(page)).toHaveAttribute("data-expanded", "true")
  await settleGeometry(page)
  const expanded = await readGeometry(page)
  const original = await readEditorSnapshot(page, "composer")
  await startProbe(page)
  await wheelTimeline(page, 100, 8)
  const first = await stopProbe(page)
  await expect(composerFrame(page)).not.toHaveAttribute("data-expanded", "true")
  expect(first.composerCollapses).toBe(1)
  expect(first.rootRenders).toBe(0)
  expect((await readGeometry(page)).composerHeight).toBeLessThan(expanded.composerHeight)
  expect(await readEditorSnapshot(page, "composer")).toEqual(original)

  await startProbe(page)
  await wheelTimeline(page, 100, 8)
  const repeated = await stopProbe(page)
  expectNoScrollRebuild(repeated)
  expect(await readEditorSnapshot(page, "composer")).toEqual(original)

  await editor.click()
  await selectDocRange(page, "composer", original.selectionStart, original.selectionEnd)
  await expect(composerFrame(page)).toHaveAttribute("data-expanded", "true")
  await settleGeometry(page)
  await startProbe(page)
  await wheelTimeline(page, 100, 8)
  const reopened = await stopProbe(page)
  expect(reopened.composerCollapses).toBe(1)
  expect(reopened.rootRenders).toBe(0)
  await expect(composerFrame(page)).not.toHaveAttribute("data-expanded", "true")
  expect(await readEditorSnapshot(page, "composer")).toEqual(original)
  await testInfo.attach("composer-collapse-counts", { body: JSON.stringify({ first, repeated, reopened }, null, 2), contentType: "application/json" })
})

test("搜索定位远端碎片仅滚动时间线，不把程序导航当成用户下滚折叠输入框", async ({ page }, testInfo) => {
  await page.locator('[data-shard-editor="composer"] .ProseMirror').click()
  await fillEditor(page, "composer", "定位过程中保留的合成草稿")
  await selectEditorText(page, "composer", "过程中保留")
  await expect(composerFrame(page)).toHaveAttribute("data-expanded", "true")
  await settleGeometry(page)
  const before = await readGeometry(page)
  const original = await readEditorSnapshot(page, "composer")
  await page.keyboard.press("Control+k")
  const search = page.getByRole("combobox", { name: "搜索内容", exact: true })
  await search.fill("合成定位终点")
  await expect(page.getByRole("option")).toHaveCount(1)
  await startProbe(page)
  await search.press("Enter")
  const target = page.locator('[data-shard-fragment-id="scroll-39"]')
  await expect(target).toBeInViewport()
  await expect(target).toHaveClass(/shard-fragment-card-highlight/)
  await settleGeometry(page)
  const navigation = await stopProbe(page)
  const after = await readGeometry(page)
  expect(navigation.scrollEvents).toBeGreaterThan(0)
  expect(navigation.composerCollapses).toBe(0)
  expect(after.scrollTop).toBeGreaterThan(before.scrollTop + 1000)
  expect(after.composerTop).toBe(before.composerTop)
  expect(after.composerHeight).toBe(before.composerHeight)
  expect(after.documentTop).toBe(0)
  await expect(composerFrame(page)).toHaveAttribute("data-expanded", "true")
  expect(await readEditorSnapshot(page, "composer")).toEqual(original)
  await testInfo.attach("programmatic-navigation-counts", { body: JSON.stringify({ navigation, before, after }, null, 2), contentType: "application/json" })
})
