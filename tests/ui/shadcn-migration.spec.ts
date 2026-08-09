import { expect, test, type Page } from "@playwright/test"

async function installTauriMock(page: Page) {
  await page.addInitScript(() => {
    const now = "2026-08-03T10:00:00.000Z"
    const fragments = Array.from({ length: 24 }, (_, index) => ({
      id: `fragment-${index + 1}`,
      content:
        index === 0
          ? "迁移回归片段\n- [ ] 验证菜单、编辑器和分享图片"
          : `第 ${index + 1} 条回归片段，保持时间线滚动和纸张布局。`,
      createdAt: new Date(Date.parse(now) - index * 60_000).toISOString(),
      updatedAt: new Date(Date.parse(now) - index * 60_000).toISOString(),
      tags: ["inbox", index % 2 === 0 ? "work" : "notes"],
      category: null,
      path: `fragments/2026/08/fragment-${index + 1}.md`,
      gitStatus: "committed",
      error: null,
      archived: false,
      lockbox: false,
      pinned: index === 1,
    }))

    fragments.push({
      id: "archived-1",
      content: "已归档的回归片段",
      createdAt: "2026-07-31T10:00:00.000Z",
      updatedAt: "2026-07-31T10:00:00.000Z",
      tags: ["inbox", "archive"],
      category: null,
      path: "fragments/2026/07/archived-1.md",
      gitStatus: "committed",
      error: null,
      archived: true,
      lockbox: false,
      pinned: false,
    })

    fragments.push({
      id: "lockbox-1",
      content: "密匣中的回归片段",
      createdAt: "2026-08-01T10:00:00.000Z",
      updatedAt: "2026-08-01T10:00:00.000Z",
      tags: ["inbox", "密匣"],
      category: null,
      path: "lockbox/lockbox-1.md",
      gitStatus: "committed",
      error: null,
      archived: false,
      lockbox: true,
      pinned: false,
    })

    const git = {
      branch: "main",
      shortCommit: "abc1234",
      hasRemote: true,
      status: "ready",
      error: null,
      ahead: 0,
      behind: 0,
    }
    const lockbox = {
      configured: true,
      unlocked: false,
      expiresAt: null,
      ttlSeconds: 180,
    }
    const state = {
      vaultPath: "/tmp/shard-ui-test-vault",
      fragments,
      git,
      lockbox,
    }
    const mapSummary = {
      id: "map-1",
      title: "测试导图",
      createdAt: now,
      updatedAt: now,
      nodeCount: 3,
      path: "maps/map-1.shardmap",
    }
    const mapFile = {
      kind: "shard.map",
      schemaVersion: 1,
      id: "map-1",
      title: "测试导图",
      createdAt: now,
      updatedAt: now,
      savedWithAppVersion: "0.1.3",
      revision: 1,
      rootId: "root",
      hasProtectedLinks: false,
      nodes: {
        root: {
          id: "root",
          parentId: null,
          sortKey: "a",
          text: "测试导图",
          createdAt: now,
          updatedAt: now,
        },
        child: {
          id: "child",
          parentId: "root",
          sortKey: "a",
          text: "迁移回归节点",
          width: 96,
          createdAt: now,
          updatedAt: now,
        },
        grandchild: {
          id: "grandchild",
          parentId: "child",
          sortKey: "a",
          text: "后续节点",
          width: 560,
          createdAt: now,
          updatedAt: now,
        },
      },
    }

    const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
    const commands: string[] = []
    const calls: Array<{ args: Record<string, unknown>; command: string }> = []

    Object.assign(globalThis, {
      isTauri: true,
      __SHARD_TEST_COMMANDS__: commands,
      __SHARD_TEST_CALLS__: calls,
      __TAURI_INTERNALS__: {
        invoke: async (command: string, args: Record<string, unknown> = {}) => {
          commands.push(command)
          calls.push({ command, args: clone(args) })

          switch (command) {
            case "list_fragments":
            case "set_vault_path":
            case "initialize_vault_git":
            case "set_vault_remote":
            case "create_github_vault_repo":
            case "lock_lockbox":
              return clone(state)
            case "list_mind_maps":
              return clone([mapSummary])
            case "read_mind_map":
              return {
                file: clone(mapFile),
                path: mapSummary.path,
                lastSavedHash: "map-hash",
              }
            case "write_mind_map":
              return {
                file: clone(args.file ?? mapFile),
                path: mapSummary.path,
                lastSavedHash: "map-hash-next",
              }
            case "create_mind_map":
              return {
                file: clone(mapFile),
                path: mapSummary.path,
                lastSavedHash: "map-hash",
              }
            case "create_fragment": {
              const created = {
                id: `fragment-created-${fragments.length + 1}`,
                content: String(args.content ?? ""),
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                tags: Array.isArray(args.tags) ? args.tags : ["inbox"],
                category: null,
                path: "fragments/2026/08/created.md",
                gitStatus: "committed",
                error: null,
                archived: false,
                lockbox: false,
                pinned: false,
              }
              fragments.unshift(created)
              return clone(created)
            }
            case "update_fragment": {
              const fragment = fragments.find((item) => item.id === args.id)
              if (!fragment) throw new Error("Fragment not found")
              fragment.content = String(args.content ?? fragment.content)
              fragment.tags = Array.isArray(args.tags)
                ? (args.tags as string[])
                : fragment.tags
              fragment.updatedAt = new Date().toISOString()
              return clone(fragment)
            }
            case "update_fragment_tags": {
              const fragment = fragments.find((item) => item.id === args.id)
              if (!fragment) throw new Error("Fragment not found")
              fragment.tags = Array.isArray(args.tags)
                ? (args.tags as string[])
                : fragment.tags
              return clone(fragment)
            }
            case "set_fragment_archived": {
              const fragment = fragments.find((item) => item.id === args.id)
              if (!fragment) throw new Error("Fragment not found")
              fragment.archived = Boolean(args.archived)
              return clone(fragment)
            }
            case "set_fragment_pinned": {
              const fragment = fragments.find((item) => item.id === args.id)
              if (!fragment) throw new Error("Fragment not found")
              fragment.pinned = Boolean(args.pinned)
              return clone(fragment)
            }
            case "move_fragment_to_lockbox":
              return clone(state)
            case "unlock_lockbox":
              lockbox.unlocked = true
              return clone(state)
            case "setup_lockbox":
            case "reset_lockbox_password":
              return { recoveryKey: "recovery-key", vault: clone(state) }
            case "change_lockbox_password":
              return clone(state)
            case "sync_vault":
              return clone(git)
            case "github_cli_status":
              return {
                installed: true,
                authenticated: true,
                login: "shard-test",
                protocol: "https",
                error: null,
              }
            case "ai_agent_statuses":
              return [
                { agent: "codex", installed: true, version: "codex-cli 0.146.0", path: "/tmp/codex", error: null },
                { agent: "claude", installed: true, version: "2.1.221", path: "/tmp/claude", error: null },
                { agent: "kimi", installed: true, version: "0.32.0", path: "/tmp/kimi", error: null },
                { agent: "opencode", installed: true, version: "1.18.0", path: "/tmp/opencode", error: null },
              ]
            case "run_ai_review_task":
              return { text: "测试洞察结果" }
            case "plugin:app|version":
              return "0.1.3"
            case "save_fragment_image":
              return "assets/test.png"
            case "read_fragment_image":
              return ""
            case "fragment_image_file_path":
              return "/tmp/shard-ui-test-vault/assets/test.png"
            case "set_window_controls_hidden":
            case "restore_window_frame":
            case "reveal_fragment_image_in_dir":
            case "save_recovery_key":
            case "save_exported_image":
            case "copy_exported_image":
              return null
            default:
              throw new Error(`Unhandled Tauri test command: ${command}`)
          }
        },
      },
    })
  })
}

test.beforeEach(async ({ page }) => {
  await installTauriMock(page)
  await page.goto("/")
  await expect(page.getByPlaceholder("想到什么，写什么...")).toBeFocused()
  await expect(page.locator("[data-shard-fragment-id]")).toHaveCount(24)
})

test("main shell keeps geometry and local scrolling", async ({ page }) => {
  const geometry = await page.evaluate(() => {
    const save = document.querySelector<HTMLButtonElement>(
      'button[aria-label="保存片段"]'
    )
    const textarea = document.querySelector<HTMLTextAreaElement>("textarea")
    const timeline = document.querySelector<HTMLElement>(
      '[data-slot="scroll-area-viewport"]'
    )
    const saveRect = save?.getBoundingClientRect()
    const textareaRect = textarea?.getBoundingClientRect()
    const timelineRect = timeline?.getBoundingClientRect()

    return {
      bodyOverflow: getComputedStyle(document.body).overflow,
      save: saveRect
        ? {
            height: saveRect.height,
            radius: getComputedStyle(save!).borderRadius,
            width: saveRect.width,
          }
        : null,
      textarea: textareaRect
        ? {
            radius: getComputedStyle(textarea!).borderRadius,
            width: textareaRect.width,
          }
        : null,
      timeline: timelineRect
        ? {
            height: timelineRect.height,
            overflowY: getComputedStyle(timeline!).overflowY,
          }
        : null,
    }
  })

  expect(geometry.bodyOverflow).toBe("hidden")
  expect(geometry.save).toEqual({ height: 32, radius: "4px", width: 32 })
  expect(geometry.textarea?.width).toBeGreaterThan(800)
  expect(geometry.textarea?.radius).toBe("6px 6px 0px 0px")
  expect(geometry.timeline?.height).toBeGreaterThan(300)
  expect(["auto", "scroll"]).toContain(geometry.timeline?.overflowY)
})

test("capture, card menu, and share dialog remain functional", async ({
  page,
}) => {
  const textarea = page.getByPlaceholder("想到什么，写什么...")
  await textarea.fill("迁移后的新片段 #work")
  await textarea.press("Control+Enter")

  await expect(page.locator("[data-shard-fragment-id]")).toHaveCount(25)
  await expect(page.getByText("迁移后的新片段")).toBeVisible()
  await expect(page.getByText("#work").first()).toBeVisible()
  await expect(page.getByText("片段已保存")).toBeVisible()

  const firstCard = page.locator("[data-shard-fragment-id]").first()
  await firstCard.getByRole("button", { name: "片段操作" }).click()
  await page.getByRole("menuitem", { name: "分享" }).click()

  const dialog = page.getByRole("dialog")
  await expect(
    dialog.getByRole("heading", { name: "导出分享图片" })
  ).toBeVisible()
  await expect(dialog.getByLabel("分享图片预览")).toBeVisible()

  const layout = await dialog.evaluate((element) => {
    const aside = element.querySelector<HTMLElement>("aside")
    const footerActions = element.querySelector<HTMLElement>("footer > div")

    return {
      dialog: { height: element.offsetHeight, width: element.offsetWidth },
      asideWidth: aside?.offsetWidth,
      footerGap: footerActions ? getComputedStyle(footerActions).gap : null,
    }
  })

  expect(layout.dialog.width).toBe(960)
  expect(layout.dialog.height).toBeLessThanOrEqual(760)
  expect(layout.asideWidth).toBe(240)
  expect(layout.footerGap).toBe("8px")

  await dialog.getByRole("button", { name: "取消" }).click()
  await expect(dialog).toBeHidden()
})

test("search and settings preserve Escape and focus contracts", async ({
  page,
}) => {
  await page.keyboard.press("Control+k")
  const search = page.getByRole("combobox", { name: "搜索笔记" })
  await expect(search).toBeFocused()
  await search.fill("work")

  await page.keyboard.press("Escape")
  await expect(search).toHaveValue("")
  await expect(page.getByRole("dialog")).toBeVisible()

  await page.keyboard.press("Escape")
  await expect(page.getByRole("dialog")).toBeHidden()
  await expect(page.getByPlaceholder("想到什么，写什么...")).toBeFocused()

  const utilityTrigger = page.locator(
    "[data-shard-utility-menu-trigger]:visible"
  )
  await utilityTrigger.click()
  await page.getByRole("menuitem", { name: "设置" }).click()
  await expect(page.getByRole("dialog")).toBeVisible()

  await page.keyboard.press("Escape")
  await expect(page.getByRole("dialog")).toBeHidden()
  await expect(utilityTrigger).toBeFocused()
})

test("lockbox and mind map editing preserve adaptive node geometry", async ({
  page,
}) => {
  await page.getByRole("button", { name: /^标签 \d+$/ }).click()
  await page.getByRole("button", { name: /密匣 已上锁/ }).click()
  await expect(
    page.getByRole("heading", { name: "解锁密匣" })
  ).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(page.getByRole("dialog")).toBeHidden()

  await page.getByRole("button", { name: /思维导图 1/ }).click()
  await page.getByLabel("打开思维导图：测试导图").click()
  await expect(page.getByLabel("思维导图编辑器")).toBeVisible()
  await page.setViewportSize({ height: 720, width: 900 })

  const childNode = page.locator('[data-mind-map-node="child"]')
  await childNode.dblclick()
  let nodeEditor = page.getByRole("textbox", { name: "导图节点" })
  await expect(nodeEditor).toBeFocused()
  await expect(nodeEditor).toHaveJSProperty("tagName", "TEXTAREA")

  await nodeEditor.press("Escape")
  await expect(nodeEditor).toBeHidden()
  await expect(page.getByLabel("思维导图编辑器")).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(page.getByLabel("思维导图编辑器")).toBeVisible()

  await childNode.dblclick()
  nodeEditor = page.getByRole("textbox", { name: "导图节点" })
  await expect(nodeEditor).toBeFocused()

  const initialBox = await nodeEditor.boundingBox()
  expect(initialBox).not.toBeNull()
  const moveHandle = page.getByRole("button", { name: "拖拽移动节点" })
  const initialTypography = await nodeEditor.evaluate((element) => {
    const style = getComputedStyle(element)
    return {
      clientHeight: element.clientHeight,
      fontSize: Number.parseFloat(style.fontSize),
      lineHeight: Number.parseFloat(style.lineHeight),
      paddingBottom: Number.parseFloat(style.paddingBottom),
      paddingTop: Number.parseFloat(style.paddingTop),
      scrollHeight: element.scrollHeight,
    }
  })
  const moveHandleBox = await moveHandle.boundingBox()
  expect(initialTypography.fontSize).toBeLessThan(13)
  expect(initialTypography.lineHeight).toBeLessThan(18)
  expect(initialTypography.scrollHeight).toBeLessThanOrEqual(
    initialTypography.clientHeight + 1
  )
  expect(
    Math.abs(initialTypography.paddingTop - initialTypography.paddingBottom)
  ).toBeLessThanOrEqual(0.1)
  const initialContentHeight =
    initialTypography.clientHeight -
    initialTypography.paddingTop -
    initialTypography.paddingBottom
  expect(
    Math.abs(initialContentHeight - initialTypography.lineHeight)
  ).toBeLessThanOrEqual(1)
  expect(moveHandleBox?.height ?? 32).toBeLessThan(32)

  await nodeEditor.fill("节点会随着文字数量持续增加而自动扩展")
  await expect
    .poll(async () => (await nodeEditor.boundingBox())?.width ?? 0)
    .toBeGreaterThan((initialBox?.width ?? 0) + 40)

  await nodeEditor.fill("自动扩展节点".repeat(12))
  await expect
    .poll(async () => (await nodeEditor.boundingBox())?.height ?? 0)
    .toBeGreaterThan((initialBox?.height ?? 0) + 8)
  const longTextOverflow = await nodeEditor.evaluate((element) => ({
    horizontal: element.scrollWidth - element.clientWidth,
    vertical: element.scrollHeight - element.clientHeight,
  }))
  expect(longTextOverflow.horizontal).toBeLessThanOrEqual(1)
  expect(longTextOverflow.vertical).toBeLessThanOrEqual(1)
  const longNodeText = await nodeEditor.inputValue()
  await nodeEditor.press("Shift+Enter")
  await expect(nodeEditor).toHaveValue(longNodeText)

  await page.getByLabel("思维导图编辑器").click({
    position: { x: 12, y: 12 },
  })
  await expect(nodeEditor).toBeHidden()
  expect(await childNode.locator("tspan").count()).toBeGreaterThan(1)
  const childRect = childNode.locator("rect").last()
  const grandchildRect = page
    .locator('[data-mind-map-node="grandchild"] rect')
    .last()
  const grandchildText = page.locator(
    '[data-mind-map-node="grandchild"] text'
  )
  // 基线由实测字形偏移的显式 y 给出，不再依赖 dominant-baseline / dy hack。
  await expect(grandchildText.locator("tspan").first()).not.toHaveAttribute(
    "dy",
    /.+/
  )
  const grandchildVerticalDelta = await grandchildText.evaluate((text) => {
    const node = text.closest("[data-mind-map-node]")
    const rect = node?.querySelector("rect")
    if (!rect) return Number.POSITIVE_INFINITY

    const textBox = text.getBoundingClientRect()
    const rectBox = rect.getBoundingClientRect()
    return Math.abs(
      textBox.top +
        textBox.height / 2 -
        (rectBox.top + rectBox.height / 2)
    )
  })
  expect(grandchildVerticalDelta).toBeLessThanOrEqual(2)
  const childRight =
    Number(await childRect.getAttribute("x")) +
    Number(await childRect.getAttribute("width"))
  const grandchildLeft = Number(await grandchildRect.getAttribute("x"))
  expect(grandchildLeft - childRight).toBeGreaterThanOrEqual(96)

  await page.keyboard.press("Control+Enter")
  await expect(page.getByLabel("打开思维导图：测试导图")).toBeVisible()
  expect(
    await page.evaluate(() =>
      (
        globalThis as typeof globalThis & {
          __SHARD_TEST_COMMANDS__?: string[]
        }
      ).__SHARD_TEST_COMMANDS__?.includes("write_mind_map")
    )
  ).toBe(true)
})

test("mind map canvas deletes nodes from selected state", async ({ page }) => {
  await page.getByRole("button", { name: /思维导图 1/ }).click()
  await page.getByLabel("打开思维导图：测试导图").click()
  await expect(page.getByLabel("思维导图编辑器")).toBeVisible()

  const childNode = page.locator('[data-mind-map-node="child"]')
  const grandchildNode = page.locator('[data-mind-map-node="grandchild"]')

  // 单击只是选中节点，不进入文本编辑，节点文字保持可见。
  await childNode.click()
  await expect(page.getByRole("textbox", { name: "导图节点" })).toBeHidden()
  await expect(childNode.locator("text")).toBeVisible()

  // Ctrl/⌘+Delete：只删节点本身，子节点上提到祖父节点下。
  await page.keyboard.press("Control+Delete")
  await expect(childNode).toBeHidden()
  await expect(grandchildNode).toBeVisible()

  // Delete：连子树删除。
  await grandchildNode.click()
  await page.keyboard.press("Delete")
  await expect(grandchildNode).toBeHidden()
})

test("mind map canvas context menu acts on nodes and multi-selection", async ({
  page,
}) => {
  await page.getByRole("button", { name: /思维导图 1/ }).click()
  await page.getByLabel("打开思维导图：测试导图").click()
  await expect(page.getByLabel("思维导图编辑器")).toBeVisible()

  const childNode = page.locator('[data-mind-map-node="child"]')
  const grandchildNode = page.locator('[data-mind-map-node="grandchild"]')

  // 右键空白画布不打开菜单。
  await page
    .getByLabel("思维导图编辑器")
    .click({ button: "right", position: { x: 12, y: 12 } })
  await expect(page.getByRole("menu")).toBeHidden()

  // 多选后右键集合内节点：保留多选，菜单按数量展示。
  await childNode.click()
  await grandchildNode.click({ modifiers: ["Meta"] })
  await grandchildNode.click({ button: "right" })
  await expect(
    page.getByRole("menuitem", { name: /删除 2 个节点及子节点/ })
  ).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(page.getByRole("menu")).toBeHidden()

  // 右键单选节点：仅删除节点本身，子节点上提。
  await childNode.click()
  await childNode.click({ button: "right" })
  await page
    .getByRole("menuitem", { name: /仅删除节点（子节点上提）/ })
    .click()
  await expect(childNode).toBeHidden()
  await expect(grandchildNode).toBeVisible()

  // 右键菜单连子树删除，destructive 项 hover 时有可见底色。
  await grandchildNode.click({ button: "right" })
  const destructiveItem = page.getByRole("menuitem", {
    name: /删除节点及子节点/,
  })
  await destructiveItem.hover()
  const destructiveHoverBg = await destructiveItem.evaluate(
    (element) => getComputedStyle(element).backgroundColor
  )
  expect(destructiveHoverBg).not.toBe("rgba(0, 0, 0, 0)")
  expect(destructiveHoverBg).not.toBe("transparent")
  await destructiveItem.click()
  await expect(grandchildNode).toBeHidden()
})

test("mind map canvas marquee selects nodes and space-drag pans", async ({
  page,
}) => {
  await page.getByRole("button", { name: /思维导图 1/ }).click()
  await page.getByLabel("打开思维导图：测试导图").click()
  const svg = page.getByLabel("思维导图编辑器")
  await expect(svg).toBeVisible()

  const childNode = page.locator('[data-mind-map-node="child"]')
  const grandchildNode = page.locator('[data-mind-map-node="grandchild"]')

  // 默认光标是箭头（选择工具），不是抓手。
  await expect(svg).toHaveCSS("cursor", "default")

  // 空白处拖出包围 child + grandchild 的选框，松开后两个节点都被选中。
  const childBox = (await childNode.boundingBox())!
  const grandchildBox = (await grandchildNode.boundingBox())!
  const left = Math.min(childBox.x, grandchildBox.x) - 30
  const top = Math.min(childBox.y, grandchildBox.y) - 30
  const right =
    Math.max(
      childBox.x + childBox.width,
      grandchildBox.x + grandchildBox.width
    ) + 30
  const bottom =
    Math.max(
      childBox.y + childBox.height,
      grandchildBox.y + grandchildBox.height
    ) + 30
  await page.mouse.move(left, top)
  await page.mouse.down()
  await page.mouse.move(right, bottom, { steps: 5 })
  await expect(page.locator('[data-mind-map-marquee="true"]')).toBeVisible()
  await page.mouse.up()

  // 框选只选中节点，不能带出原生文本选区（节点文字在非编辑态不可选）。
  const nativeSelection = await page.evaluate(
    () => window.getSelection()?.toString() ?? ""
  )
  expect(nativeSelection).toBe("")

  // 右键集合内节点：多选保留，菜单按 2 个节点展示。
  await grandchildNode.click({ button: "right" })
  await expect(
    page.getByRole("menuitem", { name: /删除 2 个节点及子节点/ })
  ).toBeVisible()
  await page.keyboard.press("Escape")

  // 按住空格 = 抓手工具，拖拽平移画布。
  const beforeViewBox = await svg.getAttribute("viewBox")
  await page.keyboard.down(" ")
  await expect(svg).toHaveCSS("cursor", "grab")
  await page.mouse.move(childBox.x + childBox.width / 2, bottom + 40)
  await page.mouse.down()
  await page.mouse.move(childBox.x + childBox.width / 2 + 120, bottom + 130, {
    steps: 5,
  })
  await page.mouse.up()
  await page.keyboard.up(" ")
  expect(await svg.getAttribute("viewBox")).not.toBe(beforeViewBox)

  // T0：适应屏幕按钮出现，点击后回到全图自适应视图。
  const fitButton = page.getByRole("button", { name: "适应屏幕" })
  await expect(fitButton).toBeVisible()
  await fitButton.click()
  expect(await svg.getAttribute("viewBox")).toBe(beforeViewBox)
})

test("mind map canvas collapses and expands subtrees", async ({ page }) => {
  await page.getByRole("button", { name: /思维导图 1/ }).click()
  await page.getByLabel("打开思维导图：测试导图").click()
  await expect(page.getByLabel("思维导图编辑器")).toBeVisible()

  const childNode = page.locator('[data-mind-map-node="child"]')
  const grandchildNode = page.locator('[data-mind-map-node="grandchild"]')
  const toggle = page.locator('[data-mind-map-collapse-toggle="child"]')

  // 有子节点的节点显示折叠钮；点击后子树收拢并显示计数。
  await expect(toggle).toBeVisible()
  await toggle.click()
  await expect(grandchildNode).toBeHidden()
  await expect(toggle.locator("text")).toHaveText("1")

  // 折叠态下 Tab 新增子节点：自动展开，新节点进入编辑。
  await childNode.click()
  await page.keyboard.press("Tab")
  await expect(grandchildNode).toBeVisible()
  await expect(page.getByRole("textbox", { name: "导图节点" })).toBeFocused()
  await expect(toggle.locator("text")).toHaveCount(0)

  // ⌘/ 快捷键折叠/展开。
  await page.keyboard.press("Escape")
  await childNode.click()
  await page.keyboard.press("Meta+/")
  await expect(grandchildNode).toBeHidden()
  await page.keyboard.press("Meta+/")
  await expect(grandchildNode).toBeVisible()
})

test("mind map workspace undo/redo restores deletions and merges typing", async ({
  page,
}) => {
  await page.getByRole("button", { name: /思维导图 1/ }).click()
  await page.getByLabel("打开思维导图：测试导图").click()
  await expect(page.getByLabel("思维导图编辑器")).toBeVisible()

  const childNode = page.locator('[data-mind-map-node="child"]')
  const grandchildNode = page.locator('[data-mind-map-node="grandchild"]')

  // 结构操作：删除子树 → ⌘Z 恢复 → ⇧⌘Z 再删。
  await childNode.click()
  await page.keyboard.press("Delete")
  await expect(childNode).toBeHidden()
  await expect(grandchildNode).toBeHidden()
  await page.keyboard.press("Meta+z")
  await expect(childNode).toBeVisible()
  await expect(grandchildNode).toBeVisible()
  await page.keyboard.press("Meta+Shift+z")
  await expect(childNode).toBeHidden()

  // 恢复后进入文本编辑。
  await page.keyboard.press("Meta+z")
  await expect(childNode).toBeVisible()
  const editor = page.getByRole("textbox", { name: "导图节点" })
  await childNode.dblclick()
  await expect(editor).toBeFocused()

  // 连续输入合并为一条历史；等自动保存落盘。
  const writeCount = () =>
    page.evaluate(
      () =>
        (
          globalThis as typeof globalThis & {
            __SHARD_TEST_COMMANDS__?: string[]
          }
        ).__SHARD_TEST_COMMANDS__?.filter((command) => command === "write_mind_map")
          .length ?? 0
    )
  await editor.fill("第一阶段")
  await expect.poll(writeCount, { timeout: 5000 }).toBeGreaterThan(0)

  // 保存后继续编辑是新的一步；⌘Z 回到刚保存的内容，不再触发写盘。
  await editor.fill("第一阶段改")
  const writesBeforeUndo = await writeCount()
  await page.keyboard.press("Meta+z")
  await expect(editor).toHaveValue("第一阶段")
  await page.waitForTimeout(1600)
  expect(await writeCount()).toBe(writesBeforeUndo)

  // 连续打字合并：一次 ⌘Z 直接回到编辑前文本。
  await editor.fill("迁移回归节点替换")
  await page.keyboard.press("Meta+z")
  await expect(editor).toHaveValue("第一阶段")
})

test("mind map canvas arrow keys navigate the tree", async ({ page }) => {
  await page.getByRole("button", { name: /思维导图 1/ }).click()
  await page.getByLabel("打开思维导图：测试导图").click()
  await expect(page.getByLabel("思维导图编辑器")).toBeVisible()

  const rootNode = page.locator('[data-mind-map-node="root"]')
  const childNode = page.locator('[data-mind-map-node="child"]')
  const grandchildNode = page.locator('[data-mind-map-node="grandchild"]')
  // 选中态的节点会比未选中多一个选框 rect。
  const selectedRects = (node: typeof childNode) => node.locator("rect")

  await childNode.click()
  await expect(selectedRects(childNode)).toHaveCount(2)

  // → 第一个子节点；← 父节点。
  await page.keyboard.press("ArrowRight")
  await expect(selectedRects(grandchildNode)).toHaveCount(2)
  await expect(selectedRects(childNode)).toHaveCount(1)
  await page.keyboard.press("ArrowLeft")
  await expect(selectedRects(childNode)).toHaveCount(2)
  await page.keyboard.press("ArrowLeft")
  await expect(selectedRects(rootNode)).toHaveCount(2)

  // 根节点无同级，↑ 落空不报错；→ 回到 child。
  await page.keyboard.press("ArrowUp")
  await expect(selectedRects(rootNode)).toHaveCount(2)
  await page.keyboard.press("ArrowRight")
  await expect(selectedRects(childNode)).toHaveCount(2)

  // Enter 建同级节点后，↑ 回到 child。
  await page.keyboard.press("Enter")
  const editor = page.getByRole("textbox", { name: "导图节点" })
  await expect(editor).toBeFocused()
  await page.keyboard.press("Escape")
  await page.keyboard.press("ArrowUp")
  await expect(selectedRects(childNode)).toHaveCount(2)

  // 折叠节点上 → = 展开。
  await page.keyboard.press("Meta+/")
  await expect(grandchildNode).toBeHidden()
  await page.keyboard.press("ArrowRight")
  await expect(grandchildNode).toBeVisible()
})

test("mind map canvas type-to-edit replaces node text", async ({ page }) => {
  await page.getByRole("button", { name: /思维导图 1/ }).click()
  await page.getByLabel("打开思维导图：测试导图").click()
  await expect(page.getByLabel("思维导图编辑器")).toBeVisible()

  const childNode = page.locator('[data-mind-map-node="child"]')
  const editor = page.getByRole("textbox", { name: "导图节点" })

  // 选中态敲可打印字符：覆盖原文本并进入编辑，光标在末尾可继续追加。
  await childNode.click()
  await page.keyboard.press("a")
  await expect(editor).toBeFocused()
  await expect(editor).toHaveValue("a")
  await page.keyboard.type("bc")
  await expect(editor).toHaveValue("abc")

  // 空格是抓手语义，不能触发 type-to-edit。
  await page.keyboard.press("Escape")
  await page.keyboard.press(" ")
  await expect(editor).toBeHidden()
})

test("mind map workspace keeps Tab focus out of global actions", async ({
  page,
}) => {
  await page.getByRole("button", { name: /思维导图 1/ }).click()
  await page.getByLabel("打开思维导图：测试导图").click()
  await expect(page.getByLabel("思维导图编辑器")).toBeVisible()

  // 未选中任何节点时按 Tab：焦点不得迁移到底部全局操作区按钮。
  await page.keyboard.press("Tab")
  const focusedTag = await page.evaluate(
    () => document.activeElement?.tagName ?? ""
  )
  expect(focusedTag).not.toBe("BUTTON")

  // 选中再取消选中后同样成立。
  await page.locator('[data-mind-map-node="child"]').click()
  await page.keyboard.press("Escape")
  await page.keyboard.press("Tab")
  const focusedTagAfter = await page.evaluate(
    () => document.activeElement?.tagName ?? ""
  )
  expect(focusedTagAfter).not.toBe("BUTTON")
})

test("insight workspace selects lenses and AI runners", async ({
  page,
}) => {
  await page.getByRole("button", { name: /洞察视角/ }).click()

  // 设置面板：分组单选列表，默认选中"默认洞察"；结果区标题常显。
  const defaultLens = page.getByRole("radio", { name: "默认洞察" })
  await expect(defaultLens).toHaveAttribute("aria-checked", "true")
  await expect(
    page.getByRole("heading", { name: "分析设置" })
  ).toBeVisible()
  await expect(
    page.getByRole("heading", { name: "洞察结果 · 默认洞察" })
  ).toBeVisible()
  await expect(page.getByText("尚未生成洞察")).toBeVisible()
  const runnerSelect = page.getByRole("combobox", { name: "AI 运行器" })
  await expect(runnerSelect).toHaveValue("codex")
  await expect(page.getByText("已识别 4/4")).toBeVisible()

  // 切换视角：摘要行跟随，已生成结果的来源标题不被牵连。
  const reverseLens = page.getByRole("radio", { name: "逆向思考" })
  await reverseLens.click()
  await expect(reverseLens).toHaveAttribute("aria-checked", "true")
  await expect(defaultLens).toHaveAttribute("aria-checked", "false")
  await expect(page.getByText(/反过来审视笔记中的默认假设/)).toBeVisible()
  await runnerSelect.selectOption("kimi")
  await expect(page.getByText("已就绪 · 0.32.0")).toBeVisible()

  // 运行洞察：结果区标题记录来源视角，文档渲染，保存入口在结果末尾。
  await page.getByRole("button", { name: "开始洞察" }).click()
  await expect(
    page.getByRole("heading", { name: "洞察结果 · 逆向思考 · Kimi Code" })
  ).toBeVisible()
  await expect(page.getByText("测试洞察结果")).toBeVisible()
  await expect(page.getByRole("button", { name: "保存为片段" })).toBeVisible()

  const request = await page.evaluate(() => {
    const calls = (globalThis as typeof globalThis & {
      __SHARD_TEST_CALLS__: Array<{ args: Record<string, unknown>; command: string }>
    }).__SHARD_TEST_CALLS__
    return calls.find((call) => call.command === "run_ai_review_task")
  })
  expect(request?.args).toMatchObject({
    request: { agent: "kimi", lens: "reverse", task: "insight" },
  })
})

test("small windows use bottom tabs without document scrolling", async ({
  page,
}) => {
  await page.setViewportSize({ height: 720, width: 820 })

  await expect(page.getByRole("navigation", { name: "Fragment filters" }))
    .toBeVisible()
  await expect(page.locator("aside").first()).toBeHidden()

  const overflow = await page.evaluate(() => ({
    body: getComputedStyle(document.body).overflow,
    root: getComputedStyle(document.querySelector("#root")!).overflow,
  }))
  expect(overflow).toEqual({ body: "hidden", root: "hidden" })
})




