import { writeFile } from "node:fs/promises"

import { expect, test, type Locator, type Page } from "@playwright/test"

import { fillEditor, focusEditor, readEditor, readEditorSnapshot, selectEditorText, typeEditor } from "./editor-helpers"
import { installSearchIpcMock } from "./search-ipc-mock"

type Surface = "composer" | "inline" | "zen" | "library"

interface TestCall {
  command: string
  args: Record<string, unknown>
}

// Exercise the real workbench routes with an in-memory vault; no user's files are written.
async function installTaskListMock(page: Page) {
  await installSearchIpcMock(page)
  await page.addInitScript(() => {
    const now = "2026-09-10T08:00:00.000Z"
    const fragments = [
      { id: "task-fragment", path: "fragments/task-fragment.md", content: "待编辑碎片", tags: ["inbox"] },
      { id: "task-note", path: "notes/任务回归.md", content: "待编辑文档", tags: ["inbox", "note"] },
    ].map((fragment) => ({
      ...fragment, createdAt: now, updatedAt: now, category: null,
      gitStatus: "committed", error: null, archived: false, lockbox: false, pinned: false,
    }))
    const git = {
      branch: "main", shortCommit: "abc1234", hasRemote: false,
      status: "ready", error: null, ahead: 0, behind: 0,
    }
    const state = {
      vaultPath: "/tmp/shard-task-list-mock-vault", fragments, git,
      lockbox: { configured: false, unlocked: false, expiresAt: null, ttlSeconds: 900 },
    }
    const tree = {
      entries: [{ name: "任务回归.md", path: "notes/任务回归.md", kind: "markdown", size: 0, modifiedAt: now }],
      assets: [], trashEntries: [], fragmentTrashEntries: [],
      fragmentStream: { totalCount: 0, years: [] },
    }
    const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T
    const calls: TestCall[] = []
    let callbackId = 0
    Object.assign(globalThis, {
      isTauri: true,
      __SHARD_TASK_LIST_CALLS__: calls,
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener() {} },
      __TAURI_INTERNALS__: {
        metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
        transformCallback: () => ++callbackId,
        invoke: async (command: string, args: Record<string, unknown> = {}) => {
          calls.push({ command, args: clone(args) })
          switch (command) {
            case "plugin:event|listen": return ++callbackId
            case "plugin:event|unlisten":
            case "unhide_pointer":
            case "set_window_controls_hidden": return null
            case "plugin:app|version": return "0.1.3"
            case "list_fragments": return clone(state)
            case "list_csv_files":
            case "list_mind_maps": return []
            case "list_library_tree": return clone(tree)
            case "migrate_legacy_notes": return { tree: clone(tree), migratedCount: 0 }
            case "sync_vault": return clone(git)
            case "checkpoint_vault":
              return { status: "no_changes", changes: 0, reason: null, git: clone(git) }
            case "github_cli_status":
              return { installed: true, authenticated: true, login: "shard-test", protocol: "https", error: null }
            case "update_fragment": {
              const fragment = fragments.find((item) => item.id === args.id)
              if (!fragment) throw new Error("Fragment not found")
              fragment.content = String(args.content ?? fragment.content)
              fragment.updatedAt = new Date().toISOString()
              return clone(fragment)
            }
            default: throw new Error(`Unhandled Tauri test command: ${command}`)
          }
        },
      },
    })
  })
}

async function openSurface(page: Page, surface: Surface) {
  let id = "composer"
  if (surface === "inline" || surface === "zen") {
    await page.locator('[data-shard-fragment-id="task-fragment"]')
      .getByRole("button", { name: "片段操作", exact: true }).click()
    await page.getByRole("menuitem", { name: surface === "inline" ? "编辑" : "禅模式", exact: true }).click()
    id = `${surface === "inline" ? "fragment" : "zen"}:task-fragment`
  } else if (surface === "library") {
    await page.getByRole("button", { name: "资料库", exact: true }).click()
    await page.getByRole("complementary", { name: "资料库目录" })
      .getByRole("button", { name: /^文件（/ }).click()
    await page.getByRole("button", { name: "打开文件 任务回归.md", exact: true }).click()
    id = "library:task-note"
  }
  const editor = page.locator(`[data-shard-editor="${id}"]`)
  await expect(editor.locator(".ProseMirror")).toBeVisible()
  const toolbar = surface === "composer"
    ? page.locator(".shard-content-measure").filter({ has: editor })
    : surface === "zen"
      ? page.getByRole("region", { name: "禅模式", exact: true })
      : page.locator("article").filter({ has: editor })
  return { id, editor, toolbar }
}

interface TaskSelectors {
  checkbox: string
  marker: string
}

/** 碎片卡片的只读渲染（packages/markdown）。 */
const CARD_TASK: TaskSelectors = { checkbox: ".shard-task-checkbox", marker: ".shard-task-marker" }
/** 富文本编辑器任务项 NodeView（src/editor-rich/schema/task-item-view.tsx）。 */
const RICH_TASK: TaskSelectors = { checkbox: '[role="checkbox"]', marker: ".shard-rich-task-check" }

async function measureTaskGeometry(lineLocator: Locator, sample: string, selectors: TaskSelectors = CARD_TASK) {
  await lineLocator.evaluate(() => document.fonts.ready)
  return lineLocator.evaluate((line, { textSample, selectors }) => {
    const checkbox = line.querySelector<HTMLElement>(selectors.checkbox)!
    const box = checkbox.getBoundingClientRect()
    const marker = checkbox.closest(selectors.marker)!.getBoundingClientRect()
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT)
    let node: Node | null
    while ((node = walker.nextNode())) {
      // 复选框里的读屏名称不是正文。
      if (checkbox.contains(node)) continue
      const offset = node.textContent?.indexOf(textSample) ?? -1
      if (offset < 0) continue
      const range = document.createRange()
      range.setStart(node, offset)
      range.setEnd(node, offset + textSample.length)
      const text = range.getClientRects()[0]
      const style = getComputedStyle(checkbox)
      const textStyle = getComputedStyle(node.parentElement!)
      const context = document.createElement("canvas").getContext("2d")!
      context.font = `${textStyle.fontStyle} ${textStyle.fontWeight} ${textStyle.fontSize} ${textStyle.fontFamily}`
      const metrics = context.measureText(textSample)
      // A Range includes the font's ascender/descent space, not the visible ink.
      // A zero-sized inline block exposes this text row's actual baseline.
      const probe = document.createElement("span")
      probe.style.cssText = "display:inline-block;width:0;height:0;padding:0;margin:0;border:0;vertical-align:baseline;line-height:0"
      node.parentNode!.insertBefore(probe, node)
      let baselineY: number
      try {
        baselineY = probe.getBoundingClientRect().top
      } finally {
        probe.remove()
      }
      const inkCenterY = baselineY + (metrics.actualBoundingBoxDescent - metrics.actualBoundingBoxAscent) / 2
      range.selectNodeContents(node)
      return {
        width: box.width, height: box.height, x: box.x, y: box.y,
        textX: text.x, textY: text.y,
        gap: text.left - box.right,
        leadingGap: box.left - marker.left,
        centerOffset: Math.abs(inkCenterY - (box.y + box.height / 2)),
        inkCenterY,
        baselineY,
        textRows: range.getClientRects().length,
        lineHeight: parseFloat(textStyle.lineHeight),
        rowHeight: line.getBoundingClientRect().height,
        fontSize: parseFloat(textStyle.fontSize),
        radius: style.borderRadius,
      }
    }
    throw new Error("Task text has no rendered text range")
  }, { textSample: sample, selectors })
}

function taskRows(editor: Locator) {
  return editor.locator(".ProseMirror .shard-rich-task")
}

async function taskGeometry(editor: Locator, sample = "任务正文") {
  return measureTaskGeometry(taskRows(editor).first(), sample, RICH_TASK)
}

async function expectStableTaskGeometry(editor: Locator, baseline: Awaited<ReturnType<typeof taskGeometry>>) {
  const actual = await taskGeometry(editor)
  for (const key of ["width", "height", "x", "y", "textX", "textY"] as const) {
    expect(Math.abs(actual[key] - baseline[key]), `${key} must not shift when hovering/checking`).toBeLessThanOrEqual(0.25)
  }
  return actual
}

/** 复选框落在自己这一行的行盒里，上下都不越界。 */
async function expectTaskInsideLine(row: Locator) {
  const geometry = await row.evaluate((element) => {
    const checkbox = element.querySelector('[role="checkbox"]')!
    const box = checkbox.getBoundingClientRect()
    const bounds = element.getBoundingClientRect()
    return {
      top: box.top - bounds.top,
      bottom: bounds.bottom - box.bottom,
    }
  })
  expect(geometry.top, "checkbox must not escape above its text line").toBeGreaterThanOrEqual(0)
  expect(geometry.bottom, "checkbox must not escape below its text line").toBeGreaterThanOrEqual(0)
}

async function latestSavedContent(page: Page, id: string) {
  return page.evaluate((fragmentId) => {
    const calls = (globalThis as typeof globalThis & { __SHARD_TASK_LIST_CALLS__: TestCall[] }).__SHARD_TASK_LIST_CALLS__
    return calls.filter((call) => call.command === "update_fragment" && call.args.id === fragmentId).at(-1)?.args.content
  }, id)
}

/**
 * 把光标落在正文 `text` 的开头或结尾。
 *
 * 编辑器刚载入正文或刚获得焦点的一小段时间里，ProseMirror 会把自己的选区写回 DOM，
 * 覆盖刚设好的原生选区；落点后稍等再核对光标确实还在目标处，被覆盖就重放一次。
 */
async function placeCaret(page: Page, id: string, text: string, collapse: "start" | "end") {
  await focusEditor(page, id)
  await selectEditorText(page, id, text, { collapse })
}

test.beforeEach(async ({ page }) => {
  await installTaskListMock(page)
  await page.goto("/")
  await expect(page.locator('[data-shard-editor="composer"] .ProseMirror')).toBeFocused()
})

for (const surface of ["composer", "inline", "zen", "library"] as const) {
  test(`${surface} 空任务、输入、续行和删除使用同一 Markdown 渲染规则`, async ({ page }, testInfo) => {
    const { id, editor, toolbar } = await openSurface(page, surface)
    await fillEditor(page, id, "")
    await focusEditor(page, id)
    if (surface === "library") {
      // 资料库文档走同一套 Markdown 输入前缀。
      await typeEditor(page, id, "[ ] ")
    } else {
      // 其余编辑面走 `/任务` 命令：底部操作条不再放列表按钮。
      await typeEditor(page, id, "/任务")
      await expect(page.getByRole("listbox", { name: "命令菜单" }).getByRole("option")).toHaveCount(1)
      await page.keyboard.press("Enter")
    }
    // 空任务项行尾没有正文，规范化输出不带尾随空格。
    await expect.poll(() => readEditor(page, id)).toBe("- [ ]")
    await expect(editor.getByRole("checkbox", { name: "标记为完成" })).toBeVisible()
    await expect(editor.locator(".ProseMirror")).not.toContainText("-")
    await expect(editor.locator(".ProseMirror")).not.toContainText("[ ]")
    await expectTaskInsideLine(taskRows(editor).first())
    const emptyPath = testInfo.outputPath(`${surface}-empty-task.png`)
    await (surface === "library" ? editor : toolbar).screenshot({ path: emptyPath })
    await testInfo.attach(`${surface}-empty-task`, { path: emptyPath, contentType: "image/png" })

    await page.keyboard.insertText("任务正文")
    await expect.poll(() => readEditor(page, id)).toBe("- [ ] 任务正文")
    await expect(editor.locator(".ProseMirror .shard-rich-task-body")).toHaveText("任务正文")
    await page.keyboard.press("Enter")
    await expect.poll(() => readEditor(page, id)).toBe("- [ ] 任务正文\n- [ ]")
    await expect(editor.getByRole("checkbox")).toHaveCount(2)
    await expect(editor.locator(".ProseMirror")).not.toContainText("-")
    await expectTaskInsideLine(taskRows(editor).last())

    // 光标在任务正文开头退格：去掉任务标记，正文留成普通段落。
    await fillEditor(page, id, "- [ ] 任务正文")
    await placeCaret(page, id, "任务正文", "start")
    await page.keyboard.press("Backspace")
    await expect.poll(() => readEditor(page, id)).toBe("任务正文")
    await expect(editor.getByRole("checkbox")).toHaveCount(0)
  })

  test(`${surface} 任务复选框 hover、完成、撤销保持文字和控件几何`, async ({ page }, testInfo) => {
    const { id, editor } = await openSurface(page, surface)
    await fillEditor(page, id, "- [ ] 任务正文")
    const checkbox = editor.getByRole("checkbox")
    await expect(checkbox).toHaveAttribute("aria-checked", "false")
    await expect(editor.locator(".ProseMirror")).not.toContainText("-")
    await page.mouse.move(0, 0)
    const baseline = await taskGeometry(editor)
    expect(baseline.width).toBeCloseTo(baseline.height, 1)
    expect(baseline.gap).toBeGreaterThan(0)
    expect(baseline.gap).toBeLessThan(baseline.fontSize)
    expect(baseline.centerOffset, "checkbox centers on the visible Chinese glyphs").toBeLessThanOrEqual(0.75)
    const uncheckedPath = testInfo.outputPath(`${surface}-unchecked.png`)
    await editor.screenshot({ path: uncheckedPath })
    await testInfo.attach(`${surface}-unchecked`, { path: uncheckedPath, contentType: "image/png" })

    await checkbox.hover()
    const hovered = await expectStableTaskGeometry(editor, baseline)
    await checkbox.click()
    await expect.poll(() => readEditor(page, id)).toBe("- [x] 任务正文")
    await expect(checkbox).toHaveAttribute("aria-checked", "true")
    const checked = await expectStableTaskGeometry(editor, baseline)
    const checkedPath = testInfo.outputPath(`${surface}-checked.png`)
    await editor.screenshot({ path: checkedPath })
    await testInfo.attach(`${surface}-checked`, { path: checkedPath, contentType: "image/png" })

    await focusEditor(page, id)
    await page.keyboard.press("ControlOrMeta+z")
    await expect.poll(() => readEditor(page, id)).toBe("- [ ] 任务正文")
    await expect(checkbox).toHaveAttribute("aria-checked", "false")
    const undone = await expectStableTaskGeometry(editor, baseline)
    const geometryPath = testInfo.outputPath(`${surface}-geometry.json`)
    await writeFile(geometryPath, JSON.stringify({ baseline, hovered, checked, undone }, null, 2))
    await testInfo.attach(`${surface}-geometry`, { path: geometryPath, contentType: "application/json" })
  })

  test(`${surface} 复选框与数字和中文的可见字形垂直居中`, async ({ page }, testInfo) => {
    const { id, editor } = await openSurface(page, surface)
    for (const sample of ["111", "任务正文"]) {
      await fillEditor(page, id, `- [ ] ${sample}`)
      const geometry = await taskGeometry(editor, sample)
      expect(geometry.gap).toBeCloseTo(8, 1)
      expect(geometry.centerOffset, `${sample} checkbox and ink center`).toBeLessThanOrEqual(sample === "111" ? 0.5 : 0.75)
      expect(geometry.rowHeight, "checkbox must not enlarge the text line").toBeCloseTo(geometry.lineHeight, 1)
      await expect.poll(() => readEditor(page, id)).toBe(`- [ ] ${sample}`)
      if (sample === "111") {
        const path = testInfo.outputPath(`${surface}-digits-alignment.png`)
        await editor.screenshot({ path })
        await testInfo.attach(`${surface}-digits-alignment`, { path, contentType: "image/png" })
        const geometryPath = testInfo.outputPath(`${surface}-digits-geometry.json`)
        await writeFile(geometryPath, JSON.stringify(geometry, null, 2))
        await testInfo.attach(`${surface}-digits-geometry`, { path: geometryPath, contentType: "application/json" })
      }
    }
  })
}

test("字号和行高变化、长任务换行后复选框仍与首行字形居中", async ({ page }) => {
  const { id, editor } = await openSurface(page, "composer")
  await editor.evaluate((element) => {
    element.style.setProperty("--shard-editor-font-size", "20px")
    element.style.setProperty("--shard-editor-line-height", "2.2")
    element.style.width = "260px"
  })
  for (const sample of ["111", "任务正文"]) {
    const body = sample + "这是一段需要换行的任务正文，确保复选框对齐首行文字。".repeat(4)
    await fillEditor(page, id, `- [ ] ${body}`)
    const geometry = await taskGeometry(editor, sample)
    expect(geometry.fontSize).toBe(20)
    expect(geometry.lineHeight).toBe(44)
    expect(geometry.textRows, "long task must really wrap").toBeGreaterThan(1)
    expect(geometry.centerOffset, `${sample} stays aligned to the first line`).toBeLessThanOrEqual(sample === "111" ? 0.5 : 0.75)
    await expectTaskInsideLine(taskRows(editor).first())
    await expect.poll(() => readEditor(page, id)).toBe(`- [ ] ${body}`)
  }
})

test("碎片切入禅模式、文档切入禅模式并保存读回仍使用同一任务渲染", async ({ page }) => {
  const inline = await openSurface(page, "inline")
  await fillEditor(page, inline.id, "- [ ] 任务正文")
  await inline.toolbar.getByRole("button", { name: "保存修改", exact: true }).click()
  await expect.poll(() => latestSavedContent(page, "task-fragment")).toBe("- [ ] 任务正文")
  // 保存修改即落盘并收起行内编辑，回到碎片卡片（fragment-editor handleSubmit）。
  await expect(inline.editor).toBeHidden()
  const cardBody = page.locator('[data-shard-fragment-id="task-fragment"] .shard-fragment-content')
  const cardUnchecked = await measureTaskGeometry(cardBody, "任务正文")
  expect(cardUnchecked.leadingGap).toBeCloseTo(8, 1)
  expect(cardUnchecked.gap).toBeCloseTo(8, 1)
  expect(cardUnchecked.centerOffset, "saved card uses the same glyph alignment").toBeLessThanOrEqual(0.75)
  const zen = await openSurface(page, "zen")
  await expect.poll(() => readEditor(page, zen.id)).toBe("- [ ] 任务正文")
  await expect(zen.editor.locator(".ProseMirror")).not.toContainText("-")
  await zen.editor.getByRole("checkbox").click()
  await page.getByRole("button", { name: "退出编辑", exact: true }).click()
  await expect.poll(() => latestSavedContent(page, "task-fragment")).toBe("- [x] 任务正文")
  await expect(page.locator('[data-shard-fragment-id="task-fragment"]')
    .getByRole("button", { name: "标记为未完成", exact: true })).toHaveAttribute("aria-pressed", "true")
  const cardChecked = await measureTaskGeometry(cardBody, "任务正文")
  expect(cardChecked.centerOffset, "checked card keeps the same glyph alignment").toBeLessThanOrEqual(0.75)
  expect(cardChecked.width).toBe(cardUnchecked.width)
  expect(cardChecked.height).toBe(cardUnchecked.height)

  const library = await openSurface(page, "library")
  await fillEditor(page, library.id, "- [ ] 任务正文")
  await page.getByRole("button", { name: "进入禅模式", exact: true }).click()
  const zenDocument = page.getByRole("region", { name: "资料库文档禅模式", exact: true })
  await expect(zenDocument).toBeVisible()
  await expect(library.editor.locator(".ProseMirror")).not.toContainText("-")
  await library.editor.getByRole("checkbox").click()
  await focusEditor(page, library.id)
  await page.keyboard.press("ControlOrMeta+s")
  await expect.poll(() => latestSavedContent(page, "task-note")).toBe("- [x] 任务正文")
  await page.keyboard.press("Escape")
  await expect(zenDocument).toHaveCount(0)
  await page.getByRole("button", { name: "碎片", exact: true }).click()
  const reopened = await openSurface(page, "library")
  await expect.poll(() => readEditor(page, reopened.id)).toBe("- [x] 任务正文")
  await expect(reopened.editor.getByRole("checkbox")).toHaveAttribute("aria-checked", "true")
  await expect(reopened.editor.locator(".ProseMirror")).not.toContainText("-")
})

test("引用、嵌套任务及前方插行后点击准确写回", async ({ page }) => {
  const { id, editor } = await openSurface(page, "composer")
  let markdown = "- [ ] 根任务\n  - [ ] 子任务\n\n> - [ ] 引用任务"
  await fillEditor(page, id, markdown)
  await expect(editor.getByRole("checkbox")).toHaveCount(3)
  await expect(editor.locator(".ProseMirror blockquote").getByRole("checkbox")).toHaveCount(1)
  await expect(editor.locator(".ProseMirror")).not.toContainText("[ ]")
  await expect(editor.locator(".ProseMirror")).not.toContainText(">")
  await editor.getByRole("checkbox").nth(2).click()
  markdown = markdown.replace("> - [ ]", "> - [x]")
  await expect.poll(() => readEditor(page, id)).toBe(markdown)

  // 在最前面插一段正文：根任务开头回车留出空任务项，退格把它变回普通段落。
  await placeCaret(page, id, "根任务", "start")
  const firstItemStart = (await readEditorSnapshot(page, id)).selectionStart
  await page.keyboard.press("Enter")
  await expect(editor.getByRole("checkbox")).toHaveCount(4)
  // 新的空任务项占住了第一项的位置：光标上移回到这个位置，才算进了空项。
  await page.keyboard.press("ArrowUp")
  await expect.poll(() => readEditorSnapshot(page, id).then((state) => state.selectionStart)).toBe(firstItemStart)
  await page.keyboard.press("Backspace")
  await page.keyboard.insertText("前方新增正文")
  markdown = "前方新增正文\n\n" + markdown
  await expect.poll(() => readEditor(page, id)).toBe(markdown)
  await editor.getByRole("checkbox").nth(1).click()
  markdown = markdown.replace("  - [ ]", "  - [x]")
  await expect.poll(() => readEditor(page, id)).toBe(markdown)
  await expect(editor.getByRole("checkbox").first()).toHaveAttribute("aria-checked", "false")
})

/**
 * 光标所在段落的有序列表嵌套深度与文字：0 表示已经不在列表里。
 * 富文本选区坐标不是 Markdown 下标，按「光标落在哪一层的哪一项」判定位置。
 */
async function caretInList(editor: Locator) {
  return editor.locator(".ProseMirror").evaluate((root) => {
    const anchor = window.getSelection()?.anchorNode ?? null
    const element = anchor instanceof Element ? anchor : anchor?.parentElement ?? null
    const block = element?.closest("p")
    if (!block || !root.contains(block)) return null
    let depth = 0
    for (let node: Element | null = block; node && node !== root; node = node.parentElement) {
      if (node.tagName === "OL") depth += 1
    }
    return { depth, text: block.textContent ?? "" }
  })
}

async function expectListDocument(
  page: Page,
  id: string,
  editor: Locator,
  value: string,
  caret: { depth: number; text: string }
) {
  await expect.poll(() => readEditor(page, id)).toBe(value)
  await expect(editor.locator(".ProseMirror")).toBeFocused()
  await expect.poll(() => caretInList(editor)).toEqual(caret)
}

// Shard 方言的有序列表只有数字序号（技术方案 §3），`a.` 字母序号不是列表语法。
for (const surface of ["composer", "inline", "zen", "library"] as const) {
  test(`${surface} 1. 子项 Enter 续行后 Shift+Tab 创建父层下一项`, async ({ page }) => {
    const { id, editor } = await openSurface(page, surface)
    const initial = "1. 父项\n   1. 子项甲\n   2. 子项乙\n   3. 子项丙"
    await fillEditor(page, id, initial)
    await placeCaret(page, id, "子项丙", "end")

    await page.keyboard.press("Enter")
    // 空列表项行尾没有正文，规范化输出不带尾随空格。
    await expectListDocument(page, id, editor, `${initial}\n   4.`, { depth: 2, text: "" })

    await page.keyboard.press("Shift+Tab")
    const promoted = `${initial}\n2.`
    await expectListDocument(page, id, editor, promoted, { depth: 1, text: "" })
    await page.keyboard.insertText("父层第二项")
    await expectListDocument(page, id, editor, `${promoted} 父层第二项`, { depth: 1, text: "父层第二项" })
  })

  for (const key of ["Enter", "Shift+Tab"] as const) {
    test(`${surface} 空子项 ${key} 提升到父层 2. 并可撤销`, async ({ page }) => {
      const { id, editor } = await openSurface(page, surface)
      const prefix = "1. 父项\n   1. 子项甲\n   2. 子项乙"
      const initial = `${prefix}\n   3.`
      await fillEditor(page, id, `${initial} `)
      await expect.poll(() => readEditor(page, id)).toBe(initial)
      // 光标落进空的第 3 个子项：从子项乙行尾往下一行。
      await placeCaret(page, id, "子项乙", "end")
      await page.keyboard.press("ArrowDown")
      await expect.poll(() => caretInList(editor)).toEqual({ depth: 2, text: "" })

      await page.keyboard.press(key)
      await expectListDocument(page, id, editor, `${prefix}\n2.`, { depth: 1, text: "" })
      await page.keyboard.press("ControlOrMeta+z")
      await expectListDocument(page, id, editor, initial, { depth: 2, text: "" })
    })
  }

  test(`${surface} 多级空列表 Enter 逐级返回后退出顶层，撤销恢复列表`, async ({ page }) => {
    const { id, editor } = await openSurface(page, surface)
    const prefix = "1. 父项\n   1. 子项"
    const initial = `${prefix}\n      1.`
    await fillEditor(page, id, `${initial} `)
    await expect.poll(() => readEditor(page, id)).toBe(initial)
    await placeCaret(page, id, "子项", "end")
    await page.keyboard.press("ArrowDown")
    await expect.poll(() => caretInList(editor)).toEqual({ depth: 3, text: "" })

    await page.keyboard.press("Enter")
    await expectListDocument(page, id, editor, `${prefix}\n   2.`, { depth: 2, text: "" })
    await page.keyboard.press("Enter")
    await expectListDocument(page, id, editor, `${prefix}\n2.`, { depth: 1, text: "" })
    // prosemirror-history 把 500ms 内的相邻改动并成一次撤销；拉开分组，
    // 让「退出顶层」单独成为一步，撤销只退回这一步。
    await page.waitForTimeout(600)
    await page.keyboard.press("Enter")
    // 退出顶层列表：光标落在列表后的空段落里，空段落不写进文件。
    await expectListDocument(page, id, editor, prefix, { depth: 0, text: "" })
    await page.keyboard.press("ControlOrMeta+z")
    await expectListDocument(page, id, editor, `${prefix}\n2.`, { depth: 1, text: "" })
  })
}
