import { expect, test, type Locator } from "@playwright/test"

/** 等对话框的入场过渡跑完，再量几何。 */
async function settled(locator: Locator) {
  await locator.evaluate(node => Promise.all(node.getAnimations().map(animation => animation.finished)))
}

test.beforeEach(async ({ page }) => {
  // 日期 / 时间用例固定「今天」为 2024-02-10：日历打开即落在含闰日的月份，「今天」按钮结果可断言。
  // Select 用例保持真实时钟：假时钟会打乱它的按键时序判定。
  if (test.info().tags.includes("@fixed-clock")) await page.clock.setFixedTime(new Date(2024, 1, 10, 10, 0))
  await page.goto("/form-controls-test.html")
})

const FIXED_CLOCK = { tag: "@fixed-clock" }

test("自绘选项保留空值语义、标签、禁用与键盘，不触发父层快捷键", async ({ page }) => {
  const field = page.getByRole("combobox", { name: "字段", exact: true })
  await expect(field).toHaveText("未填写")
  await expect(page.locator("select,input[type=date],input[type=month],datalist")).toHaveCount(0)
  await field.focus(); await page.keyboard.press("Enter")
  await expect(page.getByRole("listbox")).toBeVisible()
  await page.keyboard.press("ArrowDown"); await page.keyboard.press("Enter")
  await expect(field).toHaveText("名称（主字段）")
  await expect(page.getByLabel("选择结果", { exact: true })).toHaveText("field-name")
  await field.focus(); await page.keyboard.press("Enter"); await expect(page.getByRole("listbox")).toBeVisible()
  await page.keyboard.press("ArrowDown"); await page.keyboard.press("Enter")
  await expect(field).toHaveText("名称（主字段）")
  await expect(page.getByRole("listbox")).toBeVisible()
  await page.keyboard.press("ArrowDown"); await page.keyboard.press("Enter")
  await expect(field).toHaveText("字段 1")
  await field.click(); await expect(page.getByRole("listbox")).toBeVisible(); await page.keyboard.press("Escape")
  await expect(field).toBeFocused()
  await expect(page.getByLabel("外层快捷键")).toHaveText("none")
  await expect(page.getByRole("combobox", { name: "禁用字段", exact: true })).toBeDisabled()
  await field.click(); await page.locator('[role="option"][data-value=""]').click()
  await expect(field).toHaveText("未填写")
})

test("真实DOM弹层具有Kiln样式并在窄窗口保留边界和长列表滚动", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 600 })
  const field = page.getByRole("combobox", { name: "字段", exact: true })
  const input = page.getByRole("textbox", { name: "参考输入框" })
  const styles = await field.evaluate(node => ({ radius: getComputedStyle(node).borderRadius, height: node.getBoundingClientRect().height, font: getComputedStyle(node).fontFamily }))
  expect(styles.radius).toBe("4px"); expect(styles.height).toBe(await input.evaluate(node => node.getBoundingClientRect().height)); expect(styles.font).toContain("Noto Sans SC")
  await field.click()
  const popup = page.locator('[data-slot="select-content"]')
  await expect(popup).toBeVisible()
  const rect = await popup.boundingBox(); const trigger = await field.boundingBox()
  expect(rect!.x).toBeGreaterThanOrEqual(0); expect(rect!.x + rect!.width).toBeLessThanOrEqual(390); expect(Math.abs(rect!.x - trigger!.x)).toBeLessThan(2)
  expect(await popup.evaluate(node => getComputedStyle(node).borderRadius)).toBe("6px")
  expect(await page.getByRole("listbox").evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true)
  await page.keyboard.press("End"); await page.keyboard.press("Enter")
  await expect(field).toContainText("字段 30")
  await field.click()
  await expect(page.locator('[role="option"][data-value="field-29"]')).toBeInViewport()
  await page.keyboard.press("Escape")
})

test("日期对话框保留空值、闰日、年份边界、清空与键盘选择", FIXED_CLOCK, async ({ page }) => {
  const trigger = page.getByRole("button", { name: "日期", exact: true })
  await expect(page.locator('input[type=date],input[type=time]')).toHaveCount(0)
  await trigger.click()
  const dialog = page.getByRole("dialog", { name: "日期", exact: true })
  await expect(dialog).toBeVisible()
  await expect(dialog.locator('[data-slot="picker-summary"]')).toHaveText(/已选日期\s*未选择/)
  await expect(dialog.getByText("2024 年 2 月", { exact: true })).toBeVisible()
  await expect(dialog.getByRole("button", { name: "清空", exact: true })).toBeDisabled()
  await expect(dialog.getByRole("button", { name: "关闭", exact: true })).toHaveCount(1)
  await expect(page.getByLabel("日期结果")).toHaveText("empty")
  await expect(dialog.getByRole("button", { name: "2024-02-10", exact: true })).toBeFocused()

  // 选中态：实心 primary + aria-pressed；非本月日期降为 45% 的 muted。
  await dialog.getByRole("button", { name: "2024-02-29", exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(trigger).toHaveText("2024-02-29"); await expect(trigger).toBeFocused()
  await trigger.click()
  const leap = dialog.getByRole("button", { name: "2024-02-29", exact: true })
  await expect(leap).toBeFocused(); await expect(leap).toHaveAttribute("aria-pressed", "true")
  await expect(dialog.locator('[data-slot="picker-summary"]')).toHaveText(/已选日期\s*2024-02-29/)
  const look = await dialog.evaluate(node => {
    const probe = document.createElement("span"); node.append(probe)
    const color = (value: string) => { probe.style.color = value; return getComputedStyle(probe).color }
    const selected = node.querySelector<HTMLElement>('[data-date="2024-02-29"]')!
    const outside = node.querySelector<HTMLElement>('[data-date="2024-03-01"]')!
    const summary = node.querySelector<HTMLElement>('[data-slot="picker-summary"]')!
    const result = {
      selectedBg: getComputedStyle(selected).backgroundColor, primary: color("var(--primary)"),
      outside: getComputedStyle(outside).color, outsideExpected: color("color-mix(in srgb, var(--muted-foreground) 45%, transparent)"),
      dayHeight: selected.offsetHeight, dayFont: getComputedStyle(selected).fontSize, dayWeight: getComputedStyle(selected).fontWeight,
      summaryRadius: getComputedStyle(summary).borderRadius, dialogRadius: getComputedStyle(node).borderRadius,
    }
    probe.remove(); return result
  })
  expect(look.selectedBg).toBe(look.primary); expect(look.outside).toBe(look.outsideExpected)
  expect(look).toMatchObject({ dayHeight: 36, dayFont: "14px", dayWeight: "400", summaryRadius: "8px", dialogRadius: "6px" })
  await page.keyboard.press("ArrowRight"); await page.keyboard.press("Enter")
  await expect(trigger).toHaveText("2024-03-01")

  // Shift+PageDown 跳一年、PageUp 退一月、End 到周日。
  await trigger.click(); await expect(dialog.getByRole("button", { name: "2024-03-01", exact: true })).toBeFocused()
  await page.keyboard.press("Shift+PageDown"); await expect(dialog.getByRole("button", { name: "2025-03-01", exact: true })).toBeFocused()
  await page.keyboard.press("PageUp"); await expect(dialog.getByRole("button", { name: "2025-02-01", exact: true })).toBeFocused()
  await page.keyboard.press("End"); await expect(dialog.getByRole("button", { name: "2025-02-02", exact: true })).toBeFocused()
  await page.keyboard.press("Home"); await expect(dialog.getByRole("button", { name: "2025-01-27", exact: true })).toBeFocused()
  await page.keyboard.press("Enter"); await expect(trigger).toHaveText("2025-01-27")

  // 年份边界：接近 0001 / 9999 的初始值，对应方向的箭头禁用。
  const earliest = page.getByRole("button", { name: "最早日期", exact: true })
  await earliest.click()
  const early = page.getByRole("dialog", { name: "最早日期", exact: true })
  await expect(early.getByText("0001 年 1 月", { exact: true })).toBeVisible()
  await expect(early.getByRole("button", { name: "上个月" })).toBeDisabled()
  await expect(early.getByRole("button", { name: "下个月" })).toBeEnabled()
  await early.getByRole("button", { name: "0001-01-01", exact: true }).click(); await expect(earliest).toHaveText("0001-01-01")
  const latest = page.getByRole("button", { name: "最晚日期", exact: true })
  await latest.click()
  const late = page.getByRole("dialog", { name: "最晚日期", exact: true })
  await expect(late.getByRole("button", { name: "下个月" })).toBeDisabled()
  await expect(late.getByRole("button", { name: "上个月" })).toBeEnabled()
  await late.getByRole("button", { name: "9999-12-31", exact: true }).click(); await expect(latest).toHaveText("9999-12-31")

  await trigger.click(); await dialog.getByRole("button", { name: "清空", exact: true }).click()
  await expect(dialog).toHaveCount(0); await expect(page.getByLabel("日期结果")).toHaveText("empty")
  await trigger.click(); await dialog.getByRole("button", { name: "今天", exact: true }).click()
  await expect(trigger).toHaveText("2024-02-10")
  await expect(page.getByLabel("外层快捷键")).toHaveText("none")
  await expect(page.getByRole("button", { name: "禁用日期", exact: true })).toBeDisabled()
})

test("时间对话框：手输回车确认、点小时保持打开、点分钟完成、清空", FIXED_CLOCK, async ({ page }) => {
  const trigger = page.getByRole("button", { name: "时间", exact: true })
  await trigger.click()
  const dialog = page.getByRole("dialog", { name: "时间", exact: true })
  await expect(dialog.locator('[data-slot="picker-summary"]')).toHaveText(/已选时间\s*未选择/)
  const input = dialog.getByRole("textbox", { name: "输入时间" })
  await expect(input).toBeFocused()
  for (const [text, expected] of [["9:05", "09:05"], ["0905", "09:05"], ["21:40", "21:40"]]) {
    if (!(await dialog.isVisible())) await trigger.click()
    await input.fill(text); await input.press("Enter")
    await expect(dialog).toHaveCount(0); await expect(trigger).toHaveText(expected)
  }
  await trigger.click()
  await expect(dialog.getByRole("group", { name: "小时" }).getByRole("button", { name: "21", exact: true })).toHaveAttribute("aria-pressed", "true")
  await input.fill("25:00"); await input.press("Enter")
  await expect(input).toHaveAttribute("aria-invalid", "true"); await expect(page.getByLabel("时间结果")).toHaveText("21:40")
  await dialog.getByRole("group", { name: "小时" }).getByRole("button", { name: "14", exact: true }).click()
  await expect(dialog).toBeVisible(); await expect(page.getByLabel("时间结果")).toHaveText("14:40")
  await dialog.getByRole("group", { name: "分钟" }).getByRole("button", { name: "30", exact: true }).click()
  await expect(dialog).toHaveCount(0); await expect(trigger).toHaveText("14:30"); await expect(trigger).toBeFocused()
  await trigger.click(); await dialog.getByRole("button", { name: "清空", exact: true }).click()
  await expect(page.getByLabel("时间结果")).toHaveText("empty")
  await expect(page.getByLabel("外层快捷键")).toHaveText("none")
})

test("父dialog内打开选择器，Escape与遮罩只关闭当前层，composition不提交", FIXED_CLOCK, async ({ page }) => {
  await page.getByRole("button", { name: "打开表单", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "控件弹窗" })
  const field = dialog.getByRole("combobox", { name: "弹窗字段" })
  await field.click(); await page.keyboard.press("ArrowDown")
  await page.locator('[role="option"][data-highlighted]').dispatchEvent("keydown", { key: "Enter", code: "Enter", keyCode: 229, isComposing: true })
  await expect(page.getByRole("listbox")).toBeVisible(); await expect(field).toHaveText("未填写")
  await page.keyboard.press("Escape"); await expect(dialog).toBeVisible(); await expect(field).toBeFocused()

  const dateTrigger = dialog.getByRole("button", { name: "弹窗日期" })
  await dateTrigger.click()
  const calendar = page.getByRole("dialog", { name: "弹窗日期", exact: true })
  await expect(calendar).toBeVisible()
  const focusedDay = calendar.getByRole("button", { name: "2024-02-10", exact: true })
  await expect(focusedDay).toBeFocused()
  await focusedDay.dispatchEvent("keydown", { key: "Enter", code: "Enter", keyCode: 229, isComposing: true })
  await focusedDay.dispatchEvent("keydown", { key: "Escape", code: "Escape", keyCode: 229, isComposing: true })
  await expect(calendar).toBeVisible(); await expect(page.getByLabel("日期结果")).toHaveText("empty")
  await page.keyboard.press("Escape")
  await expect(calendar).toHaveCount(0); await expect(dialog).toBeVisible(); await expect(dateTrigger).toBeFocused()

  // 点子对话框的遮罩：只关子层。
  await dateTrigger.click(); await expect(calendar).toBeVisible()
  await page.mouse.click(4, 4)
  await expect(calendar).toHaveCount(0); await expect(dialog).toBeVisible()

  const timeTrigger = dialog.getByRole("button", { name: "弹窗时间" })
  await timeTrigger.click()
  const clock = page.getByRole("dialog", { name: "弹窗时间", exact: true })
  const input = clock.getByRole("textbox", { name: "输入时间" })
  await input.fill("0930")
  await input.dispatchEvent("keydown", { key: "Enter", code: "Enter", keyCode: 229, isComposing: true })
  await expect(clock).toBeVisible(); await expect(page.getByLabel("时间结果")).toHaveText("empty")
  await page.keyboard.press("Escape")
  await expect(clock).toHaveCount(0); await expect(dialog).toBeVisible(); await expect(timeTrigger).toBeFocused()
  await expect(page.getByLabel("外层快捷键")).toHaveText("none")
})

test("窄窗口：日期对话框走底部抽屉完整显示，浏览月份不写入", FIXED_CLOCK, async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 600 })
  const trigger = page.getByRole("button", { name: "日期", exact: true })
  await trigger.click()
  const popup = page.locator('[data-slot="date-picker-content"]')
  await expect(popup).toBeVisible(); await settled(popup)
  const bounds = (await popup.boundingBox())!
  expect(bounds.x).toBeGreaterThanOrEqual(0)
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(320)
  expect(Math.abs(bounds.y + bounds.height - 600)).toBeLessThan(1)
  expect(await popup.evaluate(node => ({ scroll: node.scrollWidth <= node.clientWidth, height: node.scrollHeight <= node.clientHeight }))).toEqual({ scroll: true, height: true })
  expect(await popup.evaluate(node => getComputedStyle(node).borderBottomLeftRadius)).toBe("0px")
  await page.getByRole("button", { name: "下个月" }).click()
  await page.getByRole("button", { name: "下个月" }).click()
  await expect(popup.getByText("2024 年 4 月", { exact: true })).toBeVisible()
  await expect(page.getByLabel("日期结果")).toHaveText("empty")
  await page.keyboard.press("Escape")
  await expect(popup).toHaveCount(0)
  await expect(trigger).toBeFocused(); await expect(trigger).toHaveText("选择日期")
  await page.keyboard.press("Escape")
  await expect(page.getByLabel("外层快捷键")).toHaveText("Escape")
})
