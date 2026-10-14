/** 数据集编辑器用例共用的内存 mock 与网格坐标辅助（Chromium 与 WebKit 两套用例共用）。 */
import { expect, type Page } from "@playwright/test"

import { installSearchIpcMock } from "./search-ipc-mock"

export const PATH = "datasets/阅读记录.csv"
export const FENCE = "```"

export type Call = { command: string; args: Record<string, unknown> }

export async function installMock(page: Page, withLockbox = false) {
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
    const state = { table: { header: ["id", "姓名", "城市"], rows: [["r_000000000001", "张三", "北京"], ["r_000000000002", "李四", "上海"]] }, sha: "sha-0", schemaSha: "schema-sha", editable: true, readOnlyReason: null as string | null, convertible: false, staleNext: false }
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
            case "normalize_csv_file": {
              if (args.expectedSha !== state.sha) throw new Error("STALE_BASE:数据文件已在别处被修改")
              Object.assign(state, { editable: true, readOnlyReason: null, convertible: false, sha: "sha-converted" })
              return snapshot()
            }
            case "create_dataset": {
              state.table = { header: clone(args.header as string[]), rows: clone(args.rows as string[][]) }
              return snapshot()
            }
            default: throw new Error(`Unhandled Tauri test command: ${command}`)
          }
        },
      },
    })
  }, { path: PATH, fence: FENCE, withLockbox })
}

export const zen = (page: Page) => page.getByRole("region", { name: "数据集禅模式" })
export const editor = (page: Page) => page.getByRole("region", { name: "数据集编辑器" })
export const calls = (page: Page, command: string) => page.evaluate(name => (window as unknown as { __DATASET_TEST__: { calls: Call[] } }).__DATASET_TEST__.calls.filter(call => call.command === name), command)

export async function openFromCard(page: Page) {
  const card = page.locator('[data-shard-fragment-id="dataset-card"]')
  await card.evaluate(element => {
    const viewport = element.closest<HTMLElement>('[data-slot="scroll-area-viewport"]')
    if (viewport) viewport.scrollTop += element.getBoundingClientRect().top - viewport.getBoundingClientRect().top
  })
  await card.getByRole("button", { name: "编辑数据" }).click()
  await expect(zen(page)).toBeVisible()
  await expect(editor(page).getByText("已保存", { exact: true })).toBeVisible()
}

export async function cellValue(page: Page, column: number, row: number) {
  return editor(page).evaluate((element, [x, y]) => (element as HTMLElement & { __datasetGetCellContent: (item: [number, number]) => { displayData: string } }).__datasetGetCellContent([x, y]).displayData, [column, row] as [number, number])
}

export async function clickCell(page: Page, column: number, row: number, count = 1) {
  const box = await zen(page).boundingBox()
  if (!box) throw new Error("数据集禅模式未显示")
  await page.mouse.click(box.x + 67 + column * 192 + 30, box.y + 174 + row * 40, { clickCount: count })
}

export async function editCell(page: Page, column: number, row: number, value: string) {
  await clickCell(page, column, row)
  await page.evaluate(text => navigator.clipboard.writeText(text), value)
  await page.keyboard.press("ControlOrMeta+V")
}
