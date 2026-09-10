import { expect, test, type Page } from "@playwright/test";

type Harness = {
  __tableWorkers: Worker[];
  __tableWorkspaceTest: { flush(): Promise<boolean>; dirty(): boolean };
  __tableWorkspaceMock: { hold: boolean; missing: boolean; release(): void; calls: { command: string }[] };
  __TAURI_INTERNALS__: { invoke(command: string, bytes: Uint8Array): Promise<unknown> };
};
async function open(page: Page, loseReply = false) {
  await page.addInitScript(() => {
    const NativeWorker = window.Worker; const workers: Worker[] = [];
    Object.assign(window, { __tableWorkers: workers });
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) { super(url, options); if (String(url).includes("/table.worker.ts")) workers.push(this); }
    };
  });
  await page.goto("/table-workspace-test.html?mock=1");
  await expect(page.getByText("4 / 4 条记录 · 6 列")).toBeVisible();
  await page.evaluate(lose => {
    const app = window as unknown as Harness;
    app.__tableWorkspaceMock.hold = true;
    if (lose) {
      const invoke = app.__TAURI_INTERNALS__.invoke;
      app.__TAURI_INTERNALS__.invoke = async (command, bytes) => {
        const result = await invoke(command, bytes);
        if (command === "apply_table_mutations" && lose) { lose = false; throw { code: "IO_ERROR", message: "写入完成后响应丢失" }; }
        return result;
      };
    }
  }, loseReply);
}
async function editFirstCell(page: Page) {
  await expect(page.locator("[data-slot=dialog-overlay]")).toHaveCount(0);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const position = await page.locator(".table-workspace").evaluate(element => {
    const style = getComputedStyle(element);
    return { x: 56, y: parseFloat(style.getPropertyValue("--control-height-lg")) + parseFloat(style.getPropertyValue("--table-row-height")) / 2 };
  });
  const box = await page.locator(".table-workspace-grid canvas").first().boundingBox(); if (!box) throw new Error("Missing grid");
  await page.mouse.dblclick(box.x + position.x, box.y + position.y);
  return page.getByRole("textbox", { name: "编辑单元格" });
}
async function crashDuringWrite(page: Page) {
  await (await editFirstCell(page)).fill("仍在飞的写入"); await page.keyboard.press("Enter");
  await expect.poll(() => callCount(page, "apply_table_mutations")).toBe(1);
  await page.evaluate(() => (window as unknown as Harness).__tableWorkers[0].dispatchEvent(new ErrorEvent("error", { message: "写入期间后台中断" })));
  await page.getByRole("button", { name: "载入磁盘版本", exact: true }).click();
}
async function callCount(page: Page, command: string) {
  return page.evaluate(name => (window as unknown as Harness).__tableWorkspaceMock.calls.filter(call => call.command === name).length, command);
}
async function assertWaitingForWrite(page: Page) {
  const reads = await callCount(page, "read_table");
  await page.getByRole("button", { name: "丢弃草稿并载入" }).click();
  await expect(page.getByRole("button", { name: "丢弃草稿并载入" })).toBeDisabled();
  // Allow Worker/UI tasks to run: the native write deliberately remains held.
  await page.waitForTimeout(150);
  expect(await callCount(page, "read_table")).toBe(reads);
  expect(await page.evaluate(() => (window as unknown as Harness).__tableWorkers.length)).toBe(1);
  expect(await page.evaluate(() => (window as unknown as Harness).__tableWorkspaceTest.dirty())).toBe(true);
}

for (const loseReply of [false, true]) {
  test(`reload waits for a crashed Worker's pending write with ${loseReply ? "a lost response" : "a successful response"}`, async ({ page }) => {
    await open(page, loseReply); await crashDuringWrite(page); await assertWaitingForWrite(page);
    await page.evaluate(() => (window as unknown as Harness).__tableWorkspaceMock.release());
    await expect(page.getByText("已载入磁盘版本")).toBeVisible();
    expect(await callCount(page, "apply_table_mutations")).toBe(1);
    expect(await page.evaluate(() => (window as unknown as Harness).__tableWorkspaceTest.dirty())).toBe(false);
    const editor = await editFirstCell(page); await expect(editor).toHaveValue("仍在飞的写入");
    await editor.fill("恢复后继续编辑");
    expect(await page.evaluate(() => (window as unknown as Harness).__tableWorkspaceTest.flush())).toBe(true);
    expect(await callCount(page, "apply_table_mutations")).toBe(2);
  });
}

test("failed disk read after a lost write response preserves dirty state and retries only the read", async ({ page }) => {
  await open(page, true); await crashDuringWrite(page); await assertWaitingForWrite(page);
  await page.evaluate(() => { const mock = (window as unknown as Harness).__tableWorkspaceMock; mock.missing = true; mock.release(); });
  await expect(page.getByText("数据表文件不存在")).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as Harness).__tableWorkspaceTest.dirty())).toBe(true);
  expect(await page.evaluate(() => (window as unknown as Harness).__tableWorkers.length)).toBe(1);
  expect(await callCount(page, "apply_table_mutations")).toBe(1);
  await page.evaluate(() => { (window as unknown as Harness).__tableWorkspaceMock.missing = false; });
  await page.getByRole("button", { name: "丢弃草稿并载入" }).click();
  await expect(page.getByText("已载入磁盘版本")).toBeVisible();
  await expect(await editFirstCell(page)).toHaveValue("仍在飞的写入");
  expect(await callCount(page, "apply_table_mutations")).toBe(1);
});
