import { expect, test } from "@playwright/test";

test("field configuration keeps its draft while Chinese composition is pending", async ({ page }) => {
  await page.goto("/table-workspace-test.html?mock=1");
  await page.getByRole("button", { name: "＋ 新增字段", exact: true }).click();
  const panel = page.getByRole("complementary", { name: "新增字段" });
  const name = panel.getByRole("textbox", { name: "名称", exact: true });
  await name.fill("输入中的字段");
  await name.dispatchEvent("compositionstart");
  await panel.getByRole("button", { name: "确定", exact: true }).click();
  await expect(panel.getByRole("alert")).toHaveText("请先完成中文输入候选词，再应用设置。");
  await name.focus();
  await page.keyboard.press("Escape");
  await expect(panel).toBeVisible();
  await expect(name).toHaveValue("输入中的字段");
  expect(await page.evaluate(() => window.__tableWorkspaceTest.flush())).toBe(false);
  expect(await page.evaluate(() => window.__tableWorkspaceMock!.disk.file.fieldOrder.length)).toBe(6);
  await name.dispatchEvent("compositionend");
  expect(await page.evaluate(() => window.__tableWorkspaceTest.flush())).toBe(true);
  expect(await page.evaluate(() => Object.values(window.__tableWorkspaceMock!.disk.file.fields).some(field => field.name === "输入中的字段"))).toBe(true);
});

test("an overlapping workspace flush joins the field panel's in-flight mutation", async ({ page }) => {
  await page.goto("/table-workspace-test.html?mock=1");
  await page.getByRole("button", { name: "＋ 新增字段", exact: true }).click();
  const panel = page.getByRole("complementary", { name: "新增字段" });
  await panel.getByRole("textbox", { name: "名称", exact: true }).fill("仅应用一次");
  await page.evaluate(() => {
    const original = Worker.prototype.postMessage;
    const state = { held: [] as { worker: Worker; message: unknown }[], flushing: null as Promise<boolean> | null, release() {
      Worker.prototype.postMessage = original;
      for (const { worker, message } of state.held) original.call(worker, message);
    } };
    Worker.prototype.postMessage = function(message: { command?: { type: string } }) {
      if (message.command?.type === "mutate") state.held.push({ worker: this, message });
      else original.call(this, message);
    };
    Object.assign(window, { __fieldDraftState: state });
  });
  await panel.getByRole("button", { name: "确定", exact: true }).click();
  await expect(panel).toHaveAttribute("aria-busy", "true");
  await page.evaluate(() => {
    const state = (window as unknown as { __fieldDraftState: { flushing: Promise<boolean> | null } }).__fieldDraftState;
    state.flushing = window.__tableWorkspaceTest.flush();
  });
  expect(await page.evaluate(() => (window as unknown as { __fieldDraftState: { held: unknown[] } }).__fieldDraftState.held.length)).toBe(1);
  expect(await page.evaluate(async () => {
    const state = (window as unknown as { __fieldDraftState: { release(): void; flushing: Promise<boolean> } }).__fieldDraftState;
    state.release(); return await state.flushing;
  })).toBe(true);
  expect(await page.evaluate(() => Object.values(window.__tableWorkspaceMock!.disk.file.fields).filter(field => field.name === "仅应用一次").length)).toBe(1);
});
