import { expect, test, type Page } from "@playwright/test"

import {
  CARD_JSON_FLOWCHART_FILE,
  CARD_JSON_OUTLINE_FILE,
  card,
  failNextGraphWrite,
  graphWrites,
  installContentTypesMock,
  lastFragmentWrite,
  lastGraphWrite,
  lastSavedFragment,
  queueFragmentStale,
  queueGraphStale,
  readTypeCalls,
  revealCard,
} from "./content-types-mock"
import {
  fillEditor,
  focusEditor,
  readEditor,
  selectEditorText,
  typeEditor,
} from "./editor-helpers"

/**
 * 阶段 D1：行内编辑与禅模式切到富文本，并按 type 分派功能集合
 * （产品框架 §2 三类型表、§3「禅模式是通用能力」）。
 *
 * 这里覆盖三种类型在行内编辑与禅模式下的分派；斜杠命令、任务列表等
 * 编辑细节由 rich-blocks / editor-task-list 等用例守着。
 */

const COMPOSER = '[data-shard-editor="composer"]'
const OUTLINE = '[data-capture-outline="editor"]'
const OUTLINE_ROOT =
  '[data-outline-node][data-root="true"] textarea[data-outline-field="text"]'

function zenSurface(page: Page) {
  return page.locator('section[aria-label="禅模式"]')
}

function graphWorkspace(page: Page) {
  return page.locator('section[aria-label="思维导图工作区"]')
}

function flowchartWorkspace(page: Page) {
  return page.locator('section[aria-label="流程图工作区"]')
}

function flowchartNode(page: Page, id = "flow-review") {
  return flowchartWorkspace(page).locator(`[data-canvas-node-id="${id}"]`)
}

function graphRoot(page: Page) {
  return graphWorkspace(page).locator(
    '[data-mind-map-outline]:visible [data-outline-node][data-root="true"] textarea'
  )
}

function graphFileWithRoot(text: string) {
  const file = structuredClone(CARD_JSON_OUTLINE_FILE)
  file.title = text
  file.nodes[file.rootId].text = text
  return file
}

function flowchartFileWithNode(text: string) {
  const file = structuredClone(CARD_JSON_FLOWCHART_FILE)
  file.nodes = file.nodes.map((node) => node.id === "flow-review" ? { ...node, text } : node)
  return file
}

async function commandCount(page: Page, command: string) {
  return page.evaluate((name) => (
    globalThis as typeof globalThis & {
      __SHARD_TYPE_CALLS__: Array<{ command: string }>
    }
  ).__SHARD_TYPE_CALLS__.filter((call) => call.command === name).length, command)
}

function richEditor(page: Page, editorId: string) {
  return page.locator(`[data-shard-editor="${editorId}"]`)
}

function proseMirror(page: Page, editorId: string) {
  return page.locator(`[data-shard-editor="${editorId}"] .ProseMirror`)
}

function commandMenu(page: Page) {
  return page.getByRole("listbox", { name: "命令菜单" })
}

/** 卡片菜单里的「编辑」/「禅模式」；卡片要先进视口才有布局。 */
async function openFromCardMenu(page: Page, id: string, entry: "编辑" | "禅模式") {
  const target = card(page, id)
  await revealCard(target)
  await target.getByRole("button", { name: "片段操作", exact: true }).click()
  await page.getByRole("menuitem", { name: entry, exact: true }).click()
}

test.describe("行内编辑与禅模式", () => {
  test.beforeEach(async ({ page }) => {
    await installContentTypesMock(page)
    await page.goto("/")
    await expect(page.locator(`${COMPOSER} .ProseMirror`)).toBeFocused()
    await expect(page.locator(".shard-timeline-item")).toHaveCount(6)
  })

  test("碎片的行内编辑是富文本：看不到语法，失焦保存规范 Markdown 且标签不变", async ({
    page,
  }) => {
    await openFromCardMenu(page, "card-fragment", "编辑")

    const editor = proseMirror(page, "fragment:card-fragment")
    await expect(editor).toHaveCount(1)
    await expect(richEditor(page, "fragment:card-fragment")).toHaveAttribute(
      "data-shard-editor-tier",
      "fragment"
    )
    // 标签是芯片、列表是真列表：编辑区里没有 `#` 与 `*` 这类语法字符。
    await expect(editor.locator(".shard-rich-tag")).toHaveCount(1)
    await expect(editor.locator("ul li")).toHaveCount(1)
    await expect(editor).toContainText("随手记的碎片")
    await expect(editor).not.toContainText("*")

    await focusEditor(page, "fragment:card-fragment")
    await typeEditor(page, "fragment:card-fragment", "，补一句")

    // 失焦即提交（行内编辑的保存语义不变）。
    await page.locator(`${COMPOSER} .ProseMirror`).click()
    await expect(editor).toHaveCount(0)

    await expect.poll(() => lastSavedFragment(page, "card-fragment")).toEqual({
      // `*` 列表在首次保存时归一为 `- `，标签原样写回。
      content: "#灵感 随手记的碎片\n\n- 非规范列表，补一句",
      tags: ["inbox", "灵感"],
    })
  })

  test("碎片的禅模式是基础档：`/` 菜单没有标题、引用、代码块", async ({ page }) => {
    await openFromCardMenu(page, "card-fragment", "禅模式")

    await expect(zenSurface(page)).toHaveCount(1)
    await expect(proseMirror(page, "zen:card-fragment")).toHaveCount(1)
    await expect(richEditor(page, "zen:card-fragment")).toHaveAttribute(
      "data-shard-editor-tier",
      "fragment"
    )

    const zen = zenSurface(page)
    // 插入与块级转换全部走 `/` 命令，底部操作条不再放格式按钮。
    await expect(zen.getByRole("button", { name: "插入标签", exact: true })).toHaveCount(0)
    // 基础档的角落仍是既有的字数 · 行数。
    await expect(zen.locator("[data-zen-word-count]")).toHaveCount(0)

    await expect(proseMirror(page, "zen:card-fragment")).toBeFocused()
    await typeEditor(page, "zen:card-fragment", " /")
    const menu = commandMenu(page)
    await expect(menu.getByRole("option", { name: /标签/ })).toHaveCount(1)
    await expect(menu.getByRole("option", { name: /标题/ })).toHaveCount(0)
    await expect(menu.getByRole("option", { name: /引用/ })).toHaveCount(0)
    await expect(menu.getByRole("option", { name: /代码块/ })).toHaveCount(0)
  })

  test("Esc 退出富文本禅模式：ProseMirror 吃掉的按键由编辑器转交回宿主", async ({
    page,
  }) => {
    await openFromCardMenu(page, "card-fragment", "禅模式")
    await expect(proseMirror(page, "zen:card-fragment")).toBeFocused()

    await page.keyboard.press("Escape")
    await expect(zenSurface(page)).toHaveCount(0)
  })

  test("禅模式打开不规范碎片不触发保存，编辑一字后保存为规范化全文", async ({ page }) => {
    await openFromCardMenu(page, "card-fragment", "禅模式")
    const editor = proseMirror(page, "zen:card-fragment")
    await expect(editor).toBeFocused()

    // 碎片正文里有 `* 非规范列表`；超过 800ms 自动保存节拍也不能有写入。
    await page.waitForTimeout(1_500)
    expect(await lastSavedFragment(page, "card-fragment")).toBeNull()

    await editor.locator("li").last().click()
    await page.keyboard.press("End")
    await page.keyboard.type("！")
    await expect.poll(() => lastSavedFragment(page, "card-fragment")).toEqual({
      content: "#灵感 随手记的碎片\n\n- 非规范列表！",
      tags: ["inbox", "灵感"],
    })
    expect((await lastFragmentWrite(page, "card-fragment"))?.args).toMatchObject({
      expectedFileSha: "file-sha-card-fragment-1",
    })
  })

  test("普通碎片 STALE_BASE 选择覆盖时清空基线重存当前草稿", async ({ page }) => {
    await queueFragmentStale(page, "card-fragment", "磁盘上的碎片版本")
    await openFromCardMenu(page, "card-fragment", "禅模式")
    page.once("dialog", async (dialog) => {
      expect(dialog.message()).toContain("磁盘内容已被修改")
      await dialog.accept()
    })

    await fillEditor(page, "zen:card-fragment", "我的碎片草稿")

    await expect.poll(async () => {
      const writes = (await graphWrites(page, "card-fragment"))
      return writes.length
    }).toBe(0)
    await expect.poll(async () => {
      const calls = await page.evaluate(() => (
        globalThis as typeof globalThis & {
          __SHARD_TYPE_CALLS__: Array<{ command: string; args: Record<string, unknown> }>
        }
      ).__SHARD_TYPE_CALLS__.filter((call) =>
        call.command === "update_fragment" && call.args.id === "card-fragment"
      ))
      return calls.length
    }).toBe(2)
    const calls = await page.evaluate(() => (
      globalThis as typeof globalThis & {
        __SHARD_TYPE_CALLS__: Array<{ command: string; args: Record<string, unknown> }>
      }
    ).__SHARD_TYPE_CALLS__.filter((call) =>
      call.command === "update_fragment" && call.args.id === "card-fragment"
    ))
    expect(calls[0].args.expectedFileSha).toBe("file-sha-card-fragment-1")
    expect(calls[1].args.expectedFileSha).toBeUndefined()
    expect(calls[1].args.content).toBe("我的碎片草稿")
  })

  test("普通碎片 STALE_BASE 选择载入磁盘版时放弃草稿并刷新基线", async ({ page }) => {
    await queueFragmentStale(page, "card-fragment", "磁盘最新碎片")
    await openFromCardMenu(page, "card-fragment", "禅模式")
    page.once("dialog", async (dialog) => {
      expect(dialog.message()).toContain("载入磁盘最新版本")
      await dialog.dismiss()
    })

    await fillEditor(page, "zen:card-fragment", "本地待放弃草稿")

    await expect(proseMirror(page, "zen:card-fragment")).toContainText("磁盘最新碎片")
    const write = await lastFragmentWrite(page, "card-fragment")
    expect(write?.args.expectedFileSha).toBe("file-sha-card-fragment-1")
  })

  test("普通碎片 STALE_BASE 的磁盘正文相同也刷新 fileSha，下一次保存不重复冲突", async ({ page }) => {
    await queueFragmentStale(page, "card-fragment", "第一次草稿")
    await openFromCardMenu(page, "card-fragment", "禅模式")
    let dialogCount = 0
    page.on("dialog", async (dialog) => {
      dialogCount += 1
      await dialog.dismiss()
    })

    await fillEditor(page, "zen:card-fragment", "第一次草稿")
    await expect.poll(() => dialogCount).toBe(1)
    await fillEditor(page, "zen:card-fragment", "第二次草稿")

    await expect.poll(async () => {
      const calls = await page.evaluate(() => (
        globalThis as typeof globalThis & {
          __SHARD_TYPE_CALLS__: Array<{ command: string; args: Record<string, unknown> }>
        }
      ).__SHARD_TYPE_CALLS__.filter((call) =>
        call.command === "update_fragment" && call.args.id === "card-fragment"
      ))
      return calls.length
    }).toBe(2)
    const write = await lastFragmentWrite(page, "card-fragment")
    expect(write?.args.expectedFileSha).toBe("file-sha-card-fragment-remote")
    expect(write?.args.content).toBe("第二次草稿")
    expect(dialogCount).toBe(1)
  })

  test("禅模式里打 #标签 不按空格等自动保存：落盘为 #标签，编辑区仍可接着打", async ({
    page,
  }) => {
    await openFromCardMenu(page, "card-fragment", "禅模式")
    const editor = proseMirror(page, "zen:card-fragment")
    await expect(editor).toBeFocused()

    await editor.locator("li").last().click()
    await page.keyboard.press("End")
    await page.keyboard.type(" #新标签")

    // 不按空格、不失焦，只等 800ms 自动保存：落盘的是收敛后的 `#新标签`，不是 `\#新标签`。
    await expect.poll(() => lastSavedFragment(page, "card-fragment")).toEqual({
      content: "#灵感 随手记的碎片\n\n- 非规范列表 #新标签",
      tags: ["inbox", "灵感", "新标签"],
    })
    // 自动保存只读不改：用户停顿时编辑区里的 `#新标签` 仍是字面文本，不抢先变芯片。
    await expect(editor.locator(".shard-rich-tag")).toHaveCount(1)
    await expect(editor).toContainText("#新标签")
  })

  test("文档类型：卡片「编辑」直接进禅模式，`/` 菜单开放文档档命令，二级标题写回 ## ", async ({
    page,
  }) => {
    await openFromCardMenu(page, "card-document", "编辑")

    // 文档不提供行内编辑（产品框架 §2）。
    await expect(zenSurface(page)).toHaveCount(1)
    await expect(proseMirror(page, "fragment:card-document")).toHaveCount(0)
    await expect(richEditor(page, "zen:card-document")).toHaveAttribute(
      "data-shard-editor-tier",
      "document"
    )

    await fillEditor(page, "zen:card-document", "本季度小结")
    await expect(proseMirror(page, "zen:card-document")).toContainText("本季度小结")

    // 行首打 `/`：文档档菜单里有标题 1–4、引用、代码块与表格。
    await selectEditorText(page, "zen:card-document", "本季度小结", { collapse: "start" })
    await typeEditor(page, "zen:card-document", "/")
    const menu = commandMenu(page)
    await expect(menu.getByRole("option", { name: /标题/ })).toHaveCount(4)
    await expect(menu.getByRole("option", { name: /引用/ })).toHaveCount(1)
    await expect(menu.getByRole("option", { name: /代码块/ })).toHaveCount(1)
    await expect(menu.getByRole("option", { name: /表格/ })).toHaveCount(1)

    await typeEditor(page, "zen:card-document", "h2")
    await expect(menu.getByRole("option")).toHaveCount(1)
    await page.keyboard.press("Enter")
    await expect(menu).toHaveCount(0)

    await expect(proseMirror(page, "zen:card-document").locator("h2")).toHaveCount(1)
    // 禅模式是自动保存：写完等落盘，标题按方言写成 `## `，文档 type 保留。
    await expect.poll(() => lastSavedFragment(page, "card-document")).toEqual({
      content: "## 本季度小结",
      tags: ["inbox", "document"],
    })
    // 编辑区里看不到井号。
    await expect(proseMirror(page, "zen:card-document")).not.toContainText("#")
  })

  test("文档档禅模式角落的字数随输入变化，只数正文纯文本", async ({ page }) => {
    await openFromCardMenu(page, "card-document", "编辑")

    const count = zenSurface(page).locator("[data-zen-word-count]")
    await fillEditor(page, "zen:card-document", "一二三")
    await expect(count).toHaveText("3 字")

    await focusEditor(page, "zen:card-document")
    await typeEditor(page, "zen:card-document", "四五")
    await expect(count).toHaveText("5 字")
  })

  test("大纲类型的行内编辑是幕布态，改节点后保存为纯缩进列表且 type 保留", async ({
    page,
  }) => {
    await openFromCardMenu(page, "card-outline", "编辑")

    const outline = page.locator(OUTLINE)
    await expect(outline).toHaveCount(1)
    // 大纲整篇就是一棵树，没有富文本正文区。
    await expect(proseMirror(page, "fragment:card-outline")).toHaveCount(0)
    await expect(page.locator('[data-editor-type-badge="outline"]')).toBeVisible()
    await expect(outline.locator(OUTLINE_ROOT)).toBeFocused()

    await page.keyboard.type("补充")
    await page
      .getByRole("button", { name: "保存修改", exact: true })
      .click({ force: true })

    await expect.poll(() => lastSavedFragment(page, "card-outline")).toEqual({
      content: "- 项目大纲补充\n  - 第一步\n  - 第二步",
      tags: ["inbox", "outline"],
    })
    await expect(outline).toHaveCount(0)
  })

  test("大纲类型的禅模式在幕布与只读导图之间切换", async ({ page }) => {
    await openFromCardMenu(page, "card-outline", "禅模式")

    const zen = zenSurface(page)
    await expect(zen).toHaveCount(1)
    await expect(zen.locator(OUTLINE)).toHaveCount(1)
    await expect(zen.locator('[data-editor-type-badge="outline"]')).toBeVisible()

    await zen.getByRole("button", { name: "导图", exact: true }).click()
    await expect(zen.getByRole("img", { name: "思维导图预览" })).toBeVisible()
    await expect(zen.locator(OUTLINE)).toHaveCount(0)

    await zen.getByRole("button", { name: "大纲", exact: true }).click()
    await expect(zen.locator(OUTLINE)).toHaveCount(1)
    await expect(zen.getByRole("img", { name: "思维导图预览" })).toHaveCount(0)
  })

  test("JSON 大纲从卡片编辑进入图形禅模式，默认大纲、可切导图、自动保存并在 Esc 前排空", async ({ page }) => {
    test.slow()
    const mindMapListsBefore = await commandCount(page, "list_mind_maps")
    await openFromCardMenu(page, "card-json-outline", "编辑")

    const workspace = graphWorkspace(page)
    await expect(workspace).toHaveCount(1)
    await expect(workspace.getByRole("tab", { name: "大纲", exact: true })).toHaveAttribute(
      "aria-selected",
      "true"
    )
    await workspace.getByRole("tab", { name: "思维导图", exact: true }).click()
    await expect(workspace.getByRole("application", { name: "思维导图编辑器" })).toBeVisible()
    await workspace.getByRole("tab", { name: "大纲", exact: true }).click()

    await graphRoot(page).fill("自动保存后的根节点")
    await expect.poll(() => lastGraphWrite(page, "card-json-outline")).not.toBeNull()
    await expect(workspace.getByText("已自动保存", { exact: true })).toBeVisible()
    let write = await lastGraphWrite(page, "card-json-outline")
    expect(write?.args.expectedFileSha).toBe("file-sha-card-json-outline-1")
    expect((write?.args.graph as typeof CARD_JSON_OUTLINE_FILE).nodes["json-root"].text)
      .toBe("自动保存后的根节点")

    await graphRoot(page).fill("Esc 排空后的根节点")
    await page.keyboard.press("Escape")
    await page.keyboard.press("Escape")

    await expect(workspace).toHaveCount(0)
    await expect.poll(() => graphWrites(page, "card-json-outline")).toHaveLength(2)
    write = await lastGraphWrite(page, "card-json-outline")
    expect((write?.args.graph as typeof CARD_JSON_OUTLINE_FILE).nodes["json-root"].text)
      .toBe("Esc 排空后的根节点")
    expect(await commandCount(page, "list_mind_maps")).toBe(mindMapListsBefore)
  })

  test("JSON 大纲文档属性先排空图保存，写入后替换 fileSha 基线并继续自动保存", async ({ page }) => {
    test.slow()
    await openFromCardMenu(page, "card-json-outline", "编辑")
    const workspace = graphWorkspace(page)
    await graphRoot(page).fill("打开属性前的大纲草稿")
    await workspace.getByRole("button", { name: "文档属性", exact: true }).click()

    const dialog = page.getByRole("dialog", { name: "文档属性", exact: true })
    await expect(dialog).toBeVisible()
    await expect.poll(() => graphWrites(page, "card-json-outline")).toHaveLength(1)
    await dialog.getByLabel("阶段 属性值").fill("评审中")
    await dialog.getByLabel("阶段 属性值").press("Enter")
    await expect.poll(async () => (await readTypeCalls(page)).filter(
      (call) => call.command === "set_fragment_property" && call.args.id === "card-json-outline"
    )).toHaveLength(1)
    await dialog.getByRole("button", { name: "关闭", exact: true }).click()

    await graphRoot(page).fill("属性写入后的大纲草稿")
    await expect.poll(() => graphWrites(page, "card-json-outline")).toHaveLength(2)
    const write = await lastGraphWrite(page, "card-json-outline")
    expect(write?.args.expectedFileSha).toMatch(/property/u)
    expect((write?.args.graph as typeof CARD_JSON_OUTLINE_FILE).nodes["json-root"].text)
      .toBe("属性写入后的大纲草稿")
    await expect(page.getByText(/保存冲突|STALE_BASE/u)).toHaveCount(0)
  })

  test("JSON 大纲排空失败时不打开文档属性", async ({ page }) => {
    await openFromCardMenu(page, "card-json-outline", "编辑")
    await failNextGraphWrite(page)
    await graphRoot(page).fill("无法排空的大纲草稿")
    await graphWorkspace(page).getByRole("button", { name: "文档属性", exact: true }).click()

    await expect(page.getByRole("dialog", { name: "文档属性", exact: true })).toHaveCount(0)
    await expect(page.getByText(/无法打开文档属性/u)).toBeVisible()
  })

  test("JSON 大纲图形编辑 STALE_BASE 选择保留我的版本时用最新 fileSha 重存", async ({ page }) => {
    test.slow()
    await queueGraphStale(page, "card-json-outline", graphFileWithRoot("磁盘冲突版本"))
    await openFromCardMenu(page, "card-json-outline", "编辑")

    await graphRoot(page).fill("我的图形版本")
    await expect(page.getByText(/检测到保存冲突/u)).toBeVisible()
    await page.getByRole("button", { name: "保留我的版本", exact: true }).click()

    await expect.poll(() => graphWrites(page, "card-json-outline")).toHaveLength(2)
    const writes = await graphWrites(page, "card-json-outline")
    expect(writes[0].args.expectedFileSha).toBe("file-sha-card-json-outline-1")
    expect(writes[1].args.expectedFileSha).toBe("file-sha-card-json-outline-remote")
    expect((writes[1].args.graph as typeof CARD_JSON_OUTLINE_FILE).nodes["json-root"].text)
      .toBe("我的图形版本")
    await expect(page.getByText(/检测到保存冲突/u)).toHaveCount(0)
  })

  test("JSON 大纲图形编辑 STALE_BASE 选择保留磁盘版本时重新载入", async ({ page }) => {
    test.slow()
    await queueGraphStale(page, "card-json-outline", graphFileWithRoot("磁盘图形版本"))
    await openFromCardMenu(page, "card-json-outline", "编辑")

    await graphRoot(page).fill("待放弃的本地图形版本")
    await expect(page.getByText(/检测到保存冲突/u)).toBeVisible()
    await page.getByRole("button", { name: "保留磁盘版本", exact: true }).click()

    await expect(graphRoot(page)).toHaveValue("磁盘图形版本")
    await expect(page.getByText(/检测到保存冲突/u)).toHaveCount(0)
    expect(await graphWrites(page, "card-json-outline")).toHaveLength(1)

    await page.keyboard.press("Escape")
    await page.keyboard.press("Escape")
    await expect(graphWorkspace(page)).toHaveCount(0)
    const target = card(page, "card-json-outline")
    await revealCard(target)
    await expect(target.locator('[data-fragment-card-kind="outline"] p').first())
      .toHaveText("磁盘图形版本")
  })

  test("JSON 流程图从卡片编辑与禅模式都进入 Canvas，关闭前排空保存", async ({ page }) => {
    test.slow()
    for (const entry of ["编辑", "禅模式"] as const) {
      await openFromCardMenu(page, "card-json-flowchart", entry)
      const workspace = flowchartWorkspace(page)
      await expect(workspace).toHaveCount(1)
      await expect(workspace.locator('[data-canvas-workspace]')).toBeVisible()
      await expect(page.locator('[data-shard-editor="fragment:card-json-flowchart"]')).toHaveCount(0)

      await flowchartNode(page).dblclick()
      const editor = page.getByRole("textbox", { name: "节点文字", exact: true })
      await editor.fill(`${entry}后的审核`)
      await page.getByRole("button", { name: "退出流程图", exact: true }).click()

      await expect(workspace).toHaveCount(0)
      const write = await lastGraphWrite(page, "card-json-flowchart")
      expect(write?.args.expectedFileSha).toMatch(/^file-sha-card-json-flowchart-/u)
      expect((write?.args.graph as typeof CARD_JSON_FLOWCHART_FILE).nodes.find(
        (node) => node.id === "flow-review"
      )?.text).toBe(`${entry}后的审核`)
    }
  })

  test("JSON 流程图文档属性先排空保存，写入后替换 fileSha 基线并继续自动保存", async ({ page }) => {
    test.slow()
    await openFromCardMenu(page, "card-json-flowchart", "编辑")
    const workspace = flowchartWorkspace(page)
    await flowchartNode(page).dblclick()
    let editor = page.getByRole("textbox", { name: "节点文字", exact: true })
    await editor.fill("打开属性前的流程")
    await editor.press("ControlOrMeta+Enter")
    await workspace.getByRole("button", { name: "文档属性", exact: true }).click()

    const dialog = page.getByRole("dialog", { name: "文档属性", exact: true })
    await expect(dialog).toBeVisible()
    await expect.poll(() => graphWrites(page, "card-json-flowchart")).toHaveLength(1)
    await dialog.getByLabel("阶段 属性值").fill("已发布")
    await dialog.getByLabel("阶段 属性值").press("Enter")
    await expect.poll(async () => (await readTypeCalls(page)).filter(
      (call) => call.command === "set_fragment_property" && call.args.id === "card-json-flowchart"
    )).toHaveLength(1)
    await dialog.getByRole("button", { name: "关闭", exact: true }).click()

    await flowchartNode(page).dblclick()
    editor = page.getByRole("textbox", { name: "节点文字", exact: true })
    await editor.fill("属性写入后的流程")
    await editor.press("ControlOrMeta+Enter")
    await expect.poll(() => graphWrites(page, "card-json-flowchart")).toHaveLength(2)
    const write = await lastGraphWrite(page, "card-json-flowchart")
    expect(write?.args.expectedFileSha).toMatch(/property/u)
    expect((write?.args.graph as typeof CARD_JSON_FLOWCHART_FILE).nodes.find(
      (node) => node.id === "flow-review"
    )?.text).toBe("属性写入后的流程")
    await expect(page.getByText(/保存冲突|STALE_BASE/u)).toHaveCount(0)
  })

  test("JSON 流程图排空失败时不打开文档属性", async ({ page }) => {
    await openFromCardMenu(page, "card-json-flowchart", "编辑")
    await failNextGraphWrite(page)
    await flowchartNode(page).dblclick()
    const editor = page.getByRole("textbox", { name: "节点文字", exact: true })
    await editor.fill("无法排空的流程")
    await editor.press("ControlOrMeta+Enter")
    await flowchartWorkspace(page).getByRole("button", { name: "文档属性", exact: true }).click()

    await expect(page.getByRole("dialog", { name: "文档属性", exact: true })).toHaveCount(0)
    await expect(flowchartWorkspace(page).getByRole("alert"))
      .toContainText("无法打开文档属性：请先处理图内容的保存问题。")
  })

  test("流程图碎片冲突可用最新基线保留本地版本，且不显示副本恢复入口", async ({ page }) => {
    test.slow()
    await queueGraphStale(page, "card-json-flowchart", flowchartFileWithNode("磁盘冲突版本"))
    await openFromCardMenu(page, "card-json-flowchart", "编辑")
    await flowchartNode(page).dblclick()
    await page.getByRole("textbox", { name: "节点文字", exact: true }).fill("我的流程图版本")
    await page.getByRole("textbox", { name: "节点文字", exact: true }).press("ControlOrMeta+Enter")

    await expect(page.getByText(/检测到保存冲突/u)).toBeVisible()
    await expect(page.getByRole("button", { name: "另存流程图副本", exact: true })).toHaveCount(0)
    await page.getByRole("button", { name: "保留我的版本", exact: true }).click()

    await expect.poll(() => graphWrites(page, "card-json-flowchart")).toHaveLength(2)
    const writes = await graphWrites(page, "card-json-flowchart")
    expect(writes[1].args.expectedFileSha).toBe("file-sha-card-json-flowchart-remote")
    expect((writes[1].args.graph as typeof CARD_JSON_FLOWCHART_FILE).nodes.find(
      (node) => node.id === "flow-review"
    )?.text).toBe("我的流程图版本")
  })

  test("流程图碎片冲突可载入磁盘版本", async ({ page }) => {
    test.slow()
    await queueGraphStale(page, "card-json-flowchart", flowchartFileWithNode("磁盘流程图版本"))
    await openFromCardMenu(page, "card-json-flowchart", "编辑")
    await flowchartNode(page).dblclick()
    await page.getByRole("textbox", { name: "节点文字", exact: true }).fill("待放弃的流程图版本")
    await page.getByRole("textbox", { name: "节点文字", exact: true }).press("ControlOrMeta+Enter")

    await expect(page.getByText(/检测到保存冲突/u)).toBeVisible()
    const readsBeforeReload = await commandCount(page, "read_graph_fragment")
    await page.getByRole("button", { name: "载入磁盘版本", exact: true }).click()
    await expect.poll(() => commandCount(page, "read_graph_fragment"))
      .toBe(readsBeforeReload + 1)
    await expect(flowchartNode(page)).toContainText("磁盘流程图版本")
    await expect(page.getByText(/检测到保存冲突/u)).toHaveCount(0)
    expect(await graphWrites(page, "card-json-flowchart")).toHaveLength(1)
  })

  test("/文档 提交后直接进禅模式，且是文档档", async ({ page }) => {
    await focusEditor(page, "composer")
    await typeEditor(page, "composer", "/文档")
    await expect(commandMenu(page).getByRole("option")).toHaveCount(1)
    await page.keyboard.press("Enter")

    await focusEditor(page, "composer")
    await typeEditor(page, "composer", "刚建的文档")
    await page.keyboard.press("ControlOrMeta+Enter")

    await expect(zenSurface(page)).toHaveCount(1)
    await expect(richEditor(page, "zen:typed-created-1")).toHaveAttribute(
      "data-shard-editor-tier",
      "document"
    )
    await expect(proseMirror(page, "zen:typed-created-1")).toContainText("刚建的文档")
  })

  test("/大纲 只命中内容类型一条候选，/导图块 插入围栏块", async ({ page }) => {
    await focusEditor(page, "composer")
    await typeEditor(page, "composer", "/大纲")
    const menu = commandMenu(page)
    await expect(menu.getByRole("option")).toHaveCount(1)
    await expect(menu.getByRole("option")).toContainText("大纲")
    await page.keyboard.press("Escape")
    await expect(menu).toHaveCount(0)

    await fillEditor(page, "composer", "")
    await focusEditor(page, "composer")
    await typeEditor(page, "composer", "/导图块")
    await expect(menu.getByRole("option")).toHaveCount(1)
    await expect(menu.getByRole("option")).toContainText("导图块")
    await page.keyboard.press("Enter")

    await expect(
      page.locator(`${COMPOSER} [data-mind-map-fence-widget="editor"]`)
    ).toHaveCount(1)
    await expect.poll(() => readEditor(page, "composer")).toContain("```mindmap")
  })
})
