import { expect, test, type Locator } from "@playwright/test"

async function appearance(control: Locator) {
  return control.evaluate(node => {
    node.getAnimations().forEach(animation => animation.finish())
    const style = getComputedStyle(node)
    const probe = document.createElement("div")
    node.parentElement!.append(probe)
    const color = (value: string) => {
      probe.style.borderColor = value
      return getComputedStyle(probe).borderColor
    }
    const shadow = (value: string) => {
      probe.style.boxShadow = value
      return getComputedStyle(probe).boxShadow
    }
    const tokens = {
      input: color("var(--input)"),
      hover: color("color-mix(in oklab, var(--foreground) 25%, transparent)"),
      focus: color("color-mix(in oklab, var(--primary) 70%, transparent)"),
      error: color("var(--destructive)"),
      restingShadow: shadow("var(--shadow-input)"),
      focusShadow: shadow("var(--shadow-primary-focus)"),
    }
    probe.remove()
    return {
      border: style.borderColor,
      borderWidth: style.borderWidth,
      radius: style.borderRadius,
      outline: style.outlineStyle,
      shadow: style.boxShadow,
      rings: style.boxShadow.split(/,(?![^()]*\))/).filter(layer =>
        !layer.includes("rgba(0, 0, 0, 0)") && /0px 0px 0px \d+px/.test(layer)),
      tokens,
    }
  })
}

for (const mode of ["light", "dark"] as const) {
  test(`${mode}：单行和多行文本使用 Kiln 边框与单一柔和焦点环`, async ({ page }) => {
    await page.goto("/form-controls-test.html")
    await page.evaluate(dark => document.documentElement.classList.toggle("dark", dark), mode === "dark")
    for (const label of ["单行文本", "多行文本"]) {
      const field = page.getByLabel(label, { exact: true })
      await page.mouse.move(0, 0)
      const rest = await appearance(field)
      expect(rest.borderWidth).toBe("1px")
      expect(rest.radius).toBe("4px")
      expect(rest.border).toBe(rest.tokens.input)
      expect(rest.shadow).toContain(rest.tokens.restingShadow)

      await field.hover()
      await expect.poll(async () => (await appearance(field)).border).toBe(rest.tokens.hover)
      const size = await field.boundingBox()
      await field.click()
      expect((await appearance(field)).outline).toBe("none")
      expect((await appearance(field)).rings).toEqual([])
      await page.keyboard.press("Tab")
      await page.keyboard.press("Shift+Tab")
      await expect(field).toBeFocused()
      await expect.poll(async () => (await appearance(field)).border).toBe(rest.tokens.focus)
      const focused = await appearance(field)
      expect(focused.outline).toBe("none")
      expect(focused.shadow).toContain(focused.tokens.focusShadow)
      expect(focused.rings).toHaveLength(1)
      const focusedSize = await field.boundingBox()
      expect(focusedSize!.width).toBe(size!.width)
      expect(focusedSize!.height).toBe(size!.height)
      await page.getByRole("heading", { name: "共享表单控件" }).click()
    }
  })

  test(`${mode}：密码显隐按钮仅有内收细环，鼠标无高亮框且切换保留输入`, async ({ page }) => {
    await page.goto("/form-controls-test.html")
    await page.evaluate(dark => document.documentElement.classList.toggle("dark", dark), mode === "dark")
    const password = page.getByLabel("验收密码", { exact: true })
    await password.fill("fixture password")
    await page.keyboard.press("Tab")
    const toggle = page.getByRole("button", { name: "显示密码", exact: true })
    await expect(toggle).toBeFocused()
    const focused = await appearance(toggle)
    expect(focused.outline).toBe("none")
    expect(focused.rings).toHaveLength(1)
    expect(focused.rings[0]).toContain("inset")
    expect(focused.rings[0]).toContain("0px 0px 0px 1px")
    await toggle.press("Space")
    await expect(password).toHaveAttribute("type", "text")
    await expect(password).toHaveValue("fixture password")
    const hide = page.getByRole("button", { name: "隐藏密码", exact: true })
    await password.click()
    await hide.click()
    await expect(password).toBeFocused()
    await expect(password).toHaveAttribute("type", "password")
    expect((await appearance(toggle)).rings).toEqual([])
    for (const label of ["无效文本", "无效多行文本"]) {
      const invalid = page.getByLabel(label, { exact: true })
      await invalid.click()
      await page.keyboard.press("Tab")
      await page.keyboard.press("Shift+Tab")
      await expect(invalid).toBeFocused()
      const error = await appearance(invalid)
      expect(error.border).toBe(error.tokens.error)
      expect(error.outline).toBe("none")
      expect(error.rings).toHaveLength(1)
      expect(error.rings[0]).toContain("0px 0px 0px 3px")
      expect(error.shadow).toContain(error.tokens.restingShadow)
    }
    await expect(page.getByLabel("禁用文本", { exact: true })).toBeDisabled()
  })
}
