import { expect, test, type Page } from "@playwright/test";
import type { TableFile } from "../../src/features/tables/model";
import { selectOption } from "./select-helpers";

type Harness = {
  __tableWorkspaceTest: { flush(): Promise<boolean>; dirty(): boolean; refresh(): void };
  __tableWorkspaceMock: { disk: { file: TableFile; revision: number; contentHash: string }; calls: { command: string }[] };
};
const field = (number: number) => `fld_${number.toString(16).padStart(32, "0")}`;
const fieldTrigger = (page: Page) => page.getByRole("button", { name: "字段", exact: true });
const fieldList = (page: Page) => page.getByRole("region", { name: "字段配置", exact: true });
const compactEditor = (page: Page, name = "编辑字段") => page.getByRole("complementary", { name, exact: true });
const flush = (page: Page) => page.evaluate(() => (window as unknown as Harness).__tableWorkspaceTest.flush());
const file = (page: Page) => page.evaluate(() => (window as unknown as Harness).__tableWorkspaceMock.disk.file);
// The table contract serializes null cells by omitting them; zero, false and empty text remain distinct.
const normalizedRecords = (value: TableFile) => Object.fromEntries(value.recordOrder.map(id => [id, {
  ...value.records[id], values: Object.fromEntries(value.fieldOrder.map(fieldId => [fieldId, value.records[id].values[fieldId] ?? null])),
}]));
async function open(page: Page) {
  await page.goto("/table-workspace-test.html?mock=1");
  await expect(page.getByText("4 / 4 条记录 · 6 列")).toBeVisible();
}
async function openFieldList(page: Page) {
  await fieldTrigger(page).click();
  await expect(fieldList(page)).toBeVisible();
}

test("field configuration opens a searchable list using shared controls", async ({ page }) => {
  await open(page);
  expect(page.workers().some(worker => worker.url().includes("table.worker.ts"))).toBe(true);
  await expect(fieldTrigger(page)).toHaveText("字段配置");
  await openFieldList(page);
  const list = fieldList(page);
  await expect(fieldTrigger(page)).toHaveAttribute("aria-expanded", "true");
  await expect(list.getByRole("listitem")).toHaveCount(6);
  await expect(list.locator(".table-field-type-icon")).toHaveCount(6);
  await expect(list.getByRole("checkbox", { name: "显示名称字段", exact: true })).toBeChecked();
  await expect(list.getByRole("checkbox", { name: "显示名称字段", exact: true })).toBeDisabled();
  await expect(list.getByRole("img", { name: "主字段，不可隐藏" })).toBeVisible();
  await expect(list.locator('select:not([aria-hidden="true"]), input[type="checkbox"]:not([aria-hidden="true"])')).toHaveCount(0);
  const nativeBridges = await list.locator('input[type="checkbox"]').evaluateAll(elements => elements.map(element => ({ hidden: element.getAttribute("aria-hidden"), clip: getComputedStyle(element).clipPath })));
  expect(nativeBridges.every(bridge => bridge.hidden === "true" && bridge.clip === "inset(50%)")).toBe(true);
  const search = list.getByRole("searchbox", { name: "搜索字段" });
  await search.fill("  数值  ");
  await expect(list.getByRole("listitem")).toHaveCount(1);
  await expect(list.getByRole("button", { name: "编辑数值字段", exact: true })).toBeVisible();
  await search.fill("不存在的字段");
  await expect(list.getByRole("status")).toHaveText("未找到匹配字段");
  await search.clear();
  await expect(list.getByRole("listitem")).toHaveCount(6);
  await search.press("Escape");
  await expect(list).toHaveCount(0);
  await expect(fieldTrigger(page)).toBeFocused();
});

test("hiding and restoring a field only changes the current view visibility", async ({ page }) => {
  await open(page);
  const before = await file(page);
  await openFieldList(page);
  const visible = fieldList(page).getByRole("checkbox", { name: "显示数值字段", exact: true });
  // Visibility is committed by the Worker; await its rendered state after the click.
  await visible.click();
  await expect(page.getByText("4 / 4 条记录 · 5 列")).toBeVisible();
  await expect(visible).not.toBeChecked();
  expect(await flush(page)).toBe(true);
  const hidden = await file(page);
  expect(hidden.views[hidden.viewOrder[0]].hiddenFieldIds).toEqual([field(2)]);
  expect(normalizedRecords(hidden)).toEqual(normalizedRecords(before));
  expect(hidden.fields).toEqual(before.fields);
  expect(hidden.fieldOrder).toEqual(before.fieldOrder);
  await visible.click();
  await expect(visible).toBeChecked();
  await expect(page.getByText("4 / 4 条记录 · 6 列")).toBeVisible();
  expect(await flush(page)).toBe(true);
  const restored = await file(page);
  expect(restored.views[restored.viewOrder[0]].hiddenFieldIds).toEqual([]);
  expect(normalizedRecords(restored)).toEqual(normalizedRecords(before));
});

test("editing from the field list opens only the selected field and saves its stable ID", async ({ page }) => {
  await open(page);
  const before = await file(page);
  await openFieldList(page);
  await fieldList(page).getByRole("button", { name: "编辑状态字段", exact: true }).click();
  const editor = compactEditor(page);
  await expect(editor).toBeVisible();
  await expect(editor.getByRole("textbox", { name: "名称", exact: true })).toHaveValue("状态");
  await expect(editor.getByRole("combobox", { name: "类型", exact: true })).toContainText("单选");
  await expect(editor.getByRole("combobox", { name: "字段", exact: true })).toHaveCount(0);
  await expect(editor.getByRole("button", { name: "新增字段", exact: true })).toHaveCount(0);
  await expect(editor.getByRole("button", { name: "字段上移", exact: true })).toHaveCount(0);
  await expect(editor.getByRole("textbox", { name: "选项 2 名称", exact: true })).toHaveValue("完成");
  await editor.getByRole("textbox", { name: "名称", exact: true }).fill("交付状态");
  await selectOption(editor.getByRole("combobox", { name: "选项 2 颜色", exact: true }), "purple");
  await editor.getByRole("button", { name: "确定", exact: true }).click();
  await expect(editor).toHaveCount(0);
  expect(await flush(page)).toBe(true);
  const after = await file(page);
  expect(after.fields[field(4)]).toMatchObject({ name: "交付状态", type: "select", options: [{}, { color: "purple" }] });
  expect(after.fieldOrder).toEqual(before.fieldOrder);
  expect(normalizedRecords(after)).toEqual(normalizedRecords(before));
  await openFieldList(page);
  await expect(fieldList(page).getByRole("button", { name: "编辑交付状态字段", exact: true })).toBeVisible();
});

test("cancel discards a newly configured field without writing it", async ({ page }) => {
  await open(page);
  const before = await file(page);
  await openFieldList(page);
  await fieldList(page).getByRole("button", { name: "新增字段", exact: true }).click();
  const editor = compactEditor(page, "新增字段");
  await expect(editor.getByRole("textbox", { name: "名称", exact: true })).toHaveValue("新字段");
  await editor.getByRole("textbox", { name: "名称", exact: true }).fill("临时分类");
  await selectOption(editor.getByRole("combobox", { name: "类型", exact: true }), "select");
  await editor.getByRole("button", { name: "添加选项", exact: true }).click();
  await editor.getByRole("textbox", { name: "选项 1 名称", exact: true }).fill("不要写入");
  expect(await page.evaluate(() => (window as unknown as Harness).__tableWorkspaceTest.dirty())).toBe(true);
  await editor.getByRole("button", { name: "取消", exact: true }).click();
  await expect(editor).toHaveCount(0);
  expect(await flush(page)).toBe(true);
  expect(await file(page)).toEqual(before);
  expect(await page.evaluate(() => (window as unknown as Harness).__tableWorkspaceMock.calls.filter(call => call.command === "apply_table_mutations").length)).toBe(0);
  await openFieldList(page);
  await expect(fieldList(page).getByRole("listitem")).toHaveCount(6);
});

test("valid field drafts survive Escape and outside clicks until explicit cancel or confirm", async ({ page }) => {
  await open(page);
  for (const creating of [true, false]) {
    const before = await file(page);
    const writesBefore = await page.evaluate(() => (window as unknown as Harness).__tableWorkspaceMock.calls.filter(call => call.command === "apply_table_mutations").length);
    const draftName = creating ? "仅确认后创建" : "仅确认后重命名";
    const openEditor = async () => {
      await openFieldList(page);
      await fieldList(page).getByRole("button", { name: creating ? "新增字段" : "编辑数值字段", exact: true }).click();
      return compactEditor(page, creating ? "新增字段" : "编辑字段");
    };
    const editor = await openEditor();
    const name = editor.getByRole("textbox", { name: "名称", exact: true });
    await name.fill(draftName);
    await name.press("Escape");
    await expect(editor).toBeVisible();
    await expect(name).toHaveValue(draftName);
    await page.locator(".table-workspace-header > strong").click();
    await expect(editor).toBeVisible();
    await expect(name).toHaveValue(draftName);
    expect(await file(page)).toEqual(before);
    expect(await page.evaluate(() => (window as unknown as Harness).__tableWorkspaceMock.calls.filter(call => call.command === "apply_table_mutations").length)).toBe(writesBefore);
    await editor.getByRole("button", { name: "取消", exact: true }).click();
    await expect(editor).toHaveCount(0);
    expect(await flush(page)).toBe(true);
    expect(await file(page)).toEqual(before);
    expect(await page.evaluate(() => (window as unknown as Harness).__tableWorkspaceMock.calls.filter(call => call.command === "apply_table_mutations").length)).toBe(writesBefore);

    const confirmed = await openEditor();
    await confirmed.getByRole("textbox", { name: "名称", exact: true }).fill(draftName);
    await confirmed.getByRole("button", { name: "确定", exact: true }).click();
    await expect(confirmed).toHaveCount(0);
    expect(await flush(page)).toBe(true);
    const after = await file(page);
    if (creating) {
      const added = after.fieldOrder.filter(id => !before.fields[id]);
      expect(added).toHaveLength(1);
      expect(after.fields[added[0]].name).toBe(draftName);
    } else {
      expect(after.fieldOrder).toEqual(before.fieldOrder);
      expect(after.fields[field(2)].name).toBe(draftName);
    }
    expect(after.recordOrder).toEqual(before.recordOrder);
    expect(normalizedRecords({ ...after, fieldOrder: before.fieldOrder })).toEqual(normalizedRecords(before));
  }
});

test("invalid field and active composition stay open until the draft is valid", async ({ page }) => {
  await open(page);
  await openFieldList(page);
  await fieldList(page).getByRole("button", { name: "编辑数值字段", exact: true }).click();
  const editor = compactEditor(page);
  const name = editor.getByRole("textbox", { name: "名称", exact: true });
  await name.clear();
  await editor.getByRole("button", { name: "确定", exact: true }).click();
  await expect(editor.getByRole("alert")).toContainText("设置未应用");
  await expect(name).toHaveValue("");
  expect(await flush(page)).toBe(false);
  expect((await file(page)).fields[field(2)].name).toBe("数值");
  await name.fill("累计数值");
  // This validates synthetic composition boundaries, not a native system IME.
  await name.dispatchEvent("compositionstart", { data: "" });
  await editor.getByRole("button", { name: "确定", exact: true }).click();
  await expect(editor.getByRole("alert")).toContainText("请先完成中文输入候选词");
  await name.focus();
  await page.keyboard.press("Escape");
  await expect(editor).toBeVisible();
  expect(await flush(page)).toBe(false);
  expect((await file(page)).fields[field(2)].name).toBe("数值");
  await name.dispatchEvent("compositionend", { data: "累计数值" });
  await editor.getByRole("button", { name: "确定", exact: true }).click();
  await expect(editor).toHaveCount(0);
  expect(await flush(page)).toBe(true);
  expect((await file(page)).fields[field(2)].name).toBe("累计数值");
});

for (const width of [375, 680]) {
  test(`field list scroll stays inside its popup while the grid remains visible at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 720 });
    await open(page);
    await page.evaluate(() => {
      const app = window as unknown as Harness;
      const disk = app.__tableWorkspaceMock.disk;
      for (let index = 7; index <= 30; index++) {
        const id = `fld_${index.toString(16).padStart(32, "0")}`;
        disk.file.fields[id] = { id, name: `附加字段 ${index}`, type: "text" };
        disk.file.fieldOrder.push(id);
        for (const view of Object.values(disk.file.views)) view.fieldOrder.push(id);
      }
      disk.contentHash = "d".repeat(64);
      disk.file.revision = ++disk.revision;
      app.__tableWorkspaceTest.refresh();
    });
    await expect(page.getByText("4 / 4 条记录 · 30 列")).toBeVisible();
    const grid = page.locator(".table-workspace-grid");
    const initialGrid = await grid.boundingBox();
    await openFieldList(page);
    const list = fieldList(page);
    const popup = page.locator('[data-slot="table-settings-popover"]');
    await expect(grid).toBeVisible();
    await expect(page.getByRole("tabpanel")).toHaveAttribute("data-panel-open", "false");
    expect(await grid.boundingBox()).toEqual(initialGrid);
    await expect(list.getByRole("listitem")).toHaveCount(30);
    const scroller = list.getByRole("list", { name: "字段列表", exact: true });
    expect(await scroller.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
    await scroller.hover();
    await page.mouse.wheel(0, 1600);
    await expect.poll(() => scroller.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
    await expect(list.getByRole("button", { name: "编辑附加字段 30字段", exact: true })).toBeInViewport();
    await expect(list.getByRole("button", { name: "新增字段", exact: true })).toBeInViewport();
    await expect(grid).toBeVisible();
    const geometry = await popup.evaluate(element => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      const input = element.querySelector("input")!;
      return { x: rect.x, right: rect.right, y: rect.y, bottom: rect.bottom, radius: style.borderRadius, font: style.fontFamily,
        inputRadius: getComputedStyle(input).borderRadius, documentScroll: document.scrollingElement?.scrollTop, overflow: document.documentElement.scrollWidth > innerWidth };
    });
    expect(geometry.x).toBeGreaterThanOrEqual(0);
    expect(geometry.right).toBeLessThanOrEqual(width);
    expect(geometry.y).toBeGreaterThanOrEqual(0);
    expect(geometry.bottom).toBeLessThanOrEqual(720);
    expect(geometry).toMatchObject({ radius: "6px", inputRadius: "4px", documentScroll: 0, overflow: false });
    expect(geometry.font).toContain("Noto Sans SC");
    await page.screenshot({ path: testInfo.outputPath(`fields-${width}.png`) });
  });
}
