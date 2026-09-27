import { expect, test, type Page } from "@playwright/test"

import { installSearchIpcMock } from "./search-ipc-mock"
import { fillEditor, focusEditor, readEditor, typeEditor } from "./editor-helpers"

const PATH = "datasets/阅读记录.csv"
const FENCE = "```"

type Call = { command: string; args: Record<string, unknown> }

async function installMock(page: Page, withLockbox = false) {
  await installSearchIpcMock(page)
  await page.addInitScript(({ path, fence, withLockbox }) => {
    const now = "2026-09-27T08:00:00.000Z"
    const csvFence = [fence + "datatable", JSON.stringify({ title: "阅读记录", src: path }), fence].join("\n")
    const fragments = [{
      id: "dataset-card", path: "fragments/dataset-card.md", content: csvFence,
      tags: ["inbox"], createdAt: now, updatedAt: now, category: null,
      gitStatus: "committed", error: null, archived: false, lockbox: false,
      pinned: false, related: [],
    }]
    const privateFragment = {
      ...fragments[0], id: "private-card", path: "lockbox/fragments/private-card.shard",
      content: "私密说明", tags: ["日记"], lockbox: true,
    }
    const lockbox = { configured: withLockbox, unlocked: false, expiresAt: null, ttlSeconds: 900 }
    const git = { branch: "main", shortCommit: "abc1234", hasRemote: false, status: "ready", error: null, ahead: 0, behind: 0 }
    const tree = { entries: [{ name: "阅读记录.csv", path, kind: "csv", size: 0, modifiedAt: now }], assets: [], trashEntries: [], fragmentTrashEntries: [], fragmentStream: { totalCount: 1, years: [] } }
    const schema = { schemaVersion: 1, datasetId: "ds_0123456789abcdef0123456789abcdef", title: "阅读记录", primaryKey: "id" }
    const state = { table: { header: ["id", "姓名", "城市"], rows: [["r_000000000001", "张三", "北京"], ["r_000000000002", "李四", "上海"]] }, sha: "sha-0", schemaSha: "schema-sha", editable: true, readOnlyReason: null as string | null, staleNext: false }
    const calls: Call[] = []
    const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T
    const snapshot = () => clone({ path, ...state, schema })
    const utf8 = () => Array.from(new TextEncoder().encode([state.table.header.join(","), ...state.table.rows.map(row => row.join(","))].join("\n") + "\n"))
    Object.assign(globalThis, {
      isTauri: true,
      __DATASET_TEST__: { state, calls },
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener() {} },
      __TAURI_INTERNALS__: {
        metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
        transformCallback: () => 1,
        invoke: async (command: string, args: Record<string, unknown> = {}) => {
          calls.push({ command, args: clone(args) })
          switch (command) {
            case "plugin:event|listen": return 1
            case "plugin:event|unlisten":
            case "unhide_pointer":
            case "set_window_controls_hidden":
            case "open_csv_file": return null
            case "plugin:app|version": return "0.1.3"
            case "list_fragments": return clone({ vaultPath: "/tmp/shard-dataset-test", fragments: lockbox.unlocked ? [...fragments, privateFragment] : fragments, git, lockbox })
            case "unlock_lockbox": lockbox.unlocked = true; return clone({ vaultPath: "/tmp/shard-dataset-test", fragments: [...fragments, privateFragment], git, lockbox })
            case "lock_lockbox": lockbox.unlocked = false; return clone({ vaultPath: "/tmp/shard-dataset-test", fragments, git, lockbox })
            case "list_mind_maps": return []
            case "list_csv_files": return [{ name: "阅读记录.csv", path }]
            case "list_library_tree": return clone(tree)
            case "migrate_legacy_notes": return { tree: clone(tree), migratedCount: 0 }
            case "sync_vault": return clone(git)
            case "checkpoint_vault": return { status: "no_changes", changes: 0, reason: null, git: clone(git) }
            case "github_cli_status": return { installed: true, authenticated: true, login: "test", protocol: "https", error: null }
            case "read_csv_file": return utf8()
            case "read_dataset": return snapshot()
            case "apply_dataset_ops": {
              if (state.staleNext) { state.staleNext = false; throw new Error("STALE_BASE:数据文件已在别处被修改") }
              if (args.expectedSha !== state.sha) throw new Error("STALE_BASE:数据文件已在别处被修改")
              for (const op of args.ops as Array<{ op: string; cells?: Array<{ row: number; column: number; value: string }>; at?: number; rows?: string[][] }>) {
                if (op.op === "setCells") for (const cell of op.cells ?? []) state.table.rows[cell.row][cell.column] = cell.value
                if (op.op === "insertRows") state.table.rows.splice(op.at!, 0, ...(op.rows ?? []))
              }
              state.sha = `sha-${calls.filter(call => call.command === "apply_dataset_ops").length}`
              return snapshot()
            }
            case "create_dataset": return snapshot()
            default: throw new Error(`Unhandled Tauri test command: ${command}`)
          }
        },
      },
    })
  }, { path: PATH, fence: FENCE, withLockbox })
}

const zen = (page: Page) => page.getByRole("region", { name: "数据集禅模式" })
const editor = (page: Page) => page.getByRole("region", { name: "数据集编辑器" })
const calls = (page: Page, command: string) => page.evaluate(name => (window as unknown as { __DATASET_TEST__: { calls: Call[] } }).__DATASET_TEST__.calls.filter(call => call.command === name), command)

async function openFromCard(page: Page) {
  const card = page.locator('[data-shard-fragment-id="dataset-card"]')
  await card.evaluate(element => {
    const viewport = element.closest<HTMLElement>('[data-slot="scroll-area-viewport"]')
    if (viewport) viewport.scrollTop += element.getBoundingClientRect().top - viewport.getBoundingClientRect().top
  })
  await card.getByRole("button", { name: "编辑数据" }).click()
  await expect(zen(page)).toBeVisible()
  await expect(editor(page).getByText("已保存", { exact: true })).toBeVisible()
}

async function cellValue(page: Page, column: number, row: number) {
  return editor(page).evaluate((element, [x, y]) => (element as HTMLElement & { __datasetGetCellContent: (item: [number, number]) => { displayData: string } }).__datasetGetCellContent([x, y]).displayData, [column, row] as [number, number])
}

async function clickCell(page: Page, column: number, row: number, count = 1) {
  const box = await zen(page).boundingBox()
  if (!box) throw new Error("数据集禅模式未显示")
  await page.mouse.click(box.x + 67 + column * 192 + 30, box.y + 174 + row * 40, { clickCount: count })
}

async function editCell(page: Page, column: number, row: number, value: string) {
  await clickCell(page, column, row)
  await page.evaluate(text => navigator.clipboard.writeText(text), value)
  await page.keyboard.press("ControlOrMeta+V")
}

test.beforeEach(async ({ page }) => { await page.context().grantPermissions(["clipboard-read", "clipboard-write"]); await installMock(page); await page.goto("/") })

async function dropCsv(page: Page, name: string, bytes: number[]) {
  await page.locator('[data-shard-editor="composer"]').evaluate((element, { name, bytes }) => {
    const transfer = new DataTransfer()
    transfer.items.add(new File([new Uint8Array(bytes)], name, { type: "text/csv" }))
    element.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }))
  }, { name, bytes })
}

test("拖放 GBK CSV 显示编码预览并导入带稳定 ID 的中文数据", async ({ page }) => {
  await dropCsv(page, "通讯录.csv", [0xD0, 0xD5, 0xC3, 0xFB, 0x0A, 0xD5, 0xC5, 0xC8, 0xFD, 0x0A])
  const dialog = page.getByRole("dialog", { name: "导入 CSV 为数据集" })
  await expect(dialog).toContainText("GBK")
  await expect(dialog).toContainText("张三")
  await dialog.getByRole("button", { name: "导入", exact: true }).click()
  await expect.poll(() => calls(page, "create_dataset")).toHaveLength(1)
  const args = (await calls(page, "create_dataset"))[0].args
  expect(args).toMatchObject({ title: "通讯录", header: ["id", "姓名"], primaryKey: "id" })
  expect(args.rows).toEqual([[expect.stringMatching(/^r_[0-9a-f]{12}$/u), "张三"]])
  await expect.poll(() => readEditor(page, "composer")).toContain('"src":"datasets/阅读记录.csv"')
})

test("拖放重复表头 CSV 时禁止导入", async ({ page }) => {
  await dropCsv(page, "重复.csv", Array.from(new TextEncoder().encode("姓名,姓名\n张三,李四\n")))
  const dialog = page.getByRole("dialog", { name: "导入 CSV 为数据集" })
  await expect(dialog).toContainText("表头名称不能为空且不能重复")
  await expect(dialog.getByRole("button", { name: "导入", exact: true })).toBeDisabled()
  expect(await calls(page, "create_dataset")).toHaveLength(0)
})

test("已有 id 列不唯一时只能按无主键导入", async ({ page }) => {
  await dropCsv(page, "重复ID.csv", Array.from(new TextEncoder().encode("id,姓名\n1,张三\n1,李四\n")))
  const dialog = page.getByRole("dialog", { name: "导入 CSV 为数据集" })
  await expect(dialog.getByText("用 id 列作为主键")).toBeVisible()
  await expect(dialog.getByRole("checkbox")).toBeDisabled()
  await dialog.getByRole("button", { name: "导入", exact: true }).click()
  expect((await calls(page, "create_dataset"))[0].args).toMatchObject({ header: ["id", "姓名"], primaryKey: null })
})

test("私密速记框拒绝 CSV 拖放", async ({ page }) => {
  await fillEditor(page, "composer", "#密匣 ")
  await dropCsv(page, "私密.csv", Array.from(new TextEncoder().encode("姓名\n张三\n")))
  await expect(page.getByRole("dialog", { name: "导入 CSV 为数据集" })).toHaveCount(0)
  expect(await calls(page, "create_dataset")).toHaveLength(0)
})

test("碎片禅模式通过 /数据集 新建 CSV 并插入说明围栏", async ({ page }) => {
  await page.locator('[data-shard-fragment-id="dataset-card"]').getByRole("button", { name: "片段操作" }).click()
  await page.getByRole("menuitem", { name: "禅模式", exact: true }).click()
  const id = "zen:dataset-card"
  await fillEditor(page, id, "说明")
  await focusEditor(page, id)
  await page.keyboard.press("End")
  await page.keyboard.press("Enter")
  await typeEditor(page, id, "/数据集")
  await page.getByRole("option", { name: /数据集/ }).click()
  const dialog = page.getByRole("dialog", { name: "新建数据集" })
  await expect(dialog.getByRole("textbox", { name: "数据集标题" })).toHaveValue("数据集")
  await dialog.getByRole("textbox", { name: "数据集标题" }).fill("旅行清单")
  await dialog.getByRole("button", { name: "创建", exact: true }).click()
  await expect.poll(() => calls(page, "create_dataset")).toHaveLength(1)
  expect((await calls(page, "create_dataset"))[0].args).toEqual({ title: "旅行清单", header: ["id", "名称"], rows: [], primaryKey: "id" })
  await expect.poll(() => readEditor(page, id)).toContain('"src":"datasets/阅读记录.csv"')
  await expect(zen(page)).toBeVisible()
})

test("速记框新建数据集后保留说明草稿，不自动提交碎片", async ({ page }) => {
  await fillEditor(page, "composer", "说明")
  await focusEditor(page, "composer")
  await page.keyboard.press("End")
  await page.keyboard.press("Enter")
  await typeEditor(page, "composer", "/数据集")
  await page.getByRole("option", { name: /数据集/ }).click()
  await page.getByRole("dialog", { name: "新建数据集" }).getByRole("button", { name: "创建", exact: true }).click()
  await expect.poll(() => readEditor(page, "composer")).toContain('"src":"datasets/阅读记录.csv"')
  expect(await readEditor(page, "composer")).toContain("说明")
  expect(await calls(page, "create_fragment")).toHaveLength(0)
  await expect(zen(page)).toBeVisible()
})

test("速记框标记密匣时隐藏 /数据集", async ({ page }) => {
  await fillEditor(page, "composer", "#密匣 ")
  await focusEditor(page, "composer")
  await page.keyboard.press("End")
  await typeEditor(page, "composer", "/数据集")
  await expect(page.getByRole("listbox", { name: "命令菜单" }).getByRole("option", { name: /数据集/ })).toHaveCount(0)
})

test("碎片准备移入密匣时隐藏 /数据集", async ({ page }) => {
  await page.locator('[data-shard-fragment-id="dataset-card"]').getByRole("button", { name: "片段操作" }).click()
  await page.getByRole("menuitem", { name: "禅模式", exact: true }).click()
  const id = "zen:dataset-card"
  await fillEditor(page, id, "#密匣 ")
  await focusEditor(page, id)
  await page.keyboard.press("End")
  await typeEditor(page, id, "/数据集")
  await expect(page.getByRole("listbox", { name: "命令菜单" }).getByRole("option", { name: /数据集/ })).toHaveCount(0)
})

test("已在密匣的碎片不显示 /数据集", async ({ page }) => {
  const privatePage = await page.context().newPage()
  await installMock(privatePage, true)
  await privatePage.goto("/")
  await privatePage.getByRole("button", { name: "资料库", exact: true }).click()
  await privatePage.getByRole("complementary", { name: "资料库目录" })
    .getByRole("button", { name: "密匣（上锁空间）", exact: true }).click()
  const gate = privatePage.getByRole("form", { name: "解锁密匣" })
  await gate.getByPlaceholder("密匣密码").fill("test-password")
  await gate.getByRole("button", { name: "解锁", exact: true }).click()
  await privatePage.locator('[data-shard-fragment-id="private-card"]')
    .getByRole("button", { name: "片段操作" }).click()
  await privatePage.getByRole("menuitem", { name: "禅模式", exact: true }).click()
  const id = "zen:private-card"
  await fillEditor(privatePage, id, "")
  await focusEditor(privatePage, id)
  await typeEditor(privatePage, id, "/数据集")
  await expect(privatePage.getByRole("listbox", { name: "命令菜单" }).getByRole("option", { name: /数据集/ })).toHaveCount(0)
  await privatePage.close()
})

test("卡片入口打开禅模式，显示标题、路径、表头和行", async ({ page }) => {
  await openFromCard(page)
  await expect(zen(page)).toContainText("阅读记录")
  await expect(zen(page)).toContainText(PATH)
  await expect.poll(() => cellValue(page, 1, 0)).toBe("张三")
  await page.screenshot({ path: "tests/evidence/datasets/open.png" })
})

test("单格编辑立即可见并按打开时 sha 保存", async ({ page }) => {
  await openFromCard(page)
  await editCell(page, 1, 0, "王五")
  await expect.poll(() => cellValue(page, 1, 0)).toBe("王五")
  await expect.poll(() => calls(page, "apply_dataset_ops")).toHaveLength(1)
  expect((await calls(page, "apply_dataset_ops"))[0].args).toMatchObject({ expectedSha: "sha-0", ops: [{ op: "setCells", cells: [{ row: 0, column: 1, value: "王五" }] }] })
  await expect(editor(page).getByText("已保存", { exact: true })).toBeVisible()
})

test("末行粘贴 2×2 产生更新与新增行，新主键由编辑器生成", async ({ page }) => {
  await openFromCard(page)
  await clickCell(page, 1, 1)
  await page.evaluate(async () => navigator.clipboard.writeText("赵六\t深圳\n钱七\t杭州"))
  await page.keyboard.press("ControlOrMeta+V")
  await expect.poll(() => calls(page, "apply_dataset_ops")).toHaveLength(1)
  const ops = (await calls(page, "apply_dataset_ops"))[0].args.ops as Array<{ op: string; rows?: string[][] }>
  expect(ops.map(op => op.op)).toEqual(["setCells", "insertRows"])
  expect(ops[1].rows?.[0][0]).toMatch(/^r_[0-9a-f]{12}$/)
  await expect.poll(() => cellValue(page, 1, 1)).toBe("赵六")
  await expect.poll(() => cellValue(page, 1, 2)).toBe("钱七")
})

test("主键列不可编辑", async ({ page }) => {
  await openFromCard(page)
  await clickCell(page, 0, 0, 2)
  await expect(zen(page).locator("textarea:visible, input:visible")).toHaveCount(0)
  expect(await calls(page, "apply_dataset_ops")).toHaveLength(0)
})

test("撤销写入逆操作并立即恢复可见值", async ({ page }) => {
  await openFromCard(page)
  await editCell(page, 1, 0, "王五")
  await expect.poll(() => calls(page, "apply_dataset_ops")).toHaveLength(1)
  await editor(page).getByRole("button", { name: "撤销" }).click()
  await expect.poll(() => cellValue(page, 1, 0)).toBe("张三")
  await expect.poll(() => calls(page, "apply_dataset_ops")).toHaveLength(2)
  expect((await calls(page, "apply_dataset_ops"))[1].args.ops).toEqual([{ op: "setCells", cells: [{ row: 0, column: 1, value: "张三" }] }])
})

test("冲突时保留修改，放弃后读取磁盘值", async ({ page }) => {
  await openFromCard(page)
  await page.evaluate(() => { (window as unknown as { __DATASET_TEST__: { state: { staleNext: boolean } } }).__DATASET_TEST__.state.staleNext = true })
  await editCell(page, 1, 0, "王五")
  await expect(editor(page).getByRole("alert")).toContainText("数据文件已在别处被修改")
  await page.screenshot({ path: "tests/evidence/datasets/conflict.png" })
  await editor(page).getByRole("button", { name: "放弃我的修改并载入磁盘版" }).click()
  await expect.poll(() => cellValue(page, 1, 0)).toBe("张三")
})

test("Esc 关闭先 flush 待保存操作", async ({ page }) => {
  await openFromCard(page)
  await editCell(page, 1, 0, "王五")
  await expect.poll(() => cellValue(page, 1, 0)).toBe("王五")
  await page.keyboard.press("Escape")
  await expect(zen(page)).toHaveCount(0)
  expect(await calls(page, "apply_dataset_ops")).toHaveLength(1)
})

test("保存后卡片数据表预览刷新", async ({ page }) => {
  await openFromCard(page)
  await editCell(page, 1, 0, "王五")
  await expect(editor(page).getByText("已保存", { exact: true })).toBeVisible()
  await zen(page).getByRole("button", { name: "关闭" }).click()
  await expect(page.locator('[data-shard-fragment-id="dataset-card"] tbody tr').first()).toContainText("王五")
})

test("⌘O 打开 CSV 结果进入禅模式，不调用系统程序", async ({ page }) => {
  await page.keyboard.press("Control+o")
  const input = page.getByRole("combobox", { name: "搜索内容" })
  await input.fill("阅读记录.csv")
  await page.getByRole("option", { name: /阅读记录/ }).first().click()
  await expect(zen(page)).toBeVisible()
  expect(await calls(page, "open_csv_file")).toHaveLength(0)
})

test("不可编辑原因显示且保留只读截图", async ({ page }) => {
  await page.evaluate(() => { const state = (window as unknown as { __DATASET_TEST__: { state: { editable: boolean; readOnlyReason: string } } }).__DATASET_TEST__.state; state.editable = false; state.readOnlyReason = "表头重复" })
  await openFromCard(page)
  await expect(editor(page).getByRole("alert")).toContainText("表头重复")
  await page.screenshot({ path: "tests/evidence/datasets/read-only.png" })
})

test("焦点刷新保持网格与选区；sha 变化后替换数据并清空撤销", async ({ page }) => {
  await openFromCard(page)
  await editCell(page, 1, 0, "新值")
  await expect(editor(page).getByText("已保存", { exact: true })).toBeVisible()
  await expect(editor(page).getByRole("button", { name: "撤销" })).toBeEnabled()
  await clickCell(page, 1, 0)
  const selected = () => editor(page).evaluate(element => (element as HTMLElement & { __datasetSelection?: { current?: { cell: [number, number] } } }).__datasetSelection?.current?.cell)
  await expect.poll(selected).toEqual([1, 0])
  const grid = zen(page).locator(".dvn-scroller").first()
  await grid.evaluate(element => { (window as unknown as { __datasetGrid?: Element }).__datasetGrid = element })
  await page.evaluate(() => window.dispatchEvent(new Event("focus")))
  await expect.poll(() => cellValue(page, 1, 0)).toBe("新值")
  await expect.poll(selected).toEqual([1, 0])
  expect(await grid.evaluate(element => element === (window as unknown as { __datasetGrid?: Element }).__datasetGrid)).toBe(true)
  await page.evaluate(() => { const state = (window as unknown as { __DATASET_TEST__: { state: { sha: string; table: { rows: string[][] } } } }).__DATASET_TEST__.state; state.sha = "external"; state.table.rows[0][1] = "磁盘版"; window.dispatchEvent(new Event("focus")) })
  await expect.poll(() => cellValue(page, 1, 0)).toBe("磁盘版")
  await expect.poll(selected).toBeUndefined()
  await expect(editor(page).getByRole("button", { name: "撤销" })).toBeDisabled()
})
