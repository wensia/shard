import { expect, test, type Page } from "@playwright/test"
import { readEditor } from "./editor-helpers"

type RecoveryScenario = "lost-response-and-check" | "failed-before-move"
interface RecoveryCall {
  command: string
  args: Record<string, unknown>
}

// The same Tauri protocol as library-tree.spec.ts, with one object so a lost
// conversion response cannot be masked by an unrelated refresh or fixture.
async function installConversionRecoveryMock(page: Page, scenario: RecoveryScenario) {
  await page.addInitScript((scenario: RecoveryScenario) => {
    const stamp = "2026-08-30T10:00:00.000Z"
    const fragment = {
      id: "conversion-source",
      content: "# 原始碎片标题\n正文和来源都应保留。",
      createdAt: stamp,
      updatedAt: stamp,
      tags: ["inbox", "灵感"],
      category: null,
      path: "fragments/2026/08/conversion-source.md",
      gitStatus: "committed",
      error: null,
      archived: false,
      lockbox: false,
      pinned: false,
      related: [],
    }
    const git = {
      branch: "main", shortCommit: "abc1234", hasRemote: false,
      status: "ready", error: null, ahead: 0, behind: 0,
    }
    const calls: RecoveryCall[] = []
    let conversions = 0
    let pendingReadFailures = 0
    const tree = () => ({
      entries: fragment.tags.includes("note") ? [{
        name: fragment.path.split("/").at(-1),
        path: fragment.path,
        kind: "markdown",
        size: fragment.content.length,
        modifiedAt: stamp,
      }] : [],
      assets: [], trashEntries: [], fragmentTrashEntries: [],
      fragmentStream: { totalCount: fragment.tags.includes("note") ? 0 : 1, years: [] },
    })
    Object.assign(globalThis, {
      isTauri: true,
      __SHARD_CONVERSION_RECOVERY_CALLS__: calls,
      __TAURI_INTERNALS__: {
        invoke: async (command: string, args: Record<string, unknown> = {}) => {
          calls.push({ command, args: structuredClone(args) })
          if (command === "list_fragments") {
            if (pendingReadFailures > 0) {
              pendingReadFailures--
              throw new Error("首次核对也暂时失败")
            }
            return structuredClone({
              vaultPath: "/tmp/shard-conversion-recovery-mock",
              fragments: [fragment], git,
              lockbox: { configured: false, unlocked: false, expiresAt: null, ttlSeconds: 900 },
            })
          }
          if (command === "list_library_tree") return structuredClone(tree())
          if (command === "migrate_legacy_notes") return { tree: structuredClone(tree()), migratedCount: 0 }
          if (command === "list_mind_maps" || command === "list_csv_files" || command === "list_diagram_documents") return []
          if (command === "restore_window_frame") return null
          if (command === "convert_fragment_to_note") {
            conversions++
            if (scenario === "failed-before-move" && conversions === 1) {
              throw new Error("转换尚未落盘，目标目录暂时不可写")
            }
            if (fragment.tags.includes("note")) throw new Error("同一内容不能重复转换")
            fragment.tags.push("note")
            fragment.path = `${String(args.destinationDirectory ?? "notes")}/${String(args.title)}.md`
            if (scenario === "lost-response-and-check" && conversions === 1) {
              pendingReadFailures = 1
              throw new Error("转换已落盘，但响应丢失")
            }
            return structuredClone({ tree: tree(), fragment, updatedLinks: 0 })
          }
          throw new Error(`Unexpected conversion recovery command: ${command}`)
        },
      },
    })
  }, scenario)
  await page.goto("/")
  const card = page.locator('[data-shard-fragment-id="conversion-source"]')
  await expect(card).toBeVisible()
  await card.getByRole("button", { name: "片段操作", exact: true }).click()
  await page.getByRole("menuitem", { name: "转为文档…", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "转为文档", exact: true })
  await expect(dialog.getByRole("button", { name: "转为文档", exact: true })).toBeEnabled()
  await dialog.getByRole("textbox", { name: "文档标题", exact: true }).fill("恢复后文档")
  return dialog
}

async function conversionCalls(page: Page) {
  return page.evaluate(() => (
    window as typeof window & { __SHARD_CONVERSION_RECOVERY_CALLS__: RecoveryCall[] }
  ).__SHARD_CONVERSION_RECOVERY_CALLS__.filter(call => call.command === "convert_fragment_to_note"))
}

async function expectConvertedDocument(page: Page) {
  await expect(page.getByRole("dialog", { name: "转为文档", exact: true })).toHaveCount(0)
  await expect(page.getByRole("textbox", { name: "资料库文档编辑器", exact: true })).toBeFocused()
  await expect.poll(() => readEditor(page, "library:conversion-source"))
    .toBe("# 原始碎片标题\n正文和来源都应保留。")
  await expect(page.locator('[data-shard-fragment-id="conversion-source"]')).toHaveCount(0)
}

test("转换响应与首次核对均失败时只允许重新核对，确认已为文档后聚焦正文且不重复转换", async ({ page }) => {
  const dialog = await installConversionRecoveryMock(page, "lost-response-and-check")
  await dialog.getByRole("button", { name: "转为文档", exact: true }).click()

  const recheck = dialog.getByRole("button", { name: "重新核对", exact: true })
  await expect(recheck).toBeEnabled()
  await expect(dialog.getByRole("textbox", { name: "文档标题", exact: true })).toHaveValue("恢复后文档")
  await expect(dialog.getByRole("textbox", { name: "文档标题", exact: true })).toBeDisabled()
  await expect(dialog.getByRole("combobox", { name: "保存位置", exact: true })).toBeDisabled()
  await expect(dialog.getByRole("button", { name: "取消", exact: true })).toBeDisabled()
  await expect(dialog.getByRole("button", { name: "转为文档", exact: true })).toHaveCount(0)
  await page.keyboard.press("Escape")
  await expect(dialog).toBeVisible()
  expect(await conversionCalls(page)).toHaveLength(1)

  await recheck.click()
  await expectConvertedDocument(page)
  expect(await conversionCalls(page)).toHaveLength(1)
})

test("转换失败后核对确认仍是碎片，可以保留输入正常重试", async ({ page }) => {
  const dialog = await installConversionRecoveryMock(page, "failed-before-move")
  await dialog.getByRole("button", { name: "转为文档", exact: true }).click()

  await expect(dialog.getByRole("alert")).toContainText("目标目录暂时不可写")
  await expect(dialog.getByRole("button", { name: "转为文档", exact: true })).toBeEnabled()
  await expect(dialog.getByRole("textbox", { name: "文档标题", exact: true })).toHaveValue("恢复后文档")
  await expect(dialog.getByRole("textbox", { name: "文档标题", exact: true })).toBeEnabled()
  await expect(dialog.getByRole("combobox", { name: "保存位置", exact: true })).toBeEnabled()
  expect(await conversionCalls(page)).toHaveLength(1)

  await dialog.getByRole("button", { name: "转为文档", exact: true }).click()
  await expectConvertedDocument(page)
  const calls = await conversionCalls(page)
  expect(calls).toHaveLength(2)
  expect(calls[1].args).toEqual(calls[0].args)
})
