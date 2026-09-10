import { expect, test, type Page } from "@playwright/test"
import type { CanvasFile, CanvasReadResult } from "../../src/features/canvas/model"

// This regression is specific to the WKWebView engine; the main workspace spec covers Chromium.
test.use({ browserName: "webkit" })

type Harness = Window & {
  __canvasMock: { disk: CanvasReadResult; hold: boolean; release(): void; calls: { command: string; request: unknown }[] }
  __canvasHarness: { flush(): Promise<boolean>; dirty(): boolean }
}
type SelectionMode = "selection rectangle" | "selected node"
type ScreenState = { zoom: number; originX: number; originY: number; nodes: { id: string; x: number; y: number; width: number; height: number }[] }
const flush = (page: Page) => page.evaluate(() => (window as Harness).__canvasHarness.flush())
const disk = (page: Page) => page.evaluate(() => (window as Harness).__canvasMock.disk.file)
const writes = (page: Page) => page.evaluate(() => (window as Harness).__canvasMock.calls.filter(call => call.command === "write_canvas").length)

async function drag(page: Page, start: { x: number; y: number }, dx: number, dy: number, checkGate = false, warmDrag = false) {
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  if (warmDrag) {
    // XYDrag starts its coordinate origin at the first movement beyond the drag threshold.
    await page.mouse.move(start.x + 3, start.y + 3)
    start = { x: start.x + 3, y: start.y + 3 }
  }
  await page.mouse.move(start.x + dx / 2, start.y + dy / 2, { steps: 6 })
  if (checkGate) expect(await flush(page), "A pointer-down group drag must block navigation/save until its gesture ends").toBe(false)
  await page.mouse.move(start.x + dx, start.y + dy, { steps: 6 })
  await page.mouse.up()
}

async function screen(page: Page): Promise<ScreenState> {
  await expect(page.locator(".react-flow__node")).toHaveCount(2)
  for (const node of await page.locator(".react-flow__node").all()) await expect(node).toHaveCSS("visibility", "visible")
  return page.locator(".react-flow").evaluate(element => {
    const container = element.getBoundingClientRect()
    const transform = new DOMMatrixReadOnly(getComputedStyle(element.querySelector(".react-flow__viewport")!).transform)
    return {
      zoom: transform.a, originX: container.x + transform.e, originY: container.y + transform.f,
      nodes: Array.from(element.querySelectorAll<HTMLElement>(".react-flow__node")).map(node => {
        const box = node.getBoundingClientRect()
        return { id: node.dataset.id!, x: box.x, y: box.y, width: box.width, height: box.height }
      }),
    }
  })
}

function expectScreenMoved(before: ScreenState, after: ScreenState, dx: number, dy: number) {
  expect(after.nodes.map(node => node.id).sort()).toEqual(before.nodes.map(node => node.id).sort())
  for (const node of before.nodes) {
    const moved = after.nodes.find(item => item.id === node.id)!
    expect(moved.x - node.x, `node ${node.id} horizontal movement`).toBeCloseTo(dx, 0)
    expect(moved.y - node.y, `node ${node.id} vertical movement`).toBeCloseTo(dy, 0)
  }
}

function expectStoredScreen(file: CanvasFile, state: ScreenState, original: CanvasFile) {
  expect(file.nodes.map(node => node.id)).toEqual(original.nodes.map(node => node.id))
  expect(file.nodes.find(node => node.kind === "decision")!.text).toEqual(original.nodes.find(node => node.kind === "decision")!.text)
  expect(file.nodes.find(node => node.kind === "process")!.text).toBe("一起移动的流程")
  for (const node of file.nodes) {
    const rendered = state.nodes.find(item => item.id === node.id)!
    expect(state.originX + node.x * state.zoom, `stored x for ${node.id}`).toBeCloseTo(rendered.x, 0)
    expect(state.originY + node.y * state.zoom, `stored y for ${node.id}`).toBeCloseTo(rendered.y, 0)
  }
}

async function selectBoth(page: Page, mode: SelectionMode) {
  // Clear the inspector and selection by clicking a known empty corner.
  const viewport = (await page.locator(".shard-canvas-viewport").boundingBox())!
  await page.mouse.click(viewport.x + 12, viewport.y + 12)
  if (mode === "selection rectangle") {
    const boxes = (await screen(page)).nodes
    const left = Math.min(...boxes.map(box => box.x)) - 20
    const top = Math.min(...boxes.map(box => box.y)) - 20
    const right = Math.max(...boxes.map(box => box.x + box.width)) + 20
    const bottom = Math.max(...boxes.map(box => box.y + box.height)) + 20
    await page.keyboard.down("Shift")
    await drag(page, { x: left, y: top }, right - left, bottom - top)
    await page.keyboard.up("Shift")
    await expect(page.locator(".react-flow__nodesselection-rect")).toBeVisible()
  } else {
    await page.locator('[data-canvas-kind="decision"] .shard-canvas-node-label').click()
    await page.keyboard.down("Shift")
    await page.locator('[data-canvas-kind="process"] .shard-canvas-node-label').click()
    await page.keyboard.up("Shift")
  }
  await expect(page.locator(".react-flow__node.selected")).toHaveCount(2)
}

async function groupDrag(page: Page, mode: SelectionMode, dx: number, dy: number, checkGate = false) {
  const target = mode === "selection rectangle" ? page.locator(".react-flow__nodesselection-rect") : page.locator('[data-canvas-kind="process"] .shard-canvas-node-label')
  const box = (await target.boundingBox())!
  await drag(page, { x: box.x + box.width / 2, y: box.y + box.height / 2 }, dx, dy, checkGate, true)
  await expect(page.locator(".react-flow__node.selected")).toHaveCount(2)
  await expect(page.getByRole("alert")).toHaveCount(0)
}

async function prepare(page: Page, mode: SelectionMode) {
  await page.goto("/canvas-workspace-test.html?mock=1")
  await page.getByRole("button", { name: "添加对象", exact: true }).click()
  await page.getByRole("menuitem", { name: "判断", exact: true }).click()
  const decisionText = page.getByRole("textbox", { name: "节点文字", exact: true })
  await decisionText.fill("连续拖动的判断")
  await decisionText.press("ControlOrMeta+Enter")
  expect(await flush(page)).toBe(true)
  await page.getByRole("button", { name: "添加对象", exact: true }).click()
  await page.getByRole("menuitem", { name: "流程", exact: true }).click()
  const text = page.getByRole("textbox", { name: "节点文字", exact: true })
  await text.fill("一起移动的流程"); await text.press("ControlOrMeta+Enter")
  const process = (await page.locator('[data-canvas-kind="process"] .shard-canvas-node-label').boundingBox())!
  await drag(page, { x: process.x + process.width / 2, y: process.y + 20 }, -340, 140)
  expect(await flush(page)).toBe(true)
  await page.getByRole("button", { name: "适合画布", exact: true }).click()
  await expect(page.locator('[data-canvas-kind="decision"]')).toContainText("连续拖动的判断")
  await selectBoth(page, mode)
  return disk(page)
}

for (const mode of ["selection rectangle", "selected node"] as const) {
  test(`WebKit 连续多选拖动 ${mode} 保留流程内容、一次撤销一手势且慢保存不回滚`, async ({ page, browserName }) => {
    test.setTimeout(60_000)
    expect(browserName).toBe("webkit")
    const pageErrors: string[] = []
    page.on("pageerror", error => pageErrors.push(error.message))
    const original = await prepare(page, mode)
    let current = await screen(page)
    let beforeLast = current
    for (const [index, [dx, dy]] of [[40, 20], [-25, 35], [55, -30]].entries()) {
      beforeLast = current
      await groupDrag(page, mode, dx, dy, index === 0)
      current = await screen(page)
      expectScreenMoved(beforeLast, current, dx, dy)
    }
    expect(await page.evaluate(() => (window as Harness).__canvasHarness.dirty())).toBe(true)
    await page.getByRole("button", { name: "撤销", exact: true }).click()
    expect(await flush(page)).toBe(true)
    expectStoredScreen(await disk(page), beforeLast, original)
    await page.getByRole("button", { name: "重做", exact: true }).click()
    expect(await flush(page)).toBe(true)
    expectStoredScreen(await disk(page), current, original)

    await selectBoth(page, mode)
    await page.evaluate(() => { (window as Harness).__canvasMock.hold = true })
    const initialWrites = await writes(page)
    await groupDrag(page, mode, -20, 15)
    await page.evaluate(() => { void (window as Harness).__canvasHarness.flush() })
    await expect.poll(() => writes(page)).toBe(initialWrites + 1)
    let held = await screen(page)
    for (const [dx, dy] of [[35, -20], [-15, 25]]) {
      await groupDrag(page, mode, dx, dy)
      const next = await screen(page)
      expectScreenMoved(held, next, dx, dy)
      held = next
    }
    await page.evaluate(() => (window as Harness).__canvasMock.release())
    expect(await flush(page)).toBe(true)
    expectStoredScreen(await disk(page), held, original)
    const afterResponse = await screen(page)
    expectScreenMoved(held, afterResponse, 0, 0)
    await expect(page.getByRole("alert")).toHaveCount(0)
    expect(pageErrors, "Repeated dragging must not cause a ResizeObserver feedback loop or another browser error").toEqual([])
  })
}
