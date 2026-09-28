import { expect, test, type Page } from "@playwright/test"

type FixtureOptions = { hideTags?: boolean; adapters?: boolean; callbackId?: string; defaultErrorFallback?: boolean }

type FixtureWindow = Window & {
  __markdownFixture: {
    render(kind: "content" | "document", content: string, options?: FixtureOptions): void
    unmount(): void
    toggles: number[]
    callbackIds: string[]
  }
  __markdownWorkers: {
    worker: Worker
    terminated: boolean
    pending: (() => void)[]
  }[]
  __holdMarkdownWorker: boolean
  __markdownContinuity: {
    nodes: Element[]
    removed: boolean
    loadingSeen: boolean
    observer: MutationObserver
  }
}

const fixturePath = "/packages/markdown/tests/fixture.html"

async function render(page: Page, kind: "content" | "document", content: string, options?: FixtureOptions) {
  await page.evaluate(({ kind, content, options }) => {
    (window as unknown as FixtureWindow).__markdownFixture.render(kind, content, options)
  }, { kind, content, options })
}

async function observeWorkers(page: Page) {
  await page.addInitScript(() => {
    const app = window as unknown as FixtureWindow
    app.__markdownWorkers = []
    app.__holdMarkdownWorker = true
    const NativeWorker = window.Worker
    window.Worker = class extends NativeWorker {
      record: FixtureWindow["__markdownWorkers"][number]
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options)
        this.record = { worker: this, terminated: false, pending: [] }
        app.__markdownWorkers.push(this.record)
      }
      postMessage(message: unknown, transfer: Transferable[] | StructuredSerializeOptions = []) {
        const send = () => super.postMessage(message, Array.isArray(transfer) ? { transfer } : transfer)
        if (app.__holdMarkdownWorker) this.record.pending.push(send)
        else send()
      }
      terminate() {
        this.record.terminated = true
        super.terminate()
      }
    }
  })
}

test.beforeEach(async ({ page }) => {
  await page.goto(fixturePath)
  await expect(page.getByRole("heading", { name: "Independent Markdown consumer" })).toBeVisible()
})

test("published components render document semantics and escape untrusted HTML without host imports", async ({ page }) => {
  const requests: string[] = []
  page.on("request", request => requests.push(request.url()))
  await page.reload()
  await expect(page.getByRole("heading", { name: "Independent Markdown consumer" })).toBeVisible()
  await render(page, "document", [
    "# 一级标题",
    "",
    "## 二级标题",
    "",
    "**粗体** 和 *斜体* 与 `源码` [文档](https://example.com/docs)",
    "",
    "- 第一项",
    "- 第二项",
    "",
    "1. 有序项目",
    "",
    "> 引用内容",
    "",
    "```html",
    "<img src=x onerror=alert(1)>",
    "```",
    "",
    "---",
    "",
    "<script>window.__markdownInjected=true</script>",
    "",
    "[危险](javascript:alert(1))",
  ].join("\n"))
  const consumer = page.getByTestId("consumer")
  await expect(consumer.getByRole("heading", { name: "一级标题", level: 1 })).toBeVisible()
  await expect(consumer.getByRole("heading", { name: "二级标题", level: 2 })).toBeVisible()
  await expect(consumer.locator("strong")).toHaveText("粗体")
  await expect(consumer.locator("em")).toHaveText("斜体")
  await expect(consumer.locator("ul > li")).toHaveText(["第一项", "第二项"])
  await expect(consumer.locator("ol > li")).toHaveText(["有序项目"])
  await expect(consumer.locator("blockquote")).toHaveText("引用内容")
  await expect(consumer.locator("pre code")).toHaveText("<img src=x onerror=alert(1)>")
  await expect(consumer.getByRole("separator")).toHaveCount(1)
  await expect(consumer.getByRole("link", { name: "文档" })).toHaveAttribute("href", "https://example.com/docs")
  await expect(consumer.locator("script, img, [onerror], a[href^='javascript:']")).toHaveCount(0)
  await expect(consumer).toContainText("<script>window.__markdownInjected=true</script>")
  expect(requests.filter(url => /\/src\/|@tauri-apps|@codemirror/.test(url))).toEqual([])
})

test("fragment tasks keep original source line indexes after hiding tags and parsing aligned tables", async ({ page }) => {
  await render(page, "content", [
    "#私有",
    "",
    "- [ ] 原始第三行 #工作",
    "| 名称 | 数量 |",
    "| :--- | ---: |",
    "| A\\|B | 3 |",
    "",
    "2. [x] 原始第八行",
    "**保留原文** ==保留荧光源码==",
  ].join("\n"), { hideTags: true })
  const consumer = page.getByTestId("consumer")
  await expect(consumer).not.toContainText("#私有")
  await expect(consumer).not.toContainText("#工作")
  await expect(consumer.locator("table tbody td").first()).toHaveText("A|B")
  await expect(consumer.locator("table thead th").first()).toHaveCSS("text-align", "left")
  await expect(consumer.locator("table thead th").last()).toHaveCSS("text-align", "right")
  await consumer.getByRole("button", { name: "标记为完成", exact: true }).click()
  await consumer.getByRole("button", { name: "标记为未完成", exact: true }).click()
  expect(await page.evaluate(() => (window as unknown as FixtureWindow).__markdownFixture.toggles)).toEqual([2, 7])
  await expect(consumer).toContainText("**保留原文** ==保留荧光源码==")
  await expect(consumer.locator("p > div, p table")).toHaveCount(0)
})

test("hard breaks keep visible rows and blank rows without exposing their markers", async ({ page }) => {
  const slash = "\\"
  await render(page, "content", `第一行${slash}\n${slash}\n第三行${slash}${slash}\n末行${slash}`, { hideTags: true })
  const body = page.getByTestId("consumer").locator(".md-content")
  await expect(body).toHaveText(`第一行\n\n第三行${slash}${slash}\n末行${slash}`)
  await expect(body).toHaveCSS("white-space", "pre-wrap")
  await render(page, "document", `第一行${slash}\n第二行`)
  await expect(page.getByTestId("consumer").locator(".md-paragraph")).toHaveText("第一行 第二行")
  await expect(page.getByTestId("consumer")).not.toContainText(slash)
})

test("task lines group into a card while a task with a note becomes its own memo card", async ({ page }) => {
  await render(page, "content", [
    "今天要做",
    "- [ ] 买菜",
    "  - [ ] 番茄",
    "- [x] 回邮件",
    "- [ ] 周会准备",
    "",
    "  带上数据表",
    "- [ ] 整理需求",
    "收尾",
  ].join("\n"))
  const consumer = page.getByTestId("consumer")
  const groups = consumer.locator(".shard-task-group")
  const memos = consumer.locator(".shard-task-memo")
  // Nested tasks stay in the task card; the note splits the memo off.
  await expect(groups).toHaveCount(2)
  await expect(memos).toHaveCount(1)
  await expect(groups.first()).toContainText("番茄")
  await expect(groups.first()).toContainText("回邮件")
  await expect(memos.locator(".shard-task-memo-detail")).toHaveText("带上数据表")
  await expect(groups.last()).toContainText("整理需求")
  await expect(consumer).toContainText("收尾")

  await memos.getByRole("button", { name: "标记为完成", exact: true }).click()
  await groups.last().getByRole("button", { name: "标记为完成", exact: true }).click()
  expect(await page.evaluate(() => (window as unknown as FixtureWindow).__markdownFixture.toggles)).toEqual([4, 7])
})

test("image, inline, and embed adapters work without vault or desktop APIs", async ({ page }) => {
  await render(page, "content", "普通首行\n![图片描述](attachments/example.png)\n![[data.csv]]\n[[local]]", { adapters: true })
  await expect(page.locator("[data-adapter-image]")).toHaveAttribute("data-adapter-image", "attachments/example.png")
  await expect(page.locator("[data-adapter-image]")).toHaveAttribute("data-line-index", "1")
  await expect(page.getByRole("img", { name: "图片描述" })).toBeVisible()
  await expect(page.locator("[data-adapter-embed]")).toHaveText("宿主数据预览")
  await expect(page.getByRole("link", { name: "本地链接" })).toHaveAttribute("href", "#local")
  await expect(page.getByTestId("consumer")).toContainText("普通首行")
})

test("standalone styles size task markers and keep wide tables inside narrow screens", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 })
  const columns = Array.from({ length: 12 }, (_, index) => `不能换行的长标题${index}`)
  await render(page, "content", [
    "- [ ] 任务正文",
    `| ${columns.join(" | ")} |`,
    `| ${columns.map(() => "---").join(" | ")} |`,
    `| ${columns.map(() => "数据").join(" | ")} |`,
  ].join("\n"))
  const table = page.getByRole("table")
  await expect(table).toBeVisible()
  const geometry = await table.evaluate(element => {
    const style = getComputedStyle(element)
    const checkbox = document.querySelector<HTMLElement>(".shard-task-checkbox")!
    const marker = document.querySelector<HTMLElement>(".shard-task-marker")!
    const checkboxBox = checkbox.getBoundingClientRect()
    const markerBox = marker.getBoundingClientRect()
    return {
      tableOverflow: style.overflowX,
      horizontalOverflow: element.scrollWidth > element.clientWidth,
      pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      tableFontSize: Number.parseFloat(style.fontSize),
      borderWidth: Number.parseFloat(getComputedStyle(checkbox).borderWidth),
      checkboxWidth: checkboxBox.width,
      checkboxHeight: checkboxBox.height,
      markerWidth: markerBox.width,
    }
  })
  expect(geometry.tableOverflow).toBe("auto")
  expect(geometry.horizontalOverflow).toBe(true)
  expect(geometry.pageOverflow).toBe(false)
  expect(geometry.tableFontSize).toBeGreaterThan(0)
  expect(geometry.borderWidth).toBeGreaterThan(0)
  expect(geometry.checkboxWidth).toBeCloseTo(geometry.checkboxHeight, 1)
  expect(geometry.checkboxWidth).toBeGreaterThan(0)
  expect(geometry.markerWidth).toBeGreaterThan(geometry.checkboxWidth)
  await table.evaluate(element => { element.scrollLeft = element.scrollWidth })
  expect(await table.evaluate(element => element.scrollLeft)).toBeGreaterThan(0)
})

for (const kind of ["content", "document"] as const) {
  test(`${kind} parses over 32k in a real Worker and only displays the latest content`, async ({ page }) => {
    await observeWorkers(page)
    await page.reload()
    await expect(page.getByRole("heading", { name: "Independent Markdown consumer" })).toBeVisible()
    const oldContent = "过期正文\n\n" + "旧内容 ".repeat(9_000)
    const latestContent = "最新正文\n\n" + "新内容 ".repeat(9_000)
    await render(page, kind, oldContent)
    await expect(page.getByTestId("loading")).toBeVisible()
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(1)
    await expect.poll(() => page.evaluate(() => (window as unknown as FixtureWindow).__markdownWorkers.length)).toBe(1)
    await render(page, kind, latestContent)
    await expect.poll(() => page.evaluate(() => (window as unknown as FixtureWindow).__markdownWorkers.length)).toBe(2)
    expect(await page.evaluate(() => (window as unknown as FixtureWindow).__markdownWorkers[0].terminated)).toBe(true)
    await page.evaluate(() => {
      const app = window as unknown as FixtureWindow
      app.__holdMarkdownWorker = false
      for (const send of app.__markdownWorkers.at(-1)!.pending.splice(0)) send()
    })
    await expect(page.getByTestId("loading")).toHaveCount(0)
    await expect(page.getByTestId("consumer")).toContainText("最新正文")
    await expect(page.getByTestId("consumer")).not.toContainText("过期正文")
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0)
    await render(page, kind, "最新短文")
    await expect(page.getByTestId("consumer")).toHaveText("最新短文")
    await page.evaluate(() => {
      for (const send of (window as unknown as FixtureWindow).__markdownWorkers[0].pending.splice(0)) send()
    })
    await expect(page.getByTestId("consumer")).toHaveText("最新短文")
  })
}

test("unmounting pending work terminates its Worker and cannot reinsert stale content", async ({ page }) => {
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await observeWorkers(page)
  await page.reload()
  await expect(page.getByRole("heading", { name: "Independent Markdown consumer" })).toBeVisible()
  await render(page, "content", "卸载中的正文 ".repeat(8_000))
  await expect(page.getByTestId("loading")).toBeVisible()
  await page.evaluate(() => (window as unknown as FixtureWindow).__markdownFixture.unmount())
  expect(await page.evaluate(() => (window as unknown as FixtureWindow).__markdownWorkers.every(worker => worker.terminated))).toBe(true)
  await page.evaluate(() => {
    for (const worker of (window as unknown as FixtureWindow).__markdownWorkers) {
      for (const send of worker.pending.splice(0)) send()
    }
  })
  await expect(page.locator("#root")).toBeEmpty()
  await render(page, "document", "# 重新挂载")
  await expect(page.getByRole("heading", { name: "重新挂载" })).toBeVisible()
  expect(errors).toEqual([])
})

test("same-content callback updates preserve long-document nodes and use the latest task callback", async ({ page }) => {
  const content = [
    "- [x] 保留任务状态",
    "![保留图片](attachments/preserved.png)",
    "[[local]]",
    ...Array.from({ length: 1_200 }, (_, index) => `第${index}行 正文持续显示且无需重新解析 Markdown。`),
  ].join("\n")
  expect(content.length).toBeGreaterThan(32_000)
  await render(page, "content", content, { adapters: true, callbackId: "before" })
  const image = page.locator("[data-adapter-image]")
  const task = page.getByRole("button", { name: "标记为未完成", exact: true })
  await expect(image).toHaveAttribute("data-callback-id", "before")
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0)
  await expect(task).toHaveAttribute("aria-pressed", "true")
  await page.evaluate(() => {
    const root = document.getElementById("root")!
    const nodes = [
      root.querySelector("[data-adapter-image]")!,
      root.querySelector(".md-task-toggle")!,
      root.querySelector("[data-adapter-inline]")!,
    ]
    const state = {
      nodes,
      removed: false,
      loadingSeen: false,
      observer: new MutationObserver(records => {
        for (const record of records) {
          for (const removed of record.removedNodes) {
            if (nodes.some(node => removed === node || removed.contains(node))) state.removed = true
          }
          for (const added of record.addedNodes) {
            if (added instanceof Element && (added.matches('[data-testid="loading"]') || added.querySelector('[data-testid="loading"]'))) state.loadingSeen = true
          }
        }
      }),
    }
    state.observer.observe(root, { childList: true, subtree: true })
    ;(window as unknown as FixtureWindow).__markdownContinuity = state
  })
  await render(page, "content", content, { adapters: true, callbackId: "after" })
  await expect(image).toHaveAttribute("data-callback-id", "after")
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0)
  await expect(page.getByTestId("loading")).toHaveCount(0)
  await expect(task).toHaveAttribute("aria-pressed", "true")
  await task.click()
  expect(await page.evaluate(() => (window as unknown as FixtureWindow).__markdownFixture.callbackIds)).toEqual(["after"])
  expect(await page.evaluate(() => {
    const state = (window as unknown as FixtureWindow).__markdownContinuity
    state.observer.disconnect()
    return { removed: state.removed, loadingSeen: state.loadingSeen, allConnected: state.nodes.every(node => node.isConnected) }
  })).toEqual({ removed: false, loadingSeen: false, allConnected: true })
})

for (const kind of ["content", "document"] as const) {
  test(`${kind} Worker constructor failure safely displays source or the custom error fallback`, async ({ page }) => {
    await page.evaluate(() => {
      Object.defineProperty(window, "Worker", {
        configurable: true,
        value: class {
          constructor() { throw new Error("Workers are unavailable in this consumer") }
        },
      })
    })
    const content = "<img src=x onerror=alert(1)>\n<script>window.__injected=true</script>\n" + "正文 ".repeat(12_000)
    await render(page, kind, content, { defaultErrorFallback: true })
    const failed = page.locator('[data-markdown-error="true"]')
    await expect(failed).toBeVisible()
    expect(await failed.textContent()).toBe(content)
    await expect(failed.locator("img, script, [onerror]")).toHaveCount(0)
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0)
    await expect(page.getByTestId("error")).toHaveCount(0)
    await render(page, kind, content)
    await expect(page.getByTestId("error")).toHaveText("解析失败")
    await expect(failed).not.toContainText("<img")
    await render(page, kind, "短文仍可使用")
    await expect(page.getByTestId("consumer")).toHaveText("短文仍可使用")
    await expect(page.locator('[data-markdown-error="true"]')).toHaveCount(0)
  })
}

test("an embed mistaken for a table header does not consume following lines or the next real table", async ({ page }) => {
  await render(page, "content", [
    "![[data.csv|预览]]",
    "| --- | --- |",
    "| 应保留甲 | 应保留乙 |",
    "",
    "| 真实列甲 | 真实列乙 |",
    "| --- | ---: |",
    "| 真实数据甲 | 真实数据乙 |",
  ].join("\n"), { adapters: true })
  const consumer = page.getByTestId("consumer")
  await expect(consumer.locator("[data-adapter-embed]")).toHaveCount(1)
  await expect(consumer).toContainText("| --- | --- |")
  await expect(consumer).toContainText("| 应保留甲 | 应保留乙 |")
  await expect(consumer.locator("table")).toHaveCount(1)
  await expect(consumer.locator("thead th")).toHaveText(["真实列甲", "真实列乙"])
  await expect(consumer.locator("tbody td")).toHaveText(["真实数据甲", "真实数据乙"])
  await expect(consumer.locator("thead th").last()).toHaveCSS("text-align", "right")
})
