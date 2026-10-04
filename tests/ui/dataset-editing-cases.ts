import { expect, test } from "@playwright/test"

import { calls, cellValue, clickCell, openFromCard, zen } from "./dataset-mock"

/** 单元格真实编辑路径（双击、直接打字、新增行、新增列）：Chromium 与 WebKit（WKWebView 同内核）各跑一遍。 */
export function datasetEditingCases() {
  test("双击单元格打开编辑框，回车写回并保存", async ({ page }) => {
    await openFromCard(page)
    await clickCell(page, 1, 0, 2)
    const input = page.getByRole("textbox", { name: "编辑单元格", exact: true })
    await expect(input).toBeVisible()
    await expect(input).toHaveValue("张三")
    await input.fill("王五")
    await input.press("Enter")
    await expect(input).toHaveCount(0)
    await expect.poll(() => cellValue(page, 1, 0)).toBe("王五")
    await expect.poll(async () => (await calls(page, "apply_dataset_ops")).length).toBe(1)
    expect((await calls(page, "apply_dataset_ops"))[0].args.ops).toEqual([{ op: "setCells", cells: [{ row: 0, column: 1, value: "王五" }] }])
  })

  test("选中单元格后直接打字进入编辑，输入不丢字", async ({ page }) => {
    await openFromCard(page)
    await clickCell(page, 2, 1)
    // WebKit 点击后稍晚才把焦点交给网格画布；等它接管再打字（真人不会在十几毫秒内开打）。
    await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).toBe("CANVAS")
    // 零间隔连发：首次打开编辑框要懒加载浮层代码，挂上之前的按键必须暂存补入，不能另起编辑互相顶替。
    await page.keyboard.type("Guangzhou")
    const input = page.getByRole("textbox", { name: "编辑单元格", exact: true })
    await expect(input).toHaveValue("Guangzhou")
    await input.press("Enter")
    await expect.poll(() => cellValue(page, 2, 1)).toBe("Guangzhou")
  })

  test("新增行后直接编辑第一个可编辑列，主键自动生成", async ({ page }) => {
    await openFromCard(page)
    await clickCell(page, 0, 2)
    const input = page.getByRole("textbox", { name: "编辑单元格", exact: true })
    await expect(input).toBeVisible()
    await input.fill("赵六")
    await input.press("Enter")
    await expect.poll(() => cellValue(page, 1, 2)).toBe("赵六")
    expect(await cellValue(page, 0, 2)).toMatch(/^r_[0-9a-f]{12}$/u)
  })

  test("工具栏新增列：起名后追加到最后一列", async ({ page }) => {
    await openFromCard(page)
    await zen(page).getByRole("button", { name: "新增列", exact: true }).click()
    const dialog = page.getByRole("dialog", { name: "插入列", exact: true })
    await dialog.getByRole("textbox", { name: "列名", exact: true }).fill("备注")
    await dialog.getByRole("button", { name: "确定", exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect.poll(async () => (await calls(page, "apply_dataset_ops")).flatMap(call => call.args.ops as unknown[])).toContainEqual({ op: "insertColumn", at: 3, name: "备注" })
  })
}
