import { expect, test, type Page } from "@playwright/test"

import type { RevealPlan, RevealResult } from "../../src/lib/search-contract"
import { installContentTypesMock } from "./content-types-mock"
import {
  fillEditor,
  focusEditor,
  readEditorSnapshot,
  selectDocRange,
  typeEditor,
} from "./editor-helpers"

const EDITOR_ID = "composer"
const EDITOR = '[data-shard-editor="composer"]'

interface RevealDiagnostics {
  activeIndex: number
  dirty: boolean
  hitCount: number
  selection: { from: number; to: number }
  undoDepth: number
  value: string
  viewportScrollTop: number | null
  windowScrollY: number
}

interface RevealBridge {
  reveal(id: string, plan: RevealPlan): Promise<RevealResult>
  stepHit(id: string, direction: 1 | -1): Promise<RevealResult>
  clearHits(id: string): void
  diagnostics(id: string): RevealDiagnostics
}

function plan(terms: readonly string[], requestId = "reveal-1"): RevealPlan {
  const vaultPath = "/tmp/shard-content-types-mock-vault"
  const path = "fragments/composer.md"
  return {
    origin: "globalSearch",
    preferredText: null,
    projectionVersion: 1,
    requestId,
    revealHint: "text",
    revision: "revision-1",
    sessionId: "session-1",
    target: {
      archived: false,
      key: JSON.stringify([vaultPath, "public", path]),
      kind: "fragment",
      objectId: "composer",
      path,
      scope: "public",
      vaultPath,
    },
    terms,
    uiEpoch: 1,
  }
}

function bridge(page: Page) {
  return {
    diagnostics: () =>
      page.evaluate((id) => {
        const value = (window as typeof window & { __shardEditorTest?: RevealBridge })
          .__shardEditorTest
        if (!value) throw new Error("Shard 编辑器测试桥尚未挂载")
        return value.diagnostics(id)
      }, EDITOR_ID),
    reveal: (nextPlan: RevealPlan) =>
      page.evaluate(
        ({ id, value }) => {
          const target = (window as typeof window & { __shardEditorTest?: RevealBridge })
            .__shardEditorTest
          if (!target) throw new Error("Shard 编辑器测试桥尚未挂载")
          return target.reveal(id, value)
        },
        { id: EDITOR_ID, value: nextPlan }
      ),
    step: (direction: 1 | -1) =>
      page.evaluate(
        ({ id, value }) => {
          const target = (window as typeof window & { __shardEditorTest?: RevealBridge })
            .__shardEditorTest
          if (!target) throw new Error("Shard 编辑器测试桥尚未挂载")
          return target.stepHit(id, value)
        },
        { id: EDITOR_ID, value: direction }
      ),
  }
}

function viewportGeometry(page: Page) {
  return page.locator(EDITOR).evaluate((element) => {
    for (let current = element.parentElement; current; current = current.parentElement) {
      if (current === document.body || current === document.documentElement) break
      const overflow = getComputedStyle(current).overflowY
      if ((overflow === "auto" || overflow === "scroll") && current.scrollHeight > current.clientHeight) {
        const rect = current.getBoundingClientRect()
        return { bottom: rect.bottom, height: rect.height, left: rect.left, right: rect.right, top: rect.top }
      }
    }
    return null
  })
}

test.beforeEach(async ({ page }) => {
  await installContentTypesMock(page)
  await page.goto("/")
  await expect(page.locator(`${EDITOR} .ProseMirror`)).toBeFocused()
})

test("reveal_does_not_change_doc_selection_history_or_dirty", async ({ page }) => {
  await fillEditor(page, EDITOR_ID, "第一处共同词\n\n第二处共同词")
  await focusEditor(page, EDITOR_ID)
  await selectDocRange(page, EDITOR_ID, 2, 4)
  await typeEditor(page, EDITOR_ID, "新增")
  const before = await bridge(page).diagnostics()

  const result = await bridge(page).reveal(plan(["共同词"]))
  const after = await bridge(page).diagnostics()

  expect(result).toMatchObject({ status: "revealed", matchCount: 2, activeIndex: 0 })
  expect(after.value).toBe(before.value)
  expect(after.selection).toEqual(before.selection)
  expect(after.undoDepth).toBe(before.undoDepth)
  expect(after.dirty).toBe(before.dirty)
  expect(after.hitCount).toBe(2)
  await expect(page.locator(".shard-rich-search-hit")).toHaveCount(2)
  await expect(page.locator(".shard-rich-search-hit--active")).toHaveCount(1)
  const hitStyle = await page.locator(".shard-rich-search-hit--active").evaluate((element) => {
    const style = getComputedStyle(element)
    return { background: style.backgroundColor, boxShadow: style.boxShadow }
  })
  expect(hitStyle.background).not.toBe("rgba(0, 0, 0, 0)")
  expect(hitStyle.boxShadow).not.toBe("none")

  const stepped = await bridge(page).step(1)
  expect(stepped).toMatchObject({ status: "revealed", activeIndex: 1, matchCount: 2 })
  expect(await bridge(page).diagnostics()).toMatchObject({
    value: before.value,
    selection: before.selection,
    undoDepth: before.undoDepth,
    dirty: before.dirty,
  })
})

test("reveal_matches_across_inline_marks", async ({ page }) => {
  await fillEditor(page, EDITOR_ID, "开头 **共同**词 结尾")

  await expect(bridge(page).reveal(plan(["共同词"]))).resolves.toMatchObject({
    status: "revealed",
    matchCount: 1,
  })
  const hit = page.locator(".shard-rich-search-hit")
  await expect(hit).toHaveCount(2)
  await expect(hit.nth(0)).toHaveText("共同")
  await expect(hit.nth(1)).toHaveText("词")
})

test("reveal_does_not_cross_cells_or_atoms", async ({ page }) => {
  await fillEditor(
    page,
    EDITOR_ID,
    [
      "| 第一列 | 第二列 |",
      "| --- | --- |",
      "| 共 | 同词 |",
      "",
      "共#边界 同词",
    ].join("\n")
  )

  await expect(bridge(page).reveal(plan(["共同词"]))).resolves.toMatchObject({
    status: "noVisibleMatch",
  })
  await expect(page.locator(".shard-rich-search-hit")).toHaveCount(0)
})

test("code_and_embed_return_document_only", async ({ page }) => {
  await fillEditor(page, EDITOR_ID, "```text\n只在代码块命中\n```")
  await expect(bridge(page).reveal(plan(["代码块命中"], "code"))).resolves.toMatchObject({
    status: "documentOnly",
    reason: "codeBlock",
  })

  await fillEditor(page, EDITOR_ID, "![[数据.csv]]")
  await expect(bridge(page).reveal(plan(["数据.csv"], "embed"))).resolves.toMatchObject({
    status: "documentOnly",
    reason: "embed",
  })
  await expect(page.locator(".shard-rich-search-hit")).toHaveCount(0)
})

test("composition_invalidates_stale_reveal", async ({ page }) => {
  await fillEditor(page, EDITOR_ID, "组合输入前的共同词")
  await expect(bridge(page).reveal(plan(["共同词"]))).resolves.toMatchObject({
    status: "revealed",
  })

  const content = page.locator(`${EDITOR} .ProseMirror`)
  await content.dispatchEvent("compositionstart", { data: "共同" })
  await expect.poll(() => bridge(page).diagnostics()).toMatchObject({ hitCount: 0 })
  await expect(bridge(page).step(1)).resolves.toMatchObject({
    status: "stale",
    reason: "revisionChanged",
  })
  await expect(
    bridge(page).reveal(plan(["共同词"], "during-composition"))
  ).resolves.toMatchObject({ status: "cancelled" })

  await content.dispatchEvent("compositionend", { data: "共同词" })
  await expect(page.locator(".shard-rich-search-hit")).toHaveCount(0)
  await expect(
    bridge(page).reveal(plan(["共同词"], "after-composition"))
  ).resolves.toMatchObject({ status: "revealed" })
})

test("editor reveal scrolls only its viewport", async ({ page }) => {
  const lines = Array.from({ length: 80 }, (_, index) =>
    index === 79 ? "最后一段唯一命中" : `普通段落 ${index + 1}`
  )
  await fillEditor(page, EDITOR_ID, lines.join("\n\n"))
  // CaptureBox 的 ResizeObserver 会把正文高度收敛到上限；先等宿主几何稳定，
  // 再证明 reveal 只改 scrollTop 而不推动 viewport 或 document。
  await page.waitForTimeout(300)
  const before = await bridge(page).diagnostics()
  const beforeGeometry = await viewportGeometry(page)
  expect(before.viewportScrollTop).not.toBeNull()
  expect(beforeGeometry).not.toBeNull()

  await expect(bridge(page).reveal(plan(["唯一命中"]))).resolves.toMatchObject({
    status: "revealed",
    matchCount: 1,
  })
  const after = await bridge(page).diagnostics()

  expect(after.viewportScrollTop).toBeGreaterThan(before.viewportScrollTop ?? 0)
  expect(after.windowScrollY).toBe(before.windowScrollY)
  expect(await viewportGeometry(page)).toEqual(beforeGeometry)
})

test("editing invalidates old positions instead of reusing them", async ({ page }) => {
  await fillEditor(page, EDITOR_ID, "旧命中")
  await expect(bridge(page).reveal(plan(["命中"]))).resolves.toMatchObject({
    status: "revealed",
  })

  const snapshot = await readEditorSnapshot(page, EDITOR_ID)
  await selectDocRange(page, EDITOR_ID, snapshot.selectionEnd, snapshot.selectionEnd)
  await typeEditor(page, EDITOR_ID, "后续编辑")

  await expect(page.locator(".shard-rich-search-hit")).toHaveCount(0)
  await expect(bridge(page).step(1)).resolves.toMatchObject({
    status: "stale",
    reason: "revisionChanged",
  })
})
