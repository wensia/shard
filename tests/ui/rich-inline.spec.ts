import { expect, test, type Page } from "@playwright/test"

import {
  fillEditor,
  focusEditor,
  readEditor,
  readEditorSnapshot,
  selectDocRange,
  typeEditor,
} from "./editor-helpers"
import { installSearchIpcMock } from "./search-ipc-mock"

interface TestCall {
  command: string
  args: Record<string, unknown>
}

const COMPOSER = '[data-shard-editor="composer"]'
// 载入正文里的 `\#` / `\[\[` 是转换层解析出来的字面文本，不是用户手打的语法。
const LITERAL_BODY = "字面 \\#不是标签 与 \\[\\[也不是双链]]"
const LITERAL_NEIGHBOUR_BODY = "字面 \\#不是标签，还有 \\[\\[也不是双链]]"
// setTextSelection 会把越界位置夹到文档末尾，不必手算偏移。
const DOC_END = 9999
const IMAGE_PATH = "attachments/diagram.png"
const IMAGE_BODY = `正文\n\n![示意图](${IMAGE_PATH})`
// 1×1 透明 PNG：图片节点走真实加载链路，断言不依赖网络。
const IMAGE_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="

/**
 * 跑真实工作台路由 + 内存 vault；不写用户的任何文件。
 *
 * 比 rich-composer 的 mock 多三件东西：可导航的碎片、导图与 CSV 候选（`[[`
 * 建议要区分类别），以及 `read_fragment_image`（图片节点在 Tauri 环境下走
 * 这条命令取地址）。
 */
async function installRichInlineMock(page: Page) {
  await installSearchIpcMock(page)
  await page.addInitScript((imageDataUrl: string) => {
    const now = "2026-09-10T08:00:00.000Z"
    const fragments = [
      { id: "rich-fragment", path: "fragments/rich-fragment.md", content: "待编辑碎片 #灵感", tags: ["inbox", "灵感"] },
      { id: "fragment-target", path: "fragments/fragment-target.md", content: "可定位的碎片摘要", tags: ["inbox"] },
    ].map((fragment) => ({
      ...fragment, createdAt: now, updatedAt: now, category: null,
      gitStatus: "committed", error: null, archived: false, lockbox: false,
      pinned: false, related: [],
    }))
    const git = {
      branch: "main", shortCommit: "abc1234", hasRemote: false,
      status: "ready", error: null, ahead: 0, behind: 0,
    }
    const state = {
      vaultPath: "/tmp/shard-rich-inline-mock-vault", fragments, git,
      lockbox: { configured: false, unlocked: false, expiresAt: null, ttlSeconds: 900 },
    }
    const tree = {
      entries: [], assets: [], trashEntries: [], fragmentTrashEntries: [],
      fragmentStream: { totalCount: fragments.length, years: [] },
    }
    const mindMaps = [
      { id: "map-quarter", title: "季度规划", path: "maps/季度规划.md", nodeCount: 3, createdAt: now, updatedAt: now },
    ]
    const csvFiles = [{ name: "small.csv", path: "data/small.csv" }]
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
            case "list_mind_maps": return clone(mindMaps)
            case "list_csv_files": return clone(csvFiles)
            case "open_csv_file": return null
            case "read_fragment_image": return imageDataUrl
            case "list_library_tree": return clone(tree)
            case "migrate_legacy_notes": return { tree: clone(tree), migratedCount: 0 }
            case "sync_vault": return clone(git)
            case "checkpoint_vault":
              return { status: "no_changes", changes: 0, reason: null, git: clone(git) }
            case "github_cli_status":
              return { installed: true, authenticated: true, login: "shard-test", protocol: "https", error: null }
            case "create_fragment": {
              const id = `rich-inline-created-${++createdCount}`
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
  }, IMAGE_DATA_URL)
}

function proseMirror(page: Page) {
  return page.locator(`${COMPOSER} .ProseMirror`)
}

function wikilinkMenu(page: Page) {
  return page.getByRole("listbox", { name: "双链建议" })
}

function commandMenu(page: Page) {
  return page.getByRole("listbox", { name: "命令菜单" })
}

function tagMenu(page: Page) {
  return page.getByRole("listbox", { name: "标签建议" })
}

function chips(page: Page) {
  return proseMirror(page).locator(".shard-rich-wikilink")
}

function tags(page: Page) {
  return proseMirror(page).locator(".shard-rich-tag")
}

function memoCard(page: Page) {
  return proseMirror(page).locator('[data-shard-memo-card="true"]')
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

async function resetComposer(page: Page) {
  await fillEditor(page, "composer", "")
  await focusEditor(page, "composer")
}

async function submitComposer(page: Page) {
  await focusEditor(page, "composer")
  // 失焦后重新聚焦是 rAF 里完成的，等焦点真的回到编辑器再按键。
  await expect(proseMirror(page)).toBeFocused()
  await page.keyboard.press("ControlOrMeta+Enter")
}

async function blurComposer(page: Page) {
  await proseMirror(page).evaluate((element) => element.blur())
}

test.describe("富文本行内与附件组件", () => {
  test.beforeEach(async ({ page }) => {
    await installRichInlineMock(page)
    await page.goto("/")
    await expect(proseMirror(page)).toBeFocused()
  })

  test("双左括号弹出双链建议，选中后写成芯片并提交为 [[目标]]", async ({ page }) => {
    await resetComposer(page)
    await typeEditor(page, "composer", "[[")

    const menu = wikilinkMenu(page)
    await expect(menu).toBeVisible()
    // detail 区分碎片 / 笔记 / 导图 / CSV。
    await expect(menu).toContainText("碎片")
    await expect(menu).toContainText("思维导图")
    await expect(menu).toContainText("CSV")

    await typeEditor(page, "composer", "季度")
    await expect(menu.getByRole("option")).toHaveCount(1)
    await expect(menu.getByRole("option")).toContainText("季度规划")
    await expect(menu.getByRole("option")).toContainText("思维导图")

    await page.keyboard.press("Enter")
    await expect(menu).toHaveCount(0)
    await expect(chips(page)).toHaveText("季度规划")
    await expect(chips(page)).not.toHaveClass(/shard-rich-wikilink--missing/u)
    // 编辑区里看不到方括号。
    await expect(proseMirror(page)).not.toContainText("[[")
    await expect.poll(() => readEditor(page, "composer")).toBe("[[季度规划]]")

    await submitComposer(page)
    await expect.poll(() => createdContents(page)).toEqual(["[[季度规划]]"])
  })

  test("断链芯片用待建样式，点击只提示且正文不动", async ({ page }) => {
    await fillEditor(page, "composer", "[[尚未创建]]")

    const chip = chips(page)
    await expect(chip).toHaveClass(/shard-rich-wikilink--missing/u)
    const decoration = await chip.evaluate((element) => {
      const style = window.getComputedStyle(element)
      return { style: style.textDecorationStyle, line: style.textDecorationLine }
    })
    expect(decoration).toEqual({ line: "underline", style: "dotted" })

    await chip.click()
    await expect(page.getByText(/待建链接「尚未创建」尚不存在/u)).toBeVisible()
    await expect.poll(() => readEditor(page, "composer")).toBe("[[尚未创建]]")
  })

  test("点击芯片复用宿主的碎片导航", async ({ page }) => {
    await fillEditor(page, "composer", "[[fragment-target]]")
    await expect(chips(page)).not.toHaveClass(/shard-rich-wikilink--missing/u)

    const documentScrollBefore = await page.evaluate(() => window.scrollY)
    await chips(page).click()

    await expect(
      page.locator('[data-shard-fragment-id="fragment-target"]')
    ).toHaveClass(/shard-fragment-card-highlight/u)
    expect(await page.evaluate(() => window.scrollY)).toBe(documentScrollBefore)
  })

  test("Backspace 在芯片后整体删除双链节点", async ({ page }) => {
    await resetComposer(page)
    await typeEditor(page, "composer", "[[季度")
    await expect(wikilinkMenu(page).getByRole("option")).toHaveCount(1)
    await page.keyboard.press("Enter")
    await expect.poll(() => readEditor(page, "composer")).toBe("[[季度规划]]")

    await page.keyboard.press("Backspace")
    await expect(chips(page)).toHaveCount(0)
    await expect.poll(() => readEditor(page, "composer")).toBe("")
  })

  test("正文里的图片显示为附件节点，提交原样", async ({ page }) => {
    await fillEditor(page, "composer", IMAGE_BODY)

    const image = proseMirror(page).locator('[data-shard-rich-inline="image"]')
    await expect(image).toHaveCount(1)
    await expect(image).toContainText("示意图")
    await expect(image.locator(`img[data-source-path="${IMAGE_PATH}"]`)).toBeVisible()
    // 编辑区里看不到 Markdown 图片语法。
    await expect(proseMirror(page)).not.toContainText("![")
    await expect.poll(() => readEditor(page, "composer")).toBe(IMAGE_BODY)

    await submitComposer(page)
    await expect.poll(() => createdContents(page)).toEqual([IMAGE_BODY])
  })

  test("点击图片附件打开原图对话框", async ({ page }) => {
    await fillEditor(page, "composer", IMAGE_BODY)

    const image = proseMirror(page).locator('[data-shard-rich-inline="image"]')
    await image.getByRole("button", { name: "放大查看图片附件：示意图" }).click()

    const dialog = page.locator(".shard-image-preview-dialog")
    await expect(dialog).toBeVisible()
    await expect(dialog.locator(`img[data-source-path="${IMAGE_PATH}"]`)).toBeVisible()

    await page.keyboard.press("Escape")
    await expect(dialog).toHaveCount(0)
    // 关闭对话框不改正文。
    await expect.poll(() => readEditor(page, "composer")).toBe(IMAGE_BODY)
  })

  test("图片节点的删除按钮只移除这一张，其余正文不动", async ({ page }) => {
    await fillEditor(page, "composer", IMAGE_BODY)
    const image = proseMirror(page).locator('[data-shard-rich-inline="image"]')
    await image.getByRole("button", { name: "删除图片" }).click()

    await expect(image).toHaveCount(0)
    await expect.poll(() => readEditor(page, "composer")).toBe("正文")
  })

  test("斜杠备忘卡片插入标题与细节两段，光标落在标题", async ({ page }) => {
    await resetComposer(page)
    await typeEditor(page, "composer", "/备忘")
    await expect(commandMenu(page).getByRole("option")).toHaveCount(1)
    await expect(commandMenu(page).getByRole("option")).toContainText("备忘卡片")
    await page.keyboard.press("Enter")

    const card = memoCard(page)
    await expect(card).toHaveCount(1)
    const empties = card.locator("p.is-empty")
    await expect(empties).toHaveCount(2)
    // 占位是 ::before 生成内容，按位置分标题与细节。
    const placeholders = await empties.evaluateAll((elements) =>
      elements.map((element) => window.getComputedStyle(element, "::before").content)
    )
    expect(placeholders[0]).toContain("备忘标题")
    expect(placeholders[1]).toContain("补充细节")

    // 光标已经在标题上：插完直接打字就是标题。
    await page.keyboard.type("标题")
    await expect(card.locator("p").first()).toHaveText("标题")
    await page.keyboard.press("ArrowDown")
    await page.keyboard.type("细节")

    await expect.poll(() => readEditor(page, "composer")).toBe("- [ ] 标题\n\n  细节")
    await submitComposer(page)
    await expect.poll(() => createdContents(page)).toEqual(["- [ ] 标题\n\n  细节"])
  })

  test("只有标题的任务项不画卡片外框，带细节的才画", async ({ page }) => {
    const frameWidth = () =>
      proseMirror(page)
        .locator(".shard-rich-task")
        .first()
        .evaluate((element) => window.getComputedStyle(element).borderTopWidth)

    await fillEditor(page, "composer", "- [ ] 只有标题")
    await expect(memoCard(page)).toHaveCount(0)
    expect(await frameWidth()).toBe("0px")

    await fillEditor(page, "composer", "- [ ] 标题\n\n  细节")
    await expect(memoCard(page)).toHaveCount(1)
    expect(await frameWidth()).toBe("1px")

    // 缩进续行写法（产品框架 §5.2 的存储示例）同样是卡片。
    await fillEditor(page, "composer", "- [ ] 买菜\n  番茄、鸡蛋、葱")
    await expect(memoCard(page)).toHaveCount(1)
    await expect.poll(() => readEditor(page, "composer")).toBe("- [ ] 买菜\n  番茄、鸡蛋、葱")
  })

  test("子任务不算备忘卡片；连续普通任务合成一张卡，备忘卡片单独成卡", async ({ page }) => {
    await fillEditor(page, "composer", "- [ ] 买菜\n  - [ ] 番茄\n- [ ] 周会准备\n\n  带上数据表\n- [ ] 整理需求")
    await expect(memoCard(page)).toHaveCount(1)
    await expect(memoCard(page)).toContainText("周会准备")

    const frames = await proseMirror(page)
      .locator('ul[data-type="taskList"] > li')
      .evaluateAll((items) =>
        items
          .filter((item) => !item.parentElement?.closest("li"))
          .map((item) => {
            const style = window.getComputedStyle(item)
            return { top: style.borderTopWidth, bottom: style.borderBottomWidth, left: style.borderLeftWidth }
          })
      )
    // 买菜：一张任务卡（上下左边都有）；周会准备：备忘卡片自己带框，li 不画；整理需求：又一张任务卡。
    expect(frames).toEqual([
      { top: "1px", bottom: "1px", left: "1px" },
      { top: "0px", bottom: "0px", left: "0px" },
      { top: "1px", bottom: "1px", left: "1px" },
    ])
  })

  test("备忘卡片的备注栏删不掉：退格、Delete、选区删除都保留备注栏", async ({ page }) => {
    await resetComposer(page)
    await typeEditor(page, "composer", "/备忘")
    await page.keyboard.press("Enter")
    await page.keyboard.type("标题")
    await page.keyboard.press("ArrowDown")
    await page.keyboard.type("细节")

    const card = memoCard(page)
    const note = card.locator("p").nth(1)

    // 删光备注文字后再退格：光标回到标题末尾，备注栏还在。
    for (let index = 0; index < 3; index += 1) await page.keyboard.press("Backspace")
    await expect(note).toHaveText("")
    await expect(card).toHaveCount(1)
    await expect(card.locator("p")).toHaveCount(2)
    await page.keyboard.type("续")
    await expect(card.locator("p").first()).toHaveText("标题续")

    // 标题末尾按 Delete 不把备注并上来。
    await page.keyboard.press("ArrowDown")
    await page.keyboard.type("备注")
    await page.keyboard.press("ArrowUp")
    await page.keyboard.press("End")
    await page.keyboard.press("Delete")
    await expect(card.locator("p")).toHaveCount(2)
    await expect(note).toHaveText("备注")

    // 从标题中间选到备注末尾再删：备注栏补回为空栏，卡片不散。
    // 先停过撤销历史的合并窗口（newGroupDelay 500ms），这次删除才自成一步撤销。
    await page.waitForTimeout(600)
    await proseMirror(page).evaluate((dom) => {
      type SelectionEditor = {
        state: { doc: { textBetween: (from: number, to: number, separator: string) => string } }
        commands: { setTextSelection: (range: { from: number; to: number }) => boolean }
      }
      const editor = (dom as unknown as { editor: SelectionEditor }).editor
      // doc > taskList > taskItem > 标题段：「标题续」从 3 起，「续」在 5；备注段正文 8–10。
      editor.commands.setTextSelection({ from: 5, to: 10 })
    })
    await page.keyboard.press("Backspace")
    await expect(card).toHaveCount(1)
    await expect(card.locator("p").first()).toHaveText("标题")
    await expect(card.locator("p")).toHaveCount(2)
    await expect(note).toHaveText("")

    // 一次撤销连补回的空栏一起撤掉，回到删除前。
    await page.keyboard.press("ControlOrMeta+z")
    await expect(card.locator("p").first()).toHaveText("标题续")
    await expect(note).toHaveText("备注")
  })

  test("空任务与空标题备忘卡片保存后再编辑，不露出 Markdown 语法", async ({ page }) => {
    const saved = "- [ ] 赚钱\n- [ ] 前期\n\n  哈哈哈\n- [ ]\n- [ ]\n\n  只有备注"
    await fillEditor(page, "composer", saved)

    await expect(proseMirror(page).getByRole("checkbox")).toHaveCount(4)
    await expect(proseMirror(page)).not.toContainText("[ ]")
    await expect(proseMirror(page).locator('ul:not([data-type="taskList"])')).toHaveCount(0)
    await expect(memoCard(page)).toHaveCount(2)
    await expect(memoCard(page).last()).toContainText("只有备注")
    // 读回再写出与原文一致：空标题没有被备注顶掉。
    await expect.poll(() => readEditor(page, "composer")).toBe(saved)
  })

  test("备忘卡片的细节区可折叠，折叠只在会话内不写文件", async ({ page }) => {
    await fillEditor(page, "composer", "- [ ] 标题\n\n  细节")
    const card = memoCard(page)
    const detail = card.locator("p").nth(1)
    await expect(detail).toBeVisible()

    await card.getByRole("button", { name: "收起备忘细节" }).click()
    await expect(detail).toBeHidden()
    await expect.poll(() => readEditor(page, "composer")).toBe("- [ ] 标题\n\n  细节")

    await card.getByRole("button", { name: "展开备忘细节" }).click()
    await expect(detail).toBeVisible()
  })

  test("备忘卡片勾选写回 [x]，提交内容一致", async ({ page }) => {
    await fillEditor(page, "composer", "- [ ] 标题\n\n  细节")
    const checkbox = proseMirror(page).getByRole("checkbox")
    await expect(checkbox).toHaveCount(1)
    await expect(checkbox).not.toBeChecked()

    await checkbox.click()
    await expect(checkbox).toBeChecked()
    await expect.poll(() => readEditor(page, "composer")).toBe("- [x] 标题\n\n  细节")

    await submitComposer(page)
    await expect.poll(() => createdContents(page)).toEqual(["- [x] 标题\n\n  细节"])
  })

  test("备忘卡片标题里组合输入不重建正文节点", async ({ page }) => {
    await fillEditor(page, "composer", "- [ ] 标题\n\n  细节")
    await memoCard(page).locator("p").first().click()
    await page.keyboard.press("End")

    await page.evaluate((selector) => {
      const probe = window as typeof window & { __shardImeProbe?: Element | null }
      probe.__shardImeProbe = document.querySelector(
        `${selector} [data-shard-memo-card="true"] p`
      )
    }, COMPOSER)

    const session = await page.context().newCDPSession(page)
    try {
      await session.send("Input.imeSetComposition", {
        selectionEnd: 2,
        selectionStart: 2,
        text: "zj",
      })
      expect((await readEditorSnapshot(page, "composer")).composing).toBe(true)
      const sameNode = await page.evaluate((selector) => {
        const probe = window as typeof window & { __shardImeProbe?: Element | null }
        return (
          probe.__shardImeProbe ===
          document.querySelector(`${selector} [data-shard-memo-card="true"] p`)
        )
      }, COMPOSER)
      expect(sameNode).toBe(true)

      await session.send("Input.insertText", { text: "追加" })
      await expect.poll(() => readEditor(page, "composer")).toBe("- [ ] 标题追加\n\n  细节")
      await expect(memoCard(page)).toHaveCount(1)
    } finally {
      await session.detach()
    }
  })

  // 手打语法自动收敛：用户从不需要输入语法，但 `#词` 与 `[[x]]` 是既有输入习惯，
  // 打出来就必须成节点，否则序列化会按字面转义成 `\#词` / `\[\[x]]`。
  test("整句手打的标签与双链都收敛成节点，提交与旧编辑器一致", async ({ page }) => {
    await resetComposer(page)
    await typeEditor(page, "composer", "记一笔 #手打标签 然后 [[手打双链]] 结束")

    await expect(tags(page)).toHaveText("#手打标签")
    await expect(chips(page)).toHaveText("手打双链")
    // 编辑区里看不到语法字符。
    await expect(proseMirror(page)).not.toContainText("[[")
    await expect.poll(() => readEditor(page, "composer")).toBe(
      "记一笔 #手打标签 然后 [[手打双链]] 结束"
    )

    await submitComposer(page)
    await expect.poll(() => createdContents(page)).toEqual([
      "记一笔 #手打标签 然后 [[手打双链]] 结束",
    ])
  })

  test("手打标签在空格边界成节点，提交写回 #手打标签", async ({ page }) => {
    await resetComposer(page)
    await typeEditor(page, "composer", "记一笔 #手打标签")
    // 还在菜单里筛选，不抢先转换。
    await expect(tagMenu(page)).toBeVisible()
    await expect(tags(page)).toHaveCount(0)

    await typeEditor(page, "composer", " ")
    await expect(tags(page)).toHaveText("#手打标签")
    await expect.poll(() => readEditor(page, "composer")).toBe("记一笔 #手打标签")

    await submitComposer(page)
    await expect.poll(() => createdContents(page)).toEqual(["记一笔 #手打标签"])
  })

  test("手打标签不跟空格直接提交，也在提交前成节点", async ({ page }) => {
    await resetComposer(page)
    await typeEditor(page, "composer", "直接提交 #未跟空格")
    await expect(tagMenu(page)).toBeVisible()
    await expect(tags(page)).toHaveCount(0)

    // 菜单开着时 Cmd+Enter 仍是提交，不是选中候选。
    await submitComposer(page)
    await expect.poll(() => createdContents(page)).toEqual(["直接提交 #未跟空格"])
  })

  test("手打双链闭合即成断链芯片，提交写回 [[目标]]", async ({ page }) => {
    await resetComposer(page)
    await typeEditor(page, "composer", "[[手打双链]]")

    await expect(chips(page)).toHaveText("手打双链")
    await expect(chips(page)).toHaveClass(/shard-rich-wikilink--missing/u)
    await expect(proseMirror(page)).not.toContainText("]]")
    await expect.poll(() => readEditor(page, "composer")).toBe("[[手打双链]]")

    await submitComposer(page)
    await expect.poll(() => createdContents(page)).toEqual(["[[手打双链]]"])
  })

  test("输入法整段上屏的标签，按空格后成节点", async ({ page }) => {
    await resetComposer(page)

    const session = await page.context().newCDPSession(page)
    try {
      await session.send("Input.imeSetComposition", {
        selectionEnd: 4,
        selectionStart: 4,
        text: "zhbq",
      })
      expect((await readEditorSnapshot(page, "composer")).composing).toBe(true)

      await session.send("Input.insertText", { text: "#组合标签" })
      // 上屏后菜单接手，文本还没到边界，不转换。
      await expect(tagMenu(page)).toBeVisible()
      await expect(tags(page)).toHaveCount(0)

      await page.keyboard.type(" ")
      await expect(tags(page)).toHaveText("#组合标签")
      await expect.poll(() => readEditor(page, "composer")).toBe("#组合标签")
    } finally {
      await session.detach()
    }
  })

  test("建议菜单开着时不抢先转换，Esc 关掉后收敛", async ({ page }) => {
    await resetComposer(page)
    await typeEditor(page, "composer", "#收敛测试")

    await expect(tagMenu(page)).toBeVisible()
    await expect(tags(page)).toHaveCount(0)

    await page.keyboard.press("Escape")
    await expect(tagMenu(page)).toHaveCount(0)
    await expect(tags(page)).toHaveText("#收敛测试")
    await expect.poll(() => readEditor(page, "composer")).toBe("#收敛测试")
  })

  test("粘贴纯文本里的标签直接成节点", async ({ page }) => {
    await resetComposer(page)

    await proseMirror(page).evaluate((element, text) => {
      const data = new DataTransfer()
      data.setData("text/plain", text)
      element.dispatchEvent(
        new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data })
      )
    }, "#粘贴标签 正文")

    await expect(tags(page)).toHaveText("#粘贴标签")
    await expect.poll(() => readEditor(page, "composer")).toBe("#粘贴标签 正文")
  })

  test("载入正文里的字面转义不被收敛改写", async ({ page }) => {
    // `\#` / `\[\[` 是转换层解析出来的字面文本，不是用户刚打的语法：
    // 只把正文写进来（不编辑）不能悄悄把它们变成节点。
    await fillEditor(page, "composer", LITERAL_BODY)

    await expect(tags(page)).toHaveCount(0)
    await expect(chips(page)).toHaveCount(0)
    await expect.poll(() => readEditor(page, "composer")).toBe(LITERAL_BODY)
  })

  test("编辑已有正文只收敛新打的部分，别处的字面转义在失焦与提交后原样保留", async ({
    page,
  }) => {
    await fillEditor(page, "composer", LITERAL_BODY)

    // 点进编辑器再点走：一个字都没改，失焦兜底不能动任何字面。
    await proseMirror(page).click()
    await blurComposer(page)
    await expect(tags(page)).toHaveCount(0)
    await expect(chips(page)).toHaveCount(0)
    await expect.poll(() => readEditor(page, "composer")).toBe(LITERAL_BODY)

    // 在末尾补一句：收敛范围只有这一段，紧挨着它的 `]]` 不跟着变节点。
    await selectDocRange(page, "composer", DOC_END, DOC_END)
    // 重新聚焦是 rAF 里完成的，等焦点真的回来再敲键盘，第一个空格才不会丢。
    await expect(proseMirror(page)).toBeFocused()
    await page.keyboard.type(" 补一句")
    await blurComposer(page)
    await expect(tags(page)).toHaveCount(0)
    await expect(chips(page)).toHaveCount(0)
    await expect.poll(() => readEditor(page, "composer")).toBe(`${LITERAL_BODY} 补一句`)

    await submitComposer(page)
    await expect.poll(() => createdContents(page)).toEqual([`${LITERAL_BODY} 补一句`])
  })

  test("字面转义后面紧接着手打的标签只收敛新标签", async ({ page }) => {
    await fillEditor(page, "composer", LITERAL_NEIGHBOUR_BODY)
    // 光标紧跟在字面 `#不是标签` 之后：段落正文从 1 起算，`字面 ` 3 字 + 标签 5 字。
    await selectDocRange(page, "composer", 9, 9)
    await expect(proseMirror(page)).toBeFocused()
    await page.keyboard.type(" #新标签 ")

    await expect(tags(page)).toHaveCount(1)
    await expect(tags(page)).toHaveText("#新标签")
    await expect(chips(page)).toHaveCount(0)
    await expect.poll(() => readEditor(page, "composer")).toBe(
      "字面 \\#不是标签 #新标签 ，还有 \\[\\[也不是双链]]"
    )

    await submitComposer(page)
    await expect.poll(() => createdContents(page)).toEqual([
      "字面 \\#不是标签 #新标签 ，还有 \\[\\[也不是双链]]",
    ])
  })

  test("自动收敛可以整体撤销回字面文本", async ({ page }) => {
    await resetComposer(page)
    await page.keyboard.type("记一笔 #撤销探针")
    // 拉开一次输入分组（prosemirror-history 默认 500ms），让空格与随之产生的
    // 收敛落在同一个新分组里：撤销一次应当同时退回空格与节点。
    await page.waitForTimeout(900)
    await page.keyboard.type(" ")
    await expect(tags(page)).toHaveText("#撤销探针")

    await page.keyboard.press("ControlOrMeta+z")
    await expect(tags(page)).toHaveCount(0)
    await expect.poll(() => readEditor(page, "composer")).toBe("记一笔 \\#撤销探针")
  })
})
