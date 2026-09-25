import { selectOption } from "./select-helpers"
import { expect, test, type Page } from "@playwright/test"
import { readFileSync } from "node:fs"
import type { TableFile } from "../../src/features/tables/model"
import { installSearchIpcMock } from "./search-ipc-mock"
const nativeFixture: TableFile = JSON.parse(readFileSync(new URL("../fixtures/tables/valid/six-types.json", import.meta.url), "utf8"))

async function installExchangeMock(page: Page, options: { kind?: "csv" | "xlsx" | "native"; loseFirstCreate?: boolean } = {}) {
  await installSearchIpcMock(page)
  await page.addInitScript(({ kind, loseFirstCreate, nativeFixture }) => {
    const calls: { command: string; args: unknown }[] = []
    const writes: { path: string; text: string }[] = []
    let attempts = 0
    const cell = (kind: string, value: unknown, extra = {}) => ({ kind, value, rawText: null, formula: null, issues: [], ...extra })
    const rows = [[cell("text", "名称"), cell("text", "缓存值"), cell("text", "异常公式")], [cell("text", "中文"), cell("number", 0, { formula: "1-1", issues: [{ code: "FORMULA_CACHED_VALUE", message: "公式缓存尚未重算", severity: "warning", row: 1, column: 1 }] }), cell("error", null, { formula: "A1+A2", issues: [{ code: "FORMULA_CACHE_MISSING", message: "公式没有缓存值", severity: "error", row: 1, column: 2 }] })]]
    const xlsx = { sheetNames: ["工作表 1", "工作表 2"], sheetIndex: 0, rows, totalRows: 2, totalColumns: 3, truncated: false, issues: rows.flatMap(row => row.flatMap(cell => cell.issues)) }
    Object.assign(window, {
      isTauri: true,
      __exchangeMock: { calls, writes, cancelSave: false },
      __TAURI_INTERNALS__: {
        invoke: async (command: string, args: Record<string, unknown> | Uint8Array = {}, invokeOptions?: { headers?: Record<string, string> }) => {
          calls.push({ command, args: command === "create_table" && args instanceof Uint8Array ? { request: JSON.parse(new TextDecoder().decode(args)) } : structuredClone(args) })
          if (command === "plugin:dialog|open") return kind === "xlsx" ? "/tmp/类型.xlsx" : kind === "native" ? "/tmp/副本.shardtable.json" : "/tmp/中文.csv"
          if (command === "read_table_exchange_file") return new TextEncoder().encode(kind === "native" ? JSON.stringify(nativeFixture) : '名称,编号,长编号\r\n"中文\n第二行",00123,98765432101234567890\r\n另一条,00000,9007199254740993\r\n').buffer
          if (command === "inspect_table_xlsx") return { sheetNames: xlsx.sheetNames, issues: [] }
          if (command === "preview_table_xlsx") return new TextEncoder().encode(JSON.stringify({ ...xlsx, sheetIndex: (args as { request: { sheetIndex: number } }).request.sheetIndex })).buffer
          if (command === "create_table") {
            attempts++
            if (loseFirstCreate && attempts === 1) throw { code: "IO_ERROR", message: "响应丢失，请核对同一次导入" }
            if (!(args instanceof Uint8Array)) throw new Error("Table creation must use raw bytes")
            const request = JSON.parse(new TextDecoder().decode(args)) as { content: Record<string, unknown>; tableId: string; requestId: string; parentPath: string; suggestedName: string }
            const now = new Date().toISOString()
            const file = { ...request.content, kind: "shard.table", schemaVersion: 1, id: request.tableId, revision: 1, creation: { requestId: request.requestId, payloadHash: "a".repeat(64) }, lastMutationId: null, lastMutationHash: null, createdAt: now, updatedAt: now }
            return new TextEncoder().encode(JSON.stringify({ file, revision: 1, title: request.suggestedName, path: `${request.parentPath}/${request.suggestedName}.shardtable.json`, contentHash: "b".repeat(64) })).buffer
          }
          if (command === "plugin:dialog|save") return (window as unknown as { __exchangeMock: { cancelSave: boolean } }).__exchangeMock.cancelSave ? null : "/tmp/导出.csv"
          if (command === "prepare_table_xlsx_export") {
            if (!(args instanceof Uint8Array)) throw new Error("XLSX export must use raw bytes")
            return args.buffer
          }
          if (command === "write_table_exchange_file") {
            if (!(args instanceof Uint8Array)) throw new Error("Export write must use raw bytes")
            writes.push({ path: decodeURIComponent(invokeOptions?.headers?.["x-shard-export-path"] ?? ""), text: new TextDecoder().decode(args) })
            return undefined
          }
          throw new Error(`Unexpected command: ${command}`)
        },
      },
    })
  }, { kind: options.kind ?? "csv", loseFirstCreate: options.loseFirstCreate ?? false, nativeFixture })
  await page.goto("/table-exchange-test.html")
}

test("CSV preview is read-only; mapping supports duplicate source columns and creation retries keep identity", async ({ page }) => {
  await installExchangeMock(page, { loseFirstCreate: true })
  await page.getByRole("button", { name: "测试导入" }).click()
  await page.getByRole("button", { name: "选择文件", exact: true }).click()
  await expect(page.getByText("2 条记录 · 3 个来源字段")).toBeVisible()
  await expect(page.getByLabel("字段 2 类型")).toContainText("文本")
  await expect(page.getByRole("button", { name: "创建多维表格", exact: true })).toBeDisabled()
  await page.getByRole("button", { name: "取消", exact: true }).click()
  expect(await page.evaluate(() => (window as unknown as { __exchangeMock: { calls: { command: string }[] } }).__exchangeMock.calls.filter(call => call.command === "create_table").length)).toBe(0)
  await page.getByRole("button", { name: "测试导入" }).click()
  await page.getByRole("button", { name: "选择文件", exact: true }).click()
  await page.getByRole("button", { name: "添加目标字段" }).click()
  await selectOption(page.getByLabel("字段 4 来源列"), "1")
  await page.getByLabel("字段 4 名称").fill("编号副本")
  await page.getByRole("button", { name: "校验全部记录" }).click()
  await expect(page.getByText("校验通过：2 条记录，4 个字段。")).toBeVisible()
  await page.getByLabel("多维表格名称", { exact: true }).fill("不允许/的名称")
  await page.getByRole("button", { name: "创建多维表格", exact: true }).click()
  await expect(page.getByText("名称包含不允许的路径字符。", { exact: true })).toBeVisible()
  await expect(page.getByLabel("字段 4 名称")).toBeEnabled()
  expect(await page.evaluate(() => (window as unknown as { __exchangeMock: { calls: { command: string }[] } }).__exchangeMock.calls.filter(call => call.command === "create_table").length)).toBe(0)
  await page.getByLabel("多维表格名称", { exact: true }).fill("中文")
  await page.getByRole("button", { name: "创建多维表格", exact: true }).click()
  await expect(page.getByText("响应丢失，请核对同一次导入", { exact: true })).toBeVisible()
  await expect(page.getByLabel("字段 4 名称")).toBeDisabled()
  await page.getByRole("button", { name: "核对并重试" }).click()
  await expect(page.getByRole("dialog")).toHaveCount(0)
  const result = await page.evaluate(() => {
    const globals = window as unknown as { __exchangeMock: { calls: { command: string; args: { request: unknown } }[] }; __tableExchangeTest: { file: { fieldOrder: string[]; records: Record<string, { values: Record<string, unknown> }>; recordOrder: string[] } } }
    const file = globals.__tableExchangeTest.file
    return { requests: globals.__exchangeMock.calls.filter(call => call.command === "create_table").map(call => call.args.request), values: file.fieldOrder.map(id => file.records[file.recordOrder[0]].values[id]) }
  })
  expect(result.requests).toHaveLength(2); expect(result.requests[0]).toEqual(result.requests[1])
  expect(result.values).toEqual(["中文\n第二行", "00123", "98765432101234567890", "00123"])
})

test("XLSX mapping preserves typed cache values and requires explicit handling of source errors", async ({ page }) => {
  await installExchangeMock(page, { kind: "xlsx" })
  await page.getByRole("button", { name: "测试导入" }).click()
  await page.getByRole("button", { name: "选择文件", exact: true }).click()
  await expect(page.getByLabel("字段 2 类型")).toContainText("数值")
  await selectOption(page.getByLabel("工作表", { exact: true }), "1")
  await page.getByRole("button", { name: "校验全部记录" }).click()
  await expect(page.getByRole("button", { name: "创建多维表格", exact: true })).toBeDisabled()
  await expect(page.getByText(/2 项问题，调整映射后重新校验/)).toBeVisible()
  await page.getByRole("checkbox", { name: /已确认提示/ }).check()
  await page.getByRole("checkbox", { name: /按文本保留异常值/ }).check()
  await page.getByRole("button", { name: "校验全部记录" }).click()
  await expect(page.getByText("校验通过：1 条记录，3 个字段。")).toBeVisible()
  await page.getByRole("button", { name: "创建多维表格", exact: true }).click()
  await expect(page.getByRole("dialog")).toHaveCount(0)
  const values = await page.evaluate(() => {
    const file = (window as unknown as { __tableExchangeTest: { file: { fieldOrder: string[]; records: Record<string, { values: Record<string, unknown> }>; recordOrder: string[] } } }).__tableExchangeTest.file
    return file.fieldOrder.map(id => file.records[file.recordOrder[0]].values[id])
  })
  expect(values).toEqual(["中文", 0, "=A1+A2"])
})

test("export defaults to safe CSV, uses full view projection, preserves raw selection and cancels without write", async ({ page }) => {
  await installExchangeMock(page)
  await page.evaluate(() => {
    const file = window.__tableExchangeTest.file
    file.records[file.recordOrder[0]].values[file.primaryFieldId] = "=1+1"
    const view = file.views[file.viewOrder[0]]
    view.filters.conditions = [{ fieldId: file.primaryFieldId, operator: "startsWith", value: "=" }]
    view.hiddenFieldIds = file.fieldOrder.slice(1)
  })
  await page.getByRole("button", { name: "测试导出" }).click()
  await expect(page.getByLabel("文本处理", { exact: true })).toContainText("电子表格安全导出（默认）")
  await selectOption(page.getByLabel("范围", { exact: true }), "view")
  await page.getByRole("button", { name: "选择保存位置" }).click()
  await expect(page.getByText("已导出 1 条记录、1 个字段；1 个公式样文本已加前缀。")).toBeVisible()
  const exported = () => page.evaluate(() => (window as unknown as { __exchangeMock: { writes: { text: string; path: string }[] } }).__exchangeMock.writes)
  expect((await exported())[0]).toEqual({ path: "/tmp/导出.csv", text: "名称\r\n'=1+1\r\n" })
  await selectOption(page.getByLabel("文本处理", { exact: true }), "raw")
  await page.getByRole("button", { name: "选择保存位置" }).click()
  await expect(page.getByText("已导出 1 条记录、1 个字段。")).toBeVisible()
  expect((await exported())[1].text).toBe("名称\r\n=1+1\r\n")
  await page.evaluate(() => { (window as unknown as { __exchangeMock: { cancelSave: boolean } }).__exchangeMock.cancelSave = true })
  await page.getByRole("button", { name: "选择保存位置" }).click()
  await expect(page.getByRole("button", { name: "选择保存位置" })).toBeEnabled()
  expect(await exported()).toHaveLength(2)
})

test("import has a stable scroll frame and uses Kiln controls at narrow widths", async ({ page }) => {
  await installExchangeMock(page)
  await page.setViewportSize({ width: 600, height: 650 })
  await page.getByRole("button", { name: "测试导入" }).click()
  const before = await page.getByRole("dialog").boundingBox()
  await page.getByRole("button", { name: "选择文件", exact: true }).click()
  await expect(page.getByLabel("字段 1 名称")).toBeVisible()
  const after = await page.getByRole("dialog").boundingBox()
  expect(after?.height).toBe(before?.height)
  expect(after!.x).toBeGreaterThanOrEqual(16); expect(after!.x + after!.width).toBeLessThanOrEqual(584)
  const styles = await page.getByLabel("字段 1 类型").evaluate(element => ({ radius: getComputedStyle(element).borderRadius, font: getComputedStyle(element).fontFamily, border: getComputedStyle(element).borderTopWidth }))
  expect(styles.radius).toBe("4px"); expect(styles.font).toContain("Noto Sans SC"); expect(styles.border).toBe("1px")
  const scroll = await page.locator(".table-exchange-mapping-viewport").evaluate(element => { element.scrollLeft = 200; return { left: element.scrollLeft, document: document.documentElement.scrollLeft } })
  expect(scroll.left).toBeGreaterThan(0); expect(scroll.document).toBe(0)
})

test("XLSX export sends typed values to Rust as Worker-encoded raw bytes", async ({ page }) => {
  await installExchangeMock(page)
  await page.getByRole("button", { name: "测试导出" }).click()
  await selectOption(page.getByLabel("格式", { exact: true }), "xlsx")
  await page.getByRole("button", { name: "选择保存位置" }).click()
  await expect(page.getByText("已导出 4 条记录、6 个字段。")).toBeVisible()
  const data = await page.evaluate(() => {
    const writes = (window as unknown as { __exchangeMock: { writes: { text: string }[] } }).__exchangeMock.writes
    return JSON.parse(writes[0].text)
  })
  expect(data.columns.map((column: { kind: string }) => column.kind)).toEqual(["text", "number", "date", "text", "text", "checkbox"])
  expect(data.rows[0]).toEqual(["苹果\n第二行", 0, "2024-02-29", "待办", '["中文","长文本"]', false])
  expect(data.rows[2][0]).toBe(""); expect(data.rows[3][0]).toBeNull()
})

test("native export retains the complete table and native import allocates a new table identity", async ({ page }) => {
  await installExchangeMock(page, { kind: "native" })
  await page.getByRole("button", { name: "测试导出" }).click()
  await selectOption(page.getByLabel("范围", { exact: true }), "view")
  await selectOption(page.getByLabel("格式", { exact: true }), "native")
  await expect(page.getByLabel("范围", { exact: true })).toHaveCount(0)
  await page.getByRole("button", { name: "选择保存位置" }).click()
  await expect(page.getByText("已导出 4 条记录、6 个字段。")).toBeVisible()
  const exported = await page.evaluate(() => JSON.parse((window as unknown as { __exchangeMock: { writes: { text: string }[] } }).__exchangeMock.writes[0].text))
  expect(exported.id).toBe(nativeFixture.id); expect(exported.views).toEqual(nativeFixture.views); expect(exported.recordOrder).toEqual(nativeFixture.recordOrder)
  await page.getByRole("button", { name: "关闭", exact: true }).last().click()
  await page.getByRole("button", { name: "测试导入" }).click()
  await page.getByRole("button", { name: "选择文件", exact: true }).click()
  await page.getByRole("button", { name: "校验全部记录" }).click()
  await expect(page.getByText("校验通过：4 条记录，6 个字段。")).toBeVisible()
  await page.getByRole("button", { name: "创建多维表格", exact: true }).click()
  await expect(page.getByRole("dialog")).toHaveCount(0)
  const imported = await page.evaluate(() => window.__tableExchangeTest.file)
  expect(imported.id).not.toBe(nativeFixture.id); expect(imported.creation.requestId).not.toBe(nativeFixture.creation.requestId)
  expect(imported.views).toEqual(nativeFixture.views); expect(imported.recordOrder).toEqual(nativeFixture.recordOrder)
})
