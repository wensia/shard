import { expect, test, type Page } from "@playwright/test"

import { fillEditor, focusEditor, readEditor, typeEditor } from "./editor-helpers"
import { installSearchIpcMock } from "./search-ipc-mock"

type Surface = "composer" | "inline" | "zen" | "library"

interface TestCall {
  command: string
  args: Record<string, unknown>
}

// Exercise the real workbench routes with an in-memory vault; no user's files are written.
async function installSlashCommandMock(page: Page) {
  await installSearchIpcMock(page)
  await page.addInitScript(() => {
    const now = "2026-09-10T08:00:00.000Z"
    const fragments = [
      { id: "slash-fragment", path: "fragments/slash-fragment.md", content: "待编辑碎片", tags: ["inbox"] },
      { id: "slash-note", path: "notes/斜杠命令.md", content: "待编辑文档", tags: ["inbox", "note"] },
    ].map((fragment) => ({
      ...fragment, createdAt: now, updatedAt: now, category: null,
      gitStatus: "committed", error: null, archived: false, lockbox: false, pinned: false,
    }))
    const git = {
      branch: "main", shortCommit: "abc1234", hasRemote: false,
      status: "ready", error: null, ahead: 0, behind: 0,
    }
    const state = {
      vaultPath: "/tmp/shard-slash-command-mock-vault", fragments, git,
      lockbox: { configured: false, unlocked: false, expiresAt: null, ttlSeconds: 900 },
    }
    const tree = {
      entries: [{ name: "斜杠命令.md", path: "notes/斜杠命令.md", kind: "markdown", size: 0, modifiedAt: now }],
      assets: [], trashEntries: [], fragmentTrashEntries: [],
      fragmentStream: { totalCount: 0, years: [] },
    }
    const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T
    const calls: TestCall[] = []
    let callbackId = 0
    Object.assign(globalThis, {
      isTauri: true,
      __SHARD_SLASH_CALLS__: calls,
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
    await page.locator('[data-shard-fragment-id="slash-fragment"]')
      .getByRole("button", { name: "片段操作", exact: true }).click()
    await page.getByRole("menuitem", { name: surface === "inline" ? "编辑" : "禅模式", exact: true }).click()
    id = `${surface === "inline" ? "fragment" : "zen"}:slash-fragment`
  } else if (surface === "library") {
    await page.getByRole("button", { name: "资料库", exact: true }).click()
    await page.getByRole("complementary", { name: "资料库目录" })
      .getByRole("button", { name: /^文件（/ }).click()
    await page.getByRole("button", { name: "打开文件 斜杠命令.md", exact: true }).click()
    id = "library:slash-note"
  }
  await expect(page.locator(`[data-shard-editor="${id}"] .ProseMirror`)).toBeVisible()
  return id
}

function commandMenu(page: Page) {
  return page.getByRole("listbox", { name: "命令菜单" })
}

async function typeSlash(page: Page, id: string, text: string) {
  await fillEditor(page, id, "")
  await focusEditor(page, id)
  await typeEditor(page, id, text)
}

test.beforeEach(async ({ page }) => {
  await installSlashCommandMock(page)
  await page.goto("/")
  await expect(page.locator('[data-shard-editor="composer"] .ProseMirror')).toBeFocused()
})

// composer 面由富文本用例覆盖：tests/ui/rich-composer.spec.ts「斜杠弹出十三项命令菜单，可过滤、应用与 Esc 关闭」
// 与「composer 输入斜杠弹出命令菜单并写回选中的命令」。
for (const surface of ["inline", "zen", "library"] as const) {
  // 围栏块（导图块、数据表）排在前面，八条行格式命令跟在后面；`/大纲`、`/文档`
  // 只在能创建新碎片的速记框出现，其余编辑面是十项。资料库文档是文档档，
  // 另有标题 1–4、引用、代码块六项，共十六项。
  const expectedCount = surface === "library" ? 16 : 10
  test(`${surface} 输入斜杠弹出 ${expectedCount} 项命令菜单并写回选中的命令`, async ({ page }) => {
    const id = await openSurface(page, surface)
    await typeSlash(page, id, "/")

    const menu = commandMenu(page)
    await expect(menu).toBeVisible()
    await expect(menu.getByRole("option")).toHaveCount(expectedCount)
    await expect(menu.getByRole("option").filter({ hasText: /^标题/u })).toHaveCount(
      surface === "library" ? 4 : 0
    )
    await expect(menu.getByRole("option").first()).toContainText("导图块")
    await expect(menu).not.toContainText("文档")
    await expect(menu).not.toContainText("流程图")
    await expect(menu.getByRole("option").filter({ hasText: /^大纲/u })).toHaveCount(0)

    // 导图块 → 数据表 → 任务列表
    await page.keyboard.press("ArrowDown")
    await page.keyboard.press("ArrowDown")
    await expect(menu.getByRole("option").nth(2)).toHaveAttribute("aria-selected", "true")
    await page.keyboard.press("Enter")
    await expect.poll(() => readEditor(page, id)).toBe("- [ ]")
    await expect(menu).toHaveCount(0)
  })
}

// 以下用例已由富文本用例覆盖，删除：
// - 「命令菜单支持拼音首字母过滤，Esc 关闭后焦点留在编辑器」→ rich-composer.spec.ts
//   「斜杠弹出十二项命令菜单，可过滤、应用与 Esc 关闭」（rw 拼音首字母过滤、Esc 后焦点与正文）。
// - 「表格命令写回 3 列 2 行 Markdown 表格」→ rich-blocks.spec.ts「/表格 插入 3 列 2 行 GFM 表格，Tab 在单元格之间走格」。
// - 「标签命令写下井号并立刻交给标签建议」→ rich-composer.spec.ts 同名用例。
// - 「组合输入期间不弹命令菜单，上屏后按拼音过滤」→ rich-composer.spec.ts「组合输入期间不弹命令菜单，且不重建正文节点」。
// - 「导图块命令插入空根围栏并直接进入大纲 widget」→ rich-blocks.spec.ts「/导图块 插入幕布式大纲，根节点直接可输入，提交为规范围栏」。
// 「光标落回围栏源码时，Enter 续行、Tab 与 Shift-Tab 仍调整层级」随 CodeMirror 消失：富文本下大纲块没有源码态，
// 层级键位由大纲组件处理，见 rich-blocks.spec.ts「空根大纲显示「中心主题」占位，Enter 建子节点、Tab 与 Shift-Tab 调层级并实时写回」。

test("大纲块节点里输入斜杠不弹命令菜单", async ({ page }) => {
  await fillEditor(page, "composer", "```mindmap\n- 中心主题\n```")
  const root = page.locator(
    '[data-shard-editor="composer"] [data-outline-node][data-root="true"] textarea[data-outline-field="text"]'
  )
  await expect(root).toHaveValue("中心主题")
  await root.click()
  await page.keyboard.press("End")
  await page.keyboard.type(" /")

  await expect.poll(() => readEditor(page, "composer")).toBe(
    "```mindmap\n- 中心主题 /\n```"
  )
  await expect(commandMenu(page)).toHaveCount(0)
})
