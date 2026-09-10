import { expect, test, type Locator, type Page } from "@playwright/test";
import type { TableFile } from "../../src/features/tables/model";

type Harness = {
  __tableWorkspaceTest: { flush(): Promise<boolean> };
  __tableWorkspaceMock: { disk: { file: TableFile } };
};
const fieldId = (number: number) => `fld_${number.toString(16).padStart(32, "0")}`;
const list = (page: Page) => page.getByRole("region", { name: "字段配置", exact: true });
const search = (page: Page) => list(page).getByRole("searchbox", { name: "搜索字段", exact: true });
const more = (page: Page, name = "名称") => list(page).getByRole("button", { name: `${name}字段更多操作`, exact: true });
// A trigger-owned Base UI menu takes its accessible name from that trigger.
const menu = (page: Page, name = "名称") => page.getByRole("menu", { name: `${name}字段更多操作`, exact: true });
const disk = (page: Page) => page.evaluate(() => (window as unknown as Harness).__tableWorkspaceMock.disk.file);
const flush = (page: Page) => page.evaluate(() => (window as unknown as Harness).__tableWorkspaceTest.flush());
const records = (file: TableFile) => Object.fromEntries(file.recordOrder.map(id => [id, {
  ...file.records[id], values: Object.fromEntries(file.fieldOrder.map(field => [field, file.records[id].values[field] ?? null])),
}]));

async function open(page: Page, query = "名称") {
  await page.goto("/table-workspace-test.html?mock=1");
  await expect(page.getByText("4 / 4 条记录 · 6 列")).toBeVisible();
  expect(page.workers().some(worker => worker.url().includes("table.worker.ts"))).toBe(true);
  await page.getByRole("button", { name: "字段", exact: true }).click();
  await expect(list(page)).toBeVisible();
  await search(page).fill(query);
}

async function surface(control: Locator) {
  return control.evaluate(element => {
    const style = getComputedStyle(element);
    return { background: style.backgroundColor, color: style.color, border: style.borderColor };
  });
}

test("a single field row keeps vertical breathing room around its controls", async ({ page }, testInfo) => {
  await open(page);
  await expect(list(page).getByRole("listitem")).toHaveCount(1);
  const geometry = await list(page).getByRole("listitem").evaluate(element => {
    const row = element.getBoundingClientRect();
    const controls = Array.from(element.querySelectorAll('[role="checkbox"], button')).map(control => {
      const rect = control.getBoundingClientRect();
      return { top: rect.top - row.top, bottom: row.bottom - rect.bottom, height: rect.height };
    });
    return { height: row.height, space: parseFloat(getComputedStyle(element).getPropertyValue("--space-1")), controls };
  });
  await testInfo.attach("field-row-geometry", { body: JSON.stringify(geometry, null, 2), contentType: "application/json" });
  expect(geometry.controls.length).toBeGreaterThanOrEqual(3);
  for (const control of geometry.controls) {
    expect(control.top).toBeGreaterThanOrEqual(geometry.space - 0.5);
    expect(control.bottom).toBeGreaterThanOrEqual(geometry.space - 0.5);
  }
  await page.screenshot({ animations: "disabled", path: testInfo.outputPath("field-row-spacing.png") });
});

test("field more has a distinct hover surface and a named tooltip without moving", async ({ page }, testInfo) => {
  await open(page);
  const button = more(page);
  await search(page).hover();
  const resting = await surface(button);
  const bounds = await button.boundingBox();
  await button.hover();
  await expect.poll(() => surface(button)).not.toEqual(resting);
  await expect(page.getByRole("tooltip")).toContainText("名称");
  await expect(button).toHaveAccessibleName("名称字段更多操作");
  expect(await button.boundingBox()).toEqual(bounds);
  await page.screenshot({ animations: "disabled", path: testInfo.outputPath("field-more-hover.png") });
});

test("opening a field menu preserves its parent query and Escape dismisses one layer at a time", async ({ page }, testInfo) => {
  await open(page);
  const original = await disk(page);
  await more(page).click();
  await expect(menu(page)).toBeVisible();
  await expect(page.getByRole("tooltip")).toBeHidden();
  await expect(list(page)).toBeVisible();
  await expect(search(page)).toHaveValue("名称");
  await expect(menu(page).getByRole("menuitem", { name: "隐藏字段", exact: true })).toBeDisabled();
  await expect(menu(page).getByRole("menuitem", { name: "删除字段", exact: true })).toBeDisabled();
  await page.screenshot({ animations: "disabled", path: testInfo.outputPath("field-menu-nested.png") });
  await page.keyboard.press("Escape");
  await expect(menu(page)).toBeHidden();
  await expect(list(page)).toBeVisible();
  await expect(search(page)).toHaveValue("名称");
  await expect(more(page)).toBeFocused();
  await expect(page.getByRole("tooltip")).toBeHidden();
  await expect(page.getByRole("menu")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(list(page)).toBeHidden();
  await expect(page.getByRole("button", { name: "字段", exact: true })).toBeFocused();
  expect(await disk(page)).toEqual(original);
});

test("hiding from the nested menu preserves the list and stable field data so visibility can be restored", async ({ page }) => {
  await open(page, "数值");
  const original = await disk(page);
  await more(page, "数值").click();
  await expect(menu(page, "数值")).toBeVisible();
  await menu(page, "数值").getByRole("menuitem", { name: "隐藏字段", exact: true }).click();
  await expect(menu(page, "数值")).toBeHidden();
  await expect(list(page)).toBeVisible();
  await expect(search(page)).toHaveValue("数值");
  await expect(list(page).getByRole("listitem")).toHaveCount(1);
  const checkbox = list(page).getByRole("checkbox", { name: "显示数值字段", exact: true });
  await expect(checkbox).not.toBeChecked();
  await expect(page.getByText("4 / 4 条记录 · 5 列")).toBeVisible();
  expect(await flush(page)).toBe(true);
  const hidden = await disk(page);
  expect(hidden.views[hidden.viewOrder[0]].hiddenFieldIds).toEqual([fieldId(2)]);
  expect(hidden.fields).toEqual(original.fields);
  expect(hidden.fieldOrder).toEqual(original.fieldOrder);
  expect(records(hidden)).toEqual(records(original));
  await checkbox.click();
  await expect(checkbox).toBeChecked();
  await expect(page.getByText("4 / 4 条记录 · 6 列")).toBeVisible();
  await expect(search(page)).toHaveValue("数值");
  expect(await flush(page)).toBe(true);
  const restored = await disk(page);
  expect(restored.views[restored.viewOrder[0]].hiddenFieldIds).toEqual([]);
  expect(restored.fields).toEqual(original.fields);
  expect(records(restored)).toEqual(records(original));
});

test("editing from a nested field menu keeps the chosen form mounted until explicit cancel", async ({ page }) => {
  await open(page, "状态");
  const original = await disk(page);
  await more(page, "状态").click();
  await menu(page, "状态").getByRole("menuitem", { name: "编辑字段", exact: true }).click();
  const editor = page.getByRole("complementary", { name: "编辑字段", exact: true });
  await expect(editor).toBeVisible();
  await expect(editor.getByRole("textbox", { name: "名称", exact: true })).toHaveValue("状态");
  await expect(editor.getByRole("combobox", { name: "类型", exact: true })).toContainText("单选");
  await expect(menu(page, "状态")).toBeHidden();
  await editor.getByRole("textbox", { name: "名称", exact: true }).fill("待确认的状态");
  await expect(editor).toBeVisible();
  expect(await disk(page)).toEqual(original);
  await editor.getByRole("button", { name: "取消", exact: true }).click();
  await expect(editor).toBeHidden();
  expect(await disk(page)).toEqual(original);
});

for (const width of [375, 680]) {
  test(`the nested field menu stays inside the ${width}px viewport without collapsing the field list`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 720 });
    await open(page);
    await more(page).click();
    await expect(menu(page)).toBeVisible();
    await expect(list(page)).toBeVisible();
    await expect(search(page)).toHaveValue("名称");
    const geometry = await menu(page).evaluate(element => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight, documentWidth: document.documentElement.scrollWidth };
    });
    expect(geometry.left).toBeGreaterThanOrEqual(0);
    expect(geometry.top).toBeGreaterThanOrEqual(0);
    expect(geometry.right).toBeLessThanOrEqual(geometry.viewportWidth);
    expect(geometry.bottom).toBeLessThanOrEqual(geometry.viewportHeight);
    expect(geometry.documentWidth).toBeLessThanOrEqual(width);
    await testInfo.attach("nested-menu-geometry", { body: JSON.stringify(geometry, null, 2), contentType: "application/json" });
    await page.screenshot({ animations: "disabled", path: testInfo.outputPath(`field-menu-${width}.png`) });
    await page.keyboard.press("Escape");
    await expect(menu(page)).toBeHidden();
    await expect(more(page)).toBeFocused();
    await expect(list(page)).toBeVisible();
  });
}
