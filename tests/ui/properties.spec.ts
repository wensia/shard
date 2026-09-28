import { expect, test, type Page } from "@playwright/test"

import { fillEditor } from "./editor-helpers"
import {
  CARD_FRAGMENT,
  card,
  installContentTypesMock,
  revealCard,
} from "./content-types-mock"
import { selectOption } from "./select-helpers"

interface TestCall {
  args: Record<string, unknown>
  command: string
}

async function installPropertiesMock(page: Page) {
  await installContentTypesMock(page)
  await page.addInitScript((fragmentBody: string) => {
    const root = globalThis as typeof globalThis & {
      __SHARD_TYPE_CALLS__: TestCall[]
      __TAURI_INTERNALS__: {
        invoke(command: string, args?: Record<string, unknown>): Promise<unknown>
      }
    }
    const originalInvoke = root.__TAURI_INTERNALS__.invoke.bind(root.__TAURI_INTERNALS__)
    const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T
    const now = "2026-09-28T08:00:00.000Z"
    const propertyValues = () => [
      { key: "客户", value: { kind: "text", text: "甲" }, editable: true },
      { key: "金额", value: { kind: "number", text: "1.50" }, editable: true },
      { key: "日期", value: { kind: "text", text: "2026-09-28" }, editable: true },
      { key: "提醒时间", value: { kind: "text", text: "2026-09-28T09:30" }, editable: true },
      { key: "完成", value: { kind: "bool", value: true }, editable: true },
      { key: "清单", value: { kind: "list", items: ["甲", "乙"] }, editable: true },
      { key: "链接", value: { kind: "text", text: "[[目标]]" }, editable: true },
      { key: "复杂", value: { kind: "other", raw: "nested: true" }, editable: false },
      { key: "错配", value: { kind: "text", text: "abc" }, editable: true },
    ]
    const registry = {
      version: 1,
      properties: {
        客户: { type: "text" }, 金额: { type: "number" }, 日期: { type: "date" },
        提醒时间: { type: "datetime" }, 完成: { type: "checkbox" }, 清单: { type: "list" },
        链接: { type: "link" }, 复杂: { type: "text" }, 错配: { type: "number" },
      } as Record<string, { type: string }>,
    }
    let registrySha = "registry-sha-1"
    let revision = 1
    let unlocked = false
    const notes = [
      {
        id: "property-note", path: "notes/属性文档.md", content: "# 属性文档\n正文",
        tags: ["inbox", "note"], createdAt: now, updatedAt: now, category: null,
        gitStatus: "committed", error: null, archived: false, lockbox: false,
        pinned: false, related: [], fileSha: "property-note-sha-1", properties: propertyValues(),
      },
      {
        id: "secret-note", path: "lockbox/notes/私密属性.shard", content: "# 私密属性",
        tags: ["note", "私密"], createdAt: now, updatedAt: now, category: null,
        gitStatus: "committed", error: null, archived: false, lockbox: true,
        pinned: false, related: [], fileSha: "secret-note-sha-1", properties: [],
      },
      {
        id: "secret-fragment", path: "lockbox/fragments/私密碎片.shard", content: "私密碎片",
        tags: ["私密"], createdAt: now, updatedAt: now, category: null,
        gitStatus: "committed", error: null, archived: false, lockbox: true,
        pinned: false, related: [], fileSha: "secret-fragment-sha-1", properties: [],
      },
    ]
    const shadow = new Map<string, Record<string, unknown>>()
    const propertyInput = (input: Record<string, unknown>) => {
      if (input.value === null) return { kind: "null" }
      if (input.type === "checkbox") return { kind: "bool", value: Boolean(input.value) }
      if (input.type === "list") return { kind: "list", items: input.value }
      if (input.type === "number") return { kind: "number", text: String(input.value) }
      return { kind: "text", text: String(input.value) }
    }
    const state = async () => {
      const base = await originalInvoke("list_fragments") as {
        fragments: Array<Record<string, unknown>>
        lockbox: Record<string, unknown>
      }
      for (const item of base.fragments) {
        if (item.id !== "card-fragment") continue
        if (!shadow.has("card-fragment")) {
          shadow.set("card-fragment", { ...item, content: fragmentBody, properties: propertyValues() })
        }
      }
      for (const note of notes) if (!shadow.has(note.id)) shadow.set(note.id, clone(note))
      base.fragments = base.fragments.map((item) => shadow.get(String(item.id)) ?? item)
      base.fragments.push(shadow.get("property-note")!)
      if (unlocked) base.fragments.push(shadow.get("secret-note")!, shadow.get("secret-fragment")!)
      base.lockbox = { configured: true, unlocked, expiresAt: null, ttlSeconds: 900 }
      return clone(base)
    }
    root.__TAURI_INTERNALS__.invoke = async (command, args = {}) => {
      if (command === "list_fragments") return state()
      if (command === "unlock_lockbox") { root.__SHARD_TYPE_CALLS__.push({ command, args: clone(args) }); unlocked = true; return state() }
      if (command === "lock_lockbox") { root.__SHARD_TYPE_CALLS__.push({ command, args: clone(args) }); unlocked = false; return state() }
      if (command === "list_library_tree") {
        const tree = await originalInvoke(command, args) as { entries: Array<Record<string, unknown>> }
        tree.entries.push({ name: "属性文档.md", path: "notes/属性文档.md", kind: "markdown", size: 0, modifiedAt: now })
        return tree
      }
      if (command === "read_property_registry") {
        root.__SHARD_TYPE_CALLS__.push({ command, args: clone(args) })
        return clone({ registry, sha: registrySha })
      }
      if (command === "register_property_type") {
        root.__SHARD_TYPE_CALLS__.push({ command, args: clone(args) })
        if (args.expectedSha !== registrySha) throw new Error("登记表已变化")
        registry.properties[String(args.key)] = { type: String(args.propertyType) }
        registrySha = `registry-sha-${++revision}`
        return clone({ registry, sha: registrySha })
      }
      if (command === "set_fragment_property" || command === "remove_fragment_property") {
        root.__SHARD_TYPE_CALLS__.push({ command, args: clone(args) })
        const fragment = shadow.get(String(args.id))
        if (!fragment) throw new Error("Fragment not found")
        const properties = fragment.properties as Array<Record<string, unknown>>
        const index = properties.findIndex((item) => item.key === args.key)
        if (command === "remove_fragment_property") {
          if (index >= 0) properties.splice(index, 1)
        } else {
          const next = { key: String(args.key), value: propertyInput(args.value as Record<string, unknown>), editable: true }
          if (index >= 0) properties[index] = next
          else properties.push(next)
        }
        fragment.fileSha = `${String(fragment.id)}-property-sha-${++revision}`
        return clone(fragment)
      }
      if (command === "update_fragment" && shadow.has(String(args.id))) {
        root.__SHARD_TYPE_CALLS__.push({ command, args: clone(args) })
        const fragment = shadow.get(String(args.id))!
        if (args.expectedFileSha !== undefined && args.expectedFileSha !== fragment.fileSha) {
          throw new Error("STALE_BASE:保存基线过期")
        }
        fragment.content = String(args.content)
        fragment.tags = clone(args.tags)
        fragment.fileSha = `${String(fragment.id)}-saved-sha-${++revision}`
        return clone(fragment)
      }
      return originalInvoke(command, args)
    }
  }, CARD_FRAGMENT)
}

async function openFragmentZen(page: Page) {
  const target = card(page, "card-fragment")
  await revealCard(target)
  await target.getByRole("button", { name: "片段操作", exact: true }).click()
  await page.getByRole("menuitem", { name: "禅模式", exact: true }).click()
}

async function calls(page: Page, command: string) {
  return page.evaluate((target) => (
    globalThis as typeof globalThis & { __SHARD_TYPE_CALLS__: TestCall[] }
  ).__SHARD_TYPE_CALLS__.filter((call) => call.command === target), command)
}

test.beforeEach(async ({ page }) => {
  await installPropertiesMock(page)
  await page.goto("/")
})

test("禅模式显示各类型属性，并可添加、编辑、删除与提示类型不符", async ({ page }) => {
  await openFragmentZen(page)
  const panel = page.getByRole("region", { name: "属性" })
  await expect(panel.getByLabel("客户 属性值")).toHaveValue("甲")
  await expect(panel.getByLabel("金额 属性值")).toHaveValue("1.50")
  await expect(panel.getByLabel("日期 属性值")).toBeVisible()
  await expect(panel.getByLabel("提醒时间 时间")).toBeVisible()
  await expect(panel.getByRole("checkbox", { name: /^完成 属性值/ })).toBeChecked()
  await expect(panel.getByText("甲", { exact: true })).toBeVisible()
  await expect(panel.getByText("此值只能在文本编辑器中修改")).toBeVisible()
  await expect(panel.getByText(/当前值与登记的数字类型不符/)).toBeVisible()
  const compactRow = await panel.locator('[data-property-key="客户"]').evaluate((row) => {
    const control = row.querySelector("input")!
    return {
      alignItems: getComputedStyle(row).alignItems,
      controlHeight: control.getBoundingClientRect().height,
      rowHeight: row.getBoundingClientRect().height,
    }
  })
  expect(compactRow.alignItems).toBe("center")
  expect(compactRow.controlHeight).toBeGreaterThanOrEqual(28)
  expect(compactRow.controlHeight).toBeLessThanOrEqual(32)
  expect(compactRow.rowHeight).toBeGreaterThanOrEqual(28)
  expect(compactRow.rowHeight).toBeLessThanOrEqual(32)

  await panel.getByLabel("客户 属性值").fill("乙")
  await panel.getByLabel("客户 属性值").press("Enter")
  await expect.poll(() => calls(page, "set_fragment_property").then((items) => items.length)).toBe(1)

  await panel.getByRole("button", { name: "添加属性", exact: true }).click()
  await panel.getByLabel("属性名").fill("评分")
  await selectOption(panel.getByLabel("属性类型"), "number")
  await panel.getByRole("button", { name: "添加", exact: true }).click()
  await expect.poll(() => calls(page, "register_property_type").then((items) => items.length)).toBe(1)
  await expect(panel.getByLabel("评分 属性值")).toBeVisible()

  const customer = panel.locator('[data-property-key="客户"]')
  await customer.getByRole("button", { name: "属性操作" }).click()
  await page.getByRole("menuitem", { name: "删除属性", exact: true }).click()
  await expect(customer).toHaveCount(0)
})

test("未保存草稿改属性后使用新 fileSha 自动保存", async ({ page }) => {
  await openFragmentZen(page)
  await fillEditor(page, "zen:card-fragment", "未保存草稿")
  await page.getByRole("checkbox", { name: /^完成 属性值/ }).click()
  await expect.poll(() => calls(page, "update_fragment").then((items) => items.length)).toBe(1)
  const propertyWrite = (await calls(page, "set_fragment_property")).at(-1)
  const save = (await calls(page, "update_fragment")).at(-1)
  expect(propertyWrite).toBeTruthy()
  expect(save?.args.expectedFileSha).toMatch(/property-sha/)
  await expect(page.getByText(/保存基线过期|冲突/)).toHaveCount(0)
})

test("资料库文档显示属性面板", async ({ page }) => {
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  const directory = page.getByRole("complementary", { name: "资料库目录" })
  await directory.getByRole("button", { name: /^文件（/ }).click()
  await page.getByRole("button", { name: "打开文件 属性文档.md", exact: true }).click()
  await expect(page.getByRole("region", { name: "属性" }).getByLabel("客户 属性值")).toHaveValue("甲")
})

test("密匣碎片新增属性不登记公开类型", async ({ page }) => {
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  await page.getByRole("complementary", { name: "资料库目录" })
    .getByRole("button", { name: "密匣（上锁空间）", exact: true }).click()
  const gate = page.getByRole("form", { name: "解锁密匣" })
  await gate.getByPlaceholder("密匣密码").fill("test-password")
  await gate.getByRole("button", { name: "解锁", exact: true }).click()
  const target = card(page, "secret-fragment")
  await revealCard(target)
  await target.getByRole("button", { name: "片段操作", exact: true }).click()
  await page.getByRole("menuitem", { name: "禅模式", exact: true }).click()
  const panel = page.getByRole("region", { name: "属性" })
  await panel.getByRole("button", { name: "添加属性", exact: true }).click()
  await expect(panel.getByText("私密内容的新属性不会写入公开类型表")).toBeVisible()
  await panel.getByLabel("属性名").fill("私密键")
  await panel.getByRole("button", { name: "添加", exact: true }).click()
  await expect(panel.getByLabel("私密键 属性值")).toBeVisible()
  await expect.poll(() => calls(page, "register_property_type").then((items) => items.length)).toBe(0)
})
