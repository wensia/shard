import { expect, test, type Page } from "@playwright/test";
import { selectOption } from "./select-helpers";

type Harness = {
  __tableWorkspaceTest: { flush(): Promise<boolean>; dirty(): boolean; closed: number };
  __tableWorkspaceMock: {
    disk: { revision: number; file: { records: Record<string, { values: Record<string, unknown> }> } };
    failSave: boolean;
    calls: { command: string; request: { operations?: { type: string; cells?: { recordId: string; fieldId: string; value: unknown }[] }[] } }[];
  };
};
const field = (number: number) => `fld_${number.toString(16).padStart(32, "0")}`;
const record = (number: number) => `rec_${number.toString(16).padStart(32, "0")}`;
const panel = (page: Page) => page.getByRole("complementary", { name: "批量修改字段" });
const flush = (page: Page) => page.evaluate(() => (window as unknown as Harness).__tableWorkspaceTest.flush());
const dirty = (page: Page) => page.evaluate(() => (window as unknown as Harness).__tableWorkspaceTest.dirty());
async function values(page: Page) {
  return page.evaluate(() => Object.fromEntries(Object.entries((window as unknown as Harness).__tableWorkspaceMock.disk.file.records)
    .map(([id, item]) => [id, Object.fromEntries(Object.entries(item.values).filter(([, value]) => value !== null))])));
}
async function selectRow(page: Page, row: number) {
  const metrics = await page.locator(".table-workspace").evaluate(element => {
    const style = getComputedStyle(element);
    return { header: parseFloat(style.getPropertyValue("--control-height-lg")), row: parseFloat(style.getPropertyValue("--table-row-height")) };
  });
  const canvas = page.locator(".table-workspace-grid canvas").first();
  const y = metrics.header + row * metrics.row + metrics.row / 2;
  await expect.poll(async () => (await canvas.boundingBox())?.height ?? 0).toBeGreaterThan(y);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error("Table grid is unavailable");
  await page.mouse.click(bounds.x + metrics.header / 2, bounds.y + y);
}
async function selectTwoAndOpen(page: Page) {
  await selectRow(page, 0);
  await expect(page.getByLabel("批量操作")).toContainText("已选择 1 条记录");
  await selectRow(page, 1);
  await expect(page.getByLabel("批量操作")).toContainText("已选择 2 条记录");
  await page.getByRole("button", { name: "批量修改字段", exact: true }).click();
  await expect(panel(page)).toBeVisible();
}
async function openBulk(page: Page) {
  await page.goto("/table-workspace-test.html?mock=1");
  await expect(page.getByText("4 / 4 条记录 · 6 列")).toBeVisible();
  await selectTwoAndOpen(page);
}
async function chooseField(page: Page, number: number) {
  await selectOption(panel(page).getByRole("combobox", { name: "修改字段", exact: true }), field(number));
}
async function apply(page: Page) {
  await panel(page).getByRole("button", { name: "应用到 2 条记录", exact: true }).click();
  await expect(panel(page).getByRole("status")).toHaveText("已更新 2 条记录");
  expect(await flush(page)).toBe(true);
}

test("selecting a bulk field alone does not clear values or make a draft", async ({ page }) => {
  await openBulk(page);
  const before = await values(page);
  expect(await dirty(page)).toBe(false);
  await chooseField(page, 2);
  await expect(panel(page).getByRole("button", { name: "应用到 2 条记录" })).toBeDisabled();
  expect(await dirty(page)).toBe(false);
  expect(await flush(page)).toBe(true);
  await panel(page).getByRole("button", { name: "返回表格" }).click();
  expect(await values(page)).toEqual(before);
  expect(await page.evaluate(() => (window as unknown as Harness).__tableWorkspaceMock.calls.filter(call => call.command === "apply_table_mutations").length)).toBe(0);
});

test("bulk numeric update changes only selected IDs and one field, with one undo", async ({ page }, testInfo) => {
  await openBulk(page);
  const before = await values(page);
  await chooseField(page, 2);
  await panel(page).getByRole("textbox", { name: "批量设置数值" }).fill("123.5");
  await page.screenshot({ path: testInfo.outputPath("table-bulk-wide.png") });
  await apply(page);
  const after = await values(page);
  for (const id of [record(1), record(2)]) expect(after[id]).toEqual({ ...before[id], [field(2)]: 123.5 });
  for (const id of [record(3), record(4)]) expect(after[id]).toEqual(before[id]);
  const cells = await page.evaluate(() => (window as unknown as Harness).__tableWorkspaceMock.calls.filter(call => call.command === "apply_table_mutations")
    .flatMap(call => call.request.operations ?? []).flatMap(operation => operation.cells ?? []));
  expect(cells).toEqual([{ recordId: record(1), fieldId: field(2), value: 123.5 }, { recordId: record(2), fieldId: field(2), value: 123.5 }]);
  await panel(page).getByRole("button", { name: "返回表格" }).click();
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  expect(await flush(page)).toBe(true);
  expect(await values(page)).toEqual(before);
  await expect(page.getByRole("button", { name: "撤销", exact: true })).toBeDisabled();
});

test("bulk targets stay frozen to selected record IDs after sorting and later selection changes", async ({ page }) => {
  await page.goto("/table-workspace-test.html?mock=1");
  await expect(page.getByText("4 / 4 条记录 · 6 列")).toBeVisible();
  await page.getByRole("button", { name: "排序", exact: true }).click();
  const settings = page.getByRole("complementary", { name: "排序设置" });
  await settings.getByRole("button", { name: "添加排序" }).click();
  await selectOption(settings.getByRole("combobox", { name: "排序 1 字段" }), field(2));
  await selectOption(settings.getByRole("combobox", { name: "排序 1 方向" }), "desc");
  await settings.getByRole("button", { name: "关闭", exact: true }).click();
  expect(await flush(page)).toBe(true);
  const before = await values(page);
  await selectTwoAndOpen(page);
  await selectRow(page, 2);
  await expect(panel(page)).toContainText("将修改选中的 2 条记录");
  await chooseField(page, 1);
  await panel(page).getByRole("textbox", { name: "批量设置名称" }).fill("冻结选中的记录");
  await apply(page);
  const after = await values(page);
  for (const id of [record(4), record(1)]) expect(after[id]).toEqual({ ...before[id], [field(1)]: "冻结选中的记录" });
  for (const id of [record(2), record(3)]) expect(after[id]).toEqual(before[id]);
});

test("bulk checkbox false, empty options and clear remain distinct values", async ({ page }) => {
  await openBulk(page);
  const before = await values(page);
  await chooseField(page, 6);
  await selectOption(panel(page).getByRole("combobox", { name: "批量设置确认" }), "false");
  await apply(page);
  let result = await values(page);
  for (const id of [record(1), record(2)]) expect(result[id][field(6)]).toBe(false);
  await chooseField(page, 5);
  await panel(page).getByRole("button", { name: "设为空选项" }).click();
  await apply(page);
  result = await values(page);
  for (const id of [record(1), record(2)]) expect(result[id][field(5)]).toEqual([]);
  await panel(page).getByRole("button", { name: "清空", exact: true }).click();
  await apply(page);
  result = await values(page);
  for (const id of [record(1), record(2)]) {
    expect(result[id][field(5)]).toBeUndefined();
    expect(result[id][field(6)]).toBe(false);
  }
  for (const id of [record(3), record(4)]) expect(result[id]).toEqual(before[id]);
  const last = await page.evaluate(() => (window as unknown as Harness).__tableWorkspaceMock.calls.filter(call => call.command === "apply_table_mutations").at(-1)?.request.operations);
  expect(last).toEqual([{ type: "setCells", cells: [{ recordId: record(1), fieldId: field(5), value: null }, { recordId: record(2), fieldId: field(5), value: null }] }]);
});

test("bulk invalid numeric drafts and composition prevent flush and navigation", async ({ page }) => {
  await openBulk(page);
  const before = await values(page);
  await chooseField(page, 2);
  const numeric = panel(page).getByRole("textbox", { name: "批量设置数值" });
  await numeric.fill("不是数字");
  expect(await dirty(page)).toBe(true);
  expect(await flush(page)).toBe(false);
  await expect(numeric).toHaveValue("不是数字");
  await expect(panel(page).getByRole("alert")).toContainText("请输入有效数字");
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  expect(await page.evaluate(() => (window as unknown as Harness).__tableWorkspaceTest.closed)).toBe(0);
  expect(await values(page)).toEqual(before);
  await numeric.fill("0");
  expect(await flush(page)).toBe(true);
  await chooseField(page, 1);
  const text = panel(page).getByRole("textbox", { name: "批量设置名称" });
  await text.fill("候选词草稿");
  await text.dispatchEvent("compositionstart", { data: "候选词" });
  expect(await flush(page)).toBe(false);
  await expect(text).toHaveValue("候选词草稿");
  expect((await values(page))[record(1)][field(1)]).toBe(before[record(1)][field(1)]);
  await text.dispatchEvent("compositionend", { data: "候选词草稿" });
  expect(await flush(page)).toBe(true);
  for (const id of [record(1), record(2)]) expect((await values(page))[id][field(1)]).toBe("候选词草稿");
});

test("failed bulk persistence preserves the worker draft and blocks leaving", async ({ page }) => {
  await openBulk(page);
  const before = await values(page);
  await page.evaluate(() => { (window as unknown as Harness).__tableWorkspaceMock.failSave = true; });
  await chooseField(page, 1);
  const text = panel(page).getByRole("textbox", { name: "批量设置名称" });
  await text.fill("保存失败仍保留");
  expect(await flush(page)).toBe(false);
  await expect(text).toHaveValue("保存失败仍保留");
  expect(await dirty(page)).toBe(true);
  expect(await values(page)).toEqual(before);
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  expect(await page.evaluate(() => (window as unknown as Harness).__tableWorkspaceTest.closed)).toBe(0);
  await page.evaluate(() => { (window as unknown as Harness).__tableWorkspaceMock.failSave = false; });
  expect(await flush(page)).toBe(true);
  const result = await values(page);
  for (const id of [record(1), record(2)]) expect(result[id]).toEqual({ ...before[id], [field(1)]: "保存失败仍保留" });
  for (const id of [record(3), record(4)]) expect(result[id]).toEqual(before[id]);
});

test("bulk controls stay Kiln-styled and usable in a narrow workspace", async ({ page }, testInfo) => {
  await openBulk(page);
  await page.setViewportSize({ width: 560, height: 640 });
  await expect(page.locator(".table-workspace-grid")).toBeHidden();
  await chooseField(page, 6);
  const trigger = panel(page).getByRole("combobox", { name: "批量设置确认" });
  await trigger.click();
  const popup = page.locator('[data-slot="select-content"]').last();
  await expect(popup).toBeVisible();
  const bounds = await popup.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(560);
  expect(await trigger.evaluate(element => getComputedStyle(element).borderRadius)).toBe("4px");
  await expect(panel(page).locator("select,input[type=date],input[type=checkbox]")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("table-bulk-narrow-select.png") });
  await page.getByRole("option", { name: "否", exact: true }).click();
  await apply(page);
  await panel(page).getByRole("button", { name: "返回表格" }).click();
  await expect(page.locator(".table-workspace-grid")).toBeVisible();
});
