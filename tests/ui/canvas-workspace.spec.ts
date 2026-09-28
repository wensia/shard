import { expect, test, type Page } from "@playwright/test"
import type { CanvasReadResult } from "../../src/features/canvas/model"
import type { Fragment } from "../../src/types"

type Harness = Window & {
  __canvasMock: { disk: CanvasReadResult; fragment: Fragment; hold: boolean; failSave: boolean; release(): void; calls: { command: string; request: Record<string, unknown> }[] }
  __canvasHarness: { flush(): Promise<boolean>; dirty(): boolean; block(value: boolean): void; opened: unknown[]; closed: number }
}
async function open(page: Page, extra = "") {
  await page.goto(`/canvas-workspace-test.html?mock=1${extra}`)
  await expect(page.getByRole("button", { name: "添加对象", exact: true })).toBeVisible()
}
async function add(page: Page, kind: string) {
  const nodeKind: Record<string, string> = { 流程: "process", 判断: "decision", 起止: "terminal", 文本: "text", 新建思维导图: "mindmap" }
  const selector = nodeKind[kind] && page.locator(`[data-canvas-kind="${nodeKind[kind]}"]`)
  const previousCount = selector ? await selector.count() : 0
  await page.getByRole("button", { name: "添加对象", exact: true }).click()
  await page.getByRole("menuitem", { name: kind, exact: true }).click()
  // Insertion completes when the menu has finished closing and released focus.
  if (selector) await expect(selector).toHaveCount(previousCount + 1)
  else await expect(page.getByRole("textbox", { name: kind === "资料引用" ? "搜索资料" : "搜索思维导图", exact: true })).toBeVisible()
}
async function openFragment(page: Page) { await open(page, "&fragment=1") }
const flush = (page: Page) => page.evaluate(() => (window as Harness).__canvasHarness.flush())
const disk = (page: Page) => page.evaluate(() => (window as Harness).__canvasMock.disk)
const object = (page: Page, kind = "process") => page.locator(`[data-canvas-kind="${kind}"]`).first()

test("文档属性只在流程图片段宿主出现", async ({ page }) => {
  await open(page)
  await expect(page.getByRole("button", { name: "文档属性", exact: true })).toHaveCount(0)
  await openFragment(page)
  await expect(page.getByRole("button", { name: "文档属性", exact: true })).toBeVisible()
})

test("文档属性先排空流程图，写入新基线后继续保存草稿", async ({ page }) => {
  await openFragment(page)
  await add(page, "流程")
  await page.getByRole("button", { name: "文档属性", exact: true }).click()

  const dialog = page.getByRole("dialog")
  await expect(dialog.getByRole("heading", { name: "文档属性", exact: true })).toBeVisible()
  await expect(page.locator("[data-canvas-workspace]")).toHaveAttribute("aria-busy", "true")
  await expect(page.locator(".shard-canvas-toolbar button").filter({ hasText: "添加对象" })).toBeDisabled()
  const callOrder = await page.evaluate(() => (window as Harness).__canvasMock.calls.map(call => call.command))
  expect(callOrder.indexOf("write_graph_fragment")).toBeGreaterThanOrEqual(0)
  expect(callOrder.indexOf("write_graph_fragment")).toBeLessThan(callOrder.indexOf("read_property_registry"))

  const panel = dialog.getByRole("region", { name: "属性" })
  await panel.getByLabel("阶段 属性值").fill("评审")
  await panel.getByLabel("阶段 属性值").press("Enter")
  await panel.getByRole("button", { name: "添加属性", exact: true }).click()
  await panel.getByLabel("属性名").fill("负责人")
  await panel.getByRole("button", { name: "添加", exact: true }).click()
  await panel.getByLabel("负责人 属性值").fill("甲")
  await panel.getByLabel("负责人 属性值").press("Enter")
  await expect.poll(() => page.evaluate(() => (window as Harness).__canvasMock.calls.filter(call => call.command === "set_fragment_property").length)).toBe(3)
  const propertySha = await page.evaluate(() => (window as Harness).__canvasMock.fragment.fileSha)

  await dialog.getByRole("button", { name: "关闭", exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await add(page, "判断")
  expect(await flush(page)).toBe(true)
  const graphWrites = await page.evaluate(() => (window as Harness).__canvasMock.calls.filter(call => call.command === "write_graph_fragment"))
  expect(graphWrites.at(-1)?.request.expectedFileSha).toBe(propertySha)
  await expect(page.getByText(/保存基线过期|冲突/)).toHaveCount(0)
})

test("流程图排空失败时不打开文档属性", async ({ page }) => {
  await openFragment(page)
  await add(page, "流程")
  await page.evaluate(() => { (window as Harness).__canvasMock.failSave = true })
  await page.getByRole("button", { name: "文档属性", exact: true }).click()
  await expect(page.getByRole("dialog")).toHaveCount(0)
  await expect(page.getByRole("alert")).toContainText("无法打开文档属性：请先处理图内容的保存问题。")
  await expect(page.getByRole("button", { name: "添加对象", exact: true })).toBeEnabled()
})

test("中文节点编辑、拖动与统一撤销保存后重新打开", async ({ page }) => {
  await open(page); await add(page, "流程")
  await object(page).dblclick()
  await page.getByRole("textbox", { name: "节点文字", exact: true }).fill("整理需求\n确认范围")
  await page.getByRole("textbox", { name: "节点文字", exact: true }).press("ControlOrMeta+Enter")
  expect(await flush(page)).toBe(true)
  const before = (await disk(page)).file.nodes[0]
  expect(before.text).toBe("整理需求\n确认范围")
  const box = (await object(page).boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + 25)
  await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + 95, box.y + 90, { steps: 8 }); await page.mouse.up()
  expect(await flush(page)).toBe(true)
  expect((await disk(page)).file.nodes[0].x).not.toBe(before.x)
  await page.getByRole("button", { name: "撤销", exact: true }).click(); expect(await flush(page)).toBe(true)
  expect((await disk(page)).file.nodes[0]).toMatchObject({ x: before.x, y: before.y, text: before.text })
  await page.getByRole("button", { name: "重新打开", exact: true }).click()
  await expect(object(page)).toContainText("整理需求")
  await expect(page.getByRole("alert")).toHaveCount(0)
})

test("慢保存保留后续输入，失败阻止离开，重试后可继续", async ({ page }) => {
  await open(page); await add(page, "流程"); expect(await flush(page)).toBe(true)
  await page.evaluate(() => { (window as Harness).__canvasMock.hold = true })
  await object(page).dblclick(); const editor = page.getByRole("textbox", { name: "节点文字", exact: true })
  await editor.fill("先写入")
  // Start flush without awaiting it, while the mock deliberately holds the native result.
  await page.evaluate(() => { void (window as Harness).__canvasHarness.flush() })
  await expect.poll(() => page.evaluate(() => (window as Harness).__canvasMock.calls.filter(call => call.command === "write_canvas").length)).toBe(2)
  await editor.fill("保存期间继续输入")
  await page.evaluate(() => (window as Harness).__canvasMock.release())
  expect(await flush(page)).toBe(true)
  expect((await disk(page)).file.nodes[0].text).toBe("保存期间继续输入")
  await page.evaluate(() => { (window as Harness).__canvasMock.failSave = true })
  await editor.fill("失败时保留的草稿")
  await page.getByRole("button", { name: "离开画布", exact: true }).click()
  await expect(page.getByRole("alert")).toContainText("测试保存失败")
  expect(await page.evaluate(() => (window as Harness).__canvasHarness.closed)).toBe(0)
  await page.evaluate(() => { (window as Harness).__canvasMock.failSave = false })
  await page.getByRole("button", { name: "重试保存", exact: true }).click()
  await expect(page.getByLabel("验收保存状态")).toHaveText("saved")
  expect((await disk(page)).file.nodes[0].text).toBe("失败时保留的草稿")
})

test("资料引用只保存引用，打开来源前排空保存", async ({ page }) => {
  await open(page); await add(page, "资料引用")
  await page.getByRole("textbox", { name: "搜索资料" }).fill("项目研究")
  await page.getByRole("button", { name: /碎片.*项目研究资料/ }).click()
  await expect(object(page, "reference")).toContainText("项目研究资料")
  await expect(object(page, "reference")).not.toContainText("先整理需求")
  await object(page, "reference").getByRole("button", { name: "在碎片中打开" }).click()
  await expect(page.getByText("已打开引用来源", { exact: true })).toBeVisible()
  const node = (await disk(page)).file.nodes[0]
  expect(node.link).toMatchObject({ targetType: "fragment", targetId: "canvas-fragment" })
  expect(JSON.stringify(node)).not.toContain("先整理需求")
  expect(await page.evaluate(() => (window as Harness).__canvasHarness.opened.length)).toBe(1)
})

test("流程文件只引用独立图文档，保存后重开仍按稳定 ID 跳转", async ({ page }) => {
  await open(page)
  await page.getByRole("button", { name: "添加对象", exact: true }).click()
  await expect(page.getByRole("menuitem", { name: "新建思维导图", exact: true })).toHaveCount(0)
  await expect(page.getByRole("menuitem", { name: "导入思维导图副本", exact: true })).toHaveCount(0)
  await page.keyboard.press("Escape")
  await add(page, "资料引用")
  await page.getByRole("textbox", { name: "搜索资料" }).fill("现有导图")
  await page.getByRole("button", { name: /思维导图\s*现有导图/ }).click()
  expect(await flush(page)).toBe(true)
  expect((await disk(page)).file.kind).toBe("shard.flow")
  expect((await disk(page)).file.nodes[0]).not.toHaveProperty("mindMap")
  expect((await disk(page)).file.nodes[0].link).toMatchObject({ targetType: "map" })
  await add(page, "资料引用")
  await page.getByRole("textbox", { name: "搜索资料" }).fill("关联流程")
  await page.getByRole("button", { name: /流程图\s*关联流程/ }).click()
  await page.getByRole("button", { name: "重新打开", exact: true }).click()
  const linked = page.locator('[data-canvas-kind="reference"]').filter({ hasText: "关联流程" })
  await linked.getByRole("button", { name: "打开原文" }).click()
  expect((await disk(page)).file.nodes[1].link).toMatchObject({ targetType: "flow", targetId: "linked-flow" })
  expect(await page.evaluate(() => (window as Harness).__canvasHarness.opened)).toEqual([expect.objectContaining({ targetType: "flow", targetId: "linked-flow" })])
  await page.setViewportSize({ width: 620, height: 640 })
  const styles = await page.locator(".shard-canvas-workspace").evaluate(element => ({
    font: getComputedStyle(element).fontFamily,
    radius: getComputedStyle(element.querySelector("button")!).borderRadius,
    overflow: document.documentElement.scrollWidth > innerWidth,
  }))
  expect(styles.font).toContain("Noto Sans SC"); expect(styles.radius).toBe("4px"); expect(styles.overflow).toBe(false)
})

test("旧混排画布只读，拆分失败保留原件并可重试", async ({ page }) => {
  await page.goto("/canvas-workspace-test.html?mock=1&legacy=1")
  await expect(page.getByLabel("旧画布拆分")).toBeVisible()
  const original = await disk(page)
  await expect(page.getByRole("button", { name: "添加对象", exact: true })).toHaveCount(0)
  await page.evaluate(() => { (window as Harness).__canvasMock.failSave = true })
  await page.getByRole("button", { name: "拆分为独立文档" }).click()
  await expect(page.getByRole("alert")).toContainText("原画布已保留")
  expect(await disk(page)).toEqual(original)
  await page.evaluate(() => { (window as Harness).__canvasMock.failSave = false })
  await page.getByRole("button", { name: "拆分为独立文档" }).click()
  await expect(page.getByText("已打开关联说明：notes/验收画布-关联说明.md", { exact: true })).toBeVisible()
  expect(await disk(page)).toEqual(original)
  expect(await page.evaluate(() => (window as Harness).__canvasMock.calls.filter(item => item.command === "write_canvas"))).toHaveLength(0)
})

test("拖动连接点创建流程线，保存标签，删除端点时清理连线且一次撤销恢复", async ({ page }) => {
  await open(page); await add(page, "流程")
  await page.getByRole("textbox", { name: "节点文字", exact: true }).press("ControlOrMeta+Enter")
  await add(page, "判断")
  await page.getByRole("textbox", { name: "节点文字", exact: true }).press("ControlOrMeta+Enter")
  const decision = object(page, "decision")
  const box = (await decision.boundingBox())!
  const processBox = (await object(page).boundingBox())!
  // The contextual panel changes the free insertion space: place the decision relative
  // to the process, rather than moving a fixed delta that can cover its right handle.
  const targetCenterX = processBox.x + processBox.width + 40 + box.width / 2
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 3, box.y + box.height / 2)
  await page.mouse.move(targetCenterX, box.y + box.height / 2, { steps: 12 })
  await page.mouse.up()
  expect((await decision.boundingBox())!.x).toBeGreaterThan(processBox.x + processBox.width)
  const source = (await object(page).getByLabel("流程右侧连接点", { exact: true }).boundingBox())!
  const target = (await decision.getByLabel("判断左侧连接点", { exact: true }).boundingBox())!
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2)
  await page.mouse.down()
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 12 })
  await page.mouse.up()
  await expect(page.locator(".react-flow__edge")).toHaveCount(1)
  expect(await flush(page)).toBe(true)
  const connected = (await disk(page)).file
  expect(connected.edges[0]).toMatchObject({ source: connected.nodes[0].id, target: connected.nodes[1].id, sourceHandle: "right", targetHandle: "left" })

  // Select a real point on the SVG path; a curved path's bounding-box center may be empty.
  const point = await page.locator(".react-flow__edge-path").evaluate(element => {
    const path = element as SVGPathElement
    const local = path.getPointAtLength(path.getTotalLength() / 2)
    const screen = local.matrixTransform(path.getScreenCTM()!)
    return { x: screen.x, y: screen.y }
  })
  await page.mouse.click(point.x, point.y)
  await page.getByRole("textbox", { name: "连线标签", exact: true }).fill("确认后继续")
  expect(await flush(page)).toBe(true)
  expect((await disk(page)).file.edges[0].label).toBe("确认后继续")
  await object(page).click()
  await page.getByRole("button", { name: "删除", exact: true }).click()
  expect(await flush(page)).toBe(true)
  expect((await disk(page)).file.edges).toHaveLength(0)
  expect((await disk(page)).file.nodes.map(node => node.kind)).toEqual(["decision"])
  await page.getByRole("button", { name: "撤销", exact: true }).click()
  expect(await flush(page)).toBe(true)
  const restored = (await disk(page)).file
  expect(restored.nodes.map(node => node.id)).toEqual(connected.nodes.map(node => node.id))
  expect(restored.edges).toEqual([{ ...connected.edges[0], label: "确认后继续" }])
})

test("浏览器 composition 期间拒绝 flush，结束后保存完整中文输入", async ({ page }) => {
  await open(page); await add(page, "流程"); expect(await flush(page)).toBe(true)
  const editor = page.getByRole("textbox", { name: "节点文字", exact: true })
  const before = await disk(page)
  const writes = await page.evaluate(() => (window as Harness).__canvasMock.calls.filter(call => call.command === "write_canvas").length)
  // These dispatched composition events exercise the browser gate, not a native IME acceptance.
  await editor.dispatchEvent("compositionstart", { data: "" })
  await editor.fill("正在确认中文候选")
  expect(await flush(page)).toBe(false)
  await expect(page.getByRole("button", { name: "保存", exact: true })).toBeDisabled()
  expect(await disk(page)).toEqual(before)
  expect(await page.evaluate(() => (window as Harness).__canvasMock.calls.filter(call => call.command === "write_canvas").length)).toBe(writes)
  await editor.dispatchEvent("compositionend", { data: "正在确认中文候选" })
  expect(await flush(page)).toBe(true)
  expect((await disk(page)).file.nodes[0].text).toBe("正在确认中文候选")
  expect(await page.evaluate(() => (window as Harness).__canvasHarness.dirty())).toBe(false)
})

test("加载失败没有草稿时可以离开，不触发写入", async ({ page }) => {
  await page.goto("/canvas-workspace-test.html?mock=1&missing=1")
  await expect(page.getByRole("alert")).toContainText("画布文件不存在")
  expect(await page.evaluate(() => (window as Harness).__canvasHarness.dirty())).toBe(false)
  expect(await flush(page)).toBe(true)
  await page.getByRole("button", { name: "离开画布", exact: true }).click()
  await expect(page.getByText("已离开画布", { exact: true })).toBeVisible()
  expect(await page.evaluate(() => (window as Harness).__canvasHarness.closed)).toBe(1)
  expect(await page.evaluate(() => (window as Harness).__canvasMock.calls.filter(call => call.command === "write_canvas"))).toHaveLength(0)
})

test("从资料列表拖入引用，重开时失效引用显示缺失并允许保存其他编辑", async ({ page }) => {
  await open(page); await add(page, "资料引用")
  await page.getByRole("button", { name: /碎片.*项目研究资料/ }).dragTo(page.locator(".shard-canvas-viewport"), { targetPosition: { x: 160, y: 140 } })
  await expect(object(page, "reference")).toContainText("项目研究资料")
  await expect(object(page, "reference")).not.toContainText("先整理需求")
  expect(await flush(page)).toBe(true)
  const saved = (await disk(page)).file
  expect(saved.nodes).toHaveLength(1)
  expect(saved.nodes[0].link).toMatchObject({ targetType: "fragment", targetId: "canvas-fragment" })
  expect(JSON.stringify(saved.nodes[0])).not.toContain("先整理需求")

  // Load a persisted reference whose public source no longer exists in this harness's source list.
  await page.evaluate(() => {
    const link = (window as Harness).__canvasMock.disk.file.nodes[0].link!
    if (link.targetType === "fragment") link.targetId = "deleted-public-source"
  })
  await page.getByRole("button", { name: "重新打开", exact: true }).click()
  await expect(object(page, "reference")).toContainText("原文不可用")
  await expect(object(page, "reference")).toContainText("原文已移动、删除或当前不可访问")
  await expect(object(page, "reference").getByRole("button", { name: "打开原文", exact: true })).toBeDisabled()
  await add(page, "流程"); expect(await flush(page)).toBe(true)
  expect((await disk(page)).file.nodes).toHaveLength(2)
  expect((await disk(page)).file.nodes[0].link).toMatchObject({ targetId: "deleted-public-source" })
  expect(await page.evaluate(() => (window as Harness).__canvasHarness.opened)).toHaveLength(0)
})
