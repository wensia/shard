import { expect, test, type Page } from "@playwright/test";
import type { TableFile } from "../../src/features/tables/model";
import { selectOption } from "./select-helpers";

type Harness = { __tableWorkspaceTest: { flush(): Promise<boolean>; dirty(): boolean }; __tableWorkspaceMock: { disk: { file: TableFile }; calls: unknown[] } };
const field = (n: number) => `fld_${n.toString(16).padStart(32, "0")}`;
async function open(page: Page) { await page.goto("/table-workspace-test.html?mock=1"); await expect(page.getByText("4 / 4 条记录 · 6 列")).toBeVisible(); }
async function disk(page: Page) { return page.evaluate(() => (window as unknown as Harness).__tableWorkspaceMock.disk.file); }
async function flush(page: Page) { expect(await page.evaluate(() => (window as unknown as Harness).__tableWorkspaceTest.flush())).toBe(true); }
async function geometry(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const box = await page.locator(".table-workspace-grid canvas").first().boundingBox();
  if (!box) throw new Error("Missing grid");
  const metrics = await page.locator(".table-workspace").evaluate(element => { const style = getComputedStyle(element); return { column: parseFloat(style.getPropertyValue("--space-12")) * 4, row: parseFloat(style.getPropertyValue("--table-row-height")), header: parseFloat(style.getPropertyValue("--control-height-lg")) }; });
  return { ...metrics, x: box.x, y: box.y };
}
async function menu(page: Page, col: number) {
  const g = await geometry(page); const x = g.x + g.header + (col + 1) * g.column - 12; const y = g.y + g.header / 2;
  await page.mouse.move(x, y); await page.mouse.click(x, y); await expect(page.getByRole("menu")).toBeVisible();
}
async function gridClick(page: Page, row: number, col = 0) { const g = await geometry(page); await page.mouse.click(g.x + g.header + col * g.column + 60, g.y + g.header + (row + .5) * g.row); }
async function groupBy(page: Page, id: string) {
  await page.getByRole("button", { name: "分组", exact: true }).click();
  const panel = page.getByRole("complementary", { name: "分组设置" });
  await selectOption(panel.getByRole("combobox", { name: "分组", exact: true }), id);
  await panel.getByRole("button", { name: "关闭", exact: true }).click(); await flush(page);
}

test("column shortcuts are view scoped, protect the primary field and locate drafts by ID", async ({ page }) => {
  await open(page); await menu(page, 0);
  await expect(page.getByRole("menuitem", { name: "隐藏字段", exact: true })).toBeDisabled();
  await expect(page.getByRole("menuitem", { name: "删除字段", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape");
  await menu(page, 1); await page.getByRole("menuitem", { name: "降序排列", exact: true }).click(); await flush(page);
  let file = await disk(page); expect(file.views[file.viewOrder[0]].sorts).toEqual([{ fieldId: field(2), direction: "desc" }]);
  await menu(page, 1); await page.getByRole("menuitem", { name: "向左移动", exact: true }).click(); await flush(page);
  file = await disk(page); expect(file.views[file.viewOrder[0]].fieldOrder[0]).toBe(field(2));
  await menu(page, 0); await page.getByRole("menuitem", { name: "编辑字段", exact: true }).click();
  const panel = page.getByRole("complementary", { name: "编辑字段" }); await expect(panel.getByRole("textbox", { name: "名称", exact: true })).toHaveValue("数值");
  await panel.getByRole("button", { name: "确定", exact: true }).click();
  await menu(page, 0); await page.getByRole("menuitem", { name: "隐藏字段", exact: true }).click(); await flush(page);
  file = await disk(page); expect(file.views[file.viewOrder[0]].hiddenFieldIds).toEqual([field(2)]); expect(file.fields[field(2)]).toBeDefined();
});

test("trailing add field and field filter shortcuts open unapplied Kiln drafts", async ({ page }) => {
  await open(page); const before = await disk(page);
  await page.getByRole("button", { name: "＋ 新增字段", exact: true }).click();
  const panel = page.getByRole("complementary", { name: "新增字段" });
  await expect(panel.getByRole("textbox", { name: "名称", exact: true })).toHaveValue("新字段");
  expect((await disk(page)).fieldOrder).toEqual(before.fieldOrder);
  await panel.getByRole("textbox", { name: "名称", exact: true }).fill("负责人"); await panel.getByRole("button", { name: "确定", exact: true }).click(); await flush(page);
  expect((await disk(page)).fieldOrder.length).toBe(7);
  await page.locator(".table-workspace-grid .dvn-scroller").evaluate(element => { element.scrollLeft = 0; });
  await menu(page, 1); await page.getByRole("menuitem", { name: "筛选此字段", exact: true }).click();
  const filters = page.getByRole("complementary", { name: "筛选设置" });
  await expect(filters.getByRole("combobox", { name: "筛选字段", exact: true })).toContainText("数值");
  await expect(filters.getByRole("combobox", { name: "筛选字段", exact: true })).toBeFocused();
  expect((await disk(page)).views[before.viewOrder[0]].filters.conditions).toHaveLength(0);
  await filters.getByRole("button", { name: "关闭", exact: true }).click(); await flush(page);
  expect((await disk(page)).views[before.viewOrder[0]].filters.conditions[0].fieldId).toBe(field(2));
});

test("inline groups fold by pointer and keyboard without changing records or save state", async ({ page }) => {
  await open(page); await groupBy(page, field(6));
  const before = await disk(page);
  await expect(page.locator(".table-workspace-grid canvas").first()).toContainText("确认：未勾选 · 2 条");
  const expandedHeight = (await page.locator(".table-workspace-grid canvas").first().boundingBox())!.height;
  await gridClick(page, 0);
  await expect.poll(async () => (await page.locator(".table-workspace-grid canvas").first().boundingBox())!.height).toBeLessThan(expandedHeight);
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await page.locator(".table-workspace-grid canvas").first().boundingBox())!.height).toBe(expandedHeight);
  await page.getByRole("button", { name: "全部折叠", exact: true }).click();
  await expect(page.getByRole("button", { name: "全部折叠", exact: true })).toBeDisabled();
  await expect(page.locator(".table-workspace-grid canvas").first()).toContainText("确认：未填写 · 1 条");
  expect(await page.evaluate(() => (window as unknown as Harness).__tableWorkspaceTest.dirty())).toBe(false);
  await flush(page); expect(await disk(page)).toEqual(before);
  await page.getByRole("button", { name: "全部展开", exact: true }).click();
  await gridClick(page, 1); await page.getByRole("button", { name: "记录详情", exact: true }).click();
  await expect(page.getByRole("complementary", { name: "记录详情" }).getByRole("textbox", { name: "名称", exact: true })).toHaveValue("苹果\n第二行");
});

test("grouped paste skips collapsed records and copies only visible records", async ({ page, context, browserName }) => {
  test.skip(browserName === "webkit", "Clipboard permission is unavailable in Playwright WebKit");
  await context.grantPermissions(["clipboard-read", "clipboard-write"]); await open(page); await groupBy(page, field(6));
  const before = await disk(page); await gridClick(page, 0); // Hide the two false records.
  await gridClick(page, 2); // The true record after its group header.
  await page.evaluate(() => navigator.clipboard.writeText("更新真值记录\n更新未填写记录")); await page.keyboard.press("ControlOrMeta+V"); await expect(page.locator(".table-workspace-grid canvas").first()).toContainText("更新真值记录"); await flush(page);
  const after = await disk(page);
  expect(after.records[after.recordOrder[0]].values).toEqual(before.records[before.recordOrder[0]].values);
  expect(after.records[after.recordOrder[2]].values).toEqual(before.records[before.recordOrder[2]].values);
  expect(after.records[after.recordOrder[1]].values[field(1)]).toBe("更新真值记录");
  expect(after.records[after.recordOrder[3]].values[field(1)]).toBe("更新未填写记录");
  await page.keyboard.press("ControlOrMeta+A"); await page.keyboard.press("ControlOrMeta+C");
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain("更新真值记录");
  expect(await page.evaluate(() => navigator.clipboard.readText())).not.toContain("苹果");
  await page.getByRole("button", { name: "撤销", exact: true }).click(); await flush(page);
  expect((await disk(page)).records[before.recordOrder[1]].values).toEqual(before.records[before.recordOrder[1]].values);
});

test("column menus and group controls fit a narrow workbench with Kiln geometry", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 680, height: 760 }); await open(page); await menu(page, 1);
  const popup = page.getByRole("menu");
  await expect(popup).toHaveCSS("opacity", "1");
  const actual = await popup.evaluate(element => { const style = getComputedStyle(element); const rect = element.getBoundingClientRect(); return { radius: style.borderRadius, font: style.fontFamily, left: rect.left, right: rect.right, bottom: rect.bottom, width: innerWidth, height: innerHeight }; });
  expect(actual.radius).toBe("6px"); expect(actual.font).toContain("Noto Sans SC"); expect(actual.left).toBeGreaterThanOrEqual(0); expect(actual.right).toBeLessThanOrEqual(actual.width); expect(actual.bottom).toBeLessThanOrEqual(actual.height);
  await page.screenshot({ path: testInfo.outputPath("table-column-menu-narrow.png") });
  await page.keyboard.press("Escape"); await groupBy(page, field(6));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("table-groups-narrow.png") });
});


test("record detail keeps its invalid draft when the grid underneath is clicked", async ({ page }) => {
  await open(page); await gridClick(page, 0); await page.getByRole("button", { name: "记录详情", exact: true }).click();
  const panel = page.getByRole("complementary", { name: "记录详情" });
  await panel.getByRole("textbox", { name: "数值", exact: true }).fill("无效数字草稿");
  await gridClick(page, 1);
  await expect(panel.getByRole("textbox", { name: "名称", exact: true })).toHaveValue("苹果\n第二行");
  await expect(panel.getByRole("textbox", { name: "数值", exact: true })).toHaveValue("无效数字草稿");
  expect(await page.evaluate(() => (window as unknown as Harness).__tableWorkspaceTest.flush())).toBe(false);
});
