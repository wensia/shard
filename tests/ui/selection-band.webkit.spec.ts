import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { expect, test, type Page } from "@playwright/test"

import { fillEditor } from "./editor-helpers"
import { installSearchIpcMock } from "./search-ipc-mock"

test.use({ browserName: "webkit", deviceScaleFactor: 3 })

const FIRST_LINE = "小游戏场景"
const SECOND_LINE = "用codex接blender建模"
const BODY = `${FIRST_LINE}\n\n${SECOND_LINE}`
const CARD = '[data-shard-fragment-id="selection-card"]'
const EDITOR = '[data-shard-editor="composer"] .ProseMirror'

async function saveEvidence(page: Page, rootSelector: string, kind: "card" | "editor") {
  const clip = await page.evaluate(({ kind, rootSelector }) => {
    const root = document.querySelector(rootSelector)!
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    let first: Text | null = null
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.textContent?.includes("小游戏场景")) { first = node as Text; break }
    }
    if (!first) throw new Error("Missing first text line for evidence")
    const range = document.createRange()
    const offset = first.textContent!.indexOf("小游戏场景")
    range.setStart(first, offset)
    range.setEnd(first, offset + "小游戏场景".length)
    const rect = range.getBoundingClientRect()
    return kind === "card"
      ? { x: rect.left - 4, y: rect.top - 20, width: 200, height: 106 }
      : { x: rect.left - 20, y: rect.top - 26, width: 220, height: 94 }
  }, { kind, rootSelector })
  const directory = join(process.cwd(), "docs/design/evidence/selection-band-after")
  await mkdir(directory, { recursive: true })
  await page.screenshot({
    animations: "disabled", clip, path: join(directory, `${kind}-webkit.png`), scale: "device",
  })
}

async function installSelectionBandMock(page: Page) {
  await installSearchIpcMock(page)
  await page.addInitScript((body) => {
    const now = "2026-09-26T08:00:00.000Z"
    const fragment = {
      id: "selection-card", path: "fragments/selection-card.md", content: body,
      tags: ["inbox"], createdAt: now, updatedAt: now, category: null,
      gitStatus: "committed", error: null, archived: false, lockbox: false,
      pinned: false, related: [],
    }
    const git = {
      branch: "main", shortCommit: "abc1234", hasRemote: false,
      status: "ready", error: null, ahead: 0, behind: 0,
    }
    const state = {
      vaultPath: "/tmp/shard-selection-band-test-vault", fragments: [fragment], git,
      lockbox: { configured: false, unlocked: false, expiresAt: null, ttlSeconds: 900 },
    }
    const tree = {
      entries: [], assets: [], trashEntries: [], fragmentTrashEntries: [],
      fragmentStream: { totalCount: 1, years: [] },
    }
    const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T
    let callbackId = 0
    Object.assign(globalThis, {
      isTauri: true,
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener() {} },
      __TAURI_INTERNALS__: {
        metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
        transformCallback: () => ++callbackId,
        invoke: async (command: string) => {
          switch (command) {
            case "plugin:event|listen": return ++callbackId
            case "plugin:event|unlisten":
            case "unhide_pointer":
            case "set_window_controls_hidden": return null
            case "plugin:app|version": return "0.1.3"
            case "list_fragments": return clone(state)
            case "list_csv_files":
            case "list_mind_maps": return []
            case "list_library_tree": return clone(tree)
            case "migrate_legacy_notes": return { tree: clone(tree), migratedCount: 0 }
            case "sync_vault": return clone(git)
            case "checkpoint_vault":
              return { status: "no_changes", changes: 0, reason: null, git: clone(git) }
            case "github_cli_status":
              return { installed: true, authenticated: true, login: "shard-test", protocol: "https", error: null }
            case "cli_install_status":
              return { state: "installed", linkPath: "/usr/local/bin/shard", shellConfigPath: null, message: null, declined: false }
            default: throw new Error(`Unhandled selection-band test command: ${command}`)
          }
        },
      },
    })
  }, BODY)
}

async function selectLines(page: Page, rootSelector: string) {
  await page.evaluate(({ first, rootSelector, second }) => {
    const root = document.querySelector(rootSelector)
    if (!(root instanceof HTMLElement)) throw new Error(`Missing selection root: ${rootSelector}`)
    const nodes = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    let start: Text | null = null
    let end: Text | null = null
    for (let node = nodes.nextNode(); node; node = nodes.nextNode()) {
      if (node.textContent?.includes(first)) start = node as Text
      if (node.textContent?.includes(second)) end = node as Text
    }
    if (!start || !end) throw new Error("Missing fixture text nodes")
    if (root.isContentEditable) root.focus()
    const range = document.createRange()
    range.setStart(start, start.textContent!.indexOf(first))
    range.setEnd(end, end.textContent!.indexOf(second) + second.length)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    document.dispatchEvent(new Event("selectionchange"))
  }, { first: FIRST_LINE, rootSelector, second: SECOND_LINE })
}

async function expectBandGeometry(page: Page, rootSelector: string) {
  const root = page.locator(rootSelector)
  await expect.poll(() => root.evaluate((node) => node.parentElement!.querySelectorAll("[data-shard-selection-band-rect]").length)).toBe(2)
  const geometry = await page.evaluate(({ first, rootSelector, second }) => {
    const root = document.querySelector(rootSelector)!
    const textNodes = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    const expected = [first, second].map((needle) => {
      let match: Text | null = null
      for (let node = textNodes.nextNode(); node; node = textNodes.nextNode()) {
        if (node.textContent?.includes(needle)) { match = node as Text; break }
      }
      if (!match) throw new Error(`Missing text: ${needle}`)
      const range = document.createRange()
      const offset = match.textContent!.indexOf(needle)
      range.setStart(match, offset)
      range.setEnd(match, offset + needle.length)
      const rect = range.getBoundingClientRect()
      const lineHeight = Number.parseFloat(getComputedStyle(match.parentElement!).lineHeight)
      return {
        center: rect.top + rect.height / 2,
        height: Number.isFinite(lineHeight) ? lineHeight : rect.height,
        left: rect.left,
        right: rect.right,
      }
    })
    const actual = Array.from(root.parentElement!.querySelectorAll<HTMLElement>("[data-shard-selection-band-rect]"))
      .map((band) => {
        const rect = band.getBoundingClientRect()
        return { center: rect.top + rect.height / 2, height: rect.height, left: rect.left, right: rect.right }
      })
      .sort((a, b) => a.center - b.center)
    return {
      actual,
      expected,
      selectionBackground: getComputedStyle(root, "::selection").backgroundColor,
      rootRight: root.getBoundingClientRect().right,
    }
  }, { first: FIRST_LINE, rootSelector, second: SECOND_LINE })
  expect(geometry.actual).toHaveLength(geometry.expected.length)
  for (const [index, band] of geometry.actual.entries()) {
    const text = geometry.expected[index]
    expect(Math.abs(band.height - text.height)).toBeLessThanOrEqual(1)
    expect(Math.abs(band.center - text.center)).toBeLessThanOrEqual(1)
    expect(band.left).toBeGreaterThanOrEqual(text.left - 1)
    expect(band.right).toBeLessThanOrEqual(text.right + 1)
  }
  expect(geometry.selectionBackground).toMatch(/^(?:transparent|rgba?\([^)]*[, ]0\))$/)
  expect(geometry.actual[0].right).toBeLessThan(geometry.rootRight - 8)
}

test.beforeEach(async ({ browser, page }) => {
  expect(browser.browserType().name()).toBe("webkit")
  await installSelectionBandMock(page)
  await page.goto("/")
  await expect(page.locator(`${CARD} [data-markdown-search-root]`)).toContainText(FIRST_LINE)
  await expect(page.locator(EDITOR)).toBeVisible()
})

test("卡片选区按文字行盒绘制，清除后消失，复制文本保持正确", async ({ page }) => {
  const root = `${CARD} [data-markdown-search-root]`
  await selectLines(page, root)
  await expectBandGeometry(page, root)
  await saveEvidence(page, root, "card")
  const selectedText = await page.evaluate(() => window.getSelection()?.toString() ?? "")
  expect(selectedText.replaceAll("\u200b", "")).toBe(BODY)

  await page.evaluate(() => {
    ;(window as typeof window & { __selectionBandCopy?: { cancelled: boolean; text: string } })
      .__selectionBandCopy = undefined
    document.addEventListener("copy", (event) => {
      ;(window as typeof window & { __selectionBandCopy?: { cancelled: boolean; text: string } })
        .__selectionBandCopy = {
          cancelled: event.defaultPrevented,
          text: window.getSelection()?.toString() ?? "",
        }
    }, { once: true })
  })
  await page.keyboard.press("Meta+c")
  const copy = await page.evaluate(async () => ({
    event: (window as typeof window & { __selectionBandCopy?: { cancelled: boolean; text: string } })
      .__selectionBandCopy,
    clipboard: navigator.clipboard
      ? await navigator.clipboard.readText().catch(() => null)
      : null,
  }))
  expect(copy.event).toEqual({ cancelled: false, text: selectedText })
  if (copy.clipboard !== null) {
    expect(copy.clipboard).toBe(selectedText)
    expect(copy.clipboard.replaceAll("\u200b", "")).toBe(BODY)
  }

  await page.evaluate(() => {
    const target = document.createElement("textarea")
    target.dataset.selectionBandPasteTarget = ""
    target.style.position = "fixed"
    target.style.left = "0"
    target.style.top = "0"
    document.body.appendChild(target)
  })
  const pasteTarget = page.locator("[data-selection-band-paste-target]")
  await pasteTarget.focus()
  await page.keyboard.press("Meta+v")
  const pastedText = await pasteTarget.inputValue()
  await pasteTarget.evaluate((node) => node.remove())
  expect(pastedText.replaceAll("\u200b", "")).toBe(BODY)

  await page.evaluate(() => {
    window.getSelection()?.removeAllRanges()
    document.dispatchEvent(new Event("selectionchange"))
  })
  await expect.poll(() => page.locator(root).evaluate((node) => node.parentElement!.querySelectorAll("[data-shard-selection-band-rect]").length)).toBe(0)
})

test("composer 跨段选区逐行绘制，首行不延伸到右边缘", async ({ page }) => {
  await fillEditor(page, "composer", BODY)
  await expect(page.locator(`${EDITOR} p`)).toHaveCount(2)
  await selectLines(page, EDITOR)
  await expectBandGeometry(page, EDITOR)
  await saveEvidence(page, EDITOR, "editor")
  expect([
    `${FIRST_LINE}\n${SECOND_LINE}`,
    `${FIRST_LINE}\n\n${SECOND_LINE}`,
  ]).toContain(await page.evaluate(() => window.getSelection()?.toString()))

  await page.evaluate(() => {
    window.getSelection()?.removeAllRanges()
    document.dispatchEvent(new Event("selectionchange"))
  })
  await expect.poll(() => page.locator(EDITOR).evaluate((node) => node.parentElement!.querySelectorAll("[data-shard-selection-band-rect]").length)).toBe(0)
})
