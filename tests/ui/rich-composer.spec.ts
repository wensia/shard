import { expect, test, type Page } from "@playwright/test"

import {
  fillEditor,
  focusEditor,
  readEditor,
  readEditorSnapshot,
  selectionToolbar,
  typeEditor,
} from "./editor-helpers"
import { installSearchIpcMock } from "./search-ipc-mock"

interface TestCall {
  command: string
  args: Record<string, unknown>
}

const COMPOSER = '[data-shard-editor="composer"]'
const PLACEHOLDER = "想到什么，写什么..."

// Exercise the real workbench route with an in-memory vault; no user's files are written.
async function installRichComposerMock(page: Page) {
  await installSearchIpcMock(page)
  await page.addInitScript(() => {
    const now = "2026-09-10T08:00:00.000Z"
    const fragments = [
      { id: "rich-fragment", path: "fragments/rich-fragment.md", content: "待编辑碎片 #灵感", tags: ["inbox", "灵感"] },
    ].map((fragment) => ({
      ...fragment, createdAt: now, updatedAt: now, category: null,
      gitStatus: "committed", error: null, archived: false, lockbox: false, pinned: false,
    }))
    const git = {
      branch: "main", shortCommit: "abc1234", hasRemote: false,
      status: "ready", error: null, ahead: 0, behind: 0,
    }
    const state = {
      vaultPath: "/tmp/shard-rich-composer-mock-vault", fragments, git,
      lockbox: { configured: false, unlocked: false, expiresAt: null, ttlSeconds: 900 },
    }
    const tree = {
      entries: [], assets: [], trashEntries: [], fragmentTrashEntries: [],
      fragmentStream: { totalCount: 0, years: [] },
    }
    const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T
    const calls: TestCall[] = []
    let callbackId = 0
    let createdCount = 0
    Object.assign(globalThis, {
      isTauri: true,
      __SHARD_RICH_CALLS__: calls,
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
            case "create_fragment": {
              const id = `rich-created-${++createdCount}`
              const created = {
                id, path: `fragments/2026/09/${id}.md`, content: String(args.content ?? ""),
                tags: (args.tags as string[]) ?? [], createdAt: now, updatedAt: now,
                category: null, gitStatus: "saved", error: null,
                archived: false, lockbox: false, pinned: false, related: [],
              }
              fragments.unshift(created)
              return clone(created)
            }
            case "update_fragment": {
              const fragment = fragments.find((item) => item.id === args.id)
              if (!fragment) throw new Error("Fragment not found")
              fragment.content = String(args.content ?? fragment.content)
              return clone(fragment)
            }
            default: throw new Error(`Unhandled Tauri test command: ${command}`)
          }
        },
      },
    })
  })
}

function composer(page: Page) {
  return page.locator(COMPOSER)
}

function proseMirror(page: Page) {
  return page.locator(`${COMPOSER} .ProseMirror`)
}

function commandMenu(page: Page) {
  return page.getByRole("listbox", { name: "命令菜单" })
}

function tagMenu(page: Page) {
  return page.getByRole("listbox", { name: "标签建议" })
}

async function createdContents(page: Page) {
  return page.evaluate(() => {
    const calls = (globalThis as typeof globalThis & { __SHARD_RICH_CALLS__: TestCall[] })
      .__SHARD_RICH_CALLS__
    return calls
      .filter((call) => call.command === "create_fragment")
      .map((call) => String(call.args.content ?? ""))
  })
}

async function submitComposer(page: Page) {
  await focusEditor(page, "composer")
  await page.keyboard.press("ControlOrMeta+Enter")
}

test.describe("速记框富文本", () => {
  test.beforeEach(async ({ page }) => {
    await installRichComposerMock(page)
    await page.goto("/")
    await expect(proseMirror(page)).toBeFocused()
  })

  test("空草稿显示占位符，且编辑区是富文本而不是 CodeMirror", async ({ page }) => {
    await expect(page.locator(`${COMPOSER} .cm-content`)).toHaveCount(0)
    const emptyParagraph = proseMirror(page).locator("p.is-editor-empty").first()
    await expect(emptyParagraph).toHaveAttribute("data-placeholder", PLACEHOLDER)
    await expect(proseMirror(page)).toHaveAttribute("aria-label", "快速记录")

    // 占位符是 ::before 生成内容，验证它真的有可见宽度。
    const width = await emptyParagraph.evaluate((element) => {
      const before = window.getComputedStyle(element, "::before")
      return { content: before.content, width: before.width }
    })
    expect(width.content).toContain("想到什么")
    expect(Number.parseFloat(width.width)).toBeGreaterThan(0)
  })

  test("两段正文与行内加粗提交为规范 Markdown，编辑区看不到星号", async ({ page }) => {
    await typeEditor(page, "composer", "第一段")
    await page.keyboard.press("Enter")
    await typeEditor(page, "composer", "**加粗**结尾")

    await expect.poll(() => readEditor(page, "composer")).toBe("第一段\n\n**加粗**结尾")
    await expect(proseMirror(page).locator("strong")).toHaveText("加粗")
    await expect(proseMirror(page)).not.toContainText("**")

    await submitComposer(page)
    await expect.poll(() => createdContents(page)).toEqual(["第一段\n\n**加粗**结尾"])
    // 提交后草稿清空，占位符回来。
    await expect(proseMirror(page).locator("p.is-editor-empty")).toHaveCount(1)
  })

  test("输入 `- ` 前缀转成列表，提交写回 `- 项`", async ({ page }) => {
    await typeEditor(page, "composer", "- 项")

    await expect(proseMirror(page).locator("ul > li")).toHaveCount(1)
    await expect(proseMirror(page)).not.toContainText("- ")
    await expect.poll(() => readEditor(page, "composer")).toBe("- 项")

    await submitComposer(page)
    await expect.poll(() => createdContents(page)).toEqual(["- 项"])
  })

  test("选区浮动条粗体作用于选区，提交内容含星号", async ({ page }) => {
    // 没有选区时不出现浮动条。
    await typeEditor(page, "composer", "加粗文本")
    await expect(selectionToolbar(page)).toHaveCount(0)
    await page.keyboard.press("ControlOrMeta+a")
    await selectionToolbar(page).getByRole("button", { name: "粗体", exact: true }).click()
    await expect(
      selectionToolbar(page).getByRole("button", { name: "粗体", exact: true })
    ).toHaveAttribute("aria-pressed", "true")

    await expect.poll(() => readEditor(page, "composer")).toBe("**加粗文本**")
    await expect(proseMirror(page).locator("strong")).toHaveText("加粗文本")

    await submitComposer(page)
    const contents = await createdContents(page)
    expect(contents).toEqual(["**加粗文本**"])
    expect(contents[0]).toContain("**")
  })

  test("井号弹出标签建议，选中后写回带可见空格的标签", async ({ page }) => {
    await typeEditor(page, "composer", "记一笔 #灵")

    const menu = tagMenu(page)
    await expect(menu).toBeVisible()
    await expect(menu.getByRole("option").first()).toContainText("灵感")
    await expect(menu.getByRole("option").first()).toContainText("使用")
    await expect(menu.getByRole("option").first()).toHaveAttribute("aria-selected", "true")

    await page.keyboard.press("Enter")
    await expect(menu).toHaveCount(0)
    await typeEditor(page, "composer", "继续")

    await expect(proseMirror(page).locator(".shard-rich-tag")).toHaveText("#灵感")
    await expect.poll(() => readEditor(page, "composer")).toBe("记一笔 #灵感 继续")
    // 标签只着色不画芯片：没有背景块，前后空格才留得住。
    const tagStyle = await proseMirror(page).locator(".shard-rich-tag").evaluate((element) => {
      const style = window.getComputedStyle(element)
      return {
        background: style.backgroundColor,
        paddingLeft: style.paddingLeft,
        marginLeft: style.marginLeft,
      }
    })
    expect(tagStyle.background).toBe("rgba(0, 0, 0, 0)")
    expect(tagStyle.paddingLeft).toBe("0px")
    expect(tagStyle.marginLeft).toBe("0px")

    await submitComposer(page)
    await expect.poll(() => createdContents(page)).toEqual(["记一笔 #灵感 继续"])
  })

  test("中文标签支持全拼与混拼检索", async ({ page }) => {
    await typeEditor(page, "composer", "#linggan")

    const menu = tagMenu(page)
    await expect(menu.getByRole("option").first()).toContainText("灵感")
    await expect(menu.getByRole("option").first()).toContainText("使用")

    await page.keyboard.press("Enter")
    await expect(menu).toHaveCount(0)
    await expect(proseMirror(page).locator(".shard-rich-tag")).toHaveText("#灵感")

    await typeEditor(page, "composer", "#lgan")
    await expect(tagMenu(page).getByRole("option").first()).toContainText("灵感")
  })

  test("Backspace 在标签后整体删除标签节点", async ({ page }) => {
    await typeEditor(page, "composer", "#灵")
    await page.keyboard.press("Enter")
    await expect.poll(() => readEditor(page, "composer")).toBe("#灵感")

    // 先删掉标签后面的空格，再删标签本身。
    await page.keyboard.press("Backspace")
    await page.keyboard.press("Backspace")
    await expect(proseMirror(page).locator(".shard-rich-tag")).toHaveCount(0)
    await expect.poll(() => readEditor(page, "composer")).toBe("")
  })

  test("斜杠弹出十二项命令菜单，可过滤、应用与 Esc 关闭", async ({ page }) => {
    await typeEditor(page, "composer", "/")

    const menu = commandMenu(page)
    await expect(menu).toBeVisible()
    // 围栏块（导图块、数据表）排在前面，行格式与内容类型命令跟在后面。
    await expect(menu.getByRole("option")).toHaveCount(12)
    await expect(menu).toContainText("文档")
    await expect(menu.getByRole("option").first()).toContainText("导图块")
    await expect(menu).toContainText("数据表")
    await expect(menu).toContainText("表格")

    await typeEditor(page, "composer", "rw")
    await expect(menu.getByRole("option")).toHaveCount(1)
    await expect(menu.getByRole("option")).toContainText("任务列表")

    await page.keyboard.press("Escape")
    await expect(menu).toHaveCount(0)
    await expect(proseMirror(page)).toBeFocused()
    await expect.poll(() => readEditor(page, "composer")).toBe("/rw")

    await fillEditor(page, "composer", "")
    await focusEditor(page, "composer")
    await typeEditor(page, "composer", "/rw")
    await expect(commandMenu(page).getByRole("option")).toHaveCount(1)
    await page.keyboard.press("Enter")

    await expect(commandMenu(page)).toHaveCount(0)
    await expect(proseMirror(page).getByRole("checkbox")).toHaveCount(1)
    await expect.poll(() => readEditor(page, "composer")).toBe("- [ ]")
  })

  test("命令菜单用上下键移动时当前项始终滚在可视区里", async ({ page }) => {
    await typeEditor(page, "composer", "/")
    const menu = commandMenu(page)
    const options = menu.getByRole("option")
    await expect(options).toHaveCount(12)

    // 列表高度装不下十二项：一路按到最后一项，它必须完整露出来。
    for (let index = 1; index < 12; index += 1) await page.keyboard.press("ArrowDown")
    await expect(options.last()).toHaveAttribute("aria-selected", "true")
    await expect(options.last()).toBeInViewport({ ratio: 1 })
    expect(await menu.evaluate((list) => list.scrollTop)).toBeGreaterThan(0)

    for (let index = 1; index < 12; index += 1) await page.keyboard.press("ArrowUp")
    await expect(options.first()).toHaveAttribute("aria-selected", "true")
    await expect.poll(() => menu.evaluate((list) => list.scrollTop)).toBe(0)
  })

  test("组合输入期间不弹命令菜单，且不重建正文节点", async ({ page }) => {
    await typeEditor(page, "composer", "/")
    await expect(commandMenu(page)).toBeVisible()

    // 不能往 ProseMirror 管辖的节点上写属性探针：DOMObserver 会把它当成外部改动
    // 直接重渲染。改成在 window 上留一份元素引用，比较前后是不是同一个 DOM 节点。
    await page.evaluate((selector) => {
      const probe = window as typeof window & { __shardImeProbe?: Element | null }
      probe.__shardImeProbe = document.querySelector(`${selector} .ProseMirror p`)
    }, COMPOSER)

    const session = await page.context().newCDPSession(page)
    try {
      await session.send("Input.imeSetComposition", {
        selectionEnd: 2,
        selectionStart: 2,
        text: "rw",
      })
      await expect(commandMenu(page)).toHaveCount(0)
      expect((await readEditorSnapshot(page, "composer")).composing).toBe(true)
      // 组合期间 ProseMirror 不能重建节点，否则输入法会被打断。
      const sameNode = await page.evaluate((selector) => {
        const probe = window as typeof window & { __shardImeProbe?: Element | null }
        return probe.__shardImeProbe === document.querySelector(`${selector} .ProseMirror p`)
      }, COMPOSER)
      expect(sameNode).toBe(true)

      await session.send("Input.insertText", { text: "rw" })
      await expect.poll(() => readEditor(page, "composer")).toBe("/rw")
      await expect(commandMenu(page).getByRole("option")).toHaveCount(1)
      await expect(commandMenu(page).getByRole("option")).toContainText("任务列表")
    } finally {
      await session.detach()
    }
  })

  test("输入五行后速记框高度增长", async ({ page }) => {
    const box = async () => (await composer(page).boundingBox())!.height
    const baseline = await box()

    await fillEditor(page, "composer", ["一", "二", "三", "四", "五"].join("\n\n"))
    await expect(proseMirror(page).locator("p")).toHaveCount(5)
    await expect.poll(box).toBeGreaterThan(baseline)
  })

  // 以下两条来自 tests/ui/slash-commands.spec.ts 的 composer 面，改用富文本桥验证行为一致。
  test("composer 输入斜杠弹出命令菜单并写回选中的命令", async ({ page }) => {
    await fillEditor(page, "composer", "")
    await focusEditor(page, "composer")
    await typeEditor(page, "composer", "/")

    const menu = commandMenu(page)
    await expect(menu).toBeVisible()
    await expect(menu.getByRole("option").first()).toContainText("导图块")

    // 导图块 → 数据表 → 任务列表 → 无序列表
    await page.keyboard.press("ArrowDown")
    await page.keyboard.press("ArrowDown")
    await page.keyboard.press("ArrowDown")
    await expect(menu.getByRole("option").nth(3)).toHaveAttribute("aria-selected", "true")
    await page.keyboard.press("Enter")
    await expect.poll(() => readEditor(page, "composer")).toBe("-")
    await expect(menu).toHaveCount(0)
  })

  test("标签命令写下井号并立刻交给标签建议", async ({ page }) => {
    await fillEditor(page, "composer", "")
    await focusEditor(page, "composer")
    await typeEditor(page, "composer", "/标签")
    await expect(commandMenu(page).getByRole("option")).toHaveCount(1)
    await page.keyboard.press("Enter")

    await expect(tagMenu(page)).toBeVisible()
    await expect(commandMenu(page)).toHaveCount(0)

    await page.keyboard.press("Enter")
    await typeEditor(page, "composer", "正文")
    await expect.poll(() => readEditor(page, "composer")).toMatch(/^#\S+ 正文$/u)
  })

  // 以下两条来自 tests/ui/editor-task-list.spec.ts 的 composer 面。
  test("composer 空任务、输入与续行使用同一 Markdown 规则", async ({ page }) => {
    await fillEditor(page, "composer", "")
    await focusEditor(page, "composer")
    await typeEditor(page, "composer", "/任务")
    await expect(commandMenu(page).getByRole("option")).toHaveCount(1)
    await page.keyboard.press("Enter")

    await expect.poll(() => readEditor(page, "composer")).toBe("- [ ]")
    await expect(proseMirror(page).getByRole("checkbox", { name: "标记为完成" })).toHaveCount(1)
    await expect(proseMirror(page).locator("li > div").first()).toBeEmpty()

    await typeEditor(page, "composer", "任务正文")
    await expect.poll(() => readEditor(page, "composer")).toBe("- [ ] 任务正文")
    // li > div 是任务项正文；label 里还有一个视觉隐藏的读屏名称。
    await expect(proseMirror(page).locator("li > div").first()).toHaveText("任务正文")

    await page.keyboard.press("Enter")
    await expect.poll(() => readEditor(page, "composer")).toBe("- [ ] 任务正文\n- [ ]")
    await expect(proseMirror(page).getByRole("checkbox")).toHaveCount(2)
  })

  test("composer 勾选任务写回 [x]，卡片提交内容一致", async ({ page }) => {
    await fillEditor(page, "composer", "- [ ] 任务正文")
    const checkbox = proseMirror(page).getByRole("checkbox")
    await expect(checkbox).toHaveCount(1)
    await expect(checkbox).not.toBeChecked()

    await checkbox.click()
    await expect.poll(() => readEditor(page, "composer")).toBe("- [x] 任务正文")

    await submitComposer(page)
    await expect.poll(() => createdContents(page)).toEqual(["- [x] 任务正文"])
  })
})

// D2b 起 CodeMirror 与迁移开关一并删除：旧的回退键 `shard.richEditor = "0"` 不再生效。
test("旧的回退开关不再生效，速记框始终是富文本编辑器", async ({ page }) => {
  await installRichComposerMock(page)
  await page.addInitScript(() => {
    try {
      localStorage.setItem("shard.richEditor", "0")
    } catch {
      // 写不进去也不影响断言：本来就应该是富文本。
    }
  })
  await page.goto("/")

  await expect(page.locator(`${COMPOSER} .ProseMirror`)).toBeVisible()
  await expect(page.locator(`${COMPOSER} .cm-content`)).toHaveCount(0)
  await fillEditor(page, "composer", "默认即富文本")
  await expect.poll(() => readEditor(page, "composer")).toBe("默认即富文本")
})
