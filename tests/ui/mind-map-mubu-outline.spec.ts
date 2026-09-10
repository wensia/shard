import { writeFileSync } from "node:fs"
import { chromium, expect, test, webkit, type Locator, type Page } from "@playwright/test"
import type { MindMapReadResult, ShardMapFile } from "../../src/types"

type Harness = Window & {
  __mindMapDocumentMock: { disk: MindMapReadResult; writes: number }
  __mindMapDocumentHarness: { save(): Promise<boolean>; reopen(): Promise<void>; dirty(): boolean }
}

const outline = (page: Page) => page.locator("[data-mind-map-outline]")
const branch = (page: Page, id = "branch-1") => page.locator(`[data-outline-node="${id}"]`).getByRole("textbox", { name: "导图节点", exact: true })
const branches = (page: Page) => page.locator('[data-outline-node][data-root="false"] textarea[data-outline-field="text"]')
const title = (page: Page) => page.locator('[data-outline-node][data-root="true"] textarea[data-outline-field="text"]')
const note = (page: Page) => page.getByRole("textbox", { name: "主题描述", exact: true })

async function openOutline(page: Page, nested = false) {
  await page.goto("/mind-map-document-test.html?mock=1")
  await expect(page.getByRole("application", { name: "思维导图编辑器", exact: true })).toBeVisible()
  if (nested) {
    await page.evaluate(async () => {
      const w = window as Harness
      const file = w.__mindMapDocumentMock.disk.file
      file.nodes["child-1"] = { ...file.nodes["branch-1"], id: "child-1", parentId: "branch-1", sortKey: "1", text: "子主题甲" }
      file.nodes["child-2"] = { ...file.nodes["branch-1"], id: "child-2", parentId: "branch-1", sortKey: "2", text: "子主题乙" }
      file.nodes["grandchild"] = { ...file.nodes["branch-1"], id: "grandchild", parentId: "child-1", sortKey: "1", text: "更深一层" }
      await w.__mindMapDocumentHarness.reopen()
    })
  }
  await page.getByRole("tab", { name: "大纲", exact: true }).click()
  await expect(branches(page)).toHaveCount(nested ? 6 : 3)
  await page.evaluate(() => document.fonts.ready)
}

async function state(page: Page) {
  return page.evaluate(() => {
    const w = window as Harness
    return { file: structuredClone(w.__mindMapDocumentMock.disk.file), writes: w.__mindMapDocumentMock.writes,
      dirty: w.__mindMapDocumentHarness.dirty() }
  })
}

async function save(page: Page): Promise<ShardMapFile> {
  expect(await page.evaluate(() => (window as Harness).__mindMapDocumentHarness.save())).toBe(true)
  return (await state(page)).file
}

async function setCaret(input: Locator, start: number, end = start) {
  await input.focus()
  await input.evaluate((element, position) => {
    const input = element as HTMLTextAreaElement
    input.setSelectionRange(position.start, position.end)
    input.dispatchEvent(new Event("select", { bubbles: true }))
  }, { start, end })
}

async function expectGuideLayout(page: Page, expected: Record<string, string[]>) {
  const geometry = await outline(page).evaluate(viewport => Array.from(viewport.querySelectorAll<HTMLElement>("[data-outline-node]")).map(row => {
    const bounds = row.getBoundingClientRect()
    const bullet = row.querySelector<HTMLElement>('button[aria-label^="聚焦主题："] > span')?.getBoundingClientRect()
    return { id: row.dataset.outlineNode!, top: bounds.top, bottom: bounds.bottom, height: bounds.height,
      bulletX: bullet ? bullet.x + bullet.width / 2 : null,
      guides: Array.from(row.querySelectorAll<HTMLElement>("[data-outline-guide]")).map(guide => {
        const g = guide.getBoundingClientRect()
        return { ancestor: guide.dataset.outlineGuide!, x: g.x + g.width / 2, top: g.top, bottom: g.bottom, width: g.width }
      }) }
  }))
  const byId = Object.fromEntries(geometry.map(row => [row.id, row]))
  for (const row of geometry) {
    expect(row.guides.map(guide => guide.ancestor), `主题 ${row.id} 只显示当前范围内的祖先线`).toEqual(expected[row.id] ?? [])
    for (const guide of row.guides) {
      expect(byId[guide.ancestor]?.bulletX, `祖先 ${guide.ancestor} 的圆点必须在当前大纲中`).not.toBeNull()
      expect(Math.abs(guide.x - byId[guide.ancestor].bulletX!), "层级线与祖先圆点严格同轴").toBeLessThanOrEqual(0.1)
      expect(guide.width).toBe(1)
      expect(Math.abs(guide.top - row.top)).toBeLessThanOrEqual(1)
      expect(Math.abs(guide.bottom - row.bottom), "多行文字和描述高度完整包含在祖先线范围内").toBeLessThanOrEqual(1)
    }
  }
  return geometry
}

async function sampleGuidePaint(page: Page, guideX: number, rowTop: number, rowBottom: number, menuTop: number, menuBottom: number) {
  // Read actual composited pixels: transparent gradient gaps do not change the guide DOM rectangle.
  const screenshot = (await page.screenshot({ animations: "disabled" })).toString("base64")
  return page.evaluate(async ({ screenshot, guideX, rowTop, rowBottom, menuTop, menuBottom }) => {
    const image = new Image()
    image.src = `data:image/png;base64,${screenshot}`
    await image.decode()
    const canvas = document.createElement("canvas")
    canvas.width = image.width; canvas.height = image.height
    const context = canvas.getContext("2d")!
    context.drawImage(image, 0, 0)
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height)
    const dpr = devicePixelRatio
    const lum = (x: number, y: number) => {
      const index = (y * canvas.width + x) * 4
      return data[index] * 0.2126 + data[index + 1] * 0.7152 + data[index + 2] * 0.0722
    }
    const rows = []
    for (let y = Math.ceil(rowTop * dpr); y < Math.floor(rowBottom * dpr); y++) {
      const baseline = lum(Math.floor((guideX + 12) * dpr), y)
      let ink = 0
      for (let x = Math.floor((guideX - 0.5) * dpr); x < Math.ceil((guideX + 0.5) * dpr); x++) {
        ink = Math.max(ink, baseline - lum(x, y))
      }
      rows.push({ y: (y + 0.5) / dpr, ink })
    }
    return {
      above: rows.filter(row => row.y >= menuTop - 4 && row.y < menuTop),
      below: rows.filter(row => row.y >= menuBottom && row.y < menuBottom + 4),
      distant: rows.filter(row => row.y > menuBottom + 5 && row.y < Math.min(rowBottom - 1, menuBottom + 24)),
      beforeMenu: rows.filter(row => row.y >= rowTop && row.y < menuTop - 5),
    }
  }, { screenshot, guideX, rowTop, rowBottom, menuTop, menuBottom })
}

for (const browserName of ["webkit", "chromium"] as const) {
  const engineTest = test.extend({
    page: async ({}, use) => {
      const browser = await ({ webkit, chromium })[browserName].launch()
      try {
        await use(await browser.newPage({ baseURL: "http://127.0.0.1:1420", viewport: { width: 1280, height: 760 } }))
      } finally { await browser.close() }
    },
  })

  engineTest.describe(`${browserName} 幕布式大纲`, () => {
    engineTest("Tab 移动当前主题而不创建节点，并保留选区和一次撤销的结构边界", async ({ page }) => {
      await openOutline(page)
      const input = branch(page, "branch-2")
      await setCaret(input, 1, 2)
      await input.press("Tab")
      await expect(input).toBeFocused()
      expect(await input.evaluate(element => {
        const input = element as HTMLTextAreaElement
        return [input.selectionStart, input.selectionEnd]
      })).toEqual([1, 2])
      let file = await save(page)
      expect(Object.keys(file.nodes)).toHaveLength(4)
      expect(file.nodes["branch-2"].parentId).toBe("branch-1")
      expect(file.nodes["branch-2"].text).toBe("主题乙")
      await input.press("ControlOrMeta+z")
      file = await save(page)
      expect(file.nodes["branch-2"].parentId).toBe(file.rootId)
      expect(file.nodes["branch-2"].text).toBe("主题乙")
      await setCaret(input, 1)
      await input.press("Tab")
      await page.keyboard.insertText("补")
      await expect(input).toHaveValue("主补题乙")
      await input.press("Shift+Tab")
      await expect(input).toBeFocused()
      file = await save(page)
      expect(file.nodes["branch-2"].parentId).toBe(file.rootId)
      expect(file.nodes["branch-2"].text).toBe("主补题乙")
      expect(Object.keys(file.nodes)).toHaveLength(4)
    })

    engineTest("首个同级与标题不能缩进，移入折叠前主题时自动展开并保留后代", async ({ page }) => {
      await openOutline(page, true)
      const initial = await state(page)
      await branch(page).press("Tab")
      await title(page).press("Tab")
      expect(await state(page)).toEqual(initial)
      await page.locator('[data-outline-node="branch-1"]').getByRole("button", { name: "折叠 主题甲", exact: true }).click()
      await expect(branches(page)).toHaveCount(3)
      await branch(page, "branch-2").press("Tab")
      await expect(branches(page)).toHaveCount(6)
      await expect(branch(page, "branch-2")).toBeFocused()
      const file = await save(page)
      expect(file.nodes["branch-1"].collapsed).not.toBe(true)
      expect(file.nodes["branch-2"].parentId).toBe("branch-1")
      expect(file.nodes["grandchild"].parentId).toBe("child-1")
      expect(Object.keys(file.nodes)).toHaveLength(7)
    })

    engineTest("Shift+Enter 独立描述可连续换行，返回主题及保存重开不会混入标题", async ({ page }) => {
      await openOutline(page)
      const input = branch(page)
      await setCaret(input, 1)
      await input.press("Shift+Enter")
      await expect(note(page)).toBeFocused()
      await page.keyboard.insertText("第一行说明")
      await page.keyboard.press("Enter")
      await page.keyboard.press("Enter")
      await page.keyboard.insertText("最后一行说明")
      const description = "第一行说明\n\n最后一行说明"
      await expect(note(page)).toHaveValue(description)
      await expect(input).toHaveValue("主题甲")
      await note(page).press("Tab")
      await expect(branches(page)).toHaveCount(3)
      await note(page).focus()
      await note(page).press("Shift+Enter")
      await expect(input).toBeFocused()
      let file = await save(page)
      expect(file.nodes["branch-1"].note).toBe(description)
      expect(file.nodes["branch-1"].text).toBe("主题甲")
      await page.getByRole("button", { name: "重新打开", exact: true }).click()
      await page.getByRole("tab", { name: "大纲", exact: true }).click()
      await branch(page).press("Shift+Enter")
      await expect(note(page)).toHaveValue(description)
      await note(page).fill("描述修改")
      await note(page).press("ControlOrMeta+z")
      await expect(note(page)).toHaveValue(description)
      file = await save(page)
      expect(file.nodes["branch-1"].note).toBe(description)
      expect(Object.keys(file.nodes)).toHaveLength(4)
    })

    engineTest("圆点聚焦与面包屑返回只改变视图，快捷键也可以往返子树", async ({ page }) => {
      await openOutline(page, true)
      const before = await state(page)
      await page.getByRole("button", { name: "聚焦主题：主题甲", exact: true }).click()
      await expect(title(page)).toHaveValue("主题甲")
      await expect(branches(page)).toHaveCount(3)
      await expect(branch(page, "branch-2")).toHaveCount(0)
      await page.getByRole("button", { name: "返回完整大纲", exact: true }).click()
      await expect(title(page)).toHaveValue("中心主题")
      await expect(branches(page)).toHaveCount(6)
      await branch(page).press("ControlOrMeta+]")
      await expect(title(page)).toHaveValue("主题甲")
      await title(page).press("ControlOrMeta+[")
      await expect(title(page)).toHaveValue("中心主题")
      await expect(branches(page)).toHaveCount(6)
      expect(await state(page)).toEqual(before)
    })

    engineTest("局部大纲切到导图选择外部主题后，返回完整大纲并显示该主题", async ({ page }) => {
      await openOutline(page, true)
      const before = await state(page)
      await page.getByRole("button", { name: "聚焦主题：主题甲", exact: true }).click()
      await expect(title(page)).toHaveValue("主题甲")
      await page.getByRole("tab", { name: "思维导图", exact: true }).click()
      await page.locator('[data-mind-map-node="branch-2"]').click()
      await page.getByRole("tab", { name: "大纲", exact: true }).click()
      await expect(title(page)).toHaveValue("中心主题")
      await expect(branches(page)).toHaveCount(6)
      await expect(page.locator('[data-outline-node="branch-2"]')).toHaveAttribute("data-selected", "true")
      await expect(branch(page, "branch-2")).toBeVisible()
      expect(await state(page)).toEqual(before)
    })

    engineTest("空描述及已有描述的光标跨视图保留，关闭帮助恢复描述输入", async ({ page }) => {
      await openOutline(page)
      const before = await state(page)
      await branch(page).press("Shift+Enter")
      await expect(note(page)).toBeFocused()
      await page.getByRole("tab", { name: "思维导图", exact: true }).click()
      await page.getByRole("tab", { name: "大纲", exact: true }).click()
      await expect(note(page)).toHaveValue("")
      await expect(page.getByRole("tab", { name: "大纲", exact: true })).toBeFocused()
      expect(await state(page)).toEqual(before)
      await note(page).fill("描述正文保留文字光标")
      await setCaret(note(page), 2, 4)
      await page.getByRole("tab", { name: "思维导图", exact: true }).click()
      await page.getByRole("tab", { name: "大纲", exact: true }).click()
      await expect(note(page)).toHaveValue("描述正文保留文字光标")
      expect(await note(page).evaluate(element => {
        const input = element as HTMLTextAreaElement
        return [input.selectionStart, input.selectionEnd]
      })).toEqual([2, 4])
      await note(page).focus()
      await page.getByRole("button", { name: "快捷键", exact: true }).click()
      await page.getByRole("button", { name: "关闭快捷键", exact: true }).click()
      await expect(note(page)).toBeFocused()
      expect(await note(page).evaluate(element => {
        const input = element as HTMLTextAreaElement
        return [input.selectionStart, input.selectionEnd]
      })).toEqual([2, 4])
      expect((await save(page)).nodes["branch-1"].note).toBe("描述正文保留文字光标")
    })

    engineTest("空描述打开并关闭帮助或属性后仍能接着输入，且不会产生内容写入", async ({ page }) => {
      await openOutline(page)
      const before = await state(page)
      await branch(page).press("Shift+Enter")
      await expect(note(page)).toHaveValue("")
      await expect(note(page)).toBeFocused()
      for (const panel of [
        { open: "快捷键", close: "关闭快捷键", label: "思维导图快捷键" },
        { open: "显示检查器", close: "关闭检查器", label: "思维导图检查器" },
      ]) {
        await page.getByRole("button", { name: panel.open, exact: true }).click()
        await expect(page.getByRole("complementary", { name: panel.label, exact: true })).toBeVisible()
        await page.getByRole("button", { name: panel.close, exact: true }).click()
        await expect(note(page)).toHaveValue("")
        await expect(note(page)).toBeFocused()
        expect(await state(page)).toEqual(before)
      }
      // A save request after view-only actions must also remain a storage no-op.
      await save(page)
      expect(await state(page)).toEqual(before)
      await page.keyboard.insertText("返回后连续写描述")
      await expect(note(page)).toHaveValue("返回后连续写描述")
      expect((await save(page)).nodes["branch-1"].note).toBe("返回后连续写描述")
    })

    engineTest("聚焦折叠子树后无效缩进不写盘，实际新建也保留范围及祖先折叠态", async ({ page }) => {
      await openOutline(page, true)
      await page.locator('[data-outline-node="child-1"]').getByRole("button", { name: "折叠 子主题甲", exact: true }).click()
      await page.locator('[data-outline-node="branch-1"]').getByRole("button", { name: "折叠 主题甲", exact: true }).click()
      await save(page)
      const before = await state(page)
      expect(before.file.nodes["branch-1"].collapsed).toBe(true)
      expect(before.file.nodes["child-1"].collapsed).toBe(true)
      await page.getByRole("button", { name: "聚焦主题：主题甲", exact: true }).click()
      await page.getByRole("button", { name: "聚焦主题：子主题甲", exact: true }).click()
      await expect(title(page)).toHaveValue("子主题甲")
      await expect(branches(page)).toHaveCount(1)
      await branch(page, "grandchild").press("Tab")
      await expect(branch(page, "grandchild")).toBeFocused()
      await expect(title(page)).toHaveValue("子主题甲")
      expect(await state(page)).toEqual(before)
      await save(page)
      expect(await state(page)).toEqual(before)
      await setCaret(branch(page, "grandchild"), "更深一层".length)
      await branch(page, "grandchild").press("Enter")
      const newInput = page.locator('textarea[data-outline-field="text"]:focus')
      await expect(newInput).toHaveValue("")
      await page.keyboard.insertText("折叠范围中新主题")
      const file = await save(page)
      expect(file.nodes["branch-1"].collapsed).toBe(true)
      expect(file.nodes["child-1"].collapsed).toBe(true)
      expect(Object.values(file.nodes).find(node => node.text === "折叠范围中新主题")?.parentId).toBe("child-1")
      expect(Object.keys(file.nodes)).toHaveLength(8)
      await page.getByRole("button", { name: "返回完整大纲", exact: true }).click()
      await expect(branches(page)).toHaveCount(3)
      await expect(page.getByRole("button", { name: "展开 主题甲", exact: true })).toBeVisible()
    })

    engineTest("组合输入期间结构与描述快捷键保持静默，确认后只执行一次", async ({ page }) => {
      await openOutline(page)
      const input = branch(page, "branch-2")
      await setCaret(input, 3)
      const before = await state(page)
      // Handler-level composition boundaries; physical macOS IME is verified separately in native Tauri.
      for (const event of [
        { key: "Tab", isComposing: true, keyCode: 9 },
        { key: "Enter", shiftKey: true, isComposing: true, keyCode: 13 },
        { key: "Tab", isComposing: false, keyCode: 229 },
        { key: "Enter", shiftKey: true, isComposing: false, keyCode: 229 },
        { key: "Process", isComposing: false, keyCode: 0 },
      ]) await input.dispatchEvent("keydown", event)
      await expect(note(page)).toHaveCount(0)
      await expect(branches(page)).toHaveCount(3)
      await expect(input).toBeFocused()
      expect(await state(page)).toEqual(before)
      await page.keyboard.insertText("确认")
      await input.press("Tab")
      const file = await save(page)
      expect(file.nodes["branch-2"].text).toBe("主题乙确认")
      expect(file.nodes["branch-2"].parentId).toBe("branch-1")
      expect(Object.keys(file.nodes)).toHaveLength(4)
    })

    engineTest("结构快捷键重排并折叠子树，圆点拖动后不会误进入聚焦视图", async ({ page }) => {
      await openOutline(page, true)
      await branch(page).press("ControlOrMeta+Shift+ArrowDown")
      let file = await save(page)
      const topIds = Object.values(file.nodes).filter(node => node.parentId === file.rootId)
        .sort((a, b) => a.sortKey.localeCompare(b.sortKey)).map(node => node.id)
      expect(topIds).toEqual(["branch-2", "branch-1", "branch-3"])
      expect(file.nodes["grandchild"].parentId).toBe("child-1")
      await branch(page).press("ControlOrMeta+.")
      await expect(branches(page)).toHaveCount(3)
      await branch(page).press("ControlOrMeta+.")
      await expect(branches(page)).toHaveCount(6)
      const source = page.getByRole("button", { name: "聚焦主题：主题甲", exact: true })
      const target = page.locator('[data-outline-node="branch-3"]')
      const bounds = (await target.boundingBox())!
      await source.dragTo(target, { targetPosition: { x: bounds.width / 2, y: bounds.height / 2 } })
      file = await save(page)
      expect(file.nodes["branch-1"].parentId).toBe("branch-3")
      expect(file.nodes["child-1"].parentId).toBe("branch-1")
      expect(file.nodes["grandchild"].parentId).toBe("child-1")
      await expect(title(page)).toHaveValue("中心主题")
      await expect(branches(page)).toHaveCount(6)
      await expect(page.getByRole("button", { name: "返回完整大纲", exact: true })).toHaveCount(0)
      expect(Object.keys(file.nodes)).toHaveLength(7)
    })

    engineTest("空标题带子树、描述或文档引用时普通退格不会递归删除内容", async ({ page }) => {
      await openOutline(page, true)
      await branch(page).fill("")
      await branch(page).press("Backspace")
      let file = await save(page)
      expect(file.nodes["branch-1"].text).toBe("")
      expect(file.nodes["child-1"].parentId).toBe("branch-1")
      expect(Object.keys(file.nodes)).toHaveLength(7)
      await branch(page, "branch-2").press("Shift+Enter")
      await note(page).fill("空标题仍保留的描述")
      await note(page).press("Shift+Enter")
      await branch(page, "branch-2").fill("")
      await branch(page, "branch-2").press("Backspace")
      file = await save(page)
      expect(file.nodes["branch-2"].note).toBe("空标题仍保留的描述")
      expect(Object.keys(file.nodes)).toHaveLength(7)
      await page.evaluate(async () => {
        const w = window as Harness
        w.__mindMapDocumentMock.disk.file.nodes["branch-3"].text = ""
        w.__mindMapDocumentMock.disk.file.nodes["branch-3"].links = [{ id: "link-flow", targetType: "flow", targetId: "reference-flow" }]
        await w.__mindMapDocumentHarness.reopen()
      })
      await page.getByRole("tab", { name: "大纲", exact: true }).click()
      await branch(page, "branch-3").press("Backspace")
      file = await save(page)
      expect(file.nodes["branch-3"].links).toEqual([{ id: "link-flow", targetType: "flow", targetId: "reference-flow" }])
      expect(Object.keys(file.nodes)).toHaveLength(7)
    })

    engineTest("标题回车进入首主题，Alt+Enter 保留主题内多行的兼容入口", async ({ page }) => {
      await openOutline(page)
      const before = await state(page)
      await title(page).press("Enter")
      await expect(branch(page)).toBeFocused()
      expect(await state(page)).toEqual(before)
      await setCaret(branch(page), 1)
      await branch(page).press("Alt+Enter")
      await page.keyboard.insertText("第二行")
      await expect(branch(page)).toHaveValue("主\n第二行题甲")
      await expect(note(page)).toHaveCount(0)
      const file = await save(page)
      expect(file.nodes["branch-1"].text).toBe("主\n第二行题甲")
      expect(Object.keys(file.nodes)).toHaveLength(4)
    })

    engineTest("宽窄大纲具有独立标题、紧凑正文和按需操作，长文不裁切或推动页面", async ({ page }) => {
      await openOutline(page, true)
      const evidence: unknown[] = []
      for (const width of [1280, 640]) {
        await page.setViewportSize({ width, height: 760 })
        await page.mouse.move(1, 1)
        await page.getByRole("tab", { name: "大纲", exact: true }).focus()
        const firstRow = page.locator('[data-outline-node="branch-1"]')
        const menu = firstRow.getByRole("button", { name: "主题操作：主题甲", exact: true })
        await expect.poll(() => menu.evaluate(element => Number(getComputedStyle(element.closest('[class*="actionsRow"]') ?? element).opacity))).toBe(0)
        await firstRow.hover()
        await expect.poll(() => menu.evaluate(element => Number(getComputedStyle(element.closest('[class*="actionsRow"]') ?? element).opacity))).toBe(1)
        const geometry = await outline(page).evaluate(viewport => {
          const input = viewport.querySelector<HTMLTextAreaElement>('[data-outline-node="branch-1"] textarea[aria-label="导图节点"]')!
          const child = viewport.querySelector<HTMLTextAreaElement>('[data-outline-node="child-1"] textarea[aria-label="导图节点"]')!
          const grandchild = viewport.querySelector<HTMLTextAreaElement>('[data-outline-node="grandchild"] textarea[aria-label="导图节点"]')!
          const root = viewport.querySelector<HTMLTextAreaElement>('textarea[aria-label="根节点"]')!
          const r = input.getBoundingClientRect()
          const row = input.closest<HTMLElement>('[data-outline-node]')!
          const rowBounds = row.getBoundingClientRect()
          const bullet = row.querySelector<HTMLElement>('button[aria-label^="聚焦主题："] > span')!
          const bulletBounds = bullet.getBoundingClientRect()
          const menuBounds = row.querySelector<HTMLElement>('button[aria-label^="主题操作："]')!.getBoundingClientRect()
          return { width: innerWidth, titleSize: parseFloat(getComputedStyle(root).fontSize), bodySize: parseFloat(getComputedStyle(input).fontSize),
            lineHeight: parseFloat(getComputedStyle(input).lineHeight), rowHeight: input.closest('[data-outline-node]')!.getBoundingClientRect().height,
            bodyWidth: r.width, bodyRightGap: rowBounds.right - r.right,
            bulletWidth: bulletBounds.width, bulletHeight: bulletBounds.height, bulletBackground: getComputedStyle(bullet).backgroundColor,
            menuOffset: menuBounds.x + menuBounds.width / 2 - bulletBounds.x - bulletBounds.width / 2,
            firstIndent: child.getBoundingClientRect().x - r.x,
            secondIndent: grandchild.getBoundingClientRect().x - child.getBoundingClientRect().x,
            titleTop: root.getBoundingClientRect().top, bodyTop: r.top, bodyBackground: getComputedStyle(input).backgroundColor,
            bodyOutline: getComputedStyle(input).outlineStyle, fontFamily: getComputedStyle(input).fontFamily,
            pageOverflow: document.documentElement.scrollWidth - innerWidth, windowScroll: scrollY }
        })
        expect(geometry.titleSize).toBeGreaterThan(geometry.bodySize)
        expect(geometry.bodySize).toBeGreaterThanOrEqual(16)
        expect(geometry.rowHeight).toBeLessThanOrEqual(40)
        expect(geometry.bodyTop).toBeGreaterThan(geometry.titleTop)
        expect(geometry.firstIndent).toBe(28)
        expect(geometry.secondIndent).toBe(28)
        expect(geometry.bulletWidth).toBe(6)
        expect(geometry.bulletHeight).toBe(6)
        expect(Math.abs(geometry.menuOffset + 28)).toBeLessThanOrEqual(1)
        expect(geometry.bodyRightGap).toBeLessThanOrEqual(4)
        expect(geometry.bodyBackground).toBe("rgba(0, 0, 0, 0)")
        expect(geometry.bodyOutline).toBe("none")
        expect(geometry.bodyWidth).toBeGreaterThan(260)
        expect(geometry.pageOverflow).toBeLessThanOrEqual(1)
        expect(geometry.windowScroll).toBe(0)
        expect(geometry.fontFamily).toContain("Noto Sans SC")
        evidence.push(geometry)
        await page.screenshot({ path: width === 1280
          ? `tests/evidence/mind-map-outline-children-${browserName}.png`
          : `tests/evidence/mind-map-outline-children-${browserName}-narrow.png` })
      }
      await branch(page, "grandchild").fill("长主题需要在当前层级完整换行，不能与后续主题相互覆盖，也不能让编辑区出现横向滚动。".repeat(6))
      const long = await branch(page, "grandchild").evaluate(element => {
        const input = element as HTMLTextAreaElement
        const viewport = input.closest<HTMLElement>("[data-mind-map-outline]")!
        return { height: input.clientHeight, clipped: input.scrollHeight - input.clientHeight,
          horizontalOverflow: input.scrollWidth - input.clientWidth, viewportOverflow: viewport.scrollWidth - viewport.clientWidth,
          windowScroll: scrollY, documentScroll: document.documentElement.scrollTop }
      })
      expect(long.height).toBeGreaterThan(50)
      expect(long.clipped).toBeLessThanOrEqual(1)
      expect(long.horizontalOverflow).toBeLessThanOrEqual(1)
      expect(long.viewportOverflow).toBeLessThanOrEqual(1)
      expect(long.windowScroll).toBe(0)
      expect(long.documentScroll).toBe(0)
      writeFileSync(`tests/evidence/mind-map-outline-children-${browserName}.json`, JSON.stringify({ geometry: evidence, long }, null, 2))
    })

    engineTest("祖先竖线贯穿多行子树且不越界，折叠外圈和聚焦范围随主题树更新", async ({ page }) => {
      await openOutline(page, true)
      await branch(page, "child-1").fill("多行子主题\n第二行应沿用同一条祖先线\n第三行继续保持对齐")
      await branch(page, "child-2").press("Shift+Enter")
      await note(page).fill("子主题描述\n第二行说明\n第三行说明")
      await note(page).press("Shift+Enter")
      const initial = await expectGuideLayout(page, {
        "child-1": ["branch-1"], grandchild: ["branch-1", "child-1"], "child-2": ["branch-1"],
      })
      expect(initial.find(row => row.id === "child-1")!.height).toBeGreaterThan(70)
      expect(initial.find(row => row.id === "child-2")!.height).toBeGreaterThan(80)
      const parentRow = page.locator('[data-outline-node="branch-1"]')
      await parentRow.getByRole("button", { name: "折叠 主题甲", exact: true }).click()
      await expect(parentRow).toHaveAttribute("data-collapsed", "true")
      await expectGuideLayout(page, {})
      const ring = await parentRow.getByRole("button", { name: "聚焦主题：主题甲", exact: true }).evaluate(button => {
        const style = getComputedStyle(button, "::before")
        return { width: parseFloat(style.width), height: parseFloat(style.height), content: style.content, background: style.backgroundColor }
      })
      expect(ring.width).toBe(18)
      expect(ring.height).toBe(18)
      expect(ring.content).not.toBe("none")
      expect(ring.background).not.toBe("rgba(0, 0, 0, 0)")
      await save(page)
      const beforeFocus = await state(page)
      await parentRow.getByRole("button", { name: "聚焦主题：主题甲", exact: true }).click()
      await expect(title(page)).toHaveValue("主题甲")
      await expectGuideLayout(page, { grandchild: ["child-1"] })
      expect(await state(page)).toEqual(beforeFocus)
      await page.getByRole("button", { name: "返回完整大纲", exact: true }).click()
      await expectGuideLayout(page, {})
      await expect(parentRow).toHaveAttribute("data-collapsed", "true")
      await parentRow.getByRole("button", { name: "展开 主题甲", exact: true }).click()
      await expectGuideLayout(page, {
        "child-1": ["branch-1"], grandchild: ["branch-1", "child-1"], "child-2": ["branch-1"],
      })
    })

    engineTest("左侧主题菜单独立命中并只选中当前整行，正文输入与折叠聚焦不相互干扰", async ({ page }) => {
      await openOutline(page, true)
      const row = page.locator('[data-outline-node="branch-1"]')
      const menu = row.getByRole("button", { name: "主题操作：主题甲", exact: true })
      await branch(page).click()
      await expect(row).toHaveAttribute("data-topic-selected", "false")
      expect(await row.evaluate(element => getComputedStyle(element).backgroundColor)).toBe("rgba(0, 0, 0, 0)")
      await branch(page).press("Escape")
      await expect(outline(page)).toBeFocused()
      await expect(outline(page).locator('[data-topic-selected="true"]')).toHaveCount(0)
      await page.keyboard.press("ArrowDown")
      await expect(branch(page, "child-1")).toBeFocused()
      await expect(outline(page).locator('[data-topic-selected="true"]')).toHaveCount(0)
      await branch(page).click()
      await row.hover()
      const hitboxes = await row.evaluate(element => {
        const menu = element.querySelector<HTMLButtonElement>('button[aria-label^="主题操作："]')!
        const toggle = element.querySelector<HTMLButtonElement>('button[aria-expanded]')!
        const bullet = element.querySelector<HTMLButtonElement>('button[aria-label^="聚焦主题："]')!
        const m = menu.getBoundingClientRect(), t = toggle.getBoundingClientRect(), b = bullet.getBoundingClientRect()
        const hits = [menu, toggle, bullet].map(button => {
          const r = button.getBoundingClientRect()
          return button.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))
        })
        return { menuLeft: m.left, menuRight: m.right, toggleRight: t.right, bulletLeft: b.left, hits }
      })
      expect(hitboxes.hits).toEqual([true, true, true])
      expect(hitboxes.menuLeft, "折叠按钮与菜单点击区域不重叠").toBeGreaterThanOrEqual(hitboxes.toggleRight)
      expect(hitboxes.menuRight, "菜单与圆点点击区域不重叠").toBeLessThanOrEqual(hitboxes.bulletLeft)
      await menu.click()
      await expect(page.getByRole("menuitem", { name: "添加同级节点", exact: true })).toBeVisible()
      await expect(row).toHaveAttribute("data-topic-selected", "true")
      await expect(outline(page).locator('[data-topic-selected="true"]')).toHaveCount(1)
      expect(await row.evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)")
      expect(await page.locator('[data-outline-node="child-1"]').evaluate(element => getComputedStyle(element).backgroundColor)).toBe("rgba(0, 0, 0, 0)")
      await page.keyboard.press("Escape")
      await expect(row).toHaveAttribute("data-topic-selected", "false")
      await branch(page).click()
      expect(await row.evaluate(element => getComputedStyle(element).backgroundColor)).toBe("rgba(0, 0, 0, 0)")
      await row.getByRole("button", { name: "折叠 主题甲", exact: true }).click()
      await expect(branches(page)).toHaveCount(3)
      await expect(title(page)).toHaveValue("中心主题")
      await expect(outline(page).locator('[data-topic-selected="true"]')).toHaveCount(0)
      await row.getByRole("button", { name: "聚焦主题：主题甲", exact: true }).click()
      await expect(title(page)).toHaveValue("主题甲")
      await expect(branches(page)).toHaveCount(3)
      await expect(outline(page).locator('[data-topic-selected="true"]')).toHaveCount(0)
      await page.getByRole("button", { name: "返回完整大纲", exact: true }).click()
      await row.getByRole("button", { name: "展开 主题甲", exact: true }).click()
      await row.hover()
      await menu.click()
      await page.getByRole("menuitem", { name: "添加同级节点", exact: true }).click()
      const newInput = page.locator('textarea[data-outline-field="text"]:focus')
      await expect(newInput).toHaveValue("")
      await page.keyboard.insertText("左侧菜单创建")
      const file = await save(page)
      expect(Object.values(file.nodes).find(node => node.text === "左侧菜单创建")?.parentId).toBe(file.rootId)
      expect(file.nodes["grandchild"].parentId).toBe("child-1")
      expect(Object.keys(file.nodes)).toHaveLength(8)
      // Commands from the portal belong to this workspace; removing its topic also discards the old open-menu state.
      await page.locator('[data-outline-node="branch-2"]').getByRole("button", { name: "主题操作：主题乙", exact: true }).click()
      await page.getByRole("menuitem", { name: "添加子节点", exact: true }).click()
      const emptyId = await page.locator('textarea[data-outline-field="text"]:focus').evaluate(element => element.closest<HTMLElement>("[data-outline-node]")!.dataset.outlineNode!)
      await page.locator(`[data-outline-node="${emptyId}"]`).getByRole("button", { name: "主题操作：未命名", exact: true }).click()
      await page.evaluate(() => {
        const testWindow = window as Window & { __outlineMenuSavePrevented?: boolean }
        testWindow.__outlineMenuSavePrevented = undefined
        const inspect = (event: KeyboardEvent) => {
          if (event.key.toLowerCase() !== "s" || !(event.ctrlKey || event.metaKey)) return
          queueMicrotask(() => { testWindow.__outlineMenuSavePrevented = event.defaultPrevented })
          window.removeEventListener("keydown", inspect)
        }
        window.addEventListener("keydown", inspect)
      })
      await page.keyboard.press("ControlOrMeta+s")
      await expect.poll(() => page.evaluate(() => (window as Window & { __outlineMenuSavePrevented?: boolean }).__outlineMenuSavePrevented)).toBe(true)
      await expect.poll(async () => (await state(page)).dirty).toBe(false)
      expect((await state(page)).file.nodes[emptyId]).toBeTruthy()
      await page.keyboard.press("ControlOrMeta+z")
      await expect(page.locator(`[data-outline-node="${emptyId}"]`)).toHaveCount(0)
      await expect(page.getByRole("menu")).toHaveCount(0)
      await expect.poll(() => outline(page).evaluate(element => element.contains(document.activeElement))).toBe(true)
      await page.keyboard.press("ControlOrMeta+Shift+z")
      await expect(page.locator(`[data-outline-node="${emptyId}"]`)).toHaveCount(1)
      await expect(page.getByRole("menu")).toHaveCount(0)
      await expect(outline(page).locator('[data-topic-selected="true"]')).toHaveCount(0)
    })

    engineTest("只有激活的主题菜单高亮，菜单单击切换与三种关闭方式正确恢复文字焦点", async ({ page }) => {
      await openOutline(page, true)
      const menuA = page.locator('[data-outline-node="branch-1"]').getByRole("button", { name: "主题操作：主题甲", exact: true })
      const menuB = page.locator('[data-outline-node="branch-2"]').getByRole("button", { name: "主题操作：主题乙", exact: true })
      await branch(page).press("Shift+Enter")
      await note(page).fill("备忘文字保留光标")
      await save(page)
      const before = await state(page)
      const expectNoteCaret = async () => {
        await expect(note(page)).toBeFocused()
        expect(await note(page).evaluate(element => {
          const input = element as HTMLTextAreaElement
          return [input.selectionStart, input.selectionEnd]
        })).toEqual([2, 4])
      }
      for (const close of ["escape", "trigger"] as const) {
        await setCaret(note(page), 2, 4)
        await menuA.click()
        await expect(page.locator('[data-outline-node="branch-1"]')).toHaveAttribute("data-topic-selected", "true")
        await expect(outline(page).locator('[data-topic-selected="true"]')).toHaveCount(1)
        if (close === "escape") await page.keyboard.press("Escape")
        else await menuA.click()
        await expect(outline(page).locator('[data-topic-selected="true"]')).toHaveCount(0)
        await expectNoteCaret()
      }
      await setCaret(note(page), 2, 4)
      await menuA.click()
      await menuB.click()
      await expect(page.locator('[data-outline-node="branch-1"]')).toHaveAttribute("data-topic-selected", "false")
      await expect(page.locator('[data-outline-node="branch-2"]')).toHaveAttribute("data-topic-selected", "true")
      await expect(outline(page).locator('[data-topic-selected="true"]')).toHaveCount(1)
      await expect(page.getByRole("menu")).toHaveCount(1)
      await page.keyboard.press("Escape")
      await expect(outline(page).locator('[data-topic-selected="true"]')).toHaveCount(0)
      await expect(branch(page, "branch-2")).toBeFocused()
      await setCaret(note(page), 2, 4)
      await menuA.click()
      await branch(page, "branch-3").click()
      await expect(outline(page).locator('[data-topic-selected="true"]')).toHaveCount(0)
      await expect(branch(page, "branch-3")).toBeFocused()
      await menuA.click()
      await page.getByRole("menuitem", { name: "编辑主题", exact: true }).click()
      await expect(branch(page)).toBeFocused()
      await expect(outline(page).locator('[data-topic-selected="true"]')).toHaveCount(0)
      await menuA.click()
      await page.getByRole("menuitem", { name: "编辑描述", exact: true }).click()
      await expect(note(page)).toBeFocused()
      await expect(outline(page).locator('[data-topic-selected="true"]')).toHaveCount(0)
      expect(await state(page)).toEqual(before)
      await menuA.click()
      await page.getByRole("menuitem", { name: "聚焦主题", exact: true }).click()
      await expect(title(page)).toHaveValue("主题甲")
      await expect(outline(page)).toBeFocused()
      await page.keyboard.press("Enter")
      const newInput = page.locator('textarea[data-outline-field="text"]:focus')
      await expect(newInput).toHaveValue("")
      await page.keyboard.insertText("菜单聚焦后的新主题")
      expect(Object.values((await save(page)).nodes).find(node => node.text === "菜单聚焦后的新主题")?.parentId).toBe("branch-1")
    })

    engineTest("主题菜单轻量显示元数据且宽窄不越界，移动边界准确并将焦点交给结果主题", async ({ page }) => {
      await openOutline(page, true)
      const metadataBefore = (await state(page)).file.nodes["branch-1"]
      const evidence: unknown[] = []
      const closeMenus = async () => {
        await page.getByRole("tab", { name: "大纲", exact: true }).click()
        await expect(page.getByRole("menu")).toHaveCount(0)
        await expect(outline(page).locator('[data-topic-selected="true"]')).toHaveCount(0)
      }
      for (const width of [1280, 640]) {
        await page.setViewportSize({ width, height: 760 })
        await page.locator('[data-outline-node="branch-1"]').getByRole("button", { name: "主题操作：主题甲", exact: true }).click()
        const popup = page.getByRole("menu", { name: "主题操作：主题甲", exact: true })
        await expect(popup).toBeVisible()
        // Wait for the popup's entrance scale to settle before measuring its rendered controls.
        await expect.poll(async () => (await popup.getByRole("menuitem", { name: "编辑主题", exact: true }).boundingBox())?.height).toBe(32)
        const meta = popup.locator("[data-outline-menu-meta]")
        await expect(meta).toContainText("编辑于")
        await expect(meta).toContainText(/主题字数\s*3/)
        await expect(meta.locator("time")).toHaveAttribute("datetime", metadataBefore.updatedAt)
        const geometry = await popup.evaluate(element => {
          const rect = element.getBoundingClientRect(), style = getComputedStyle(element)
          const item = element.querySelector<HTMLElement>('[role="menuitem"]')!
          const itemStyle = getComputedStyle(item)
          const icon = item.querySelector("svg")!.getBoundingClientRect()
          return { viewportWidth: innerWidth, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
            width: rect.width, viewportHeight: innerHeight, radius: parseFloat(style.borderRadius), shadow: style.boxShadow,
            fontSize: parseFloat(style.fontSize), weight: style.fontWeight, itemHeight: item.getBoundingClientRect().height,
            itemFontSize: parseFloat(itemStyle.fontSize), itemWeight: itemStyle.fontWeight, iconWidth: icon.width,
            metaFontSize: parseFloat(getComputedStyle(element.querySelector('[data-outline-menu-meta]')!).fontSize) }
        })
        expect(geometry.left).toBeGreaterThanOrEqual(0)
        expect(geometry.right).toBeLessThanOrEqual(width)
        expect(geometry.top).toBeGreaterThanOrEqual(0)
        expect(geometry.bottom).toBeLessThanOrEqual(geometry.viewportHeight)
        expect(geometry.width).toBeLessThanOrEqual(360)
        expect(geometry.radius).toBe(6)
        expect(geometry.shadow).not.toBe("none")
        expect(geometry.fontSize).toBe(14)
        expect(geometry.weight).toBe("400")
        expect(geometry.itemFontSize).toBe(14)
        expect(geometry.itemWeight).toBe("400")
        expect(geometry.itemHeight).toBeGreaterThanOrEqual(32)
        expect(geometry.itemHeight).toBeLessThanOrEqual(36)
        expect(geometry.iconWidth).toBe(16)
        expect(geometry.metaFontSize).toBe(12)
        evidence.push(geometry)
        await page.screenshot({ path: `tests/evidence/mind-map-outline-menu-${browserName}-${width}.png`, animations: "disabled" })
        await page.getByRole("menuitem", { name: "移动主题", exact: true }).click()
        await expect(page.getByRole("menuitem", { name: "上移", exact: true })).toBeDisabled()
        await expect(page.getByRole("menuitem", { name: "下移", exact: true })).toBeEnabled()
        await expect(page.getByRole("menuitem", { name: "缩进", exact: true })).toBeDisabled()
        await expect(page.getByRole("menuitem", { name: "反缩进", exact: true })).toBeDisabled()
        await expect.poll(async () => (await page.getByRole("menuitem", { name: "下移", exact: true }).boundingBox())?.height).toBe(32)
        const submenus = await page.getByRole("menu").evaluateAll(elements => elements.map(element => {
          const rect = element.getBoundingClientRect()
          return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, size: parseFloat(getComputedStyle(element).fontSize) }
        }))
        expect(submenus).toHaveLength(2)
        const [parentMenu, childMenu] = submenus
        const gap = Math.max(childMenu.left - parentMenu.right, parentMenu.left - childMenu.right)
        expect(gap, "子菜单紧贴父菜单外缘，不覆盖父菜单内边距或边框").toBeGreaterThanOrEqual(0)
        expect(gap, "父子菜单之间不留宽缝").toBeLessThanOrEqual(4)
        evidence.push({ submenus, gap })
        for (const submenu of submenus) {
          expect(submenu.left).toBeGreaterThanOrEqual(0)
          expect(submenu.right).toBeLessThanOrEqual(width)
          expect(submenu.top).toBeGreaterThanOrEqual(0)
          expect(submenu.bottom).toBeLessThanOrEqual(760)
          expect(submenu.size).toBe(14)
        }
        await page.screenshot({ path: `tests/evidence/mind-map-outline-submenu-${browserName}-${width}.png`, animations: "disabled" })
        await page.getByRole("menuitem", { name: "下移", exact: true }).hover()
        await expect(page.getByRole("menu")).toHaveCount(2)
        await closeMenus()
      }
      await page.locator('[data-outline-node="root"]').getByRole("button", { name: "主题操作：中心主题", exact: true }).click()
      await expect(page.getByRole("menuitem", { name: "移动主题", exact: true })).toBeDisabled()
      await expect(page.getByRole("menuitem", { name: "删除节点及子节点", exact: true })).toBeDisabled()
      await closeMenus()
      await page.locator('[data-outline-node="branch-3"]').getByRole("button", { name: "主题操作：主题丙", exact: true }).click()
      await page.getByRole("menuitem", { name: "移动主题", exact: true }).click()
      await expect(page.getByRole("menuitem", { name: "下移", exact: true })).toBeDisabled()
      await expect(page.getByRole("menuitem", { name: "上移", exact: true })).toBeEnabled()
      await expect(page.getByRole("menuitem", { name: "缩进", exact: true })).toBeEnabled()
      await page.getByRole("menuitem", { name: "上移", exact: true }).click()
      await expect(branch(page, "branch-3")).toBeFocused()
      await expect(outline(page).locator('[data-topic-selected="true"]')).toHaveCount(0)
      let file = await save(page)
      const ordered = Object.values(file.nodes).filter(node => node.parentId === file.rootId)
        .sort((a, b) => a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0).map(node => node.id)
      expect(ordered).toEqual(["branch-1", "branch-3", "branch-2"])
      await page.locator('[data-outline-node="child-1"]').getByRole("button", { name: "主题操作：子主题甲", exact: true }).click()
      // The preceding menu may still be completing its exit animation after moving the topic.
      await expect(page.getByRole("menu")).toHaveCount(1)
      await page.getByRole("menu", { name: "主题操作：子主题甲", exact: true }).getByRole("menuitem", { name: "移动主题", exact: true }).click()
      await expect(page.getByRole("menuitem", { name: "反缩进", exact: true })).toBeEnabled()
      await page.getByRole("menuitem", { name: "反缩进", exact: true }).click()
      await expect(branch(page, "child-1")).toBeFocused()
      file = await save(page)
      expect(file.nodes["child-1"].parentId).toBe(file.rootId)
      expect(file.nodes["grandchild"].parentId).toBe("child-1")
      expect(Object.keys(file.nodes)).toHaveLength(7)
      writeFileSync(`tests/evidence/mind-map-outline-menu-${browserName}.json`, JSON.stringify(evidence, null, 2))
    })

    engineTest("圆点与层级线同轴且菜单周围留白，多行主题和描述不移动首行锚点", async ({ page }) => {
      await openOutline(page, true)
      const childRow = page.locator('[data-outline-node="child-1"]')
      const anchor = () => childRow.evaluate(row => {
        const r = row.getBoundingClientRect()
        const bullet = row.querySelector<HTMLElement>('button[aria-label^="聚焦主题："] > span')!.getBoundingClientRect()
        const menu = row.querySelector<HTMLElement>('button[aria-label^="主题操作："]')!.getBoundingClientRect()
        return { bulletCenter: bullet.y + bullet.height / 2 - r.top, menuCenter: menu.y + menu.height / 2 - r.top, height: r.height }
      })
      const beforeText = await anchor()
      await branch(page, "child-1").fill("多行主题第一行\n第二行仍沿首行锚点\n第三行与层级线保持距离")
      await branch(page, "child-1").press("Shift+Enter")
      await note(page).fill("描述第一行\n描述第二行\n描述第三行")
      await page.getByRole("tab", { name: "大纲", exact: true }).focus()
      const afterText = await anchor()
      expect(afterText.height).toBeGreaterThan(beforeText.height * 3)
      expect(Math.abs(afterText.bulletCenter - beforeText.bulletCenter)).toBeLessThanOrEqual(0.1)
      expect(Math.abs(afterText.menuCenter - beforeText.menuCenter)).toBeLessThanOrEqual(0.1)
      const evidence: unknown[] = []
      for (const width of [1280, 640]) {
        await page.setViewportSize({ width, height: 760 })
        await page.getByRole("tab", { name: "大纲", exact: true }).focus()
        await page.mouse.move(1, 1)
        const menu = childRow.locator('button[aria-label^="主题操作："]')
        const opacity = () => menu.evaluate(element => Number(getComputedStyle(element.closest('[class*="actionsRow"]') ?? element).opacity))
        await expect.poll(opacity).toBe(0)
        const geometry = await childRow.evaluate(row => {
          const rect = row.getBoundingClientRect()
          const guide = row.querySelector<HTMLElement>('[data-outline-guide="branch-1"]')!
          const g = guide.getBoundingClientRect()
          const menu = row.querySelector<HTMLElement>('button[aria-label^="主题操作："]')!.getBoundingClientRect()
          const parent = document.querySelector<HTMLElement>('[data-outline-node="branch-1"] button[aria-label^="聚焦主题："] > span')!.getBoundingClientRect()
          return { width: innerWidth, rowTop: rect.top, rowBottom: rect.bottom, guideX: g.x + g.width / 2,
            parentX: parent.x + parent.width / 2, parentBottom: parent.bottom, guideTop: g.top,
            menuX: menu.x + menu.width / 2, menuTop: menu.top, menuBottom: menu.bottom, menuHeight: menu.height }
        })
        expect(Math.abs(geometry.guideX - geometry.parentX)).toBeLessThanOrEqual(0.1)
        expect(Math.abs(geometry.menuX - geometry.guideX)).toBeLessThanOrEqual(0.1)
        expect(geometry.guideTop - geometry.parentBottom, "父主题圆点与下方层级线之间有可见留白").toBeGreaterThanOrEqual(4)
        expect(geometry.menuHeight).toBe(18)
        const hidden = await sampleGuidePaint(page, geometry.guideX, geometry.rowTop, geometry.rowBottom, geometry.menuTop, geometry.menuBottom)
        expect(hidden.above.length).toBeGreaterThanOrEqual(4)
        expect(hidden.below.length).toBeGreaterThanOrEqual(4)
        for (const pixel of [...hidden.above, ...hidden.below, ...hidden.distant]) expect(pixel.ink, "菜单隐藏时祖先线连续绘制").toBeGreaterThan(2)
        await childRow.hover()
        await expect.poll(opacity).toBe(1)
        const visible = await sampleGuidePaint(page, geometry.guideX, geometry.rowTop, geometry.rowBottom, geometry.menuTop, geometry.menuBottom)
        for (const pixel of [...visible.above, ...visible.below]) expect(pixel.ink, "菜单外缘上下各4px内不绘制层级线").toBeLessThanOrEqual(1)
        expect(visible.distant.length).toBeGreaterThan(8)
        for (const pixel of [...visible.beforeMenu, ...visible.distant]) {
          expect(pixel.ink, "菜单留白之外继续绘制祖先线").toBeGreaterThan(2)
          const previous = [...hidden.beforeMenu, ...hidden.distant].find(sample => sample.y === pixel.y)!
          expect(Math.abs(pixel.ink - previous.ink), "留白外的线条墨量不因渐变或图层抗锯齿而变淡").toBeLessThanOrEqual(1)
        }
        const activeBackgroundImage = await childRow.locator('[data-outline-guide="branch-1"]').evaluate(element => getComputedStyle(element).backgroundImage)
        evidence.push({ geometry, hidden, visible, backgroundImage: activeBackgroundImage })
        await page.screenshot({ path: `tests/evidence/mind-map-outline-axis-${browserName}-${width}.png`, animations: "disabled" })
        await page.mouse.move(1, 1)
        await expect.poll(opacity).toBe(0)
        const restored = await sampleGuidePaint(page, geometry.guideX, geometry.rowTop, geometry.rowBottom, geometry.menuTop, geometry.menuBottom)
        for (const pixel of [...restored.above, ...restored.below]) expect(pixel.ink, "移走鼠标后菜单附近层级线恢复连续").toBeGreaterThan(2)
        // Keyboard focus and a portal menu retain the same gap even after the mouse leaves the row.
        await menu.focus()
        await expect.poll(opacity).toBe(1)
        await expect.poll(() => childRow.locator('[data-outline-guide="branch-1"]').evaluate(element => getComputedStyle(element).backgroundImage)).toBe(activeBackgroundImage)
        await menu.press("Enter")
        await expect(page.getByRole("menuitem", { name: "添加同级节点", exact: true })).toBeVisible()
        await page.mouse.move(1, 1)
        // The popup casts a shadow over this column; verify the same transparent paint stops remain active.
        const portalBackgroundImage = await childRow.locator('[data-outline-guide="branch-1"]').evaluate(element => getComputedStyle(element).backgroundImage)
        expect(portalBackgroundImage).toBe(activeBackgroundImage)
        await page.keyboard.press("Escape")
        await expect(page.getByRole("menuitem", { name: "添加同级节点", exact: true })).toHaveCount(0)
        await expect(note(page)).toBeFocused()
        await page.getByRole("tab", { name: "大纲", exact: true }).focus()
        evidence.push({ width, focusAndPortal: { backgroundImage: portalBackgroundImage } })
      }
      // Exercise the coarse-pointer CSS in a separate browser context; this is not native touch-device acceptance.
      const touchPage = await page.context().browser()!.newPage({ baseURL: "http://127.0.0.1:1420", viewport: { width: 640, height: 760 }, hasTouch: true })
      try {
        await openOutline(touchPage, true)
        await touchPage.getByRole("tab", { name: "大纲", exact: true }).focus()
        await touchPage.mouse.move(1, 1)
        const touch = await touchPage.locator('[data-outline-node="child-1"]').evaluate(row => {
          const r = row.getBoundingClientRect()
          const guide = row.querySelector<HTMLElement>('[data-outline-guide="branch-1"]')!
          const g = guide.getBoundingClientRect()
          const menu = row.querySelector<HTMLElement>('button[aria-label^="主题操作："]')!
          const m = menu.getBoundingClientRect()
          return { coarse: matchMedia("(pointer: coarse)").matches, backgroundImage: getComputedStyle(guide).backgroundImage,
            opacity: Number(getComputedStyle(menu.closest('[class*="actionsRow"]')!).opacity),
            guideX: g.x + g.width / 2, rowTop: r.top, rowBottom: r.bottom, menuTop: m.top, menuBottom: m.bottom }
        })
        expect(touch.coarse).toBe(true)
        expect(touch.opacity).toBe(1)
        expect(touch.backgroundImage).toContain("linear-gradient")
        evidence.push({ touch })
      } finally { await touchPage.close() }
      writeFileSync(`tests/evidence/mind-map-outline-axis-${browserName}.json`, JSON.stringify(evidence, null, 2))
    })

    engineTest("快捷键帮助按大纲与导图分别说明 Tab 和描述语义", async ({ page }) => {
      await openOutline(page)
      await page.getByRole("button", { name: "快捷键", exact: true }).click()
      const help = page.getByRole("complementary", { name: "思维导图快捷键", exact: true })
      await expect(help).toContainText("缩进当前主题")
      await expect(help).toContainText("进入主题描述")
      await expect(help).toContainText("描述内换行")
      await expect(help).not.toContainText("新建子主题")
      await page.getByRole("tab", { name: "思维导图", exact: true }).click()
      await expect(help).toContainText("新建子主题")
      await expect(help).toContainText("文字内换行")
      await expect(help).not.toContainText("进入主题描述")
      expect((await state(page)).dirty).toBe(false)
    })
  })
}
