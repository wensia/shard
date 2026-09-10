import { expect, test, type Page } from "@playwright/test";
import { selectOption } from "./select-helpers";

type Harness = { __tableWorkspaceTest: { flush(): Promise<boolean>; dirty(): boolean; refresh(): void; setDisabled(disabled: boolean): void; setInteractionBlocked(blocked: boolean): void; closed: number; saved: number }; __tableWorkspaceMock: { disk: { file: { revision: number; records: Record<string, { values: Record<string, unknown> }>; recordOrder: string[]; fields: Record<string, { name: string; options?: { id: string; label: string }[] }>; views: Record<string, unknown>; viewOrder: string[] }; revision: number; contentHash: string }; failSave: boolean; missing: boolean; hold: boolean; release(): void; copies: unknown[]; calls: { command: string; request: { expectedHash?: string; operations?: unknown[] } }[] } };
const field = (number: number) => `fld_${number.toString(16).padStart(32, "0")}`;
const record = (number: number) => `rec_${number.toString(16).padStart(32, "0")}`;
async function open(page: Page, extra = "") { await page.goto(`/table-workspace-test.html?mock=1${extra}`); if (!extra.includes("missing")) await expect(page.getByText("4 / 4 条记录 · 6 列")).toBeVisible(); }
async function cell(page: Page, column: number, row: number, edit = true) {
  await expect(page.locator("[data-slot=dialog-overlay]")).toHaveCount(0);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const dimensions = await page.locator(".table-workspace").evaluate(element => { const style = getComputedStyle(element); return { width: parseFloat(style.getPropertyValue("--space-12")) * 4, row: parseFloat(style.getPropertyValue("--table-row-height")), header: parseFloat(style.getPropertyValue("--control-height-lg")) }; });
  const canvas = page.locator(".table-workspace-grid canvas").first();
  const position = { x: 32 + column * dimensions.width + 24, y: dimensions.header + row * dimensions.row + dimensions.row / 2 };
  // The first Worker snapshot can precede ResizeObserver's usable grid height.
  await expect.poll(async () => (await canvas.boundingBox())?.height ?? 0).toBeGreaterThan(position.y);
  const box = await canvas.boundingBox(); if (!box) throw new Error("Grid canvas not visible");
  if (edit) await page.mouse.dblclick(box.x + position.x, box.y + position.y); else { await page.mouse.click(box.x + position.x, box.y + position.y); await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))); if (await page.getByRole("textbox", { name: "编辑单元格" }).isVisible()) await page.keyboard.press("Escape"); await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve()))); }
}
async function flush(page: Page) { return page.evaluate(() => (window as unknown as Harness).__tableWorkspaceTest.flush()); }
async function values(page: Page, row = 1) { return page.evaluate(id => (window as unknown as Harness).__tableWorkspaceMock.disk.file.records[id]?.values, record(row)); }
async function viewSettings(page: Page) { await page.getByRole("button", { name: "视图", exact: true }).click(); await page.getByRole("menuitem", { name: "筛选、排序与列设置" }).click(); }
async function expectGridFocus(page: Page) { await expect.poll(() => page.locator(".table-workspace-grid canvas").first().evaluate(element => element.contains(document.activeElement))).toBe(true); }

test("real keyboard input keeps its editor and Escape restores grid focus", async ({ page }) => {
  await open(page, "&trace=1"); await cell(page, 0, 0);
  const editor = page.getByRole("textbox", { name: "编辑单元格" });
  const firstInstance = await editor.elementHandle();
  await editor.pressSequentially("abc", { delay: 40 }); await expect(editor).toHaveValue("abc");
  expect(await firstInstance?.evaluate(element => element === document.querySelector(".table-native-cell-editor"))).toBe(true);
  await expect(page.getByLabel("原生输入事件")).toContainText('"type":"input"');
  await expect(page.getByLabel("原生输入事件")).toContainText('"dirty":true');
  await page.keyboard.press("Enter"); expect(await flush(page)).toBe(true); expect((await values(page))[field(1)]).toBe("abc");
  await cell(page, 0, 0); await editor.pressSequentially("discard"); await page.keyboard.press("Escape");
  await expect(editor).toHaveCount(0);
  await expectGridFocus(page);
  // Glide moves focus from canvas to its accessibility cell after a 200ms
  // debounce. Both belong to the grid; keyboard navigation must keep working.
  await expect(page.locator(".table-workspace-grid #glide-cell-1-0")).toBeFocused();
  expect(await flush(page)).toBe(true); expect((await values(page))[field(1)]).toBe("abc");
  await page.keyboard.press("ArrowDown"); await page.keyboard.press("Enter"); await expect(editor).toHaveValue("Apple");
  await editor.fill("Esc 后继续编辑"); expect(await flush(page)).toBe(true); expect((await values(page, 2))[field(1)]).toBe("Esc 后继续编辑");
});

test("structural freeze flushes existing drafts and blocks editing until released", async ({ page, context, browserName }) => {
  if (browserName === "chromium") await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await open(page); await cell(page, 0, 0); await page.getByRole("textbox", { name: "编辑单元格" }).fill("冻结前草稿");
  expect(await page.evaluate(() => { const app = (window as unknown as Harness).__tableWorkspaceTest; app.setInteractionBlocked(true); return app.flush(); })).toBe(true);
  expect((await values(page))[field(1)]).toBe("冻结前草稿");
  const workspace = page.locator(".table-workspace"); await expect(workspace).toHaveAttribute("aria-disabled", "true"); await expect(workspace).toHaveAttribute("aria-busy", "true");
  for (const name of ["撤销", "重做", "字段", "新增记录", "新建视图", "视图", "筛选", "排序", "分组", "记录详情", "导出"]) await expect(workspace.getByRole("button", { name, exact: true })).toBeDisabled();
  await expect(page.getByRole("tab", { selected: true })).toBeDisabled();
  const before = await page.evaluate(() => (window as unknown as Harness).__tableWorkspaceMock.disk.revision);
  await cell(page, 0, 1); await page.keyboard.type("不得写入"); await page.keyboard.press("ControlOrMeta+Z"); await page.keyboard.press("Delete");
  if (browserName === "chromium") { await page.evaluate(() => navigator.clipboard.writeText("不得粘贴\t123")); await page.keyboard.press("ControlOrMeta+V"); }
  await expect(page.locator(".table-native-cell-editor")).toHaveCount(0); expect(await flush(page)).toBe(true);
  expect(await page.evaluate(() => (window as unknown as Harness).__tableWorkspaceMock.disk.revision)).toBe(before);
  await page.evaluate(() => (window as unknown as Harness).__tableWorkspaceTest.setInteractionBlocked(false));
  await cell(page, 0, 0, false); await page.getByRole("button", { name: "记录详情", exact: true }).click();
  const panel = page.getByRole("complementary", { name: "记录详情" }); await panel.getByRole("textbox", { name: "名称", exact: true }).fill("冻结前表单");
  await page.evaluate(() => (window as unknown as Harness).__tableWorkspaceTest.setDisabled(true)); await expect(workspace).toHaveAttribute("aria-disabled", "true");
  expect(await flush(page)).toBe(true); expect((await values(page))[field(1)]).toBe("冻结前表单");
  await page.evaluate(() => (window as unknown as Harness).__tableWorkspaceTest.setDisabled(false)); await panel.getByRole("button", { name: "返回表格" }).click();
  await cell(page, 0, 0); await page.getByRole("textbox", { name: "编辑单元格" }).fill("解除冻结后"); expect(await flush(page)).toBe(true); expect((await values(page))[field(1)]).toBe("解除冻结后");
});

test("invalid numeric text survives outside save/close and blocks flush", async ({ page }) => {
  await open(page); await cell(page, 1, 0);
  const editor = page.getByRole("textbox", { name: "编辑单元格" }); await expect(editor).toBeVisible(); await editor.fill("不能转换的编号");
  expect(await page.evaluate(() => (window as unknown as Harness).__tableWorkspaceTest.dirty())).toBe(true);
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(editor).toHaveValue("不能转换的编号"); expect(await flush(page)).toBe(false);
  await page.getByRole("button", { name: "关闭", exact: true }).click(); await expect(editor).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as Harness).__tableWorkspaceTest.closed)).toBe(0);
  expect((await values(page))[field(2)]).toBe(0);
  await editor.fill("12.5"); expect(await flush(page)).toBe(true); expect((await values(page))[field(2)]).toBe(12.5);
});

test("record form edits six stable-ID types and keeps zero, false and empty text", async ({ page }) => {
  await open(page); await cell(page, 0, 0, false);
  await page.getByRole("button", { name: "记录详情", exact: true }).click();
  const panel = page.getByRole("complementary", { name: "记录详情" });
  await panel.getByRole("textbox", { name: "名称", exact: true }).fill("");
  await panel.getByRole("textbox", { name: "数值", exact: true }).fill("0");
  await panel.getByRole("button", { name: "日期", exact: true }).click();
  const calendar = page.getByRole("dialog", { name: "日期", exact: true });
  await calendar.getByRole("textbox", { name: "年份", exact: true }).fill("2025");
  await selectOption(calendar.getByRole("combobox", { name: "月份", exact: true }), "3");
  await calendar.getByRole("button", { name: "2025-03-08", exact: true }).click();
  await selectOption(panel.getByRole("combobox", { name: "状态", exact: true }), "opt_00000000000000000000000000000002");
  await panel.getByRole("checkbox", { name: "中文", exact: true }).uncheck(); await panel.getByRole("checkbox", { name: "长文本", exact: true }).uncheck();
  await selectOption(panel.getByRole("combobox", { name: "确认", exact: true }), "false");
  expect(await flush(page)).toBe(true);
  expect(await values(page)).toMatchObject({ [field(1)]: "", [field(2)]: 0, [field(3)]: "2025-03-08", [field(4)]: "opt_00000000000000000000000000000002", [field(5)]: [], [field(6)]: false });
  await expect(panel).toBeVisible();
  await panel.getByRole("button", { name: "返回表格" }).click();
  await page.getByRole("button", { name: "字段", exact: true }).click();
  await page.getByRole("button", { name: "编辑状态字段", exact: true }).click();
  const fields = page.getByRole("complementary", { name: "编辑字段" });
  await fields.getByRole("textbox", { name: "选项 2 名称" }).fill("已完成");
  expect(await flush(page)).toBe(true);
  expect((await values(page))[field(4)]).toBe("opt_00000000000000000000000000000002");
  expect(await page.evaluate(id => (window as unknown as Harness).__tableWorkspaceMock.disk.file.fields[id].options?.[1].label, field(4))).toBe("已完成");
});

test("late save response retains newer edits and a failed save prevents closing", async ({ page }) => {
  await open(page); await page.evaluate(() => { (window as unknown as Harness).__tableWorkspaceMock.hold = true; });
  await cell(page, 0, 0); await page.getByRole("textbox", { name: "编辑单元格" }).fill("先保存"); await page.keyboard.press("Enter");
  await expect.poll(() => page.evaluate(() => (window as unknown as Harness).__tableWorkspaceMock.calls.filter(call => call.command === "apply_table_mutations").length)).toBe(1);
  await cell(page, 0, 0); await page.getByRole("textbox", { name: "编辑单元格" }).fill("保存期间的后续输入"); await page.keyboard.press("Enter");
  await page.evaluate(() => (window as unknown as Harness).__tableWorkspaceMock.release()); expect(await flush(page)).toBe(true);
  expect((await values(page))[field(1)]).toBe("保存期间的后续输入");
  const hashes = await page.evaluate(() => (window as unknown as Harness).__tableWorkspaceMock.calls.filter(call => call.command === "apply_table_mutations").map(call => call.request.expectedHash));
  expect(hashes.length).toBe(2); expect(hashes[0]).not.toBe(hashes[1]);
  await page.evaluate(() => { (window as unknown as Harness).__tableWorkspaceMock.failSave = true; });
  await cell(page, 0, 0); await page.getByRole("textbox", { name: "编辑单元格" }).fill("失败时保留");
  await page.getByRole("button", { name: "关闭", exact: true }).click(); await expect(page.getByText("测试保存失败，草稿仍然保留")).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as Harness).__tableWorkspaceTest.closed)).toBe(0); expect(await flush(page)).toBe(false);
  await page.getByRole("button", { name: "另存副本", exact: true }).click(); await expect(page.getByText(/副本已保存到/)).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as Harness).__tableWorkspaceMock.copies.length)).toBe(1);
});

test("filter/sort then edit targets the projected record and view settings persist", async ({ page }) => {
  await open(page); await viewSettings(page);
  const panel = page.getByRole("complementary", { name: "视图设置" });
  await panel.getByRole("button", { name: "添加条件", exact: true }).click();
  await selectOption(panel.getByRole("combobox", { name: "筛选关系" }), "contains"); await panel.getByRole("textbox", { name: "筛选值" }).fill("Apple");
  await panel.getByRole("button", { name: "添加排序", exact: true }).click(); await selectOption(panel.getByRole("combobox", { name: "排序 1 方向" }), "desc");
  await selectOption(panel.getByRole("combobox", { name: "分组", exact: true }), field(4));
  await panel.getByRole("button", { name: "关闭", exact: true }).click(); await expect(page.getByText("1 / 4 条记录 · 6 列")).toBeVisible();
  await cell(page, 0, 1); await page.getByRole("textbox", { name: "编辑单元格" }).fill("Apple edited"); expect(await flush(page)).toBe(true);
  expect((await values(page, 2))[field(1)]).toBe("Apple edited"); expect((await values(page, 1))[field(1)]).toBe("苹果\n第二行");
  await page.getByRole("button", { name: "视图", exact: true }).click(); await page.getByRole("menuitem", { name: "复制当前视图" }).click();
  await expect(page.getByRole("complementary", { name: "视图设置" })).toBeVisible(); expect(await flush(page)).toBe(true);
  expect(await page.evaluate(() => (window as unknown as Harness).__tableWorkspaceMock.disk.file.viewOrder.length)).toBe(2);
});

test("rectangular paste adds rows atomically and undo reverts one whole gesture", async ({ page, context, browserName }) => {
  test.skip(browserName === "webkit", "Playwright WebKit does not support the clipboard-write permission; native system clipboard acceptance is separate.");
  await context.grantPermissions(["clipboard-read", "clipboard-write"]); await open(page);
  await cell(page, 0, 3, false); await page.evaluate(() => navigator.clipboard.writeText("第四条\t10\n第五条\t20\n第六条\t30")); await page.keyboard.press("ControlOrMeta+V");
  await expect(page.getByText("6 / 6 条记录 · 6 列")).toBeVisible(); expect(await flush(page)).toBe(true);
  expect(await page.evaluate(() => (window as unknown as Harness).__tableWorkspaceMock.disk.file.recordOrder.length)).toBe(6);
  await page.getByRole("button", { name: "撤销", exact: true }).click(); await expect(page.getByText("4 / 4 条记录 · 6 列")).toBeVisible(); expect(await flush(page)).toBe(true);
  expect((await values(page, 4))[field(2)]).toBe(42);
  // Move from a different row: two rapid clicks on the previous target can
  // intentionally activate Glide's editor instead of selecting a paste range.
  await cell(page, 0, 2, false); await page.keyboard.press("ArrowDown");
  await expectGridFocus(page);
  await page.evaluate(() => navigator.clipboard.writeText("不得部分写入\t10\n非法数字\txyz")); await page.keyboard.press("ControlOrMeta+V");
  await expect(page.getByRole("alert")).toBeVisible(); expect(await page.evaluate(() => (window as unknown as Harness).__tableWorkspaceMock.disk.file.recordOrder.length)).toBe(4);
  expect((await values(page, 4))[field(1)]).toBeUndefined();
});

test("own-save refresh keeps undo; external replacement preserves dirty edits; narrow details use one pane", async ({ page }) => {
  await open(page); await cell(page, 0, 0); await page.getByRole("textbox", { name: "编辑单元格" }).fill("自己的保存"); expect(await flush(page)).toBe(true);
  await page.evaluate(() => (window as unknown as Harness).__tableWorkspaceTest.refresh()); await page.waitForTimeout(150);
  await expect(page.getByRole("button", { name: "撤销", exact: true })).toBeEnabled(); await expect(page.getByRole("alert")).toHaveCount(0);
  await cell(page, 0, 0); await page.getByRole("textbox", { name: "编辑单元格" }).fill("尚未保存的草稿");
  await page.evaluate(() => { const app = window as unknown as Harness; app.__tableWorkspaceMock.disk.contentHash = "d".repeat(64); app.__tableWorkspaceTest.refresh(); });
  await expect(page.getByText("磁盘中的多维表格已变化，当前草稿已保留。请选择如何处理。")).toBeVisible(); expect(await flush(page)).toBe(false);
  await page.getByRole("button", { name: "载入磁盘版本", exact: true }).click(); await page.getByRole("button", { name: "丢弃草稿并载入" }).click();
  await expect(page.getByText("已载入磁盘版本")).toBeVisible();
  await page.setViewportSize({ width: 560, height: 640 }); await cell(page, 0, 0, false); await page.getByRole("button", { name: "记录详情", exact: true }).click();
  await expect(page.getByRole("complementary", { name: "记录详情" })).toBeVisible(); await expect(page.locator(".table-workspace-grid")).toBeHidden();
  const styles = await page.locator(".table-workspace").evaluate(element => { const button = element.querySelector("button")!; const input = element.querySelector("input")!; return { font: getComputedStyle(element).fontFamily, buttonRadius: getComputedStyle(button).borderRadius, inputRadius: getComputedStyle(input).borderRadius, overflow: document.documentElement.scrollWidth > innerWidth }; });
  expect(styles.font).toContain("Noto Sans SC"); expect(styles.buttonRadius).toBe("4px"); expect(styles.inputRadius).toBe("4px"); expect(styles.overflow).toBe(false);
});

test("a missing unopened file can be left without claiming a save", async ({ page }) => {
  await open(page, "&missing=1"); await expect(page.getByText("数据表文件不存在")).toBeVisible(); expect(await flush(page)).toBe(true);
  await page.getByRole("button", { name: "关闭", exact: true }).click(); await expect(page.getByText("已离开工作区")).toBeVisible();
});


test("pristine overlay cannot overwrite an externally refreshed record", async ({ page }) => {
  await open(page); await cell(page, 0, 0);
  await expect(page.getByRole("textbox", { name: "编辑单元格" })).toHaveValue("苹果\n第二行");
  expect(await page.evaluate(() => (window as unknown as Harness).__tableWorkspaceTest.dirty())).toBe(false);
  await page.evaluate(({ recordId, fieldId }) => {
    const app = window as unknown as Harness;
    app.__tableWorkspaceMock.disk.file.records[recordId].values[fieldId] = "磁盘中的新值";
    app.__tableWorkspaceMock.disk.contentHash = "d".repeat(64);
    app.__tableWorkspaceMock.disk.revision++;
    app.__tableWorkspaceMock.disk.file.revision = app.__tableWorkspaceMock.disk.revision;
    app.__tableWorkspaceTest.refresh();
  }, { recordId: record(1), fieldId: field(1) });
  await expect(page.getByRole("textbox", { name: "编辑单元格" })).toHaveCount(0);
  expect(await flush(page)).toBe(true); expect((await values(page))[field(1)]).toBe("磁盘中的新值");
  expect(await page.evaluate(() => (window as unknown as Harness).__tableWorkspaceMock.calls.filter(call => call.command === "apply_table_mutations").length)).toBe(0);
});

test("clean external deletion allows leaving; dirty deletion requires explicit abandonment", async ({ page }) => {
  await open(page);
  await page.evaluate(() => { const app = window as unknown as Harness; app.__tableWorkspaceMock.missing = true; app.__tableWorkspaceTest.refresh(); });
  await expect(page.getByText("数据表文件不存在")).toBeVisible(); expect(await flush(page)).toBe(true);
  await cell(page, 0, 0); await page.getByRole("textbox", { name: "编辑单元格" }).fill("保留的草稿"); await page.keyboard.press("Enter");
  expect(await flush(page)).toBe(false);
  await page.getByRole("button", { name: "放弃草稿并离开", exact: true }).click();
  expect(await page.evaluate(() => (window as unknown as Harness).__tableWorkspaceTest.closed)).toBe(0);
  await page.getByRole("button", { name: "确认放弃并离开", exact: true }).click();
  await expect(page.getByText("已离开工作区")).toBeVisible(); expect(await flush(page)).toBe(true);
});

test("synthetic composition boundary prevents clean refresh replacing the active editor", async ({ page }) => {
  await open(page); await cell(page, 0, 0); const editor = page.getByRole("textbox", { name: "编辑单元格" });
  await editor.dispatchEvent("compositionstart", { data: "" });
  expect(await page.evaluate(() => (window as unknown as Harness).__tableWorkspaceTest.dirty())).toBe(true);
  await page.evaluate(({ recordId, fieldId }) => { const app = window as unknown as Harness; app.__tableWorkspaceMock.disk.file.records[recordId].values[fieldId] = "外部新内容"; app.__tableWorkspaceMock.disk.contentHash = "d".repeat(64); app.__tableWorkspaceTest.refresh(); }, { recordId: record(1), fieldId: field(1) });
  await expect(page.getByText("磁盘中的多维表格已变化，当前草稿已保留。请选择如何处理。")).toBeVisible();
  await expect(editor).toHaveValue("苹果\n第二行"); expect(await flush(page)).toBe(false);
  await editor.dispatchEvent("compositionend", { data: "" }); await page.keyboard.press("Escape");
  expect((await values(page))[field(1)]).toBe("外部新内容");
  expect(await page.evaluate(() => (window as unknown as Harness).__tableWorkspaceMock.calls.filter(call => call.command === "apply_table_mutations").length)).toBe(0);
});

async function trackWorkers(page: Page) {
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    const state = { workers: [] as Worker[], hold: false, held: [] as (() => void)[] };
    Object.assign(window, { __tableWorkerControl: state });
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) { super(url, options); if (String(url).includes("/table.worker.ts")) state.workers.push(this); }
      postMessage(message: unknown, transferOrOptions?: Transferable[] | StructuredSerializeOptions) {
        const send = () => super.postMessage(message, transferOrOptions as Transferable[]);
        if (state.hold && state.workers.includes(this) && (message as { command?: { type: string } }).command?.type === "mutate") state.held.push(send); else send();
      }
    };
  });
}

test("fatal Worker recovery accepts a generation-zero reset and editing works again", async ({ page }) => {
  await trackWorkers(page); await open(page); await cell(page, 0, 0); await page.getByRole("textbox", { name: "编辑单元格" }).fill("尚未保存的旧Worker草稿"); await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "撤销", exact: true })).toBeEnabled();
  await page.evaluate(() => { const state = (window as unknown as { __tableWorkerControl: { workers: Worker[] } }).__tableWorkerControl; state.workers[0].dispatchEvent(new ErrorEvent("error", { message: "测试Worker中断" })); });
  await expect(page.getByRole("button", { name: "载入磁盘版本", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "载入磁盘版本", exact: true }).click(); await page.getByRole("button", { name: "丢弃草稿并载入" }).click(); await expect(page.getByText("已载入磁盘版本")).toBeVisible();
  await cell(page, 0, 0); await expect(page.getByRole("textbox", { name: "编辑单元格" })).toHaveValue("苹果\n第二行");
  await page.getByRole("textbox", { name: "编辑单元格" }).fill("新Worker可继续编辑"); expect(await flush(page)).toBe(true); expect((await values(page))[field(1)]).toBe("新Worker可继续编辑");
});

test("abandon waits for a pending edit and its late response never triggers a save", async ({ page }) => {
  await trackWorkers(page); await open(page);
  await page.evaluate(() => { (window as unknown as { __tableWorkerControl: { hold: boolean } }).__tableWorkerControl.hold = true; });
  await cell(page, 0, 0); await page.getByRole("textbox", { name: "编辑单元格" }).fill("待处理的草稿"); await page.keyboard.press("Enter");
  await page.evaluate(() => { const app = window as unknown as Harness; app.__tableWorkspaceMock.missing = true; app.__tableWorkspaceTest.refresh(); });
  await expect(page.getByText("数据表文件不存在")).toBeVisible();
  await expect(page.getByRole("button", { name: "放弃草稿并离开", exact: true })).toBeDisabled();
  await page.evaluate(() => { const state = (window as unknown as { __tableWorkerControl: { hold: boolean; held: (() => void)[] } }).__tableWorkerControl; state.hold = false; for (const send of state.held.splice(0)) send(); });
  await expect(page.getByRole("button", { name: "放弃草稿并离开", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "放弃草稿并离开", exact: true }).click(); await page.getByRole("button", { name: "确认放弃并离开", exact: true }).click();
  await expect(page.getByText("已离开工作区")).toBeVisible(); await page.waitForTimeout(1000);
  expect(await page.evaluate(() => (window as unknown as Harness).__tableWorkspaceMock.calls.filter(call => call.command === "apply_table_mutations").length)).toBe(0);
});

test("visible view tabs preserve invalid drafts and require composition to finish", async ({ page }) => {
  await open(page);
  await expect(page.getByRole("tab", { name: "全部记录", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("button", { name: "新建视图", exact: true }).click();
  const settings = page.getByRole("complementary", { name: "视图设置" });
  await settings.getByRole("textbox", { name: "视图名称" }).fill("工作视图");
  await settings.getByRole("button", { name: "关闭", exact: true }).click();
  const original = page.getByRole("tab", { name: "全部记录", exact: true });
  const working = page.getByRole("tab", { name: "工作视图", exact: true });
  await expect(working).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", await working.getAttribute("id") ?? "");

  await cell(page, 1, 0);
  const editor = page.getByRole("textbox", { name: "编辑单元格" });
  await editor.fill("不是数字"); await original.click();
  await expect(working).toHaveAttribute("aria-selected", "true");
  await expect(editor).toHaveValue("不是数字"); expect(await flush(page)).toBe(false);
  await editor.fill("17.5"); await original.click();
  await expect(original).toHaveAttribute("aria-selected", "true");
  expect(await flush(page)).toBe(true); expect((await values(page))[field(2)]).toBe(17.5);

  await cell(page, 0, 0); await editor.dispatchEvent("compositionstart", { data: "" });
  await working.click(); await expect(original).toHaveAttribute("aria-selected", "true");
  await expect(editor).toBeVisible();
  await editor.dispatchEvent("compositionend", { data: "" }); await editor.press("Escape");
  await working.click(); await expect(working).toHaveAttribute("aria-selected", "true");

  await viewSettings(page); await settings.getByRole("textbox", { name: "视图名称" }).fill("");
  await original.click(); await expect(working).toHaveAttribute("aria-selected", "true");
  await expect(settings.getByRole("textbox", { name: "视图名称" })).toHaveValue("");
  await settings.getByRole("textbox", { name: "视图名称" }).fill("已恢复的视图：本季度重点事项");
  await original.click(); await expect(original).toHaveAttribute("aria-selected", "true");
  await expect(settings).toHaveCount(0); expect(await flush(page)).toBe(true);
  await expect(page.getByRole("tab", { name: "已恢复的视图：本季度重点事项", exact: true })).toBeVisible();
  await original.focus(); await page.keyboard.press("ArrowRight");
  const recovered = page.getByRole("tab", { name: "已恢复的视图：本季度重点事项", exact: true });
  await expect(recovered).toBeFocused(); await expect(original).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter"); await expect(recovered).toHaveAttribute("aria-selected", "true");
  const tabStyle = await recovered.evaluate(element => { const style = getComputedStyle(element); const group = element.closest(".table-view-tab-group")!; return { active: group.getAttribute("data-active"), background: getComputedStyle(group).backgroundColor, radius: style.borderRadius, shadow: style.boxShadow, weight: style.fontWeight, height: element.getBoundingClientRect().height, siblingHeight: element.closest(".table-view-bar")!.querySelector(":scope > button")!.getBoundingClientRect().height }; });
  expect(tabStyle).toMatchObject({ radius: "0px", shadow: "none", weight: "500" });
  expect(tabStyle.active).toBe("true"); expect(tabStyle.background).not.toBe("rgba(0, 0, 0, 0)"); expect(tabStyle.height).toBe(tabStyle.siblingHeight);
  await page.setViewportSize({ width: 320, height: 800 });
  expect(await page.locator(".table-view-tabs").evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
});

test("filter sort and group buttons open only their own settings and expose active counts", async ({ page }) => {
  await open(page);
  for (const name of ["筛选", "排序", "分组"]) await expect(page.getByRole("button", { name, exact: true })).toHaveAttribute("aria-pressed", "false");
  await page.getByRole("button", { name: "筛选", exact: true }).click();
  const filters = page.getByRole("complementary", { name: "筛选设置", exact: true });
  await expect(filters.getByRole("textbox", { name: "视图名称" })).toHaveCount(0);
  await expect(filters.getByRole("button", { name: "添加排序" })).toHaveCount(0);
  await filters.getByRole("button", { name: "添加条件", exact: true }).click();
  await filters.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(page.getByRole("button", { name: "筛选 1", exact: true })).toHaveAttribute("aria-pressed", "true");

  await page.getByRole("button", { name: "排序", exact: true }).click();
  const sorts = page.getByRole("complementary", { name: "排序设置", exact: true });
  await expect(sorts.getByRole("button", { name: "添加条件" })).toHaveCount(0);
  await sorts.getByRole("button", { name: "添加排序", exact: true }).click();
  await selectOption(sorts.getByRole("combobox", { name: "排序 1 字段" }), field(2));
  await selectOption(sorts.getByRole("combobox", { name: "排序 1 方向" }), "desc");
  await sorts.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(page.getByRole("button", { name: "排序 1", exact: true })).toHaveAttribute("aria-pressed", "true");

  await page.getByRole("button", { name: "分组", exact: true }).click();
  const groups = page.getByRole("complementary", { name: "分组设置", exact: true });
  await expect(groups.getByRole("button", { name: "添加排序" })).toHaveCount(0);
  await selectOption(groups.getByRole("combobox", { name: "分组", exact: true }), field(4));
  await groups.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(page.getByRole("button", { name: "分组 1", exact: true })).toHaveAttribute("aria-pressed", "true");
  expect(await flush(page)).toBe(true);
  expect(await page.evaluate(() => { const file = (window as unknown as Harness).__tableWorkspaceMock.disk.file; return file.views[file.viewOrder[0]]; })).toMatchObject({ filters: { conditions: [{ operator: "isNotEmpty" }] }, sorts: [{ fieldId: field(2), direction: "desc" }], groupBy: field(4) });
});

test("column headers open the correct stable field after view reordering", async ({ page }) => {
  await open(page); await viewSettings(page);
  const settings = page.getByRole("complementary", { name: "视图设置" });
  await settings.getByRole("button", { name: "状态上移", exact: true }).click();
  await settings.getByRole("button", { name: "状态上移", exact: true }).click();
  await settings.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(settings).toHaveCount(0);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
  const canvas = page.locator(".table-workspace-grid canvas").first();
  const width = await page.locator(".table-workspace").evaluate(element => parseFloat(getComputedStyle(element).getPropertyValue("--space-12")) * 4);
  const box = await canvas.boundingBox(); if (!box) throw new Error("Grid canvas not visible");
  await page.mouse.click(box.x + 32 + width + 24, box.y + 20);
  const fields = page.getByRole("complementary", { name: "编辑字段", exact: true });
  await expect(fields.getByRole("combobox", { name: "类型", exact: true })).toContainText("单选");
  await expect(fields.getByRole("textbox", { name: "名称", exact: true })).toHaveValue("状态");
  await fields.getByRole("textbox", { name: "名称", exact: true }).fill("项目状态");
  await fields.getByRole("button", { name: "确定", exact: true }).click();
  expect(await flush(page)).toBe(true);
  expect(await page.evaluate(id => (window as unknown as Harness).__tableWorkspaceMock.disk.file.fields[id].name, field(4))).toBe("项目状态");
  expect((await values(page))[field(4)]).toBe("opt_00000000000000000000000000000001");
  await cell(page, 0, 0, false); await page.getByRole("button", { name: "记录详情", exact: true }).click();
  await expect(page.getByRole("complementary", { name: "记录详情" }).getByRole("combobox", { name: "项目状态", exact: true })).toBeVisible();
});

test("Kiln field type selector renders its popup with stable geometry in wide and narrow panels", async ({ page }) => {
  await open(page); await page.getByRole("button", { name: "字段", exact: true }).click();
  await page.getByRole("button", { name: "编辑状态字段", exact: true }).click();
  const panel = page.getByRole("complementary", { name: "编辑字段", exact: true });
  const selector = panel.getByRole("combobox", { name: "类型", exact: true });
  for (const width of [1280, 560]) {
    await page.setViewportSize({ width, height: 720 });
    const triggerBox = await selector.boundingBox();
    expect(await selector.evaluate(element => getComputedStyle(element).borderRadius)).toBe("4px");
    await selector.click();
    const popup = page.locator('[data-slot="select-content"]');
    await expect(popup.getByRole("option")).toHaveCount(6);
    const popupBox = await popup.boundingBox();
    if (!triggerBox || !popupBox) throw new Error("Field selector or popup is not visible");
    expect(Math.abs(popupBox.x - triggerBox.x)).toBeLessThan(2);
    // A taller field list can place this editor near the viewport bottom;
    // the shared selector may flip above its trigger to keep all options usable.
    expect(popupBox.y >= triggerBox.y + triggerBox.height || popupBox.y + popupBox.height <= triggerBox.y).toBe(true);
    expect(popupBox.y).toBeGreaterThanOrEqual(0);
    expect(popupBox.y + popupBox.height).toBeLessThanOrEqual(720);
    expect(popupBox.x + popupBox.width).toBeLessThanOrEqual(width);
    expect(await popup.evaluate(element => getComputedStyle(element).borderRadius)).toBe("6px");
    await page.keyboard.press("Escape");
    await expect(selector).toBeFocused();
    await expect(panel.locator('select:not([aria-hidden="true"]), input[type="date"]')).toHaveCount(0);
  }
  await selectOption(selector, "select");
  await selectOption(panel.getByRole("combobox", { name: "选项 2 颜色", exact: true }), "purple");
  await panel.getByRole("textbox", { name: "名称", exact: true }).fill("发布状态");
  expect(await flush(page)).toBe(true);
  expect(await page.evaluate(id => (window as unknown as Harness).__tableWorkspaceMock.disk.file.fields[id], field(4))).toMatchObject({ name: "发布状态", options: [{}, { color: "purple" }] });
});

test("cell select and date portals isolate keyboard and retain values when switching views", async ({ page }) => {
  await open(page); await page.getByRole("button", { name: "新建视图", exact: true }).click();
  await page.getByRole("complementary", { name: "视图设置" }).getByRole("button", { name: "关闭", exact: true }).click();
  const original = page.getByRole("tab", { name: "全部记录", exact: true });
  await cell(page, 3, 0);
  const overlay = page.locator(".table-cell-overlay");
  const status = overlay.getByRole("combobox", { name: "状态", exact: true });
  await status.focus(); await page.keyboard.press("Enter");
  await expect(page.getByRole("listbox")).toBeVisible();
  await page.keyboard.press("Escape"); await expect(overlay).toBeVisible();
  await selectOption(status, "opt_00000000000000000000000000000002");
  await expect(overlay).toBeVisible();
  expect((await values(page))[field(4)]).toBe("opt_00000000000000000000000000000001");
  await status.press("Tab"); await expect(overlay).toHaveCount(0);
  await original.click(); await expect(original).toHaveAttribute("aria-selected", "true");
  expect(await flush(page)).toBe(true);
  expect((await values(page))[field(4)]).toBe("opt_00000000000000000000000000000002");

  await cell(page, 2, 0);
  const date = overlay.getByRole("button", { name: "日期", exact: true });
  await expect(date).toContainText("2024-02-29");
  await date.focus(); await page.keyboard.press("Enter");
  const calendar = page.getByRole("dialog", { name: "日期", exact: true });
  await expect(calendar).toBeVisible();
  await page.keyboard.press("Escape"); await expect(overlay).toBeVisible();
  await date.click();
  await calendar.getByRole("textbox", { name: "年份", exact: true }).fill("1");
  await selectOption(calendar.getByRole("combobox", { name: "月份", exact: true }), "1");
  await calendar.getByRole("button", { name: "0001-01-01", exact: true }).click();
  await expect(overlay).toBeVisible(); await expect(date).toContainText("0001-01-01");
  await date.click(); await expect(calendar).toBeVisible();
  const other = page.getByRole("tab").filter({ hasNotText: "全部记录" });
  await other.click(); await expect(other).toHaveAttribute("aria-selected", "true");
  await expect(calendar).toHaveCount(0); expect(await flush(page)).toBe(true);
  expect((await values(page))[field(3)]).toBe("0001-01-01");
  await cell(page, 2, 0); await overlay.getByRole("button", { name: "日期", exact: true }).click();
  await calendar.getByRole("button", { name: "清空", exact: true }).click();
  expect(await flush(page)).toBe(true); expect((await values(page))[field(3)] ?? null).toBeNull();
});

test("cleared required date filter remains a visible draft and blocks changing views", async ({ page }) => {
  await open(page); await page.getByRole("button", { name: "新建视图", exact: true }).click();
  await page.getByRole("complementary", { name: "视图设置" }).getByRole("button", { name: "关闭", exact: true }).click();
  const current = page.getByRole("tab", { selected: true }); const currentId = await current.getAttribute("id");
  await page.getByRole("button", { name: "筛选", exact: true }).click();
  const filters = page.getByRole("complementary", { name: "筛选设置", exact: true });
  await filters.getByRole("button", { name: "添加条件", exact: true }).click();
  await selectOption(filters.getByRole("combobox", { name: "筛选字段", exact: true }), field(3));
  await selectOption(filters.getByRole("combobox", { name: "筛选关系", exact: true }), "eq");
  await filters.getByRole("button", { name: "筛选值", exact: true }).click();
  await page.getByRole("dialog", { name: "筛选值", exact: true }).getByRole("button", { name: "清空", exact: true }).click();
  await page.getByRole("tab", { name: "全部记录", exact: true }).click();
  await expect(page.getByRole("tab", { selected: true })).toHaveAttribute("id", currentId!);
  await expect(filters.getByRole("button", { name: "筛选值", exact: true })).toContainText("选择日期");
  expect(await flush(page)).toBe(false);
  await filters.getByRole("button", { name: "筛选值", exact: true }).click();
  await page.getByRole("dialog", { name: "筛选值", exact: true }).getByRole("button", { name: "今天", exact: true }).click();
  await page.getByRole("tab", { name: "全部记录", exact: true }).click();
  await expect(page.getByRole("tab", { name: "全部记录", exact: true })).toHaveAttribute("aria-selected", "true");
  expect(await flush(page)).toBe(true);
});
