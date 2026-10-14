import { expect, test, type Page } from "@playwright/test"

import { fillEditor, focusEditor, readEditor, typeEditor } from "./editor-helpers"
import { PATH, FENCE, installMock, zen, editor, calls, openFromCard, cellValue, clickCell, editCell } from "./dataset-mock"
import { datasetEditingCases } from "./dataset-editing-cases"

test.beforeEach(async ({ page }) => { await page.context().grantPermissions(["clipboard-read", "clipboard-write"]); await installMock(page); await page.goto("/") })

async function dropCsv(page: Page, name: string, bytes: number[]) {
  await page.locator('[data-shard-editor="composer"]').evaluate((element, { name, bytes }) => {
    const transfer = new DataTransfer()
    transfer.items.add(new File([new Uint8Array(bytes)], name, { type: "text/csv" }))
    element.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }))
  }, { name, bytes })
}

test("内联表提取为 CSV 后只保留 src，原始编号和视图映射保持正确", async ({ page }) => {
  const inline = [FENCE + "datatable", JSON.stringify({
    title: "编号表",
    columns: [{ key: "code", label: "编号", type: "number" }, { key: "name", label: "名称" }],
    rows: [{ code: "00123", name: "张三" }],
    view: { sort: { key: "code", direction: "asc" }, group: "name", filter: "张" },
  }), FENCE].join("\n")
  await fillEditor(page, "composer", inline)
  const block = page.locator('[data-shard-editor="composer"] [data-datatable="block"]')
  await expect(block).toHaveAttribute("data-datatable-editable", "true")
  await block.getByRole("button", { name: "更多操作" }).click()
  await page.getByRole("menuitem", { name: "提取为 CSV" }).click()
  const dialog = page.getByRole("dialog", { name: "提取为 CSV" })
  await expect(dialog).toContainText("编号表.csv · 1 行 · 2 列")
  await dialog.getByRole("button", { name: "确认提取" }).click()
  await expect.poll(() => calls(page, "create_dataset")).toHaveLength(1)
  expect((await calls(page, "create_dataset"))[0].args).toEqual({
    title: "编号表", header: ["编号", "名称"], rows: [["00123", "张三"]], primaryKey: null,
  })
  await expect.poll(() => readEditor(page, "composer")).toContain('"src": "datasets/阅读记录.csv"')
  const source = await readEditor(page, "composer")
  expect(source).not.toContain('"rows"')
  expect(source).not.toContain('"columns"')
  expect(source).toContain('"key": "c0"')
  expect(source).toContain('"group": "c1"')
  await expect(block).toContainText("00123")
})

test("私密速记框的内联表不显示提取入口", async ({ page }) => {
  const inline = ["#密匣", "", FENCE + "datatable", JSON.stringify({
    columns: [{ key: "a", label: "名称" }], rows: [{ a: "私密" }],
  }), FENCE].join("\n")
  await fillEditor(page, "composer", inline)
  const block = page.locator('[data-shard-editor="composer"] [data-datatable="block"]')
  await expect(block).toBeVisible()
  await expect(block.getByRole("button", { name: "更多操作" })).toHaveCount(0)
})

test("超过软阈值的内联表提示提取，但仍可编辑", async ({ page }) => {
  const inline = [FENCE + "datatable", JSON.stringify({
    columns: [{ key: "a", label: "名称" }],
    rows: Array.from({ length: 201 }, (_, index) => ({ a: `记录 ${index + 1}` })),
  }), FENCE].join("\n")
  await fillEditor(page, "composer", inline)
  const block = page.locator('[data-shard-editor="composer"] [data-datatable="block"]')
  await expect(block).toHaveAttribute("data-datatable-editable", "true")
  const hint = block.getByText("数据较多，建议提取为 CSV")
  await expect(hint).toBeVisible()
  expect(await hint.evaluate((element) => getComputedStyle(element).color)).toBeTruthy()
})

test("拖放 GBK CSV 显示编码预览并导入带稳定 ID 的中文数据", async ({ page }) => {
  await dropCsv(page, "通讯录.csv", [0xD0, 0xD5, 0xC3, 0xFB, 0x0A, 0xD5, 0xC5, 0xC8, 0xFD, 0x0A])
  const dialog = page.getByRole("dialog", { name: "导入 CSV 为数据集" })
  await expect(dialog).toContainText("GBK")
  await expect(dialog).toContainText("张三")
  await dialog.getByRole("button", { name: "导入", exact: true }).click()
  await expect.poll(() => calls(page, "create_dataset")).toHaveLength(1)
  const args = (await calls(page, "create_dataset"))[0].args
  expect(args).toMatchObject({ title: "通讯录", header: ["id", "姓名"], primaryKey: "id" })
  expect(args.rows).toEqual([[expect.stringMatching(/^r_[0-9a-f]{12}$/u), "张三"]])
  await expect.poll(() => readEditor(page, "composer")).toContain('"src":"datasets/阅读记录.csv"')
})

test("拖放重复表头 CSV 时禁止导入", async ({ page }) => {
  await dropCsv(page, "重复.csv", Array.from(new TextEncoder().encode("姓名,姓名\n张三,李四\n")))
  const dialog = page.getByRole("dialog", { name: "导入 CSV 为数据集" })
  await expect(dialog).toContainText("表头名称不能为空且不能重复")
  await expect(dialog.getByRole("button", { name: "导入", exact: true })).toBeDisabled()
  expect(await calls(page, "create_dataset")).toHaveLength(0)
})

test("已有 id 列不唯一时只能按无主键导入", async ({ page }) => {
  await dropCsv(page, "重复ID.csv", Array.from(new TextEncoder().encode("id,姓名\n1,张三\n1,李四\n")))
  const dialog = page.getByRole("dialog", { name: "导入 CSV 为数据集" })
  await expect(dialog.getByText("用 id 列作为主键")).toBeVisible()
  await expect(dialog.getByRole("checkbox")).toBeDisabled()
  await dialog.getByRole("button", { name: "导入", exact: true }).click()
  expect((await calls(page, "create_dataset"))[0].args).toMatchObject({ header: ["id", "姓名"], primaryKey: null })
})

test("私密速记框拒绝 CSV 拖放", async ({ page }) => {
  await fillEditor(page, "composer", "#密匣 ")
  await dropCsv(page, "私密.csv", Array.from(new TextEncoder().encode("姓名\n张三\n")))
  await expect(page.getByRole("dialog", { name: "导入 CSV 为数据集" })).toHaveCount(0)
  expect(await calls(page, "create_dataset")).toHaveLength(0)
})

test("碎片禅模式通过 /数据集 新建 CSV 并插入说明围栏", async ({ page }) => {
  await page.locator('[data-shard-fragment-id="dataset-card"]').getByRole("button", { name: "片段操作" }).click()
  await page.getByRole("menuitem", { name: "禅模式", exact: true }).click()
  const id = "zen:dataset-card"
  await fillEditor(page, id, "说明")
  await focusEditor(page, id)
  await page.keyboard.press("End")
  await page.keyboard.press("Enter")
  await typeEditor(page, id, "/数据集")
  await page.getByRole("option", { name: /数据集/ }).click()
  const dialog = page.getByRole("dialog", { name: "新建数据集" })
  await expect(dialog.getByRole("textbox", { name: "数据集标题" })).toHaveValue("数据集")
  await dialog.getByRole("textbox", { name: "数据集标题" }).fill("旅行清单")
  await dialog.getByRole("button", { name: "创建", exact: true }).click()
  await expect.poll(() => calls(page, "create_dataset")).toHaveLength(1)
  expect((await calls(page, "create_dataset"))[0].args).toEqual({ title: "旅行清单", header: ["id", "名称"], rows: [], primaryKey: "id" })
  await expect.poll(() => readEditor(page, id)).toContain('"src":"datasets/阅读记录.csv"')
  await expect(zen(page)).toBeVisible()
})

test("速记框新建数据集后保留说明草稿，不自动提交碎片", async ({ page }) => {
  await fillEditor(page, "composer", "说明")
  await focusEditor(page, "composer")
  await page.keyboard.press("End")
  await page.keyboard.press("Enter")
  await typeEditor(page, "composer", "/数据集")
  await page.getByRole("option", { name: /数据集/ }).click()
  await page.getByRole("dialog", { name: "新建数据集" }).getByRole("button", { name: "创建", exact: true }).click()
  await expect.poll(() => readEditor(page, "composer")).toContain('"src":"datasets/阅读记录.csv"')
  expect(await readEditor(page, "composer")).toContain("说明")
  expect(await calls(page, "create_fragment")).toHaveLength(0)
  await expect(zen(page)).toBeVisible()
})

test("速记框标记密匣时隐藏 /数据集", async ({ page }) => {
  await fillEditor(page, "composer", "#密匣 ")
  await focusEditor(page, "composer")
  await page.keyboard.press("End")
  await typeEditor(page, "composer", "/数据集")
  await expect(page.getByRole("listbox", { name: "命令菜单" }).getByRole("option", { name: /数据集/ })).toHaveCount(0)
})

test("碎片准备移入密匣时隐藏 /数据集", async ({ page }) => {
  await page.locator('[data-shard-fragment-id="dataset-card"]').getByRole("button", { name: "片段操作" }).click()
  await page.getByRole("menuitem", { name: "禅模式", exact: true }).click()
  const id = "zen:dataset-card"
  await fillEditor(page, id, "#密匣 ")
  await focusEditor(page, id)
  await page.keyboard.press("End")
  await typeEditor(page, id, "/数据集")
  await expect(page.getByRole("listbox", { name: "命令菜单" }).getByRole("option", { name: /数据集/ })).toHaveCount(0)
})

test("已在密匣的碎片不显示 /数据集", async ({ page }) => {
  const privatePage = await page.context().newPage()
  await installMock(privatePage, true)
  await privatePage.goto("/")
  await privatePage.getByRole("button", { name: "资料库", exact: true }).click()
  await privatePage.getByRole("complementary", { name: "资料库目录" })
    .getByRole("button", { name: "密匣（上锁空间）", exact: true }).click()
  const gate = privatePage.getByRole("form", { name: "解锁密匣" })
  await gate.getByPlaceholder("密匣密码").fill("test-password")
  await gate.getByRole("button", { name: "解锁", exact: true }).click()
  await privatePage.locator('[data-shard-fragment-id="private-card"]')
    .getByRole("button", { name: "片段操作" }).click()
  await privatePage.getByRole("menuitem", { name: "禅模式", exact: true }).click()
  const id = "zen:private-card"
  await fillEditor(privatePage, id, "")
  await focusEditor(privatePage, id)
  await typeEditor(privatePage, id, "/数据集")
  await expect(privatePage.getByRole("listbox", { name: "命令菜单" }).getByRole("option", { name: /数据集/ })).toHaveCount(0)
  await privatePage.close()
})

test("卡片入口打开禅模式，显示标题、路径、表头和行", async ({ page }) => {
  await openFromCard(page)
  await expect(zen(page)).toContainText("阅读记录")
  await expect(zen(page)).toContainText(PATH)
  await expect.poll(() => cellValue(page, 1, 0)).toBe("张三")
  await page.screenshot({ path: "tests/evidence/datasets/open.png" })
})

test("单格编辑立即可见并按打开时 sha 保存", async ({ page }) => {
  await openFromCard(page)
  await editCell(page, 1, 0, "王五")
  await expect.poll(() => cellValue(page, 1, 0)).toBe("王五")
  await expect.poll(() => calls(page, "apply_dataset_ops")).toHaveLength(1)
  expect((await calls(page, "apply_dataset_ops"))[0].args).toMatchObject({ expectedSha: "sha-0", ops: [{ op: "setCells", cells: [{ row: 0, column: 1, value: "王五" }] }] })
  await expect(editor(page).getByText("已保存", { exact: true })).toBeVisible()
})

test("末行粘贴 2×2 产生更新与新增行，新主键由编辑器生成", async ({ page }) => {
  await openFromCard(page)
  await clickCell(page, 1, 1)
  await page.evaluate(async () => navigator.clipboard.writeText("赵六\t深圳\n钱七\t杭州"))
  await page.keyboard.press("ControlOrMeta+V")
  await expect.poll(() => calls(page, "apply_dataset_ops")).toHaveLength(1)
  const ops = (await calls(page, "apply_dataset_ops"))[0].args.ops as Array<{ op: string; rows?: string[][] }>
  expect(ops.map(op => op.op)).toEqual(["setCells", "insertRows"])
  expect(ops[1].rows?.[0][0]).toMatch(/^r_[0-9a-f]{12}$/)
  await expect.poll(() => cellValue(page, 1, 1)).toBe("赵六")
  await expect.poll(() => cellValue(page, 1, 2)).toBe("钱七")
})

test("主键列不可编辑", async ({ page }) => {
  await openFromCard(page)
  await clickCell(page, 0, 0, 2)
  await expect(zen(page).locator("textarea:visible, input:visible")).toHaveCount(0)
  expect(await calls(page, "apply_dataset_ops")).toHaveLength(0)
})

test("撤销写入逆操作并立即恢复可见值", async ({ page }) => {
  await openFromCard(page)
  await editCell(page, 1, 0, "王五")
  await expect.poll(() => calls(page, "apply_dataset_ops")).toHaveLength(1)
  await editor(page).getByRole("button", { name: "撤销" }).click()
  await expect.poll(() => cellValue(page, 1, 0)).toBe("张三")
  await expect.poll(() => calls(page, "apply_dataset_ops")).toHaveLength(2)
  expect((await calls(page, "apply_dataset_ops"))[1].args.ops).toEqual([{ op: "setCells", cells: [{ row: 0, column: 1, value: "张三" }] }])
})

test("冲突时保留修改，放弃后读取磁盘值", async ({ page }) => {
  await openFromCard(page)
  await page.evaluate(() => { (window as unknown as { __DATASET_TEST__: { state: { staleNext: boolean } } }).__DATASET_TEST__.state.staleNext = true })
  await editCell(page, 1, 0, "王五")
  await expect(editor(page).getByRole("alert")).toContainText("数据文件已在别处被修改")
  await page.screenshot({ path: "tests/evidence/datasets/conflict.png" })
  await editor(page).getByRole("button", { name: "放弃我的修改并载入磁盘版" }).click()
  await expect.poll(() => cellValue(page, 1, 0)).toBe("张三")
})

test("Esc 关闭先 flush 待保存操作", async ({ page }) => {
  await openFromCard(page)
  await editCell(page, 1, 0, "王五")
  await expect.poll(() => cellValue(page, 1, 0)).toBe("王五")
  await page.keyboard.press("Escape")
  await expect(zen(page)).toHaveCount(0)
  expect(await calls(page, "apply_dataset_ops")).toHaveLength(1)
})

test("保存后卡片数据表预览刷新", async ({ page }) => {
  await openFromCard(page)
  await editCell(page, 1, 0, "王五")
  await expect(editor(page).getByText("已保存", { exact: true })).toBeVisible()
  await zen(page).getByRole("button", { name: "关闭" }).click()
  await expect(page.locator('[data-shard-fragment-id="dataset-card"] tbody tr').first()).toContainText("王五")
})

test("⌘O 打开 CSV 结果进入禅模式，不调用系统程序", async ({ page }) => {
  await page.keyboard.press("Control+o")
  const input = page.getByRole("combobox", { name: "搜索内容" })
  await input.fill("阅读记录.csv")
  await page.getByRole("option", { name: /阅读记录/ }).first().click()
  await expect(zen(page)).toBeVisible()
  expect(await calls(page, "open_csv_file")).toHaveLength(0)
})

test("不可编辑原因显示且保留只读截图", async ({ page }) => {
  await page.evaluate(() => { const state = (window as unknown as { __DATASET_TEST__: { state: { editable: boolean; readOnlyReason: string } } }).__DATASET_TEST__.state; state.editable = false; state.readOnlyReason = "表头重复" })
  await openFromCard(page)
  await expect(editor(page).getByRole("alert")).toContainText("表头重复")
  await page.screenshot({ path: "tests/evidence/datasets/read-only.png" })
})

test("GBK 等外部编码只读打开，确认转换后才可编辑", async ({ page }) => {
  await page.evaluate(() => {
    const state = (window as unknown as { __DATASET_TEST__: { state: Record<string, unknown> } }).__DATASET_TEST__.state
    Object.assign(state, { editable: false, convertible: true, readOnlyReason: "CSV_NOT_UTF8:这是 GBK 编码的 CSV，转换为 UTF-8 后才能编辑" })
  })
  await openFromCard(page)
  const alert = editor(page).getByRole("alert")
  await expect(alert).toHaveText(/^只读：这是 GBK 编码的 CSV/u)
  await alert.getByRole("button", { name: "转换为 UTF-8 后编辑" }).click()
  const dialog = page.getByRole("dialog", { name: "转换为 UTF-8 后编辑" })
  await expect(dialog).toContainText("会改写这个文件")
  await dialog.getByRole("button", { name: "取消" }).click()
  expect(await calls(page, "normalize_csv_file")).toHaveLength(0)

  await alert.getByRole("button", { name: "转换为 UTF-8 后编辑" }).click()
  await dialog.getByRole("button", { name: "转换", exact: true }).click()
  await expect.poll(() => calls(page, "normalize_csv_file")).toEqual([
    { command: "normalize_csv_file", args: { path: PATH, expectedSha: "sha-0" } },
  ])
  await expect(editor(page).getByRole("alert")).toHaveCount(0)
  await editCell(page, 1, 0, "王五")
  await expect.poll(() => calls(page, "apply_dataset_ops")).toHaveLength(1)
})

test("焦点刷新保持网格与选区；sha 变化后替换数据并清空撤销", async ({ page }) => {
  await openFromCard(page)
  await editCell(page, 1, 0, "新值")
  await expect(editor(page).getByText("已保存", { exact: true })).toBeVisible()
  await expect(editor(page).getByRole("button", { name: "撤销" })).toBeEnabled()
  await clickCell(page, 1, 0)
  const selected = () => editor(page).evaluate(element => (element as HTMLElement & { __datasetSelection?: { current?: { cell: [number, number] } } }).__datasetSelection?.current?.cell)
  await expect.poll(selected).toEqual([1, 0])
  const grid = zen(page).locator(".dvn-scroller").first()
  await grid.evaluate(element => { (window as unknown as { __datasetGrid?: Element }).__datasetGrid = element })
  await page.evaluate(() => window.dispatchEvent(new Event("focus")))
  await expect.poll(() => cellValue(page, 1, 0)).toBe("新值")
  await expect.poll(selected).toEqual([1, 0])
  expect(await grid.evaluate(element => element === (window as unknown as { __datasetGrid?: Element }).__datasetGrid)).toBe(true)
  await page.evaluate(() => { const state = (window as unknown as { __DATASET_TEST__: { state: { sha: string; table: { rows: string[][] } } } }).__DATASET_TEST__.state; state.sha = "external"; state.table.rows[0][1] = "磁盘版"; window.dispatchEvent(new Event("focus")) })
  await expect.poll(() => cellValue(page, 1, 0)).toBe("磁盘版")
  await expect.poll(selected).toBeUndefined()
  await expect(editor(page).getByRole("button", { name: "撤销" })).toBeDisabled()
})

test("网格主题颜色全部转为 Glide 可解析的 rgb/rgba（color-mix token 不得漏出）", async ({ page }) => {
  await openFromCard(page)
  await clickCell(page, 0, 2)
  await expect.poll(() => cellValue(page, 0, 2)).toMatch(/^r_[0-9a-f]{12}$/)
  const colors = await editor(page).evaluate(async element => {
    const { readKilnGridTheme } = await import(/* @vite-ignore */ "/src/features/datasets/kiln-grid-theme.ts") as typeof import("../../src/features/datasets/kiln-grid-theme")
    const { theme } = readKilnGridTheme(element as HTMLElement)
    return Object.entries(theme).filter(([key, value]) => typeof value === "string" && /(color|^text|^bg|^fg|^accent|border)/iu.test(key)).map(([key, value]) => [key, value as string])
  })
  expect(colors.length).toBeGreaterThan(10)
  for (const [key, value] of colors) expect(`${key}=${value}`).toMatch(/=rgba?\(\d+, \d+, \d+(, [\d.]+)?\)$/)
})

test("对话框底栏：桌面右对齐同排、主按钮在最右；窄屏竖排主按钮在上", async ({ page }) => {
  await page.locator('[data-shard-fragment-id="dataset-card"]').getByRole("button", { name: "片段操作" }).click()
  await page.getByRole("menuitem", { name: "禅模式", exact: true }).click()
  const id = "zen:dataset-card"
  await fillEditor(page, id, "说明")
  await focusEditor(page, id)
  await page.keyboard.press("End")
  await page.keyboard.press("Enter")
  await typeEditor(page, id, "/数据集")
  await page.getByRole("option", { name: /数据集/ }).click()
  const dialog = page.getByRole("dialog", { name: "新建数据集" })
  const footer = dialog.locator('[data-slot="dialog-footer"]')
  const cancel = await footer.getByRole("button", { name: "取消", exact: true }).boundingBox()
  const create = await footer.getByRole("button", { name: "创建", exact: true }).boundingBox()
  const bar = await footer.boundingBox()
  if (!cancel || !create || !bar) throw new Error("底栏未显示")
  expect(Math.abs(cancel.y - create.y)).toBeLessThan(1)
  expect(create.x).toBeGreaterThan(cancel.x + cancel.width)
  expect(Math.abs(create.x + create.width - (bar.x + bar.width))).toBeLessThan(1)
  expect(create.width).toBeLessThan(bar.width / 3)
  await dialog.screenshot({ path: "tests/evidence/datasets/create-dialog.png" })
  await page.setViewportSize({ width: 480, height: 720 })
  const narrowCancel = await footer.getByRole("button", { name: "取消", exact: true }).boundingBox()
  const narrowCreate = await footer.getByRole("button", { name: "创建", exact: true }).boundingBox()
  if (!narrowCancel || !narrowCreate) throw new Error("窄屏底栏未显示")
  expect(narrowCreate.y + narrowCreate.height).toBeLessThanOrEqual(narrowCancel.y)
  expect(Math.abs(narrowCreate.width - narrowCancel.width)).toBeLessThan(1)
})

datasetEditingCases()
