import { expect, test, type Page } from "@playwright/test"

import {
  fillEditor,
  focusEditor,
  readEditor,
  typeEditor,
} from "./editor-helpers"
import { installSearchIpcMock } from "./search-ipc-mock"

/**
 * 阶段 D2a：资料库编辑器切富文本（技术方案 §5、§6 阶段 3）。
 *
 * 资料库里全是文档，档位固定为文档档；几何走 `library` 变体——内边距由
 * library-shell 的 editorViewport / zenNoteViewport 给，沿用旧 CodeMirror 编辑器的几何。
 * 资料库的其余行为由 library-workspace / library-tree 等既有用例守着。
 */

const NOTE_ID = "library-note"
const EDITOR = `[data-shard-editor="library:${NOTE_ID}"]`
const NOTE_BODY = ["# 文档样例", "", "正文第一段 #工作", "", "- 列表项"].join("\n")
const NOTE_TAGS = ["inbox", "note", "工作"]

interface TestCall {
  command: string
  args: Record<string, unknown>
}

/**
 * 资料库工作台 mock，协议与 library-workspace.spec.ts 同源，另外补三样
 * D2a 要用的东西：可做双链候选的笔记 / 导图 / CSV、图片上传命令，以及一个
 * 可由用例释放的重命名（用来把编辑器压成只读态）。
 */
async function installRichLibraryMock(page: Page, noteBody = NOTE_BODY) {
  await installSearchIpcMock(page)
  await page.addInitScript((noteBody: string) => {
    const now = "2026-09-10T08:00:00.000Z"
    const fragments = [
      {
        id: "library-note", path: "notes/文档样例.md",
        content: noteBody, tags: ["inbox", "note", "工作"],
      },
      {
        id: "library-target", path: "notes/目标文档.md",
        content: "# 目标文档\n\n被双链指向的文档", tags: ["inbox", "note"],
      },
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
      vaultPath: "/tmp/shard-rich-library-mock-vault", fragments, git,
      lockbox: { configured: false, unlocked: false, expiresAt: null, ttlSeconds: 900 },
    }
    const tree = {
      entries: [
        { name: "文档样例.md", path: "notes/文档样例.md", kind: "markdown", size: 0, modifiedAt: "" },
        { name: "目标文档.md", path: "notes/目标文档.md", kind: "markdown", size: 0, modifiedAt: "" },
        {
          name: "季度规划.shardmap.json", path: "notes/季度规划.shardmap.json",
          kind: "mindmap", size: 0, modifiedAt: "", mindMapId: "map-quarter",
        },
      ],
      assets: [], trashEntries: [], fragmentTrashEntries: [],
      fragmentStream: { totalCount: fragments.length, years: [] },
    }
    const csvFiles = [{ name: "small.csv", path: "data/small.csv" }]
    const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T
    const calls: TestCall[] = []
    let callbackId = 0
    // 重命名挂起时 busyAction 不为 null，资料库编辑器随之进入只读态。
    let releaseRename: (() => void) | null = null
    Object.assign(globalThis, {
      isTauri: true,
      __SHARD_LIBRARY_CALLS__: calls,
      __SHARD_RELEASE_RENAME__: () => releaseRename?.(),
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
            case "list_mind_maps": return []
            case "list_csv_files": return clone(csvFiles)
            case "open_csv_file": return null
            case "read_fragment_image":
              return "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs="
            case "save_fragment_image": return `assets/${String(args.fileName)}`
            case "list_library_tree": return clone(tree)
            case "migrate_legacy_notes": return { tree: clone(tree), migratedCount: 0 }
            case "sync_vault": return clone(git)
            case "checkpoint_vault":
              return { status: "no_changes", changes: 0, reason: null, git: clone(git) }
            case "github_cli_status":
              return { installed: true, authenticated: true, login: "shard-test", protocol: "https", error: null }
            case "rename_library_entry":
              // 用例显式释放前一直挂着：编辑器保持只读。
              await new Promise<void>((resolve) => { releaseRename = resolve })
              return { tree: clone(tree), fragment: null, updatedLinks: 0 }
            case "update_fragment": {
              const fragment = fragments.find((item) => item.id === args.id)
              if (!fragment) throw new Error("Fragment not found")
              fragment.content = String(args.content ?? fragment.content)
              fragment.tags = (args.tags as string[]) ?? fragment.tags
              return clone(fragment)
            }
            default: throw new Error(`Unhandled Tauri test command: ${command}`)
          }
        },
      },
    })
  }, noteBody)
}

function proseMirror(page: Page) {
  return page.locator(`${EDITOR} .ProseMirror`)
}

function wikilinkMenu(page: Page) {
  return page.getByRole("listbox", { name: "双链建议" })
}

function chips(page: Page) {
  return proseMirror(page).locator(".shard-rich-wikilink")
}

async function commandCalls(page: Page, command: string) {
  return page.evaluate((name) => {
    const calls = (globalThis as typeof globalThis & {
      __SHARD_LIBRARY_CALLS__: TestCall[]
    }).__SHARD_LIBRARY_CALLS__
    return calls.filter((call) => call.command === name).map((call) => call.args)
  }, command)
}

/** 打开资料库里的「文档样例.md」，回到与旧编辑器同一条用户路径。 */
async function openSampleNote(page: Page) {
  await page.getByRole("button", { name: "资料库", exact: true }).click()
  await page
    .getByRole("complementary", { name: "资料库目录" })
    .getByRole("button", { name: /^文件（/ })
    .click()
  await page
    .getByRole("region", { name: "notes 目录列表", exact: true })
    .getByRole("button", { name: "打开文件 文档样例.md", exact: true })
    .click()
  await expect(proseMirror(page)).toHaveCount(1)
}

test.describe("资料库编辑器", () => {
  test.beforeEach(async ({ page }) => {
    await installRichLibraryMock(page)
    await page.goto("/")
    await openSampleNote(page)
  })

  test("打开 md 文档即富文本：文档档、library 几何，编辑区里没有 Markdown 语法", async ({
    page,
  }) => {
    const editor = page.locator(EDITOR)
    // 旧 CodeMirror 编辑面已经不在这条路径上。
    await expect(editor.locator(".cm-content")).toHaveCount(0)
    await expect(editor).toHaveAttribute("data-shard-editor-tier", "document")
    await expect(editor).toHaveAttribute("data-shard-editor-variant", "library")

    const content = proseMirror(page)
    await expect(content.locator("h1")).toHaveText("文档样例")
    await expect(content.locator(".shard-rich-tag")).toHaveText("#工作")
    await expect(content.locator("ul li")).toHaveCount(1)
    // 标题的井号与列表标记都不出现在编辑区里。
    await expect(content).not.toContainText("# 文档样例")
    await expect(content).not.toContainText("- 列表项")
    await expect(content).toContainText("列表项")
    // 打开一篇规范文档不会顺手改写它。
    expect(await commandCalls(page, "update_fragment")).toHaveLength(0)
  })

  test("文档档开放标题与引用的输入前缀，写回规范 Markdown", async ({ page }) => {
    await fillEditor(page, `library:${NOTE_ID}`, "")
    await focusEditor(page, `library:${NOTE_ID}`)
    await typeEditor(page, `library:${NOTE_ID}`, "## 小节")

    await expect(proseMirror(page).locator("h2")).toHaveText("小节")
    await expect(proseMirror(page)).not.toContainText("##")
    await expect.poll(() => readEditor(page, `library:${NOTE_ID}`)).toBe("## 小节")

    await page.keyboard.press("Enter")
    await typeEditor(page, `library:${NOTE_ID}`, "> 引用")
    await expect(proseMirror(page).locator("blockquote")).toHaveText("引用")
    await expect.poll(() => readEditor(page, `library:${NOTE_ID}`)).toBe(
      "## 小节\n\n> 引用"
    )
  })

  test("编辑后自动保存：命令与旧编辑器一致，正文是规范 Markdown 且标签不变", async ({
    page,
  }) => {
    await fillEditor(
      page,
      `library:${NOTE_ID}`,
      ["# 文档样例", "", "改写后的正文 #工作"].join("\n")
    )

    await expect.poll(() => commandCalls(page, "update_fragment")).toHaveLength(1)
    expect((await commandCalls(page, "update_fragment"))[0]).toMatchObject({
      id: NOTE_ID,
      content: "# 文档样例\n\n改写后的正文 #工作",
      tags: NOTE_TAGS,
    })
    await expect(
      page.getByRole("contentinfo", { name: "状态栏" }).getByText("已保存")
    ).toBeVisible()
  })

  test("只读态：重命名在飞时 ProseMirror 不可编辑，释放后恢复", async ({ page }) => {
    const before = await readEditor(page, `library:${NOTE_ID}`)

    await page.getByRole("button", { name: "重命名文件", exact: true }).click()
    const nameInput = page.getByRole("textbox", { name: "重命名名称", exact: true })
    await nameInput.fill("改名后的文档")
    await nameInput.press("Enter")

    await expect(
      page.locator(`${EDITOR} .ProseMirror[contenteditable="false"]`)
    ).toHaveCount(1)
    // 只读态下键入不进正文。
    await proseMirror(page).click({ force: true })
    await page.keyboard.type("不该写进去")
    await expect.poll(() => readEditor(page, `library:${NOTE_ID}`)).toBe(before)

    await page.evaluate(() =>
      (globalThis as typeof globalThis & {
        __SHARD_RELEASE_RENAME__: () => void
      }).__SHARD_RELEASE_RENAME__()
    )
    await expect(
      page.locator(`${EDITOR} .ProseMirror[contenteditable="true"]`)
    ).toHaveCount(1)
  })

  test("[[ 建议按类别给出候选，选中写成芯片并落盘为 [[目标]]", async ({ page }) => {
    await fillEditor(page, `library:${NOTE_ID}`, "# 文档样例")
    await focusEditor(page, `library:${NOTE_ID}`)
    await page.keyboard.press("Enter")
    await typeEditor(page, `library:${NOTE_ID}`, "[[")

    const menu = wikilinkMenu(page)
    await expect(menu).toBeVisible()
    await expect(menu).toContainText("笔记")
    await expect(menu).toContainText("思维导图")
    await expect(menu).toContainText("CSV")

    await typeEditor(page, `library:${NOTE_ID}`, "目标")
    await expect(menu.getByRole("option")).toHaveCount(1)
    await expect(menu.getByRole("option")).toContainText("目标文档")
    await page.keyboard.press("Enter")

    await expect(chips(page)).toHaveText("目标文档")
    await expect(chips(page)).not.toHaveClass(/shard-rich-wikilink--missing/u)
    // 编辑区里看不到方括号。
    await expect(proseMirror(page)).not.toContainText("[[")
    await expect.poll(() => readEditor(page, `library:${NOTE_ID}`)).toBe(
      "# 文档样例\n\n[[目标文档]]"
    )

    await expect.poll(() => commandCalls(page, "update_fragment")).toHaveLength(1)
    expect((await commandCalls(page, "update_fragment"))[0]).toMatchObject({
      id: NOTE_ID,
      content: "# 文档样例\n\n[[目标文档]]",
      // 正文里不再有 `#工作`：标签跟着正文走，`note` 由资料库固定带上。
      tags: ["inbox", "note"],
    })
  })

  test("芯片导航：CSV 交给系统打开，待建链接只提示", async ({ page }) => {
    await fillEditor(page, `library:${NOTE_ID}`, "[[data/small.csv]]")
    await chips(page).click()
    await expect.poll(() => commandCalls(page, "open_csv_file")).toEqual([
      { path: "data/small.csv" },
    ])

    await fillEditor(page, `library:${NOTE_ID}`, "[[尚未创建]]")
    await expect(chips(page)).toHaveClass(/shard-rich-wikilink--missing/u)
    await chips(page).click()
    await expect(page.locator('[data-sonner-toast][data-type="info"]').filter({ hasText: "「尚未创建」还没有文档" })).toBeVisible()
    await expect.poll(() => readEditor(page, `library:${NOTE_ID}`)).toBe("[[尚未创建]]")
  })

  test("粘贴图片走共享上传命令，并把附件追加到正文", async ({ page }) => {
    await proseMirror(page).evaluate((element) => {
      const clipboardData = new DataTransfer()
      clipboardData.items.add(
        new File([new Uint8Array([137, 80, 78, 71])], "library-paste.png", {
          type: "image/png",
        })
      )
      element.dispatchEvent(
        new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData })
      )
    })

    await expect.poll(() => commandCalls(page, "save_fragment_image")).toEqual([
      { bytes: [137, 80, 78, 71], fileName: "library-paste.png" },
    ])
    await expect(
      proseMirror(page).locator('[data-shard-rich-inline="image"]')
    ).toHaveCount(1)
    // 附件按方言独占一个块，alt 由文件名推出。
    await expect.poll(() => readEditor(page, `library:${NOTE_ID}`)).toBe(
      `${NOTE_BODY}\n\n![library paste](assets/library-paste.png)`
    )
  })
})

/**
 * 打开不规范的 Markdown 不改写磁盘：载入时的归一化只发生在文档模型里，
 * 宿主不标脏、不自动保存；用户真正编辑后，保存写出的才是规范化后的全文。
 */
test.describe("资料库编辑器：不规范文档的载入与保存", () => {
  const LOOSE_BODY = ["* 星号列表项", "* 第二项"].join("\n")

  test.beforeEach(async ({ page }) => {
    await installRichLibraryMock(page, LOOSE_BODY)
    await page.goto("/")
    await openSampleNote(page)
  })

  test("打开不规范文档不触发保存，编辑一字后保存为规范化全文", async ({ page }) => {
    await expect(proseMirror(page).locator("ul li")).toHaveCount(2)
    // 超过 800ms 的自动保存节拍：打开本身不能产生写入，状态栏保持已保存。
    await page.waitForTimeout(1_500)
    expect(await commandCalls(page, "update_fragment")).toHaveLength(0)
    await expect(
      page.getByRole("contentinfo", { name: "状态栏" }).getByText("已保存")
    ).toBeVisible()

    await proseMirror(page).locator("li").last().click()
    await page.keyboard.press("End")
    await page.keyboard.type("！")

    await expect.poll(() => commandCalls(page, "update_fragment")).toHaveLength(1)
    expect((await commandCalls(page, "update_fragment"))[0]).toMatchObject({
      id: NOTE_ID,
      content: "- 星号列表项\n- 第二项！",
    })
  })
})

test.describe("资料库编辑器：有序任务列表", () => {
  test.beforeEach(async ({ page }) => {
    await installRichLibraryMock(page, ["1. [ ] 第一件", "2. [x] 第二件"].join("\n"))
    await page.goto("/")
    await openSampleNote(page)
  })

  test("`1. [ ]` 保留序号：编辑区显示序号，保存写回有序任务", async ({ page }) => {
    const list = proseMirror(page).locator('ul[data-type="taskList"][data-ordered="true"]')
    await expect(list).toHaveCount(1)
    await expect(list.locator(":scope > li")).toHaveCount(2)
    // 序号由 CSS 计数器画在复选框前，与卡片的 `.md-task-list-marker` 同一形态。
    const markers = await list.locator(":scope > li > .shard-rich-task").evaluateAll((items) =>
      items.map((item) => getComputedStyle(item, "::before").content)
    )
    expect(markers).toHaveLength(2)
    for (const marker of markers) expect(marker).toContain("shard-rich-task-order")

    await list.locator("li").last().click()
    await page.keyboard.press("End")
    await page.keyboard.press("Enter")
    await page.keyboard.type("第三件")

    await expect.poll(() => readEditor(page, `library:${NOTE_ID}`)).toBe(
      "1. [ ] 第一件\n2. [x] 第二件\n3. [ ] 第三件"
    )
    await expect.poll(() => commandCalls(page, "update_fragment")).toHaveLength(1)
    expect((await commandCalls(page, "update_fragment"))[0]).toMatchObject({
      content: "1. [ ] 第一件\n2. [x] 第二件\n3. [ ] 第三件",
    })
  })
})

// 迁自 tests/ui/mind-map-widget.spec.ts（旧 CodeMirror widget 用例）。
test.describe("资料库编辑器里的大纲块", () => {
  const OUTLINE_BODY = ["前言", "", "```mindmap", "- 中心主题", "  - 分支一", "```", "", "结尾"].join("\n")

  test.beforeEach(async ({ page }) => {
    await installRichLibraryMock(page)
    await page.goto("/")
    await openSampleNote(page)
  })

  test("mindmap 围栏是幕布式大纲，文档只读时退回只读导图预览", async ({ page }) => {
    await fillEditor(page, `library:${NOTE_ID}`, OUTLINE_BODY)
    const widget = page.locator(`${EDITOR} [data-mind-map-fence-widget]`)
    await expect(widget).toHaveAttribute("data-mind-map-fence-widget", "editor")
    await expect(
      widget.locator('[data-outline-node][data-root="true"] textarea[data-outline-field="text"]')
    ).toHaveValue("中心主题")
    await expect(
      widget.locator('[data-outline-node][data-root="false"] textarea[data-outline-field="text"]')
    ).toHaveValue("分支一")
    await expect(proseMirror(page)).not.toContainText("```mindmap")
    // 等自动保存落盘，再让重命名把编辑器压成只读。
    await expect.poll(() => commandCalls(page, "update_fragment")).toHaveLength(1)

    await page.getByRole("button", { name: "重命名文件", exact: true }).click()
    const nameInput = page.getByRole("textbox", { name: "重命名名称", exact: true })
    await nameInput.fill("导图文档改名")
    await nameInput.press("Enter")

    await expect(widget).toHaveAttribute("data-mind-map-fence-widget", "readonly")
    await expect(widget.getByRole("img", { name: "思维导图预览", exact: true })).toBeVisible()

    await page.evaluate(() =>
      (globalThis as typeof globalThis & {
        __SHARD_RELEASE_RENAME__: () => void
      }).__SHARD_RELEASE_RENAME__()
    )
    await expect(widget).toHaveAttribute("data-mind-map-fence-widget", "editor")
    await expect.poll(() => readEditor(page, `library:${NOTE_ID}`)).toBe(OUTLINE_BODY)
  })
})

test.describe("资料库保存与后端归一化", () => {
  test("只有标题的文档打开后显式保存不写盘，更不会反复重存", async ({ page }) => {
    // 真实后端写入时去掉尾部空白再补一个换行，读回的正文总带尾换行；
    // 编辑器序列化不带尾换行。两边口径不一时，排空式保存曾把同一份正文无限重存。
    await installRichLibraryMock(page, "# 未命名\n")
    await page.addInitScript(() => {
      const internals = (globalThis as typeof globalThis & {
        __TAURI_INTERNALS__: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> }
      }).__TAURI_INTERNALS__
      const invoke = internals.invoke
      internals.invoke = async (command, args = {}) => {
        const result = await invoke(command, args)
        if (command !== "update_fragment") return result
        const fragment = result as { content: string }
        return { ...fragment, content: `${fragment.content.trimEnd()}\n` }
      }
    })
    await page.goto("/")
    await openSampleNote(page)
    await expect(proseMirror(page).locator("h1")).toHaveText("未命名")

    await page.keyboard.press("ControlOrMeta+s")
    await expect(
      page.getByRole("contentinfo", { name: "状态栏" }).getByText("已保存")
    ).toBeVisible()
    // 失控时两秒内会有上百次调用；留出足够的时间窗再断言一次都没有。
    await page.waitForTimeout(1_000)
    expect(await commandCalls(page, "update_fragment")).toHaveLength(0)
  })
})
