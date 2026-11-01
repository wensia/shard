import { expect, test, type Page } from "@playwright/test"

import type { KdocsRecord, KdocsSaveInput } from "../../src/features/kdocs/api"
import { installContentTypesMock } from "./content-types-mock"
import { fillEditor } from "./editor-helpers"

interface KdocsMock {
  calls: { command: string; args: Record<string, unknown> }[]
  failSave: boolean
  failList: boolean
  holdSave: boolean
  releaseSave: (() => void) | null
}

declare global {
  interface Window { __KD_TEST__: KdocsMock }
}

async function installCloudMock(page: Page, connected = true, count = 50) {
  await installContentTypesMock(page)
  await page.addInitScript(({ connected, count }) => {
    localStorage.setItem("shard.storage-target", "kdocs")
    const root = globalThis as typeof globalThis & {
      __TAURI_INTERNALS__: { invoke(command: string, args?: Record<string, unknown>): Promise<unknown> }
      __KD_TEST__: KdocsMock
    }
    const fallback = root.__TAURI_INTERNALS__.invoke
    const control: KdocsMock = { calls: [], failSave: false, failList: false, holdSave: false, releaseSave: null }
    root.__KD_TEST__ = control
    const connection = { fileId: "test-file", sheetId: "1", url: "https://www.kdocs.cn/l/test-shard" }
    let isConnected = connected
    const records: KdocsRecord[] = Array.from({ length: count }, (_, i) => ({
      id: `r-${i}`, shardId: `shard-${i}`, content: `云端记录 ${i}：随手记下工作中的一个观察。`,
      tags: ["灵感"], createdAt: "2026-10-31T07:00:00.000Z",
      attachments: i === 0 ? [{ objectId: "attachment-1", name: "项目资料.pdf", size: 2048, type: "pdf" }] : [],
    }))
    root.__TAURI_INTERNALS__.invoke = async (command, args = {}) => {
      control.calls.push({ command, args })
      if (command === "kdocs_status") return { cliAvailable: true, authenticated: true, connection: isConnected ? connection : null }
      if (command === "kdocs_initialize") {
        isConnected = true
        return { cliAvailable: true, authenticated: true, connection }
      }
      if (command === "kdocs_list_records") {
        if (control.failList) { control.failList = false; throw new Error("读取暂时失败") }
        return args.cursor === "next-page"
          ? { records: [{ ...records[0], id: "last", content: "第二页的云端记录" }], hasMore: false, nextCursor: null }
          : { records: structuredClone(records), hasMore: records.length > 0, nextCursor: records.length > 0 ? "next-page" : null }
      }
      if (command === "kdocs_save_record") {
        if (control.holdSave) await new Promise<void>(resolve => { control.releaseSave = resolve })
        if (control.failSave) { control.failSave = false; throw new Error("网络中断，保存结果待确认") }
        const input = args.input as unknown as KdocsSaveInput
        const saved: KdocsRecord = {
          id: "created-record", shardId: input.requestId, content: input.content, tags: input.tags,
          createdAt: "2026-10-31T08:00:00.000Z",
          attachments: input.attachmentPaths.map((path, index) => ({ objectId: `new-attachment-${index}`, name: path.split("/").pop()!, size: 100, type: "txt" })),
        }
        records.unshift(saved)
        return structuredClone(saved)
      }
      if (command === "plugin:dialog|open") return ["/tmp/录入验证.txt", "/tmp/需求附件.pdf"]
      if (command === "kdocs_attachment_url") return "https://files.kdocs.cn/test-attachment.pdf"
      if (command === "plugin:opener|open_url") return null
      return fallback(command, args)
    }
  }, { connected, count })
}

async function calls(page: Page, command: string) {
  return page.evaluate(command => window.__KD_TEST__.calls.filter(call => call.command === command), command)
}

test("默认云端入口只检查连接，点击创建才初始化，且不挂载本地资料库", async ({ page }) => {
  await installCloudMock(page, false, 0)
  await page.goto("/")
  await expect(page.getByRole("heading", { name: "连接金山文档" })).toBeVisible()
  expect(await calls(page, "kdocs_initialize")).toHaveLength(0)
  expect(await calls(page, "list_fragments")).toHaveLength(0)
  expect(await calls(page, "watch_vault")).toHaveLength(0)
  await page.getByRole("button", { name: "创建 Shard 多维表格", exact: true }).click()
  await expect(page.getByRole("textbox", { name: "快速录入", exact: true })).toBeVisible()
  expect(await calls(page, "kdocs_initialize")).toHaveLength(1)
  await expect(page.getByText("还没有记录，从上方开始录入。")).toBeVisible()
})

test("正文、标签和多个附件一起异步保存，成功后清空草稿并展示记录", async ({ page }) => {
  await installCloudMock(page)
  await page.goto("/")
  await page.getByRole("textbox", { name: "快速录入", exact: true }).fill("支持附件的新记录")
  await page.getByLabel("标签", { exact: true }).fill("#产品 产品，灵感")
  await page.getByRole("button", { name: "添加附件", exact: true }).click()
  await expect(page.getByRole("list", { name: "待上传附件" })).toContainText("录入验证.txt")
  await page.evaluate(() => { window.__KD_TEST__.holdSave = true })
  await page.getByRole("button", { name: "保存", exact: true }).click()
  await expect(page.getByRole("button", { name: "正在保存…", exact: true })).toBeDisabled()
  await expect(page.getByRole("textbox", { name: "快速录入", exact: true })).toBeDisabled()
  await expect(page.getByRole("button", { name: "本地资料", exact: true })).toBeDisabled()
  await page.evaluate(() => window.__KD_TEST__.releaseSave?.())
  await expect(page.getByRole("textbox", { name: "快速录入", exact: true })).toHaveValue("")
  await expect(page.getByRole("table")).toContainText("支持附件的新记录")
  const input = (await calls(page, "kdocs_save_record"))[0].args.input as unknown as KdocsSaveInput
  expect(input.tags).toEqual(["产品", "灵感"])
  expect(input.attachmentPaths).toEqual(["/tmp/录入验证.txt", "/tmp/需求附件.pdf"])
  expect(await calls(page, "create_fragment")).toHaveLength(0)
})

test("保存失败及重载后保留草稿和操作ID，重试沿用原ID", async ({ page }) => {
  await installCloudMock(page)
  await page.goto("/")
  await page.getByRole("textbox", { name: "快速录入", exact: true }).fill("网络失败也不能丢失的草稿")
  await page.getByRole("button", { name: "添加附件", exact: true }).click()
  await page.evaluate(() => { window.__KD_TEST__.failSave = true })
  await page.getByRole("textbox", { name: "快速录入", exact: true }).press("Control+Enter")
  await expect(page.getByRole("alert")).toContainText("草稿已保留")
  const original = (await calls(page, "kdocs_save_record"))[0].args.input as unknown as KdocsSaveInput
  await page.reload()
  await expect(page.getByRole("textbox", { name: "快速录入", exact: true })).toHaveValue(original.content)
  await expect(page.getByRole("list", { name: "待上传附件" })).toContainText("录入验证.txt")
  await page.getByRole("button", { name: "保存", exact: true }).click()
  await expect(page.getByRole("textbox", { name: "快速录入", exact: true })).toHaveValue("")
  const retried = (await calls(page, "kdocs_save_record"))[0].args.input as unknown as KdocsSaveInput
  expect(retried.requestId).toBe(original.requestId)
})

test("按服务端游标翻页，记录和附件从云端打开", async ({ page }) => {
  await installCloudMock(page)
  await page.goto("/")
  await page.getByRole("button", { name: "项目资料.pdf", exact: true }).click()
  await expect.poll(async () => (await calls(page, "plugin:opener|open_url")).length).toBe(1)
  expect((await calls(page, "kdocs_attachment_url"))[0].args.objectId).toBe("attachment-1")
  await page.getByRole("button", { name: "第 2 页", exact: true }).click()
  await expect(page.getByRole("table")).toContainText("第二页的云端记录")
  expect((await calls(page, "kdocs_list_records")).at(-1)?.args.cursor).toBe("next-page")
  await page.getByRole("button", { name: "第 1 页", exact: true }).click()
  await expect(page.getByRole("table")).toContainText("云端记录 0")
})

test("核对上次保存时保留后来修改的草稿，再录入使用新ID", async ({ page }) => {
  await installCloudMock(page)
  await page.goto("/")
  const editor = page.getByRole("textbox", { name: "快速录入", exact: true })
  await editor.fill("第一次提交的内容")
  await page.evaluate(() => { window.__KD_TEST__.failSave = true })
  await page.getByRole("button", { name: "保存", exact: true }).click()
  await expect(page.getByRole("alert")).toContainText("草稿已保留")
  await editor.fill("失败后继续修改的内容")
  await page.getByRole("button", { name: "重试上次保存", exact: true }).click()
  await expect(page.getByRole("table")).toContainText("第一次提交的内容")
  await expect(editor).toHaveValue("失败后继续修改的内容")
  await page.getByRole("button", { name: "保存", exact: true }).click()
  await expect(editor).toHaveValue("")
  const inputs = (await calls(page, "kdocs_save_record")).map(call => call.args.input as unknown as KdocsSaveInput)
  expect(inputs[1].requestId).toBe(inputs[0].requestId)
  expect(inputs[2].requestId).not.toBe(inputs[0].requestId)
  expect(inputs[2].content).toBe("失败后继续修改的内容")
})

test("密匣标记阻止上传且不持久保存明文草稿", async ({ page }) => {
  await installCloudMock(page)
  await page.goto("/")
  await page.getByRole("textbox", { name: "快速录入", exact: true }).fill("私密内容 #密匣")
  await expect(page.getByRole("button", { name: "保存", exact: true })).toBeDisabled()
  await expect.poll(() => page.evaluate(() => localStorage.getItem("shard.kdocs-draft.v1"))).toBeNull()
  expect(await calls(page, "kdocs_save_record")).toHaveLength(0)
})

test("无法持久保存操作ID时保留当前稿并阻止云写", async ({ page }) => {
  await installCloudMock(page)
  await page.goto("/")
  await expect(page.getByRole("textbox", { name: "快速录入", exact: true })).toBeVisible()
  await page.evaluate(() => {
    const original = Storage.prototype.setItem
    Storage.prototype.setItem = function (key, value) {
      if (key === "shard.kdocs-draft.v1") throw new DOMException("Storage full", "QuotaExceededError")
      return original.call(this, key, value)
    }
  })
  const editor = page.getByRole("textbox", { name: "快速录入", exact: true })
  await editor.fill("本地草稿存储失败时保留在窗口")
  await page.getByRole("button", { name: "保存", exact: true }).click()
  await expect(page.getByRole("alert")).toContainText("草稿未能保留")
  await expect(editor).toHaveValue("本地草稿存储失败时保留在窗口")
  expect(await calls(page, "kdocs_save_record")).toHaveLength(0)
})

test("云端与本地切换保护未保存草稿", async ({ page }) => {
  await installCloudMock(page)
  await page.goto("/")
  await page.getByRole("textbox", { name: "快速录入", exact: true }).fill("还未保存")
  await page.getByRole("button", { name: "本地资料", exact: true }).click()
  await expect(page.locator("[data-kdocs-workspace]")).toBeVisible()
  expect(await calls(page, "list_fragments")).toHaveLength(0)
  await page.getByRole("textbox", { name: "快速录入", exact: true }).fill("")
  await page.getByRole("button", { name: "本地资料", exact: true }).click()
  await expect(page.locator('[data-shard-editor="composer"] .ProseMirror')).toBeVisible()
  await fillEditor(page, "composer", "未保存的本地草稿")
  await page.getByRole("button", { name: "金山多维表格", exact: true }).click()
  await expect(page.locator('[data-shard-editor="composer"] .ProseMirror')).toContainText("未保存的本地草稿")
  await expect(page.locator("[data-kdocs-workspace]")).toHaveCount(0)
})

test("记录滚动不移动录入区，宽窄屏样式消费Kiln控件与字体", async ({ page }) => {
  await installCloudMock(page)
  await page.goto("/")
  const composer = page.getByRole("textbox", { name: "快速录入", exact: true })
  await expect(page.getByRole("table")).toContainText("云端记录 49")
  const before = await composer.boundingBox()
  await page.locator("[data-kdocs-table-viewport]").evaluate(element => { element.scrollTop = 1000 })
  expect(await composer.boundingBox()).toEqual(before)
  const styles = await page.getByRole("button", { name: "保存", exact: true }).evaluate(element => {
    const style = getComputedStyle(element)
    return { radius: style.borderRadius, font: style.fontFamily }
  })
  expect(styles.radius).toBe("4px")
  expect(styles.font).toContain("Noto Sans SC")
  expect(await page.evaluate(() => document.scrollingElement?.scrollTop)).toBe(0)
  await page.screenshot({ path: "test-results/kdocs-workspace-wide.png" })
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(composer).toBeVisible()
  await expect(page.getByRole("button", { name: "保存", exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: "test-results/kdocs-workspace-narrow.png" })
})

test("窄窗口从本地资料菜单可返回云端工作区", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 720 })
  await installCloudMock(page)
  await page.goto("/")
  await expect(page.getByRole("textbox", { name: "快速录入", exact: true })).toBeVisible()
  await page.getByRole("button", { name: "本地资料", exact: true }).click()
  await expect(page.locator('[data-shard-editor="composer"] .ProseMirror')).toBeVisible()
  await page.getByRole("button", { name: "更多操作", exact: true }).click()
  await page.getByRole("menuitem", { name: "金山多维表格", exact: true }).click()
  await expect(page.getByRole("textbox", { name: "快速录入", exact: true })).toBeVisible()
  await expect(page.locator('[data-shard-editor="composer"]')).toHaveCount(0)
})
