import { expect, test, type Page } from "@playwright/test"

import { installContentTypesMock } from "./content-types-mock"

// 消息通知合同（src/lib/notify.tsx + src/components/ui/notice.css，kiln Toast / Feedback）：
// 轻量浮卡——弹层表面、标题用正文色、状态只由图标表达，失败加整圈细环；
// 不盖住底部状态栏；同类同标题合并；详情展开后堆叠重新测量。

async function boot(page: Page, mode: "light" | "dark") {
  await page.addInitScript((m) => localStorage.setItem("shard.colorMode", m), mode)
  await installContentTypesMock(page)
  await page.goto("/")
  await expect(page.locator('[data-shard-editor="composer"]')).toBeVisible()
}

type Notify = typeof import("../../src/lib/notify").notify

async function run(page: Page, script: (notify: Notify) => void) {
  await page.evaluate(async (source) => {
    const { notify } = await import(/* @vite-ignore */ "/src/lib/notify.tsx")
    new Function("notify", `(${source})(notify)`)(notify)
  }, script.toString())
}

function toast(page: Page, title: string) {
  return page.locator("[data-sonner-toast]").filter({ hasText: title })
}

/** 按 WCAG 相对亮度计算前景对背景的对比度（颜色由浏览器解析为 rgb）。 */
function contrast(page: Page, selector: string) {
  return page.evaluate((sel) => {
    const el = document.querySelector<HTMLElement>(sel)!
    const parse = (value: string) => {
      const probe = document.createElement("div")
      probe.style.color = value
      document.body.append(probe)
      const rgb = getComputedStyle(probe).color.match(/[\d.]+/g)!.slice(0, 3).map(Number)
      probe.remove()
      return rgb
    }
    const lum = ([r, g, b]: number[]) => [r, g, b]
      .map((c) => c / 255)
      .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
      .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0)
    const card = el.closest<HTMLElement>("[data-sonner-toast]")!
    const fg = lum(parse(getComputedStyle(el).color))
    const bg = lum(parse(getComputedStyle(card).backgroundColor))
    const [hi, lo] = fg > bg ? [fg, bg] : [bg, fg]
    return (hi + 0.05) / (lo + 0.05)
  }, selector)
}

for (const mode of ["light", "dark"] as const) {
  test(`${mode}：四种状态的标题与描述都达到正文对比度，状态只由图标着色`, async ({ page }) => {
    await boot(page, mode)
    await run(page, (notify) => {
      notify.success("思维导图已保存")
      notify.info("已记录，当前筛选下不可见")
      notify.warning("文档还在准备中", { description: "请稍后再试。" })
      notify.failure("图片上传失败", new Error("Permission denied (os error 13)"), { description: "原图仍在剪贴板。" })
    })
    await page.locator("[data-sonner-toast]").first().hover()

    for (const type of ["success", "info", "warning", "error"]) {
      const title = `[data-sonner-toast][data-type="${type}"] .kiln-notice-title`
      expect(await contrast(page, title)).toBeGreaterThanOrEqual(4.5)
      const titleColor = await page.locator(title).evaluate((el) => getComputedStyle(el).color)
      const iconColor = await page.locator(`[data-sonner-toast][data-type="${type}"] .kiln-notice-icon`)
        .evaluate((el) => getComputedStyle(el).color)
      expect(iconColor).not.toBe(titleColor)
    }
    expect(await contrast(page, '[data-sonner-toast][data-type="warning"] .kiln-notice-description')).toBeGreaterThanOrEqual(4.5)
    expect(await contrast(page, '[data-sonner-toast][data-type="error"] .kiln-notice-description')).toBeGreaterThanOrEqual(4.5)
  })
}

test("失败通知带整圈细环，关闭按钮静止时透明无边框", async ({ page }) => {
  await boot(page, "light")
  await run(page, (notify) => notify.failure("图片上传失败", new Error("EACCES")))
  const card = toast(page, "图片上传失败")
  await expect(card).toHaveAttribute("data-type", "error")
  expect(await card.evaluate((el) => getComputedStyle(el).boxShadow)).toMatch(/0px 0px 0px 1px/)
  const close = card.getByRole("button", { name: "关闭通知" })
  expect(await close.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgba(0, 0, 0, 0)")
  expect(await close.evaluate((el) => getComputedStyle(el).borderTopWidth)).toBe("0px")
})

test("通知堆叠不盖住底部状态栏", async ({ page }) => {
  await boot(page, "light")
  await run(page, (notify) => {
    notify.success("一")
    notify.success("二")
    notify.failure("三失败", new Error("x"))
  })
  await page.locator("[data-sonner-toast]").first().hover()
  const statusBarTop = await page.locator('[data-focus-region="status-bar"]').evaluate((el) => el.getBoundingClientRect().top)
  for (const box of await page.locator("[data-sonner-toast]").evaluateAll((els) => els.map((el) => el.getBoundingClientRect().bottom))) {
    expect(box).toBeLessThanOrEqual(statusBarTop)
  }
})

test("同类型同标题合并为一条，不同标题各自成条", async ({ page }) => {
  await boot(page, "light")
  await run(page, (notify) => {
    notify.failure("图片上传失败", new Error("a"))
    notify.failure("图片上传失败", new Error("b"))
    notify.success("图片上传失败")
  })
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(2)
})

test("详情折叠在正文下，展开后堆叠重新测量、不与下一条重叠，可复制", async ({ page }) => {
  await boot(page, "dark")
  await run(page, (notify) => {
    notify.failure("图片上传失败", new Error("Failed to write file /tmp/a.png: Permission denied"))
    notify.success("思维导图已保存")
  })
  const card = toast(page, "图片上传失败")
  await card.hover()
  await expect(card).not.toContainText("Permission denied")
  await card.getByRole("button", { name: "详情" }).click()
  await expect(card).toContainText("Permission denied")
  await expect(card.getByRole("button", { name: "收起详情" })).toHaveAttribute("aria-expanded", "true")
  await page.waitForTimeout(400)

  const rects = await page.locator("[data-sonner-toast]").evaluateAll((els) =>
    els.map((el) => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom } }))
  const sorted = rects.sort((a, b) => a.top - b.top)
  for (let i = 1; i < sorted.length; i += 1) expect(sorted[i].top).toBeGreaterThanOrEqual(sorted[i - 1].bottom)

  await page.context().grantPermissions(["clipboard-read", "clipboard-write"])
  await card.getByRole("button", { name: "复制详情" }).click()
  await expect(card.getByRole("button", { name: "已复制" })).toBeVisible()
})

test("动作按钮执行后关闭通知；折叠时后排通知内容隐藏", async ({ page }) => {
  await boot(page, "light")
  await run(page, (notify) => {
    notify.failure("导出失败", new Error("x"), {
      action: { label: "重试", onClick: () => { (window as unknown as { __retried: boolean }).__retried = true } },
    })
    notify.success("思维导图已保存")
  })
  const back = toast(page, "导出失败")
  await expect.poll(() => back.evaluate((el) => getComputedStyle(el.querySelector(".kiln-notice-title")!.parentElement!).opacity)).toBe("0")

  await page.locator("[data-sonner-toast]").first().hover()
  await back.getByRole("button", { name: "重试" }).click()
  await expect(back).toHaveCount(0)
  expect(await page.evaluate(() => (window as unknown as { __retried?: boolean }).__retried)).toBe(true)
})
