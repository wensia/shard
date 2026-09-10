import { expect, test, type Page } from "@playwright/test";

async function rowPoint(page: Page, row: number) {
  const canvas = page.locator(".table-workspace-grid canvas").first();
  const metrics = await page.locator(".table-workspace").evaluate(element => {
    const style = getComputedStyle(element);
    return { header: parseFloat(style.getPropertyValue("--control-height-lg")), row: parseFloat(style.getPropertyValue("--table-row-height")) };
  });
  const offset = metrics.header + row * metrics.row + metrics.row / 2;
  await expect.poll(async () => (await canvas.boundingBox())?.height ?? 0).toBeGreaterThan(offset);
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error("Grid canvas is not visible");
  return { x: bounds.x, y: bounds.y + offset };
}

for (const source of ["row context menu", "trailing add row"]) {
  test(`record detail takes keyboard focus from the ${source} and returns it on close`, async ({ page }) => {
    await page.goto("/table-workspace-test.html?mock=1");
    await expect(page.getByText("4 / 4 条记录 · 6 列")).toBeVisible();
    const point = await rowPoint(page, source === "row context menu" ? 0 : 4);
    if (source === "row context menu") {
      await page.mouse.click(point.x + 18, point.y, { button: "right" });
      await page.getByRole("menu", { name: "记录操作", exact: true }).getByRole("menuitem", { name: "查看详情", exact: true }).click();
    } else {
      await page.mouse.click(point.x + 80, point.y);
    }
    const detail = page.getByRole("complementary", { name: "记录详情", exact: true });
    const title = detail.getByRole("textbox", { name: "名称", exact: true });
    await expect(title).toBeFocused();
    await expect(page.locator(".table-workspace-grid")).toHaveAttribute("inert", "");
    // Glide defers its accessibility-cell focus; the drawer must still own focus afterwards.
    await page.waitForTimeout(300);
    await expect(title).toBeFocused();
    await page.keyboard.press("Tab");
    await expect.poll(() => detail.evaluate(element => element.contains(document.activeElement))).toBe(true);
    await detail.getByRole("button", { name: "返回表格", exact: true }).click();
    await expect(detail).toHaveCount(0);
    await expect(page.locator(".table-workspace-grid")).not.toHaveAttribute("inert", "");
    await expect.poll(() => page.locator(".table-workspace-grid canvas").first().evaluate(element => element.contains(document.activeElement))).toBe(true);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("textbox", { name: "编辑单元格", exact: true })).toBeVisible();
  });
}
