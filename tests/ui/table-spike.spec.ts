import { selectOption } from "./select-helpers"
import { expect, test } from "@playwright/test";

test.describe("isolated table renderer", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/table-spike.html");
    await expect(page.getByRole("status")).toContainText("1,000 行");
  });

  test("edits Chinese multiline text, confirms once, and cancels without changing data", async ({ page }) => {
    const scroller = page.locator(".dvn-scroller").first();
    await scroller.dblclick({ position: { x: 120, y: 55 } });
    // Glide mounts then focuses its portal editor in an effect. Filling before
    // that focus races the activation; wait for the real editing state.
    await expect(page.locator("textarea.gdg-input")).toBeFocused();
    await page.keyboard.press("Meta+A");
    await page.keyboard.insertText("中文原生文本\n第二行");
    await page.keyboard.press("Enter");
    await expect.poll(() => page.evaluate(() => window.__tableSpike.snapshot()?.rows[0][0])).toBe("中文原生文本\n第二行");
    const count = await page.evaluate(() => window.__tableSpike.samples.filter((sample) => sample.kind === "edit").length);
    await scroller.dblclick({ position: { x: 120, y: 55 } });
    await expect(page.locator("textarea.gdg-input")).toBeFocused();
    await page.keyboard.press("Meta+A");
    await page.keyboard.insertText("取消修改");
    await page.keyboard.press("Escape");
    await expect(page.locator("textarea.gdg-input")).toHaveCount(0);
    expect(await page.evaluate(() => window.__tableSpike.snapshot()?.rows[0][0])).toBe("中文原生文本\n第二行");
    expect(await page.evaluate(() => window.__tableSpike.samples.filter((sample) => sample.kind === "edit").length)).toBe(count);
  });

  test("10k rows project in the Worker and both axes stay inside the table", async ({ page }) => {
    await selectOption(page.getByLabel("数据规模"), "10000");
    await expect(page.getByRole("status")).toContainText("10,000 行");
    await page.getByLabel("按名称筛选").fill("记录 1");
    await page.getByRole("button", { name: "筛选并倒序" }).click();
    await expect.poll(() => page.evaluate(() => window.__tableSpike.snapshot()?.order.length)).toBe(1112);
    const scroller = page.locator(".dvn-scroller").first();
    await scroller.hover();
    await page.mouse.wheel(700, 900);
    await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await expect.poll(() => scroller.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
    expect(await page.evaluate(() => [document.scrollingElement?.scrollTop, document.scrollingElement?.scrollLeft])).toEqual([0, 0]);
    expect(await page.locator(".table-spike-toolbar").evaluate((element) => element.getBoundingClientRect().top)).toBe(0);
  });

  test("synthetic composition sequence does not submit on candidate Enter", async ({ page }) => {
    await page.locator(".dvn-scroller").first().dblclick({ position: { x: 120, y: 55 } });
    const editor = page.getByRole("textbox", { name: "编辑单元格" });
    await expect(editor).toBeFocused();
    await editor.dispatchEvent("compositionstart", { data: "" });
    await page.keyboard.press("Meta+A");
    await page.keyboard.insertText("候选文字");
    await page.keyboard.press("Enter");
    await expect(editor).toBeVisible();
    expect(await page.evaluate(() => window.__tableSpike.snapshot()?.rows[0][0])).toBe("记录 1 中文测试");
    await editor.dispatchEvent("compositionend", { data: "候选文字" });
    // Candidate confirmation may insert a newline in this synthetic sequence;
    // set the final committed text after ending composition, as a browser does.
    await editor.fill("候选文字");
    await page.keyboard.press("Enter");
    await expect.poll(() => page.evaluate(() => window.__tableSpike.snapshot()?.rows[0][0])).toBe("候选文字");
  });

  test("Canvas and portal consume the same Kiln font, colors and pixel lengths", async ({ page }) => {
    await page.locator(".dvn-scroller").first().dblclick({ position: { x: 120, y: 55 } });
    await expect(page.locator("textarea.gdg-input")).toBeFocused();
    const styles = await page.evaluate(() => {
      const editor = document.querySelector("textarea.gdg-input")!;
      const css = getComputedStyle(editor);
      const root = getComputedStyle(document.querySelector(".table-spike")!);
      return { font: css.fontFamily, size: css.fontSize, body: root.getPropertyValue("--text-body").trim(), radius: css.getPropertyValue("--gdg-rounding-radius").trim(), border: css.getPropertyValue("--gdg-border-color").trim(), horizontal: css.getPropertyValue("--gdg-horizontal-border-color").trim(), color: css.getPropertyValue("--gdg-accent-color").trim() };
    });
    expect(styles.font).toContain("Noto Sans SC");
    expect(styles.size).toBe(styles.body);
    expect(parseFloat(styles.radius)).toBeGreaterThan(1);
    expect(styles.border).not.toBe(styles.horizontal);
    expect(styles.color).toBeTruthy();
  });
});
