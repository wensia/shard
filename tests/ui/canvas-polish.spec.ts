import { expect, test, type Page } from "@playwright/test"
import type { CanvasReadResult } from "../../src/features/canvas/model"

// Exercise the engine used by the macOS canvas. Storage is isolated in the browser harness.
test.use({ browserName: "webkit" })

type Harness = Window & {
  __canvasMock: { disk: CanvasReadResult }
  __canvasHarness: { flush(): Promise<boolean> }
}
const kinds = { 流程: "process", 判断: "decision", 起止: "terminal", 文本: "text", 新建思维导图: "mindmap" } as const
const flush = (page: Page) => page.evaluate(() => (window as Harness).__canvasHarness.flush())
const disk = (page: Page) => page.evaluate(() => (window as Harness).__canvasMock.disk.file)
const editor = (page: Page) => page.getByRole("textbox", { name: "节点文字", exact: true })
const node = (page: Page, kind: string) => page.locator(`[data-canvas-kind="${kind}"]`).last()

async function open(page: Page) {
  await page.goto("/canvas-workspace-test.html?mock=1")
  await expect(page.getByRole("button", { name: "添加对象", exact: true })).toBeVisible()
  await page.evaluate(() => document.fonts.ready)
}

async function add(page: Page, name: keyof typeof kinds) {
  const objects = page.locator(`[data-canvas-kind="${kinds[name]}"]`)
  const count = await objects.count()
  await page.getByRole("button", { name: "添加对象", exact: true }).click()
  await page.getByRole("menuitem", { name, exact: true }).click()
  await expect(objects).toHaveCount(count + 1)
}

async function clearSelection(page: Page) {
  const viewport = (await page.locator(".shard-canvas-viewport").boundingBox())!
  await page.mouse.click(viewport.x + 12, viewport.y + 12)
  await page.mouse.move(viewport.x + 12, viewport.y + 12)
  await expect(page.locator(".react-flow__node.selected")).toHaveCount(0)
}

async function geometry(object: Locator) {
  return object.evaluate(element => {
    const box = element.getBoundingClientRect()
    const label = element.querySelector(".shard-canvas-node-label")!
    const labelBox = label.getBoundingClientRect()
    const range = document.createRange()
    range.selectNodeContents(label)
    const text = range.getBoundingClientRect()
    const style = getComputedStyle(element)
    const before = getComputedStyle(element, "::before")
    const polygon = element.querySelector(".shard-canvas-shape polygon")
    return {
      box: { x: box.x, y: box.y, width: box.width, height: box.height },
      label: { x: labelBox.x, y: labelBox.y, width: labelBox.width, height: labelBox.height },
      text: { x: text.x, y: text.y, width: text.width, height: text.height },
      shape: { radius: style.borderRadius, clip: before.clipPath, points: polygon?.getAttribute("points") ?? null },
    }
  })
}

function expectSameBox(actual: { x: number; y: number; width: number; height: number }, expected: typeof actual) {
  for (const key of ["x", "y", "width", "height"] as const) expect(actual[key], `stable ${key} when entering/leaving text editing`).toBeCloseTo(expected[key], 0)
}

for (const [name, kind] of Object.entries(kinds).filter(([, value]) => value !== "mindmap")) {
  test(`WebKit ${name} 编辑只有对象轮廓，单行与多行切换不改变形状或排版`, async ({ page, browserName }) => {
    expect(browserName).toBe("webkit")
    await open(page)
    await add(page, name as keyof typeof kinds)
    // Insertion focuses the editor after the menu has fully closed.
    await expect(editor(page)).toBeFocused()
    const object = node(page, kind)
    const errors: string[] = []
    page.on("pageerror", error => errors.push(error.message))

    for (const text of ["确认需求", "整理需求\n确认范围\n开始实施"]) {
      if (!await editor(page).count()) await object.locator(".shard-canvas-node-label").dblclick()
      await editor(page).fill(text)
      await editor(page).press("ControlOrMeta+Enter")
      await expect(editor(page)).toHaveCount(0)
      await expect(object.locator(".shard-canvas-node-label")).toHaveText(text)
      const display = await geometry(object)

      await object.locator(".shard-canvas-node-label").dblclick()
      await expect(editor(page)).toBeFocused()
      await expect(editor(page)).toHaveValue(text)
      const editing = await geometry(object)
      expectSameBox(editing.box, display.box)
      expectSameBox(editing.label, display.label)
      expectSameBox(editing.text, display.text)
      expect(editing.shape).toEqual(display.shape)

      const styles = await editor(page).evaluate(element => {
        const style = getComputedStyle(element)
        const label = getComputedStyle(element.closest(".shard-canvas-object")!.querySelector(".shard-canvas-node-label")!)
        return {
          borders: [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth],
          outline: style.outlineStyle, shadow: style.boxShadow, resize: style.resize,
          background: style.backgroundColor, alignment: style.textAlign, labelAlignment: label.textAlign,
          font: style.fontFamily, labelFont: label.fontFamily, fontSize: style.fontSize, labelFontSize: label.fontSize,
          lineHeight: style.lineHeight, labelLineHeight: label.lineHeight,
          textPosition: (() => {
            const labelElement = element.closest(".shard-canvas-object")!.querySelector(".shard-canvas-node-label")!
            const range = document.createRange()
            range.selectNodeContents(labelElement)
            const labelText = range.getBoundingClientRect()
            const box = element.getBoundingClientRect()
            const scale = new DOMMatrixReadOnly(getComputedStyle(element.closest(".react-flow__viewport")!).transform).a
            const paddingLeft = parseFloat(style.paddingLeft) * scale
            const paddingRight = parseFloat(style.paddingRight) * scale
            const paddingTop = parseFloat(style.paddingTop) * scale
            const textHeight = (element.scrollHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)) * scale
            return {
              scale,
              editorY: box.y + paddingTop + textHeight / 2,
              labelY: labelText.y + labelText.height / 2,
              editorX: style.textAlign === "left" ? box.x + paddingLeft : box.x + paddingLeft + (box.width - paddingLeft - paddingRight) / 2,
              labelX: style.textAlign === "left" ? labelText.x : labelText.x + labelText.width / 2,
            }
          })(),
        }
      })
      expect(styles.borders).toEqual(["0px", "0px", "0px", "0px"])
      expect(styles.outline).toBe("none")
      expect(styles.shadow).toBe("none")
      expect(styles.resize).toBe("none")
      expect(styles.background).toBe("rgba(0, 0, 0, 0)")
      expect(styles.alignment).toBe(styles.labelAlignment)
      expect(styles.font).toBe(styles.labelFont)
      expect(styles.fontSize).toBe(styles.labelFontSize)
      expect(styles.lineHeight).toBe(styles.labelLineHeight)
      expect(Math.abs(styles.textPosition.editorX - styles.textPosition.labelX), "The editable text must use the same horizontal anchor as its displayed label").toBeLessThanOrEqual(2 * styles.textPosition.scale)
      expect(Math.abs(styles.textPosition.editorY - styles.textPosition.labelY), "The editable text must remain vertically aligned with its displayed label").toBeLessThanOrEqual(2 * styles.textPosition.scale)
      await expect(object.locator(".shard-canvas-node-label")).toHaveCSS("visibility", "hidden")
      await expect(object.locator("xpath=..")).toHaveCSS("outline-style", "none")
      if (kind === "decision") {
        await expect(object.locator(".shard-canvas-shape polygon")).toHaveAttribute("points", /\S+/)
        await expect(object).toHaveCSS("outline-style", "none")
      } else {
        await expect(object).toHaveCSS("outline-style", "solid")
      }
      if (kind === "terminal") expect(editing.shape.radius).toBe("50%")

      await editor(page).press("ControlOrMeta+Enter")
      await expect(object.locator(".shard-canvas-node-label")).toHaveCSS("visibility", "visible")
      expectSameBox((await geometry(object)).box, display.box)
    }

    expect(await flush(page)).toBe(true)
    expect((await disk(page)).nodes[0].text).toBe("整理需求\n确认范围\n开始实施")
    await page.getByRole("button", { name: "撤销", exact: true }).click()
    await expect(object.locator(".shard-canvas-node-label")).toHaveText("确认需求")
    await page.getByRole("button", { name: "重做", exact: true }).click()
    await expect(object.locator(".shard-canvas-node-label")).toHaveText("整理需求\n确认范围\n开始实施")
    expect(await flush(page)).toBe(true)
    await page.getByRole("button", { name: "重新打开", exact: true }).click()
    await expect(node(page, kind).locator(".shard-canvas-node-label")).toHaveText("整理需求\n确认范围\n开始实施")
    expect(errors).toEqual([])
  })
}

test("WebKit 混合多选框保持透明、使用主题色，Escape 清空选区及单对象面板", async ({ page }) => {
  await open(page)
  await add(page, "判断")
  await editor(page).press("ControlOrMeta+Enter")
  await expect(page.getByRole("complementary", { name: "画布对象面板" })).toBeVisible()
  await page.getByRole("button", { name: "关闭", exact: true }).click()
  await add(page, "流程")
  await editor(page).press("ControlOrMeta+Enter")
  await page.getByRole("button", { name: "适合画布", exact: true }).click()
  await clearSelection(page)

  const boxes = await page.locator(".react-flow__node").evaluateAll(elements => elements.map(element => {
    const box = element.getBoundingClientRect()
    return { x: box.x, y: box.y, right: box.right, bottom: box.bottom }
  }))
  const left = Math.min(...boxes.map(box => box.x)) - 16
  const top = Math.min(...boxes.map(box => box.y)) - 16
  const right = Math.max(...boxes.map(box => box.right)) + 16
  const bottom = Math.max(...boxes.map(box => box.bottom)) + 16
  expect(boxes[0].right <= boxes[1].x || boxes[1].right <= boxes[0].x || boxes[0].bottom <= boxes[1].y || boxes[1].bottom <= boxes[0].y, "A newly inserted process must not cover the existing mind map").toBe(true)
  await page.keyboard.down("Shift")
  await page.mouse.move(left, top)
  await page.mouse.down()
  await page.mouse.move(right, bottom, { steps: 12 })
  await page.mouse.up()
  await page.keyboard.up("Shift")
  await expect(page.locator(".react-flow__node.selected")).toHaveCount(2)
  const group = page.locator(".react-flow__nodesselection-rect")
  await expect(group).toBeVisible()
  await expect(group).toHaveCSS("background-color", "rgba(0, 0, 0, 0)")
  const colors = await group.evaluate(element => {
    const probe = document.createElement("span")
    probe.style.color = "var(--primary)"
    element.append(probe)
    const primary = getComputedStyle(probe).color
    probe.remove()
    return { primary, border: getComputedStyle(element).borderTopColor }
  })
  expect(colors.border).toBe(colors.primary)
  await expect(page.getByRole("complementary", { name: "画布对象面板" })).toHaveCount(0)
  await page.keyboard.press("Escape")
  await expect(page.locator(".react-flow__node.selected")).toHaveCount(0)
  await expect(group).toHaveCount(0)
  await expect(page.getByRole("button", { name: "删除", exact: true })).toBeDisabled()
  await expect(page.locator(".react-flow__node")).toHaveCount(2)
})

test("WebKit 连接点静息隐藏，悬停与键盘焦点可发现，连线期间目标连接点可见", async ({ page }) => {
  await open(page)
  await add(page, "流程")
  await editor(page).press("ControlOrMeta+Enter")
  await add(page, "判断")
  await editor(page).press("ControlOrMeta+Enter")
  await page.getByRole("button", { name: "适合画布", exact: true }).click()
  await clearSelection(page)
  const process = node(page, "process")
  const decision = node(page, "decision")
  const source = process.getByLabel("流程右侧连接点", { exact: true })
  const target = decision.getByLabel("判断左侧连接点", { exact: true })
  await expect(source).toHaveCSS("opacity", "0")
  await expect(target).toHaveCSS("opacity", "0")
  await process.hover()
  await expect(source).toHaveCSS("opacity", "1")
  await expect(target).toHaveCSS("opacity", "0")
  await clearSelection(page)
  await process.locator("xpath=..").focus()
  // Enter actual keyboard modality; programmatic focus after a pointer click is not :focus-visible.
  await page.keyboard.press("Tab")
  await page.keyboard.press("Shift+Tab")
  await expect(process.locator("xpath=..")).toBeFocused()
  await expect(source).toHaveCSS("opacity", "1")
  await clearSelection(page)
  await process.hover()
  const start = (await source.boundingBox())!
  const end = (await target.boundingBox())!
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2)
  await page.mouse.down()
  await page.mouse.move(start.x + start.width / 2 + 12, start.y + start.height / 2 + 12, { steps: 3 })
  await expect(target).toHaveCSS("opacity", "1")
  await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2, { steps: 12 })
  await page.mouse.up()
  await expect(page.locator(".react-flow__edge")).toHaveCount(1)
  expect(await flush(page)).toBe(true)
  expect((await disk(page)).edges).toHaveLength(1)
  await clearSelection(page)
  await expect(source).toHaveCSS("opacity", "0")
  await expect(target).toHaveCSS("opacity", "0")
})

test("WebKit 缩放百分比与真实视口一致，达到边界禁用，重置和适合画布可恢复", async ({ page }) => {
  await open(page)
  await add(page, "流程")
  await editor(page).press("ControlOrMeta+Enter")
  const reset = page.getByRole("button", { name: "重置缩放", exact: true })
  const zoomIn = page.getByRole("button", { name: "放大画布", exact: true })
  const zoomOut = page.getByRole("button", { name: "缩小画布", exact: true })
  const zoom = () => page.locator(".react-flow__viewport").evaluate(element => new DOMMatrixReadOnly(getComputedStyle(element).transform).a)
  const expectPercent = async () => {
    await expect.poll(async () => (await reset.textContent())?.trim()).toBe(`${Math.round(await zoom() * 100)}%`)
  }
  await expectPercent()
  for (let i = 0; i < 24 && await zoomIn.isEnabled(); i++) await zoomIn.click()
  await expect(zoomIn).toBeDisabled()
  expect(await zoom()).toBeCloseTo(2.5, 4)
  await expectPercent()
  await reset.click()
  await expect.poll(zoom).toBe(1)
  await expect(reset).toHaveText("100%")
  for (let i = 0; i < 32 && await zoomOut.isEnabled(); i++) await zoomOut.click()
  await expect(zoomOut).toBeDisabled()
  expect(await zoom()).toBeCloseTo(0.1, 4)
  await expectPercent()
  await page.getByRole("button", { name: "适合画布", exact: true }).click()
  await expect(zoomOut).toBeEnabled()
  await expect(zoomIn).toBeEnabled()
  await expectPercent()
  await expect(node(page, "process")).toBeVisible()
})

test("WebKit 连续新建六个流程各占空位，当前新对象始终可见且位置可保存", async ({ page }) => {
  await open(page)
  const placed: { id: string; x: number; y: number; width: number; height: number }[] = []
  for (let index = 0; index < 6; index++) {
    await add(page, "流程")
    await editor(page).fill(`流程 ${index + 1}`)
    await editor(page).press("ControlOrMeta+Enter")
    const object = node(page, "process")
    await expect(object).toBeInViewport({ ratio: 1 })
    expect(await flush(page)).toBe(true)
    const saved = (await disk(page)).nodes.at(-1)!
    const size = await object.evaluate(element => {
      const box = element.getBoundingClientRect()
      const zoom = new DOMMatrixReadOnly(getComputedStyle(element.closest(".react-flow__viewport")!).transform).a
      return { width: box.width / zoom, height: box.height / zoom }
    })
    placed.push({ id: saved.id, x: saved.x, y: saved.y, ...size })
  }
  for (const [index, a] of placed.entries()) for (const b of placed.slice(index + 1)) {
    expect(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y,
      `New objects ${a.id} and ${b.id} must not overlap`).toBe(true)
  }
  expect((await disk(page)).nodes.map(item => ({ id: item.id, x: item.x, y: item.y }))).toEqual(placed.map(({ id, x, y }) => ({ id, x, y })))
})

test("WebKit 流程面板按容器宽度浮出，矮窗口可以编辑", async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 720 })
  await open(page)
  const workspace = page.locator(".shard-canvas-workspace")
  await workspace.evaluate(element => { (element as HTMLElement).style.width = "440px" })
  await add(page, "流程")
  const panel = page.getByRole("complementary", { name: "画布对象面板" })
  await expect(panel).toHaveCSS("position", "absolute")
  const narrow = await workspace.evaluate(element => ({
    width: element.getBoundingClientRect().width,
    viewportWidth: element.querySelector(".shard-canvas-viewport")!.getBoundingClientRect().width,
    workspaceOverflow: element.scrollWidth > element.clientWidth,
    pageOverflow: document.documentElement.scrollWidth > innerWidth,
  }))
  expect(narrow.width).toBe(440); expect(narrow.viewportWidth).toBeCloseTo(narrow.width, 0)
  expect(narrow.workspaceOverflow).toBe(false); expect(narrow.pageOverflow).toBe(false)
  await workspace.evaluate(element => { (element as HTMLElement).style.removeProperty("width") })
  await page.setViewportSize({ width: 1000, height: 340 })
  await expect(panel.locator(".shard-canvas-inspector-body")).toHaveCSS("overflow-y", "auto")
  const field = page.getByRole("textbox", { name: "对象文字", exact: true })
  await field.scrollIntoViewIfNeeded(); await field.fill("矮窗口仍可编辑的流程")
  expect(await flush(page)).toBe(true)
  expect((await disk(page)).nodes[0].text).toBe("矮窗口仍可编辑的流程")
  expect(await page.evaluate(() => ({ x: scrollX, y: scrollY, overflow: document.documentElement.scrollWidth > innerWidth }))).toEqual({ x: 0, y: 0, overflow: false })
})
