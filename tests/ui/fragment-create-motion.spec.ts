import { expect, test, type Page } from "@playwright/test"

import { fillEditor, focusEditor, readEditor } from "./editor-helpers"
import { applyFragmentTag } from "./fragment-filter-helpers"
import { installSearchIpcMock } from "./search-ipc-mock"

interface RecordedMotion {
  id: string
  element: Element
  animation: Animation
}

interface CreateMotionMock {
  calls: string[]
  animations: RecordedMotion[]
  mountedIds: string[]
  originalNodes: Map<string, Element>
  observeMounts: boolean
  settleCreate: (error?: string) => void
}

declare global {
  interface Window {
    __SHARD_CREATE_MOTION__: CreateMotionMock
  }
}

const createdId = "motion-created-1"
const newContent = "把刚刚的观察保存下来，让新碎片自然接入已有记录。"

async function installCreateMotionMock(page: Page, count: number, pinned: boolean) {
  await installSearchIpcMock(page)
  await page.addInitScript(({ count, pinned }) => {
    const fragments = Array.from({ length: count }, (_, index) => {
      const createdAt = new Date(Date.UTC(2026, 0, 1, 12, 0, -index)).toISOString()
      return {
        id: `motion-${index}`,
        kind: "fragment",
        content: Array.from({ length: index % 3 + 1 }, (_, line) =>
          `已有碎片 ${index} 的第 ${line + 1} 段，阅读位置与卡片内容应在保存期间保持稳定。`
        ).join("\n\n"),
        createdAt,
        updatedAt: createdAt,
        tags: ["inbox", index % 2 === 0 ? "motion-even" : "motion-odd"],
        category: null,
        path: `fragments/2026/01/motion-${index}.md`,
        gitStatus: "committed",
        error: null,
        archived: false,
        lockbox: false,
        pinned,
        related: [],
      }
    })
    const git = {
      branch: "main", shortCommit: "abc1234", hasRemote: false,
      status: "ready", error: null, ahead: 0, behind: 0,
    }
    const tree = () => ({
      entries: [], assets: [], trashEntries: [], fragmentTrashEntries: [],
      fragmentStream: { totalCount: fragments.length, years: [] },
    })
    const mock: CreateMotionMock = {
      calls: [], animations: [], mountedIds: [], originalNodes: new Map(),
      observeMounts: false,
      settleCreate: () => { throw new Error("No pending fragment creation") },
    }
    let createCount = 0

    // Keep the real browser animation, but pause its clock so geometry can be
    // inspected at start/midpoint/end without racing a 200 ms transition.
    const animate = Element.prototype.animate
    Element.prototype.animate = function (keyframes, options) {
      const animation = animate.call(this, keyframes, options)
      if (this.matches(".shard-timeline-item")) {
        animation.pause()
        animation.currentTime = 0
        mock.animations.push({
          id: this.getAttribute("data-timeline-item-id")!, element: this, animation,
        })
      }
      return animation
    }
    new MutationObserver((records) => {
      if (!mock.observeMounts) return
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (!(node instanceof Element)) continue
          const items = node.matches(".shard-timeline-item")
            ? [node] : Array.from(node.querySelectorAll(".shard-timeline-item"))
          for (const item of items) mock.mountedIds.push(item.getAttribute("data-timeline-item-id")!)
        }
      }
    }).observe(document, { childList: true, subtree: true })

    Object.assign(globalThis, {
      isTauri: true,
      __SHARD_CREATE_MOTION__: mock,
      __TAURI_INTERNALS__: {
        invoke: async (command: string, args: Record<string, unknown> = {}) => {
          mock.calls.push(command)
          if (command === "list_fragments") return structuredClone({
            vaultPath: "/tmp/shard-create-motion-ui-mock", fragments, git,
            lockbox: { configured: false, unlocked: false, expiresAt: null, ttlSeconds: 900 },
          })
          if (command === "list_library_tree") return tree()
          if (command === "migrate_legacy_notes") return { tree: tree(), migratedCount: 0 }
          if (command === "list_mind_maps" || command === "list_csv_files") return []
          if (command === "sync_vault") return structuredClone(git)
          if (command === "checkpoint_vault") {
            return { status: "no_changes", changes: 0, reason: null, git: structuredClone(git) }
          }
          if (command === "create_fragment") {
            const id = `motion-created-${++createCount}`
            return new Promise((resolve, reject) => {
              mock.settleCreate = (error) => {
                if (error) { reject(new Error(error)); return }
                const createdAt = new Date().toISOString()
                const created = {
                  id, kind: "fragment", content: String(args.content),
                  createdAt, updatedAt: createdAt, tags: args.tags as string[],
                  category: null, path: `fragments/2026/09/${id}.md`,
                  gitStatus: "saved", error: null, archived: false,
                  lockbox: false, pinned: false, related: [],
                }
                fragments.unshift(created)
                resolve(structuredClone(created))
              }
            })
          }
          throw new Error(`Unexpected Tauri command in create motion test: ${command}`)
        },
      },
    })
  }, { count, pinned })
}

async function settleLayout(page: Page) {
  await page.evaluate(async () => {
    await document.fonts.ready
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  })
}

async function openStream(page: Page, { width = 1800, count = 24, reducedMotion = false, pinned = false } = {}) {
  await page.setViewportSize({ width, height: width === 1050 ? 520 : 900 })
  await page.emulateMedia({ reducedMotion: reducedMotion ? "reduce" : "no-preference" })
  await installCreateMotionMock(page, count, pinned)
  await page.goto("/")
  await page.getByRole("button", { name: "碎片", exact: true }).click()
  await expect(page.locator(".shard-timeline-item")).toHaveCount(Math.min(count, 40))
  await expect(page.locator('[data-shard-editor="composer"]')).toBeVisible()
  if (count > 0) {
    await expect(page.locator(".shard-timeline-layout"))
      .toHaveAttribute("data-columns", width === 1050 ? "1" : "2")
  }
  await settleLayout(page)
  expect(await motionIds(page)).toEqual([])
  await page.evaluate(() => {
    const mock = window.__SHARD_CREATE_MOTION__
    mock.originalNodes = new Map(Array.from(document.querySelectorAll(".shard-timeline-item"))
      .map((element) => [element.getAttribute("data-timeline-item-id")!, element]))
    mock.observeMounts = true
  })
}

async function motionIds(page: Page) {
  return page.evaluate(() => window.__SHARD_CREATE_MOTION__.animations.map(({ id }) => id))
}

async function readLifecycle(page: Page) {
  return page.evaluate(() => {
    const mock = window.__SHARD_CREATE_MOTION__
    return {
      mountedIds: [...mock.mountedIds],
      preserved: [...mock.originalNodes].every(([id, node]) => node.isConnected
        && document.querySelector(`[data-timeline-item-id="${id}"]`) === node),
      reloads: mock.calls.filter((command) => command === "list_fragments").length,
      creates: mock.calls.filter((command) => command === "create_fragment").length,
    }
  })
}

async function submitDraft(page: Page, content = newContent, expectedCreates = 1) {
  await fillEditor(page, "composer", content)
  await focusEditor(page, "composer")
  await expect(page.getByRole("button", { name: "保存片段", exact: true })).toBeEnabled()
  await page.keyboard.press("ControlOrMeta+Enter")
  await expect(page.getByRole("button", { name: "保存中", exact: true })).toBeDisabled()
  await expect.poll(async () => (await readLifecycle(page)).creates).toBe(expectedCreates)
}

async function resolveCreate(page: Page, error?: string) {
  await page.evaluate((error) => window.__SHARD_CREATE_MOTION__.settleCreate(error), error)
}

async function finishMotions(page: Page) {
  await page.evaluate(() => {
    for (const { animation } of window.__SHARD_CREATE_MOTION__.animations) {
      if (animation.playState !== "idle") animation.finish()
    }
  })
  await settleLayout(page)
}

async function seekMotions(page: Page, time: number) {
  await page.evaluate((time) => {
    for (const { animation } of window.__SHARD_CREATE_MOTION__.animations) {
      if (animation.playState !== "idle") animation.currentTime = time
    }
  }, time)
}

async function attachScreenshot(page: Page, name: string) {
  const path = test.info().outputPath(`${name}.png`)
  await page.screenshot({ path })
  await test.info().attach(name, { path, contentType: "image/png" })
}

async function readLayout(page: Page) {
  return page.locator(".shard-timeline-layout").evaluate((layout) => {
    const bounds = layout.getBoundingClientRect()
    const viewport = layout.closest<HTMLElement>('[data-slot="scroll-area-viewport"]')!
    return {
      width: bounds.width, height: bounds.height,
      gap: Number.parseFloat(getComputedStyle(layout).rowGap),
      columns: Number(layout.getAttribute("data-columns")),
      scrollTop: viewport.scrollTop,
      documentScroll: document.scrollingElement?.scrollTop ?? 0,
      cards: Array.from(layout.querySelectorAll<HTMLElement>(".shard-timeline-item")).map((element) => {
        const box = element.getBoundingClientRect()
        const style = getComputedStyle(element)
        return {
          id: element.dataset.timelineItemId!, x: box.left - bounds.left, y: box.top - bounds.top,
          width: box.width, height: box.height, opacity: Number(style.opacity), transform: style.transform,
        }
      }),
    }
  })
}

async function expectPackedLayout(page: Page) {
  await expect(async () => {
    const layout = await readLayout(page)
    const bottoms = Array.from({ length: layout.columns }, () => 0)
    for (const card of layout.cards) {
      expect(card.width).toBeGreaterThan(0)
      expect(card.height).toBeGreaterThan(0)
      const column = layout.columns === 1 || card.x < 1 ? 0 : 1
      expect(Math.abs(card.y - Math.min(...bottoms)), card.id).toBeLessThanOrEqual(1)
      expect(Math.abs(card.y - bottoms[column]), card.id).toBeLessThanOrEqual(1)
      expect(card.x).toBeGreaterThanOrEqual(-1)
      expect(card.x + card.width).toBeLessThanOrEqual(layout.width + 1)
      expect(card.opacity).toBe(1)
      bottoms[column] = card.y + card.height + layout.gap
    }
    expect(Math.abs(layout.height - Math.max(...bottoms) + layout.gap)).toBeLessThanOrEqual(1)
    expect(layout.documentScroll).toBe(0)
  }).toPass()
}

for (const width of [1050, 1800]) {
  test(`${width === 1050 ? "单列" : "双列"}保存保持旧卡，成功后新卡淡入且旧卡连续让位`, async ({ page }) => {
    await openStream(page, { width })
    await expectPackedLayout(page)
    const lifecycleBefore = await readLifecycle(page)
    await submitDraft(page)
    const pendingLayout = await readLayout(page)
    expect(pendingLayout.cards.map(({ id }) => id)).toEqual(Array.from({ length: 24 }, (_, index) => `motion-${index}`))
    expect(await readEditor(page, "composer")).toBe(newContent)
    expect(await readLifecycle(page)).toMatchObject({ mountedIds: [], preserved: true, creates: 1 })
    expect(await motionIds(page)).toEqual([])

    // A second shortcut while the write is pending must not enqueue another save.
    await page.keyboard.press("ControlOrMeta+Enter")
    expect((await readLifecycle(page)).creates).toBe(1)
    await resolveCreate(page)
    await expect(page.locator(`[data-timeline-item-id="${createdId}"]`)).toHaveCount(1)
    await expect.poll(() => motionIds(page)).toContain(createdId)
    await expect.poll(() => readEditor(page, "composer")).toBe("")

    const motion = await page.evaluate(() => window.__SHARD_CREATE_MOTION__.animations.map(({ id, animation }) => ({
      id,
      duration: animation.effect!.getTiming().duration,
      properties: [...new Set((animation.effect as KeyframeEffect).getKeyframes()
        .flatMap((frame) => Object.keys(frame))
        .filter((property) => !["offset", "computedOffset", "easing", "composite"].includes(property)))],
    })))
    expect(motion.filter(({ id }) => id === createdId)).toHaveLength(1)
    expect(motion.some(({ id }) => id.startsWith("motion-") && id !== createdId)).toBe(true)
    for (const animation of motion) {
      expect(animation.duration).toBe(200)
      expect(animation.properties.every((property) => ["transform", "opacity"].includes(property))).toBe(true)
    }

    const start = await readLayout(page)
    expect(start.cards.find(({ id }) => id === createdId)!.opacity).toBe(0)
    for (const id of motion.map(({ id }) => id).filter((id) => id !== createdId)) {
      const before = pendingLayout.cards.find((card) => card.id === id)!
      const current = start.cards.find((card) => card.id === id)!
      expect(Math.abs(current.x - before.x), `${id} starts at its old x`).toBeLessThanOrEqual(1)
      expect(Math.abs(current.y - before.y), `${id} starts at its old y`).toBeLessThanOrEqual(1)
    }

    await seekMotions(page, 100)
    const middle = await readLayout(page)
    const entering = middle.cards.find(({ id }) => id === createdId)!
    expect(entering.opacity).toBeGreaterThan(0)
    expect(entering.opacity).toBeLessThan(1)
    expect(middle.cards.some((card) => {
      const original = pendingLayout.cards.find(({ id }) => id === card.id)
      return original && (Math.abs(original.x - card.x) > 1 || Math.abs(original.y - card.y) > 1)
    })).toBe(true)
    await attachScreenshot(page, "fragment-create-midpoint")
    await finishMotions(page)
    await expectPackedLayout(page)
    await attachScreenshot(page, "fragment-create-finished")
    expect((await readLayout(page)).cards.map(({ id }) => id))
      .toEqual([createdId, ...pendingLayout.cards.map(({ id }) => id)])
    expect(await readLifecycle(page)).toEqual({
      mountedIds: [createdId], preserved: true, reloads: lifecycleBefore.reloads, creates: 1,
    })
  })
}

test("保存失败保留可编辑草稿，碎片流没有出现过临时卡片", async ({ page }) => {
  await openStream(page)
  const before = await readLifecycle(page)
  await submitDraft(page)
  await resolveCreate(page, "磁盘暂时不可写")
  await expect(page.locator('[data-sonner-toast][data-type="error"]').filter({ hasText: "碎片保存失败" })).toBeVisible()
  await expect(page.getByRole("button", { name: "保存片段", exact: true })).toBeEnabled()
  await expect(page.locator('[data-shard-editor="composer"] .ProseMirror')).toBeFocused()
  expect(await readEditor(page, "composer")).toBe(newContent)
  await expect(page.locator(".shard-timeline-item")).toHaveCount(24)
  expect(await readLifecycle(page)).toEqual({ mountedIds: [], preserved: true, reloads: before.reloads, creates: 1 })
  expect(await motionIds(page)).toEqual([])
})

test("减少动态效果时直接呈现稳定终态，仍仅挂载真实新卡", async ({ page }) => {
  await openStream(page, { reducedMotion: true })
  await submitDraft(page)
  await resolveCreate(page)
  await expect(page.locator(`[data-timeline-item-id="${createdId}"]`)).toHaveCount(1)
  await expect.poll(() => readEditor(page, "composer")).toBe("")
  await settleLayout(page)
  expect(await motionIds(page)).toEqual([])
  expect(await readLifecycle(page)).toMatchObject({ mountedIds: [createdId], preserved: true })
  await expectPackedLayout(page)
})

test("向下阅读时创建保持阅读锚点，离屏新卡不会将视口拉回顶部", async ({ page }) => {
  await openStream(page)
  await submitDraft(page)
  const anchor = page.locator('[data-timeline-item-id="motion-12"]')
  await anchor.evaluate((element) => {
    const viewport = element.closest<HTMLElement>('[data-slot="scroll-area-viewport"]')!
    viewport.scrollTop += element.getBoundingClientRect().top - viewport.getBoundingClientRect().top + 12
  })
  await settleLayout(page)
  const readOffset = () => anchor.evaluate((element) => {
    const viewport = element.closest<HTMLElement>('[data-slot="scroll-area-viewport"]')!
    return element.getBoundingClientRect().top - viewport.getBoundingClientRect().top
  })
  const before = await readOffset()
  expect(before).toBeCloseTo(-12, 0)
  await resolveCreate(page)
  await expect(page.locator(`[data-timeline-item-id="${createdId}"]`)).toHaveCount(1)
  await expect.poll(() => readEditor(page, "composer")).toBe("")
  await settleLayout(page)
  await finishMotions(page)
  expect(Math.abs(await readOffset() - before)).toBeLessThanOrEqual(1)
  const animations = await motionIds(page)
  expect(animations).not.toContain(createdId)
  expect(animations).not.toContain("motion-0")
  expect((await readLayout(page)).scrollTop).toBeGreaterThan(0)
  expect((await readLayout(page)).documentScroll).toBe(0)
  await expectPackedLayout(page)
})

test("空碎片流保存第一条也有入场过程，空态只在保存成功后消失", async ({ page }) => {
  await openStream(page, { count: 0 })
  const empty = page.getByText("还没有碎片，记下一点什么吧。", { exact: true })
  await expect(empty).toBeVisible()
  await submitDraft(page)
  await expect(empty).toBeVisible()
  await expect(page.locator(".shard-timeline-item")).toHaveCount(0)
  await resolveCreate(page)
  await expect(empty).toHaveCount(0)
  await expect.poll(() => motionIds(page)).toEqual([createdId])
  expect((await readLayout(page)).cards[0].opacity).toBe(0)
  await finishMotions(page)
  await expectPackedLayout(page)
  expect((await readLifecycle(page)).mountedIds).toEqual([createdId])
})

test("已有记录均置顶时，新卡接在置顶记录之后仍自然入场", async ({ page }) => {
  await openStream(page, { count: 2, pinned: true })
  await submitDraft(page)
  await resolveCreate(page)
  await expect.poll(() => motionIds(page)).toContain(createdId)
  expect((await readLayout(page)).cards.map(({ id }) => id)).toEqual(["motion-0", "motion-1", createdId])
  expect((await readLayout(page)).cards[2].opacity).toBe(0)
  await finishMotions(page)
  await expectPackedLayout(page)
  expect(await readLifecycle(page)).toMatchObject({ mountedIds: [createdId], preserved: true })
})

test("入场动画中搜索定位旧卡，取消位移动画后按最终卡片位置对齐", async ({ page }) => {
  await openStream(page)
  await submitDraft(page)
  await resolveCreate(page)
  await expect.poll(() => motionIds(page)).toContain("motion-1")
  await expect.poll(() => readEditor(page, "composer")).toBe("")
  await seekMotions(page, 100)
  const target = page.locator('[data-shard-fragment-id="motion-1"]')
  await expect(target).toBeInViewport()
  const composerTop = (await page.locator('[data-shard-editor="composer"]').boundingBox())!.y
  const moving = (await readLayout(page)).cards.find(({ id }) => id === "motion-1")!
  expect(moving.transform).not.toBe("none")

  await page.keyboard.press("Control+k")
  const palette = page.getByRole("dialog", { name: "搜索", exact: true })
  const search = palette.getByRole("combobox", { name: "搜索内容" })
  await search.fill("已有碎片 1 的")
  const result = palette.getByRole("option").filter({ hasText: "已有碎片 1 的" })
  await expect(result).toHaveCount(1)
  await result.click()
  await expect(palette).toHaveCount(0)
  await expect(target).toHaveClass(/shard-fragment-card-highlight/)
  await expect.poll(() => target.evaluate((element) => {
    const viewport = element.closest<HTMLElement>('[data-slot="scroll-area-viewport"]')!
    const topInset = Number.parseFloat(getComputedStyle(viewport).getPropertyValue("--shard-card-gap"))
    return Math.abs(element.getBoundingClientRect().top - viewport.getBoundingClientRect().top - topInset)
  })).toBeLessThanOrEqual(1)
  expect(await page.evaluate(() => window.__SHARD_CREATE_MOTION__.animations
    .every(({ animation }) => animation.playState === "idle"))).toBe(true)
  expect((await page.locator('[data-shard-editor="composer"]').boundingBox())!.y).toBe(composerTop)
  expect((await readLayout(page)).documentScroll).toBe(0)
  await expectPackedLayout(page)
})

test("连续创建从当前动画帧续接，切换减少动态效果立即取消剩余动画", async ({ page }) => {
  await openStream(page)
  await submitDraft(page)
  await resolveCreate(page)
  await expect.poll(() => motionIds(page)).toContain(createdId)
  await expect.poll(() => readEditor(page, "composer")).toBe("")
  await seekMotions(page, 100)
  const firstCreated = await page.locator(`[data-timeline-item-id="${createdId}"]`).elementHandle()
  await submitDraft(page, "紧接着保存第二条，已有动画应从当前可见位置继续。", 2)
  const before = await readLayout(page)
  const oldAnimationCount = (await motionIds(page)).length
  await resolveCreate(page)
  const secondId = "motion-created-2"
  await expect.poll(() => motionIds(page)).toContain(secondId)
  await expect.poll(() => readEditor(page, "composer")).toBe("")
  const continued = await readLayout(page)
  const continuedIds = (await motionIds(page)).slice(oldAnimationCount).filter((id) => id !== secondId)
  expect(continuedIds).toContain(createdId)
  for (const id of continuedIds) {
    const oldCard = before.cards.find((card) => card.id === id)!
    const card = continued.cards.find((card) => card.id === id)!
    expect(Math.abs(card.x - oldCard.x), `${id} continues from visible x`).toBeLessThanOrEqual(1)
    expect(Math.abs(card.y - oldCard.y), `${id} continues from visible y`).toBeLessThanOrEqual(1)
    expect(card.opacity, `${id} retains its current opacity`).toBeCloseTo(oldCard.opacity, 3)
  }
  expect(continued.cards.find(({ id }) => id === secondId)!.opacity).toBe(0)
  expect(await firstCreated!.evaluate((element) => element.isConnected)).toBe(true)
  expect(await readLifecycle(page)).toMatchObject({ mountedIds: [createdId, secondId], preserved: true, creates: 2 })

  await seekMotions(page, 100)
  await page.emulateMedia({ reducedMotion: "reduce" })
  await settleLayout(page)
  expect(await page.evaluate(() => window.__SHARD_CREATE_MOTION__.animations
    .every(({ animation }) => animation.playState === "idle"))).toBe(true)
  await expectPackedLayout(page)
  expect((await readLayout(page)).cards.slice(0, 2).map(({ id }) => id)).toEqual([secondId, createdId])
})

test("首屏读取、标签切换和加载更多不重播创建入场动画", async ({ page }) => {
  await openStream(page, { count: 60 })
  await applyFragmentTag(page, "motion-even")
  await expect(page.locator(".shard-timeline-item")).toHaveCount(30)
  await settleLayout(page)
  expect(await motionIds(page)).toEqual([])
  await page.getByRole("button", { name: "清除筛选", exact: true }).click()
  await expect(page.locator(".shard-timeline-item")).toHaveCount(40)
  await settleLayout(page)
  await page.locator(".shard-timeline-layout").evaluate((element) => {
    const viewport = element.closest<HTMLElement>('[data-slot="scroll-area-viewport"]')!
    viewport.scrollTop = viewport.scrollHeight
  })
  await expect(page.locator(".shard-timeline-item")).toHaveCount(60)
  await settleLayout(page)
  expect(await motionIds(page)).toEqual([])
  await expectPackedLayout(page)
})
