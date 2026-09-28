import { expect, test, type Page } from "@playwright/test"

import { openFragmentFilters } from "./fragment-filter-helpers"
import {
  card,
  installContentTypesMock,
  revealCard,
} from "./content-types-mock"
import { selectOption } from "./select-helpers"

const TOPIC_TAG = "项目"

async function installTagTopicMock(page: Page) {
  await installContentTypesMock(page)
  await page.addInitScript(({ topicTag }) => {
    const root = globalThis as typeof globalThis & {
      __TAURI_INTERNALS__: {
        invoke(command: string, args?: Record<string, unknown>): Promise<unknown>
      }
    }
    const originalInvoke = root.__TAURI_INTERNALS__.invoke.bind(root.__TAURI_INTERNALS__)
    const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T
    const topicIds = new Set([
      "card-fragment",
      "card-json-outline",
      "card-json-flowchart",
      "card-document",
    ])
    const properties: Record<string, Array<Record<string, unknown>>> = {
      "card-fragment": [
        { key: "客户", value: { kind: "text", text: "甲" }, editable: true },
        { key: "金额", value: { kind: "number", text: "12345678901234567890" }, editable: true },
        { key: "清单", value: { kind: "list", items: ["调研", "实现"] }, editable: true },
      ],
      "card-json-outline": [
        { key: "客户", value: { kind: "text", text: "乙" }, editable: true },
        { key: "金额", value: { kind: "number", text: "2" }, editable: true },
        { key: "日期", value: { kind: "text", text: "2026-09-28" }, editable: true },
      ],
      "card-json-flowchart": [
        { key: "金额", value: { kind: "number", text: "10" }, editable: true },
        { key: "完成", value: { kind: "bool", value: true }, editable: true },
        { key: "提醒", value: { kind: "text", text: "2026-09-28T09:30" }, editable: true },
      ],
      "card-document": [
        { key: "金额", value: { kind: "text", text: "9" }, editable: true },
        { key: "链接", value: { kind: "text", text: "[[发布流程]]" }, editable: true },
        { key: "复杂", value: { kind: "other", raw: "nested: true, nested-again: value" }, editable: false },
      ],
    }
    const registry = {
      version: 1,
      properties: {
        客户: { type: "text" },
        金额: { type: "number" },
        日期: { type: "date" },
        完成: { type: "checkbox" },
        提醒: { type: "datetime" },
        清单: { type: "list" },
        链接: { type: "link" },
        复杂: { type: "text" },
      },
    }

    root.__TAURI_INTERNALS__.invoke = async (command, args = {}) => {
      if (command === "read_property_registry") {
        return clone({ registry, sha: "tag-topic-registry-sha" })
      }
      if (command !== "list_fragments") return originalInvoke(command, args)

      const state = await originalInvoke(command, args) as {
        fragments: Array<Record<string, unknown>>
      }
      state.fragments = state.fragments.map((fragment, index) => {
        const id = String(fragment.id)
        if (!topicIds.has(id)) return fragment
        return {
          ...fragment,
          properties: clone(properties[id]),
          tags: [...(fragment.tags as string[]), topicTag],
          updatedAt: `2026-09-${String(index + 20).padStart(2, "0")}T09:30:00.000Z`,
        }
      })
      state.fragments.push({
        archived: false,
        category: null,
        content: "引用主题内容的外部碎片",
        createdAt: "2026-09-27T08:00:00.000Z",
        error: null,
        fileSha: "topic-backlink-sha",
        gitStatus: "committed",
        id: "topic-backlink",
        lockbox: false,
        path: "fragments/topic-backlink.md",
        pinned: false,
        properties: [],
        related: [{
          targetId: "card-document",
          origin: "wikilink",
          createdAt: "2026-09-27T08:00:00.000Z",
        }],
        tags: ["inbox", "引用"],
        updatedAt: "2026-09-27T08:00:00.000Z",
      })
      return clone(state)
    }
  }, { topicTag: TOPIC_TAG })
}

async function openTopicFromCard(page: Page) {
  const target = card(page, "card-fragment")
  await revealCard(target)
  await target.getByRole("button", { name: `打开标签主题页：${TOPIC_TAG}`, exact: true }).click()
  return page.getByRole("region", { name: `标签主题页：${TOPIC_TAG}`, exact: true })
}

test.beforeEach(async ({ page }) => {
  await installTagTopicMock(page)
  await page.goto("/")
})

test("卡片标签进入主题页，显示四类计数、主题卡片、反链并可返回", async ({ page }) => {
  const topic = await openTopicFromCard(page)
  const activeViewStyle = await topic.getByRole("button", { name: "卡片", exact: true }).evaluate((element) => {
    const probe = document.createElement("span")
    probe.style.backgroundColor = "var(--card)"
    probe.style.color = "var(--primary)"
    probe.style.boxShadow = "var(--shadow-card)"
    document.body.append(probe)
    const active = getComputedStyle(element)
    const expected = getComputedStyle(probe)
    const result = {
      backgroundColor: active.backgroundColor,
      boxShadow: active.boxShadow,
      color: active.color,
      expectedBackgroundColor: expected.backgroundColor,
      expectedBoxShadow: expected.boxShadow,
      expectedColor: expected.color,
    }
    probe.remove()
    return result
  })
  expect(activeViewStyle.backgroundColor).toBe(activeViewStyle.expectedBackgroundColor)
  expect(activeViewStyle.boxShadow).toContain(activeViewStyle.expectedBoxShadow)
  expect(activeViewStyle.color).toBe(activeViewStyle.expectedColor)
  await expect(topic).toContainText("碎片 1")
  await expect(topic).toContainText("大纲 1")
  await expect(topic).toContainText("流程图 1")
  await expect(topic).toContainText("文档 1")
  await expect(topic.locator(".shard-timeline-item")).toHaveCount(4)
  await expect(topic.locator('[data-shard-fragment-id="card-fragment"]')).toBeVisible()
  await expect(topic.locator('[data-shard-fragment-id="card-json-outline"]')).toBeVisible()
  await expect(topic.locator('[data-shard-fragment-id="card-json-flowchart"]')).toBeVisible()
  await expect(topic.locator('[data-shard-fragment-id="card-document"]')).toBeVisible()
  await expect(topic.locator('[data-shard-fragment-id="card-outline"]')).toHaveCount(0)

  const backlinks = topic.getByRole("region", { name: "标签主题反向链接", exact: true })
  await expect(backlinks).toContainText("引用主题内容的外部碎片")
  await topic.getByRole("button", { name: "返回全部碎片", exact: true }).click()
  await expect(topic).toHaveCount(0)
  await expect(card(page, "topic-backlink")).toBeVisible()
})

test("表格展示属性类型和值，数字精确排序且错配值始终在末尾", async ({ page }) => {
  const topic = await openTopicFromCard(page)
  await topic.getByRole("button", { name: "表格", exact: true }).click()
  const table = topic.getByRole("table", { name: "标签内容属性表格", exact: true })
  await expect(table.locator("[data-tag-topic-row]")).toHaveCount(4)
  const initialOrder = await table.locator("tbody tr").evaluateAll((rows) => rows.map((row) => row.getAttribute("data-tag-topic-row")))
  await expect(table.getByRole("columnheader", { name: /金额.*数字/ })).toBeVisible()
  await expect(table.getByText("12345678901234567890", { exact: true })).toBeVisible()
  await expect(table.getByText("nested: true, nested-again: value", { exact: true })).toBeVisible()
  await expect(table.getByText("调研", { exact: true })).toBeVisible()
  await expect(table.getByText("实现", { exact: true })).toBeVisible()
  await expect(table.getByText("已勾选", { exact: true })).toBeVisible()
  const geometry = await table.evaluate((element) => {
    const header = element.querySelector("thead tr") as HTMLElement
    const row = element.querySelector("tbody tr") as HTMLElement
    const viewport = element.closest<HTMLElement>("[data-tag-topic-table-viewport]")!
    const rowStyle = getComputedStyle(row)
    return {
      headerHeight: header.getBoundingClientRect().height,
      overflowX: getComputedStyle(viewport).overflowX,
      headerPosition: getComputedStyle(header.querySelector("th")!).position,
      rowBorderBottomWidth: rowStyle.borderBottomWidth,
      rowHeight: row.getBoundingClientRect().height,
      rowToken: Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--table-row-height")),
      scrollableWidth: viewport.scrollWidth - viewport.clientWidth,
    }
  })
  expect(geometry.headerHeight).toBe(40)
  expect(geometry.headerPosition).toBe("sticky")
  expect(geometry.rowHeight).toBeGreaterThanOrEqual(Math.max(48, geometry.rowToken))
  expect(geometry.rowBorderBottomWidth).not.toBe("0px")
  expect(geometry.overflowX).toBe("auto")
  expect(geometry.scrollableWidth).toBeGreaterThan(0)

  const amountHeader = table.getByRole("columnheader", { name: /金额.*数字/ })
  await amountHeader.getByRole("button").click()
  await expect.poll(() => table.locator("tbody tr").evaluateAll((rows) => rows.map((row) => row.getAttribute("data-tag-topic-row")))).toEqual([
    "card-json-outline",
    "card-json-flowchart",
    "card-fragment",
    "card-document",
  ])
  await amountHeader.getByRole("button").click()
  await expect.poll(() => table.locator("tbody tr").evaluateAll((rows) => rows.map((row) => row.getAttribute("data-tag-topic-row")))).toEqual([
    "card-fragment",
    "card-json-flowchart",
    "card-json-outline",
    "card-document",
  ])
  await amountHeader.getByRole("button").click()
  await expect.poll(() => table.locator("tbody tr").evaluateAll((rows) => rows.map((row) => row.getAttribute("data-tag-topic-row")))).toEqual(initialOrder)

  await page.setViewportSize({ width: 720, height: 700 })
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await expect(topic.locator("[data-tag-topic-table-viewport]")).toBeVisible()
  await page.setViewportSize({ width: 720, height: 480 })
  await expect(topic.getByRole("button", { name: "返回全部碎片", exact: true })).toBeVisible()
  await expect(table).toBeVisible()
})

test("表格行按四种内容类型打开既有宿主", async ({ page }) => {
  const topic = await openTopicFromCard(page)
  await topic.getByRole("button", { name: "表格", exact: true }).click()

  await topic.locator('[data-tag-topic-row="card-fragment"]').click()
  await expect(page.locator('[data-shard-editor="zen:card-fragment"]')).toBeVisible()
  await page.keyboard.press("Escape")

  await topic.locator('[data-tag-topic-row="card-document"]').click()
  await expect(page.locator('[data-shard-editor="zen:card-document"]')).toBeVisible()
  await page.keyboard.press("Escape")

  await topic.locator('[data-tag-topic-row="card-json-outline"]').click()
  await expect(page.getByRole("region", { name: "思维导图工作区", exact: true })).toBeVisible()
  await page.keyboard.press("Escape")

  await topic.locator('[data-tag-topic-row="card-json-flowchart"]').click()
  await expect(page.getByRole("region", { name: "流程图工作区", exact: true })).toBeVisible()
})

test("表格视图按标签记忆，刷新后重新进入同标签仍保留", async ({ page }) => {
  let topic = await openTopicFromCard(page)
  await topic.getByRole("button", { name: "表格", exact: true }).click()
  await expect(topic.getByRole("button", { name: "表格", exact: true })).toHaveAttribute("aria-pressed", "true")

  await page.reload()
  topic = await openTopicFromCard(page)
  await expect(topic.getByRole("button", { name: "表格", exact: true })).toHaveAttribute("aria-pressed", "true")
  await expect(topic.getByRole("table", { name: "标签内容属性表格", exact: true })).toBeVisible()
})

test("从筛选状态条进入主题页，并在主题页保留类型筛选", async ({ page }) => {
  let dialog = await openFragmentFilters(page)
  await selectOption(dialog.getByRole("combobox", { name: "标签", exact: true }), TOPIC_TAG)
  await dialog.getByRole("button", { name: "查看碎片", exact: true }).click()
  const context = page.getByRole("region", { name: "当前碎片筛选", exact: true })
  await context.getByRole("button", { name: "打开主题页", exact: true }).click()
  const topic = page.getByRole("region", { name: `标签主题页：${TOPIC_TAG}`, exact: true })
  await expect(topic.locator(".shard-timeline-item")).toHaveCount(4)

  dialog = await openFragmentFilters(page)
  await selectOption(dialog.getByRole("combobox", { name: "类型", exact: true }), "document")
  await dialog.getByRole("button", { name: "查看碎片", exact: true }).click()
  await expect(topic).toContainText("碎片 1")
  await expect(topic).toContainText("文档 1")
  await expect(topic.locator(".shard-timeline-item")).toHaveCount(1)
  await expect(topic.locator('[data-shard-fragment-id="card-document"]')).toBeVisible()

  dialog = await openFragmentFilters(page)
  await selectOption(dialog.getByRole("combobox", { name: "属性名", exact: true }), "链接")
  await dialog.getByRole("button", { name: "查看碎片", exact: true }).click()
  await expect(topic).toBeVisible()
  await expect(page.getByRole("region", { name: "当前碎片筛选", exact: true })).toContainText("属性：链接 存在")
  await expect(topic.locator(".shard-timeline-item")).toHaveCount(1)

  await topic.getByRole("button", { name: "表格", exact: true }).click()
  const table = topic.getByRole("table", { name: "标签内容属性表格", exact: true })
  await expect(table.getByRole("columnheader", { name: /客户.*文本/ })).toBeVisible()
  await expect(table.getByRole("columnheader", { name: /金额.*数字/ })).toBeVisible()
  await expect(table.getByRole("columnheader", { name: /日期.*日期/ })).toBeVisible()
  await expect(table.getByRole("columnheader", { name: /完成.*勾选/ })).toBeVisible()
  await expect(table.getByRole("columnheader", { name: /提醒.*日期时间/ })).toBeVisible()
  await expect(table.getByRole("columnheader", { name: /清单.*列表/ })).toBeVisible()
  await expect(table.getByRole("columnheader", { name: /链接.*链接/ })).toBeVisible()
  await topic.getByRole("button", { name: "返回全部碎片", exact: true }).click()
  await expect(page.getByRole("region", { name: "当前碎片筛选", exact: true })).toHaveCount(0)
  await expect(card(page, "card-fragment")).toBeVisible()
})
