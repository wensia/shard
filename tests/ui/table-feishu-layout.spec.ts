import { expect, test, type Page } from "@playwright/test";
import type { TableFile } from "../../src/features/tables/model";
import { selectOption } from "./select-helpers";

type Harness = {
  __tableWorkspaceTest: { flush(): Promise<boolean>; dirty(): boolean };
  __tableWorkspaceMock: { disk: { file: TableFile }; calls: { command: string; request: { operations?: { type: string }[] } }[] };
};
const field = (number: number) => `fld_${number.toString(16).padStart(32, "0")}`;
const toolbar = (page: Page) => page.locator(".table-workspace-toolbar");
const trigger = (page: Page, name: string) => toolbar(page).getByRole("button", { name: new RegExp(`^${name}(?: \\d+)?$`) });
const popup = (page: Page) => page.locator('[data-slot="table-settings-popover"]');
const panel = (page: Page, name: string) => page.getByRole("complementary", { name, exact: true });
const canvas = (page: Page) => page.locator(".table-workspace-grid canvas").first();
const flush = (page: Page) => page.evaluate(() => (window as unknown as Harness).__tableWorkspaceTest.flush());
const file = (page: Page) => page.evaluate(() => (window as unknown as Harness).__tableWorkspaceMock.disk.file);

async function open(page: Page) {
  await page.goto("/table-workspace-test.html?mock=1");
  await expect(page.getByText("4 / 4 条记录 · 6 列")).toBeVisible();
  await expect.poll(async () => (await canvas(page).boundingBox())?.height ?? 0).toBeGreaterThan(200);
  expect(page.workers().some(worker => worker.url().includes("table.worker.ts"))).toBe(true);
}

async function selectFirstRecord(page: Page) {
  const box = await canvas(page).boundingBox();
  if (!box) throw new Error("Grid canvas is not visible");
  const row = await page.locator(".table-workspace").evaluate(element => {
    const style = getComputedStyle(element);
    return { header: parseFloat(style.getPropertyValue("--control-height-lg")), height: parseFloat(style.getPropertyValue("--table-row-height")) };
  });
  await page.mouse.click(box.x + 80, box.y + row.header + row.height / 2);
  await expect(trigger(page, "记录详情")).toBeEnabled();
}

async function expectNoPageOverflow(page: Page) {
  expect(await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth, scroll: document.scrollingElement?.scrollTop })))
    .toEqual({ overflow: false, scroll: 0 });
}

for (const width of [1280, 680, 375]) {
  test(`anchored settings preserve the grid and compact toolbar at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 720 });
    await open(page);
    const metrics = await toolbar(page).evaluate(element => {
      const style = getComputedStyle(element);
      const buttons = Array.from(element.querySelectorAll("button")).map(button => button.getBoundingClientRect());
      const primary = element.querySelector(".table-toolbar-primary")!;
      return { height: element.getBoundingClientRect().height, maxHeight: parseFloat(style.getPropertyValue("--toolbar-control")) + parseFloat(style.getPropertyValue("--space-1")) * 2 + 2,
        rows: new Set(buttons.map(rect => Math.round(rect.y))).size, font: style.fontFamily, primaryOverflow: primary.scrollWidth > primary.clientWidth };
    });
    expect(metrics.height).toBeLessThanOrEqual(metrics.maxHeight);
    expect(metrics.rows).toBe(1);
    expect(metrics.font).toContain("Noto Sans SC");
    if (width === 1280) expect(metrics.primaryOverflow).toBe(false);
    await expectNoPageOverflow(page);
    await page.screenshot({ path: testInfo.outputPath(`table-${width}.png`) });

    const before = await canvas(page).boundingBox();
    await trigger(page, "筛选").click();
    await expect(panel(page, "筛选设置")).toBeVisible();
    await expect(page.getByRole("tabpanel")).toHaveAttribute("data-panel-open", "false");
    expect(await canvas(page).boundingBox()).toEqual(before);
    const anchor = await trigger(page, "筛选").boundingBox();
    const bounds = await popup(page).boundingBox();
    if (!anchor || !bounds) throw new Error("Settings trigger or popup is not visible");
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    expect(bounds.y - anchor.y - anchor.height).toBeGreaterThanOrEqual(0);
    expect(bounds.y - anchor.y - anchor.height).toBeLessThanOrEqual(8);
    expect(await popup(page).evaluate(element => ({ radius: getComputedStyle(element).borderRadius, focus: element.contains(document.activeElement), modal: element.getAttribute("aria-modal") })))
      .toMatchObject({ radius: "6px", focus: true, modal: null });
    const matching = panel(page, "筛选设置").getByRole("combobox", { name: "匹配方式", exact: true });
    await matching.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("option", { name: "满足任一条件", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("option")).toHaveCount(0);
    await expect(panel(page, "筛选设置")).toBeVisible();
    await expect(matching).toBeFocused();
    await page.screenshot({ path: testInfo.outputPath(`filter-${width}.png`) });
    await page.keyboard.press("Escape");
    await expect(popup(page)).toHaveCount(0);
    await expect(trigger(page, "筛选")).toBeFocused();

    await trigger(page, "排序").click();
    const sorts = panel(page, "排序设置");
    await expect(sorts).toBeVisible();
    expect(await canvas(page).boundingBox()).toEqual(before);
    await sorts.getByRole("button", { name: "添加排序", exact: true }).click();
    await selectOption(sorts.getByRole("combobox", { name: "排序 1 字段", exact: true }), field(2));
    await expect(sorts).toBeVisible();
    await expect(sorts.getByRole("combobox", { name: "排序 1 字段", exact: true })).toContainText("数值");
    await expectNoPageOverflow(page);
    await page.screenshot({ path: testInfo.outputPath(`sort-${width}.png`) });
    await testInfo.attach("layout-metrics", { body: JSON.stringify({ width, metrics, anchor, bounds }), contentType: "application/json" });
  });
}

test("switching settings applies a valid draft and refuses an invalid one", async ({ page }) => {
  await open(page);
  await trigger(page, "筛选").click();
  const filters = panel(page, "筛选设置");
  await filters.getByRole("button", { name: "添加条件", exact: true }).click();
  await selectOption(filters.getByRole("combobox", { name: "筛选字段", exact: true }), field(2));
  await selectOption(filters.getByRole("combobox", { name: "筛选关系", exact: true }), "gte");
  await filters.getByRole("spinbutton", { name: "筛选值", exact: true }).fill("0");
  await trigger(page, "排序").click();
  await expect(panel(page, "排序设置")).toBeVisible();
  await expect(filters).toHaveCount(0);
  await expect(popup(page)).toHaveCount(1);
  expect(await flush(page)).toBe(true);
  const after = await file(page);
  expect(after.views[after.viewOrder[0]].filters.conditions).toEqual([{ fieldId: field(2), operator: "gte", value: 0 }]);
  await trigger(page, "视图配置").click();
  const settings = panel(page, "视图设置");
  await settings.getByRole("textbox", { name: "视图名称", exact: true }).clear();
  await trigger(page, "分组").click();
  await expect(settings).toBeVisible();
  await expect(settings.getByRole("alert")).toContainText("设置未应用");
  await expect(panel(page, "分组设置")).toHaveCount(0);
  expect(await flush(page)).toBe(false);
  expect((await file(page)).views[after.viewOrder[0]].name).toBe(after.views[after.viewOrder[0]].name);
  await settings.getByRole("textbox", { name: "视图名称", exact: true }).fill("飞书式工作视图");
  await trigger(page, "分组").click();
  await expect(panel(page, "分组设置")).toBeVisible();
  await expect(settings).toHaveCount(0);
  expect(await flush(page)).toBe(true);
  expect((await file(page)).views[after.viewOrder[0]].name).toBe("飞书式工作视图");
});

test("a canvas header's opening pointer sequence keeps its field editor open", async ({ page }) => {
  await open(page);
  const box = await canvas(page).boundingBox();
  if (!box) throw new Error("Grid canvas is not visible");
  const columnWidth = await page.locator(".table-workspace").evaluate(element => parseFloat(getComputedStyle(element).getPropertyValue("--space-12")) * 4);
  await page.mouse.click(box.x + 40 + columnWidth + 24, box.y + 20);
  const editor = panel(page, "编辑字段");
  await expect(editor.getByRole("textbox", { name: "名称", exact: true })).toHaveValue("数值");
  await expect(editor.getByRole("combobox", { name: "类型", exact: true })).toContainText("数字");
  await editor.getByRole("textbox", { name: "名称", exact: true }).fill("累计数值");
  await page.keyboard.press("Escape");
  await expect(editor).toBeVisible();
  expect((await file(page)).fields[field(2)].name).toBe("数值");
  await page.mouse.click(1200, 650);
  await expect(editor).toBeVisible();
  await expect(editor.getByRole("textbox", { name: "名称", exact: true })).toBeFocused();
  await page.getByText("工作区测试", { exact: true }).click();
  await expect(editor.getByRole("textbox", { name: "名称", exact: true })).toBeFocused();
  expect((await file(page)).fields[field(2)].name).toBe("数值");
  await editor.getByRole("button", { name: "取消", exact: true }).click();
  await expect(editor).toHaveCount(0);
  expect(await flush(page)).toBe(true);
  expect((await file(page)).fields[field(2)].name).toBe("数值");
});

for (const width of [1280, 680, 375]) {
  test(`record detail preserves the wide grid and uses one panel at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 720 });
    await open(page);
    const before = await canvas(page).boundingBox();
    await selectFirstRecord(page);
    await trigger(page, "记录详情").click();
    const detail = panel(page, "记录详情");
    await expect(detail).toBeVisible();
    await expect(page.getByRole("tabpanel")).toHaveAttribute("data-panel-open", "true");
    const bounds = await detail.boundingBox();
    if (!bounds) throw new Error("Record detail is not visible");
    expect(bounds.x + bounds.width).toBe(width);
    if (width === 1280) {
      await expect(canvas(page)).toBeVisible();
      expect(await canvas(page).boundingBox()).toEqual(before);
      expect(bounds.x).toBeGreaterThan(width / 2);
      expect(await detail.evaluate(element => getComputedStyle(element).position)).toBe("absolute");
    } else {
      await expect(page.locator(".table-workspace-grid")).toBeHidden();
      expect(bounds.x).toBe(0);
      expect(bounds.width).toBe(width);
    }
    await expect(detail.getByRole("textbox", { name: "名称", exact: true })).toHaveValue("苹果\n第二行");
    await expectNoPageOverflow(page);
    await page.screenshot({ path: testInfo.outputPath(`record-${width}.png`) });
    await detail.getByRole("button", { name: "返回表格", exact: true }).click();
    await expect(detail).toHaveCount(0);
    await expect(canvas(page)).toBeVisible();
    await expect.poll(() => canvas(page).boundingBox()).toEqual(before);
  });
}

test("the trailing add row creates exactly one record and opens its detail", async ({ page }) => {
  await open(page);
  const before = await file(page);
  const box = await canvas(page).boundingBox();
  if (!box) throw new Error("Grid canvas is not visible");
  const sizes = await page.locator(".table-workspace").evaluate(element => {
    const style = getComputedStyle(element);
    return { header: parseFloat(style.getPropertyValue("--control-height-lg")), row: parseFloat(style.getPropertyValue("--table-row-height")) };
  });
  const y = sizes.header + before.recordOrder.length * sizes.row + sizes.row / 2;
  expect(box.height).toBeGreaterThan(y);
  await page.mouse.click(box.x + 80, box.y + y);
  await expect(panel(page, "记录详情")).toBeVisible();
  await expect(page.getByText("5 / 5 条记录 · 6 列")).toBeVisible();
  expect(await flush(page)).toBe(true);
  const after = await file(page);
  expect(after.recordOrder).toHaveLength(before.recordOrder.length + 1);
  const created = after.recordOrder.filter(id => !before.records[id]);
  expect(created).toHaveLength(1);
  expect(after.records[created[0]].values[field(1)] ?? "").toBe("");
  expect(await page.evaluate(() => (window as unknown as Harness).__tableWorkspaceMock.calls.flatMap(call => call.request.operations ?? []).filter(operation => operation.type === "insertRecords").length)).toBe(1);
});

test("right-clicking a sorted row opens the record behind that visible row", async ({ page }) => {
  await open(page);
  await trigger(page, "排序").click();
  const sorts = panel(page, "排序设置");
  await sorts.getByRole("button", { name: "添加排序", exact: true }).click();
  await selectOption(sorts.getByRole("combobox", { name: "排序 1 字段", exact: true }), field(2));
  await selectOption(sorts.getByRole("combobox", { name: "排序 1 方向", exact: true }), "desc");
  await sorts.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(sorts).toHaveCount(0);
  expect(await flush(page)).toBe(true);
  const expected = Object.values((await file(page)).records).find(record => record.values[field(2)] === 42)!;
  const box = await canvas(page).boundingBox();
  if (!box) throw new Error("Grid canvas is not visible");
  const row = await page.locator(".table-workspace").evaluate(element => {
    const style = getComputedStyle(element);
    return { header: parseFloat(style.getPropertyValue("--control-height-lg")), height: parseFloat(style.getPropertyValue("--table-row-height")) };
  });
  await page.mouse.click(box.x + 80, box.y + row.header + row.height / 2, { button: "right" });
  const menu = page.getByRole("menu", { name: "记录操作", exact: true });
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: "查看详情", exact: true }).click();
  const detail = panel(page, "记录详情");
  await expect(detail.getByRole("textbox", { name: "数值", exact: true })).toHaveValue("42");
  await detail.getByRole("textbox", { name: "名称", exact: true }).fill("已排序的记录");
  expect(await flush(page)).toBe(true);
  expect((await file(page)).records[expected.id].values[field(1)]).toBe("已排序的记录");
});
