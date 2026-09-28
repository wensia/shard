import { expect, test, type Locator, type Page } from "@playwright/test"

import { fillEditor } from "./editor-helpers"
import { installSearchIpcMock } from "./search-ipc-mock"

const TARGET_ID = "t10-target"
const LATE_TARGET_ID = "t10-late-target"

interface HighlightSnapshot {
  entries: Array<{
    key: string
    ranges: Array<{
      bottom: number
      text: string
      top: number
      visible: boolean
    }>
  }>
  viewportScrollTop: number
}

async function installRevealFixture(page: Page) {
  await installSearchIpcMock(page)
  await page.addInitScript(() => {
    const origin = Date.parse("2026-09-25T08:00:00.000Z")
    const fragments = Array.from({ length: 62 }, (_, index) =>
      fragment(
        `t10-filler-${index}`,
        `普通片段 ${index}\n\n用于撑开时间线的普通正文 ${index}`,
        new Date(origin - index * 1_000).toISOString()
      )
    )
    fragments.push(
      fragment(
        "t10-target",
        "T10 定位目标 firstneedle 中段 secondneedle 结尾",
        new Date(origin - 100_000).toISOString()
      ),
      fragment(
        "t10-late-target",
        "T10 延迟目标 latenoodle",
        new Date(origin - 101_000).toISOString()
      )
    )
    const git = {
      ahead: 0,
      behind: 0,
      branch: "main",
      error: null,
      hasRemote: false,
      shortCommit: "t10test",
      status: "ready",
    }
    const lockbox = {
      configured: false,
      expiresAt: null,
      ttlSeconds: 900,
      unlocked: false,
    }
    const tree = {
      assets: [],
      entries: [],
      fragmentStream: { totalCount: fragments.length, years: [] },
      fragmentTrashEntries: [],
      trashEntries: [],
    }
    const clone = <T,>(value: T): T => structuredClone(value)
    const state = () => ({
      fragments: clone(fragments),
      git: clone(git),
      lockbox: clone(lockbox),
      vaultPath: "/tmp/shard-search-fragment-reveal",
    })
    let callbackId = 0

    Object.assign(globalThis, {
      isTauri: true,
      __T10_REVEAL_FRAGMENTS__: fragments,
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener() {} },
      __TAURI_INTERNALS__: {
        metadata: {
          currentWebview: { label: "main" },
          currentWindow: { label: "main" },
        },
        transformCallback: () => ++callbackId,
        invoke: async (command: string) => {
          switch (command) {
            case "plugin:event|listen": return ++callbackId
            case "plugin:event|unlisten":
            case "unhide_pointer":
            case "set_window_controls_hidden": return null
            case "plugin:app|version": return "0.1.3-test"
            case "list_fragments": return state()
            case "list_library_tree": return clone(tree)
            case "migrate_legacy_notes": return { migratedCount: 0, tree: clone(tree) }
            case "list_mind_maps":
            case "list_csv_files":
            case "list_diagram_documents": return []
            case "sync_vault": return clone(git)
            case "checkpoint_vault": return { git: clone(git), status: "noop" }
            case "cli_install_status": return {
              declined: false,
              linkPath: "/usr/local/bin/shard",
              message: null,
              shellConfigPath: null,
              state: "installed",
            }
            default: throw new Error(`Unhandled T10 command: ${command}`)
          }
        },
      },
    })

    function fragment(id: string, content: string, timestamp: string) {
      return {
        aiStatus: "none",
        archived: false,
        category: null,
        content,
        createdAt: timestamp,
        error: null,
        gitStatus: "committed",
        id,
        lockbox: false,
        path: `fragments/${id}.md`,
        pinned: false,
        related: [],
        tags: ["inbox"],
        updatedAt: timestamp,
      }
    }
  })
}

async function delayMarkdownWorker(page: Page) {
  await page.addInitScript(() => {
    const fixture = (globalThis as typeof globalThis & {
      __T10_REVEAL_FRAGMENTS__: Array<{ content: string; id: string }>
    }).__T10_REVEAL_FRAGMENTS__
    const late = fixture.find(({ id }) => id === "t10-late-target")
    if (late) {
      late.content = [
        "T10 延迟目标 latenoodle",
        ...Array.from({ length: 4_600 }, (_, index) => `普通延迟行 ${index}`),
      ].join("\n")
    }
    const NativeWorker = globalThis.Worker
    class DelayedMarkdownWorker extends NativeWorker {
      private readonly delayMarkdown: boolean

      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options)
        this.delayMarkdown = String(url).includes("parse.worker")
      }

      override postMessage(message: unknown, transferOrOptions?: Transferable[] | StructuredSerializeOptions) {
        const send = () => NativeWorker.prototype.postMessage.call(this, message, transferOrOptions)
        if (this.delayMarkdown) globalThis.setTimeout(send, 1_500)
        else send()
      }
    }
    Object.defineProperty(globalThis, "Worker", {
      configurable: true,
      value: DelayedMarkdownWorker,
      writable: true,
    })
  })
}

async function disableCustomHighlight(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(globalThis, "Highlight", {
      configurable: true,
      value: undefined,
      writable: true,
    })
    if (globalThis.CSS) {
      Object.defineProperty(globalThis.CSS, "highlights", {
        configurable: true,
        value: undefined,
        writable: true,
      })
    }
  })
}

async function openSearchResult(page: Page, query: string, option: RegExp) {
  await page.keyboard.press("Control+k")
  const palette = page.getByRole("dialog", { name: "搜索", exact: true })
  const input = palette.getByRole("combobox", { name: "搜索内容" })
  await input.fill(query)
  const result = palette.getByRole("option", { name: option })
  await expect(result).toHaveCount(1)
  await result.click()
  await expect(palette).toBeHidden()
}

async function productHighlights(page: Page, fragmentId = TARGET_ID) {
  return page.evaluate((id): HighlightSnapshot => {
    const card = document.querySelector<HTMLElement>(`[data-shard-fragment-id="${id}"]`)
    if (!card) throw new Error(`Missing fragment card ${id}`)
    const viewport = card.closest<HTMLElement>('[data-slot="scroll-area-viewport"]')
    if (!viewport) throw new Error("Missing timeline viewport")
    const viewportRect = viewport.getBoundingClientRect()
    const registry = (CSS as typeof CSS & { highlights: Map<string, Set<Range>> }).highlights
    const entries: HighlightSnapshot["entries"] = []
    registry.forEach((highlight, key) => {
      if (!/^shard-search-hit-(?:active-)?\d+$/u.test(key)) return
      const ranges: HighlightSnapshot["entries"][number]["ranges"] = []
      highlight.forEach((range) => {
        if (!card.contains(range.startContainer)) return
        const rect = range.getBoundingClientRect()
        ranges.push({
          bottom: rect.bottom,
          text: range.toString(),
          top: rect.top,
          visible: rect.top >= viewportRect.top - 1 && rect.bottom <= viewportRect.bottom + 1,
        })
      })
      entries.push({ key, ranges })
    })
    return { entries, viewportScrollTop: viewport.scrollTop }
  }, fragmentId)
}

function normalRanges(snapshot: HighlightSnapshot) {
  return snapshot.entries.find(({ key }) => /^shard-search-hit-\d+$/u.test(key))?.ranges ?? []
}

async function waitForVisibleHighlight(page: Page, fragmentId = TARGET_ID) {
  await expect.poll(async () => normalRanges(await productHighlights(page, fragmentId))).toEqual(
    expect.arrayContaining([expect.objectContaining({ visible: true })])
  )
  return productHighlights(page, fragmentId)
}

async function settleGeometry(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  }))
}

async function waitForStableBox(locator: Locator) {
  let previous: { height: number; top: number } | null = null
  let stableSamples = 0
  await expect.poll(async () => {
    const box = await locator.boundingBox()
    if (!box) return 0
    const next = { height: box.height, top: box.y }
    stableSamples = previous &&
      Math.abs(previous.height - next.height) <= 1 &&
      Math.abs(previous.top - next.top) <= 1
      ? stableSamples + 1
      : 0
    previous = next
    return stableSamples
  }).toBeGreaterThanOrEqual(2)
}

test.beforeEach(async ({ page }) => {
  await installRevealFixture(page)
})

test("same_fragment_new_request_reveals_again", async ({ page }) => {
  await page.goto("/")
  await openSearchResult(page, "firstneedle", /T10 定位目标/)
  const first = await waitForVisibleHighlight(page)
  expect(normalRanges(first).map(({ text }) => text)).toEqual(["firstneedle"])
  await page.evaluate(() => {
    const registry = (CSS as typeof CSS & { highlights: Map<string, Set<Range>> }).highlights
    ;(globalThis as typeof globalThis & { __T10_FIRST_HIGHLIGHT__?: Set<Range> }).__T10_FIRST_HIGHLIGHT__ =
      Array.from(registry.entries()).find(([key]) => /^shard-search-hit-\d+$/u.test(key))?.[1]
  })

  await page.getByRole("button", { name: "返回搜索结果" }).click()
  const palette = page.getByRole("dialog", { name: "搜索", exact: true })
  await palette.getByRole("combobox", { name: "搜索内容" }).fill("secondneedle")
  await palette.getByRole("option", { name: /T10 定位目标/ }).click()
  await expect(palette).toBeHidden()

  const second = await waitForVisibleHighlight(page)
  expect(normalRanges(second).map(({ text }) => text)).toEqual(["secondneedle"])
  expect(await page.evaluate(() => {
    const previous = (globalThis as typeof globalThis & { __T10_FIRST_HIGHLIGHT__?: Set<Range> })
      .__T10_FIRST_HIGHLIGHT__
    return previous ? previous.size : -1
  })).toBe(0)
})

test("硬换行移除后仍按可见文本定位搜索高亮", async ({ page }) => {
  await page.addInitScript(() => {
    const fragments = (globalThis as typeof globalThis & {
      __T10_REVEAL_FRAGMENTS__: Array<{ content: string; id: string }>
    }).__T10_REVEAL_FRAGMENTS__
    const target = fragments.find(({ id }) => id === "t10-target")
    if (target) target.content = "T10 定位目标 firstneedle\\\n\\\nsecondneedle 结尾"
  })
  await page.goto("/")
  await openSearchResult(page, "secondneedle", /T10 定位目标/)
  const target = page.locator(`[data-shard-fragment-id="${TARGET_ID}"]`)
  await expect(target.locator(".shard-fragment-card-content")).toHaveText(
    "T10 定位目标 firstneedle\n\nsecondneedle 结尾"
  )
  expect(normalRanges(await waitForVisibleHighlight(page)).map(({ text }) => text)).toEqual(["secondneedle"])
})

test("late_markdown_render_is_awaited", async ({ page }) => {
  await delayMarkdownWorker(page)
  await page.goto("/")
  await page.keyboard.press("Control+k")
  const palette = page.getByRole("dialog", { name: "搜索", exact: true })
  await palette.getByRole("combobox", { name: "搜索内容" }).fill("latenoodle")
  const result = palette.getByRole("option", { name: /T10 延迟目标/ })
  await expect(result).toHaveCount(1)
  await result.click()

  const card = page.locator(`[data-shard-fragment-id="${LATE_TARGET_ID}"]`)
  await expect(card).toBeVisible()
  await expect(card.locator('[data-markdown-search-root="true"]')).toHaveAttribute("aria-busy", "true")
  expect(normalRanges(await productHighlights(page, LATE_TARGET_ID))).toHaveLength(0)
  await expect(palette).toBeHidden()
  await expect(card.locator('[data-markdown-search-root="true"]')).not.toHaveAttribute("aria-busy", "true")
  const revealed = await waitForVisibleHighlight(page, LATE_TARGET_ID)
  expect(normalRanges(revealed).map(({ text }) => text)).toEqual(["latenoodle"])
})

test("folded_fragment_is_expanded_before_matching", async ({ page }) => {
  await page.goto("/")
  await expect(page.locator(".shard-timeline-item")).toHaveCount(40)
  await expect(page.locator(`[data-shard-fragment-id="${TARGET_ID}"]`)).toHaveCount(0)

  await openSearchResult(page, "firstneedle", /T10 定位目标/)

  await expect(page.locator(`[data-shard-fragment-id="${TARGET_ID}"]`)).toBeVisible()
  expect(await page.locator(".shard-timeline-item").count()).toBeGreaterThan(40)
  expect(normalRanges(await waitForVisibleHighlight(page)).map(({ text }) => text)).toEqual(["firstneedle"])
})

test("missing_custom_highlight_falls_back_to_card_outline", async ({ page }) => {
  await disableCustomHighlight(page)
  await page.goto("/")
  await openSearchResult(page, "firstneedle", /T10 定位目标/)

  const card = page.locator(`[data-shard-fragment-id="${TARGET_ID}"]`)
  await expect(card).toHaveClass(/shard-fragment-card-highlight/)
  await expect(page.getByText(/文内 \d+ \/ \d+/u)).toHaveCount(0)
  await expect(page.getByRole("button", { name: "结束搜索" })).toBeVisible()
})

test("revoke_removes_ranges_and_registry_entries", async ({ page }) => {
  await page.goto("/")
  await page.evaluate(() => {
    const node = document.createElement("span")
    node.dataset.t10Unrelated = "true"
    node.textContent = "unrelated-highlight"
    document.body.append(node)
    const range = document.createRange()
    range.selectNodeContents(node)
    const registry = (CSS as typeof CSS & { highlights: Map<string, Set<Range>> }).highlights
    const ForeignHighlight = (globalThis as typeof globalThis & {
      Highlight: new (...ranges: Range[]) => Set<Range>
    }).Highlight
    registry.set("t10-unrelated", new ForeignHighlight(range))
  })
  await openSearchResult(page, "firstneedle", /T10 定位目标/)
  await waitForVisibleHighlight(page)
  await page.evaluate(() => {
    const registry = (CSS as typeof CSS & { highlights: Map<string, Set<Range>> }).highlights
    const owned = Array.from(registry.entries())
      .filter(([key]) => /^shard-search-hit-(?:active-)?\d+$/u.test(key))
      .map(([, highlight]) => highlight)
    ;(globalThis as typeof globalThis & { __T10_OWNED_HIGHLIGHTS__?: Array<Set<Range>> })
      .__T10_OWNED_HIGHLIGHTS__ = owned
  })

  await page.getByRole("button", { name: "结束搜索" }).click()

  await expect.poll(() => page.evaluate(() => {
    const registry = (CSS as typeof CSS & { highlights: Map<string, Set<Range>> }).highlights
    return Array.from(registry.keys()).filter((key) => /^shard-search-hit-(?:active-)?\d+$/u.test(key))
  })).toEqual([])
  expect(await page.evaluate(() => {
    const owned = (globalThis as typeof globalThis & { __T10_OWNED_HIGHLIGHTS__?: Array<Set<Range>> })
      .__T10_OWNED_HIGHLIGHTS__ ?? []
    return owned.map((highlight) => highlight.size)
  })).toEqual([0, 0])
  expect(await page.evaluate(() => {
    const registry = (CSS as typeof CSS & { highlights: Map<string, Set<Range>> }).highlights
    return registry.get("t10-unrelated")?.size
  })).toBe(1)
})

test("fragment reveal keeps document and composer stationary", async ({ page }) => {
  await page.goto("/")
  await fillEditor(
    page,
    "composer",
    Array.from({ length: 18 }, (_, index) => `保持展开的 composer 第 ${index + 1} 行`).join("\n\n")
  )
  const composerFrame = page.locator('[data-shard-editor="composer"]')
    .locator("xpath=ancestor::div[@data-expanded='true'][1]")
  await expect(composerFrame).toBeVisible()
  await settleGeometry(page)
  await waitForStableBox(composerFrame)
  const before = await composerFrame.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    const viewport = document.querySelector<HTMLElement>(".shard-timeline-layout")
      ?.closest<HTMLElement>('[data-slot="scroll-area-viewport"]')
    return {
      composerHeight: rect.height,
      composerTop: rect.top,
      documentScrollTop: document.scrollingElement?.scrollTop ?? 0,
      timelineScrollTop: viewport?.scrollTop ?? 0,
    }
  })

  await openSearchResult(page, "firstneedle", /T10 定位目标/)
  const revealed = await waitForVisibleHighlight(page)
  await settleGeometry(page)
  await waitForStableBox(composerFrame)
  const after = await composerFrame.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    const viewport = document.querySelector<HTMLElement>(".shard-timeline-layout")
      ?.closest<HTMLElement>('[data-slot="scroll-area-viewport"]')
    return {
      composerHeight: rect.height,
      composerTop: rect.top,
      documentScrollTop: document.scrollingElement?.scrollTop ?? 0,
      expanded: element.dataset.expanded,
      timelineScrollTop: viewport?.scrollTop ?? 0,
    }
  })

  expect(normalRanges(revealed)).toEqual(
    expect.arrayContaining([expect.objectContaining({ visible: true })])
  )
  expect(after.timelineScrollTop).toBeGreaterThan(before.timelineScrollTop)
  expect(after.documentScrollTop).toBe(before.documentScrollTop)
  expect(Math.abs(after.composerTop - before.composerTop)).toBeLessThanOrEqual(1)
  expect(Math.abs(after.composerHeight - before.composerHeight)).toBeLessThanOrEqual(1)
  expect(after.expanded).toBe("true")
})
