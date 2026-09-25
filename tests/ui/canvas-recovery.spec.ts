import { expect, test, type Page } from "@playwright/test"
import type { CanvasFile, CanvasReadResult } from "../../src/features/canvas/model"
import { installSearchIpcMock } from "./search-ipc-mock"

type RecoveryHarness = Window & {
  __canvasHarness: { flush(): Promise<boolean>; dirty(): boolean; closed: number }
  __canvasMock: { disk: CanvasReadResult }
  __TAURI_INTERNALS__: { invoke(command: string, args: Record<string, unknown> | Uint8Array): Promise<unknown> }
  __recoveryTest: { original: CanvasReadResult; copies: Record<string, CanvasReadResult>; createIds: string[]; loseNextResult: boolean }
}

async function prepareConflict(page: Page, loseNextResult = false) {
  await installSearchIpcMock(page)
  await page.goto("/canvas-workspace-test.html?mock=1")
  await page.getByRole("button", { name: "添加对象", exact: true }).click()
  await page.getByRole("menuitem", { name: "流程", exact: true }).click()
  await expect(page.getByRole("menu")).toHaveCount(0)
  await page.getByRole("textbox", { name: "节点文字", exact: true }).fill("已经保存的原文")
  expect(await page.evaluate(() => (window as RecoveryHarness).__canvasHarness.flush())).toBe(true)
  await page.evaluate((loseResult) => {
    const host = window as RecoveryHarness
    const originalInvoke = host.__TAURI_INTERNALS__.invoke
    host.__recoveryTest = { original: structuredClone(host.__canvasMock.disk), copies: {}, createIds: [], loseNextResult: loseResult }
    host.__TAURI_INTERNALS__.invoke = async (command, args) => {
      const raw = args instanceof Uint8Array
      const request = raw ? JSON.parse(new TextDecoder().decode(args)) as Record<string, unknown> : args
      const state = host.__recoveryTest
      const encode = (value: unknown) => raw ? new TextEncoder().encode(JSON.stringify(value)).buffer : value
      if (command === "create_canvas") {
        const file = request.file as CanvasFile
        state.createIds.push(file.id)
        state.copies[file.id] ??= {
          path: `${request.parentPath}/${request.title}.shardflow.json`,
          file: { ...structuredClone(file), revision: 1 }, lastSavedHash: "c".repeat(64),
        }
        if (state.loseNextResult) { state.loseNextResult = false; throw new Error("创建结果暂时不可见") }
        return encode(state.copies[file.id])
      }
      if (command === "write_canvas") {
        const file = request.file as CanvasFile
        if (file.id === state.original.file.id) throw new Error("画布保存冲突，已另存冲突副本")
        const copy = state.copies[file.id]
        if (!copy || request.expectedRevision !== copy.file.revision || request.lastSavedHash !== copy.lastSavedHash) throw new Error("副本保存版本不一致")
        const revision = copy.file.revision + 1
        state.copies[file.id] = { ...copy, file: { ...structuredClone(file), revision }, lastSavedHash: String(revision).padStart(64, "0") }
        return encode(state.copies[file.id])
      }
      if (command === "read_canvas") {
        const copy = Object.values(state.copies).find((item) => item.path === request.path)
        if (copy) return encode(copy)
      }
      return originalInvoke(command, args)
    }
  }, loseNextResult)
  await page.getByRole("textbox", { name: "节点文字", exact: true }).fill("冲突之后的完整草稿")
  expect(await page.evaluate(() => (window as RecoveryHarness).__canvasHarness.flush())).toBe(false)
  await expect(page.getByRole("alert")).toContainText("冲突")
}

test("保存冲突后另存完整草稿，保留原文件并恢复离开", async ({ page }) => {
  await prepareConflict(page)
  await page.getByRole("textbox", { name: "节点文字", exact: true }).fill("另存时仍未失焦的最新中文")
  await page.getByRole("button", { name: "另存流程图副本", exact: true }).click()
  await expect(page.getByLabel("验收保存状态")).toHaveText("saved")
  const state = await page.evaluate(() => (window as RecoveryHarness).__recoveryTest)
  expect(Object.values(state.copies)).toHaveLength(1)
  expect(Object.values(state.copies)[0].file.nodes[0].text).toBe("另存时仍未失焦的最新中文")
  expect(state.original.file.nodes[0].text).toBe("已经保存的原文")
  expect(Object.values(state.copies)[0].file.id).not.toBe(state.original.file.id)
  await expect(page.locator('[data-canvas-kind="process"]')).toContainText("另存时仍未失焦的最新中文")
  await page.getByRole("button", { name: "重新打开", exact: true }).click()
  await expect(page.locator('[data-canvas-kind="process"]')).toContainText("另存时仍未失焦的最新中文")
  expect(await page.evaluate(() => (window as RecoveryHarness).__canvasMock.disk.file.nodes[0].text)).toBe("已经保存的原文")
  expect(await page.evaluate(() => (window as RecoveryHarness).__canvasHarness.flush())).toBe(true)
  await page.getByRole("button", { name: "离开画布", exact: true }).click()
  await expect(page.getByText("已离开画布", { exact: true })).toBeVisible()
})

test("另存响应丢失重用创建身份，并继续保存失败后的编辑", async ({ page }) => {
  await prepareConflict(page, true)
  await page.getByRole("button", { name: "另存流程图副本", exact: true }).click()
  await expect(page.getByText("创建结果暂时不可见", { exact: true })).toBeVisible()
  await page.locator('[data-canvas-kind="process"]').dblclick()
  await page.getByRole("textbox", { name: "节点文字", exact: true }).fill("创建响应丢失后继续写入")
  await page.getByRole("button", { name: "重试另存副本", exact: true }).click()
  await expect(page.getByLabel("验收保存状态")).toHaveText("saved")
  const state = await page.evaluate(() => (window as RecoveryHarness).__recoveryTest)
  expect(state.createIds).toHaveLength(2)
  expect(new Set(state.createIds).size).toBe(1)
  expect(Object.values(state.copies)).toHaveLength(1)
  expect(Object.values(state.copies)[0].file.nodes[0].text).toBe("创建响应丢失后继续写入")
  expect(await page.evaluate(() => (window as RecoveryHarness).__canvasHarness.flush())).toBe(true)
})
