import { fork, type ChildProcess } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { chromium, expect, test, webkit, type Browser } from "@playwright/test"

import { fillEditor, readEditor, readEditorSnapshot, selectRange, typeEditor } from "./editor-helpers"

const projectRoot = fileURLToPath(new URL("../../", import.meta.url))
const serverFixture = path.join(projectRoot, "tests/fixtures/editor-hmr/server.mjs")

async function stopServer(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 5_000)
    child.once("exit", () => { clearTimeout(timer); resolve() })
    if (child.connected) child.send({ type: "close" })
    else child.kill("SIGTERM")
  })
}

// Both engines run under the normal test:ui command; the isolated page mounts
// the real editor only and has no Tauri bridge or vault.
for (const engine of [chromium, webkit]) {
  test(`${engine.name()} 预览热更新保留视图、草稿、选区和撤销并替换旧 checkbox`, async ({}, testInfo) => {
    test.setTimeout(60_000)
    const cache = await mkdtemp(path.join(tmpdir(), "shard-preview-hmr-"))
    const child = fork(serverFixture, [cache], {
      cwd: projectRoot, execArgv: [], stdio: ["ignore", "pipe", "pipe", "ipc"],
    })
    let output = ""
    child.stdout?.on("data", (chunk) => { output += chunk.toString() })
    child.stderr?.on("data", (chunk) => { output += chunk.toString() })
    const ready = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Isolated Vite startup timed out\n${output}`)), 20_000)
      child.once("error", (error) => { clearTimeout(timer); reject(error) })
      child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Isolated Vite exited (${code})\n${output}`)) })
      child.on("message", (message: { type: string; url: string }) => {
        if (message.type === "ready") { clearTimeout(timer); resolve(message.url) }
      })
    })
    let browser: Browser | undefined
    try {
      const url = await ready
      browser = await engine.launch()
      const page = await browser.newPage({ viewport: { width: 960, height: 600 }, locale: "zh-CN" })
      const errors: string[] = []
      page.on("pageerror", (error) => errors.push(error.message))
      await page.goto(url)
      const editor = page.locator('[data-shard-editor="hmr"]')
      await expect(editor.locator(".cm-content")).toBeVisible()
      const original = "- [ ] 原有草稿"
      await fillEditor(page, "hmr", original)
      await typeEditor(page, "hmr", "补充")
      await selectRange(page, "hmr", 6, 8)
      const before = await readEditorSnapshot(page, "hmr")
      await expect(editor.getByRole("checkbox")).toHaveCount(1)
      await expect(editor.locator(".shard-cm-task-marker")).toHaveCount(0)
      await expect(editor.locator(".cm-line")).toHaveText("-  原有草稿补充")
      await page.evaluate(() => {
        const state = window as unknown as { __hmrHandle: { view: unknown }; __hmrBeforeView: unknown }
        state.__hmrBeforeView = state.__hmrHandle.view
      })
      await editor.screenshot({ path: testInfo.outputPath("before-update.png") })

      // Notify only this isolated server; production source and the user's server
      // are untouched. Vite supplies the real dependency HMR message and module.
      child.send({ type: "update" })
      await expect(editor.locator(".shard-cm-task-marker")).toHaveCount(1)
      await expect(editor.locator(".cm-line")).toHaveText("原有草稿补充")
      expect(await readEditorSnapshot(page, "hmr")).toEqual(before)
      expect(await page.evaluate(() => {
        const state = window as unknown as { __hmrHandle: { view: unknown }; __hmrBeforeView: unknown }
        return state.__hmrHandle.view === state.__hmrBeforeView
      })).toBe(true)
      const geometry = await editor.locator(".cm-line").evaluate((line) => {
        const checkbox = line.querySelector('[role="checkbox"]')!
        const box = checkbox.getBoundingClientRect()
        const row = line.getBoundingClientRect()
        return {
          width: box.width, height: box.height,
          left: box.left - row.left, top: box.top - row.top,
          bottom: row.bottom - box.bottom,
          position: getComputedStyle(checkbox).position,
        }
      })
      expect(geometry.width).toBeGreaterThan(0)
      expect(geometry.width).toBeCloseTo(geometry.height, 1)
      expect(geometry.left).toBeCloseTo(8, 1)
      expect(geometry.top).toBeGreaterThanOrEqual(0)
      expect(geometry.bottom).toBeGreaterThanOrEqual(0)
      expect(geometry.position).not.toBe("absolute")
      await testInfo.attach("checkbox-geometry", { body: JSON.stringify(geometry, null, 2), contentType: "application/json" })
      await page.evaluate(() => (window as unknown as { __hmrUndo(): void }).__hmrUndo())
      expect(await readEditor(page, "hmr")).toBe(original)
      await page.evaluate(() => (window as unknown as { __hmrRedo(): void }).__hmrRedo())
      expect(await readEditor(page, "hmr")).toBe(before.value)
      await editor.screenshot({ path: testInfo.outputPath("after-update.png") })

      // New instances also use the latest accepted factory, rather than the
      // original ES module binding retained by the dependency accept callback.
      await page.evaluate(() => (window as unknown as { __hmrRemount(): void }).__hmrRemount())
      await expect(editor.locator(".cm-content")).toHaveText("")
      await fillEditor(page, "hmr", original)
      await expect(editor.locator(".shard-cm-task-marker")).toHaveCount(1)
      expect(errors).toEqual([])
    } finally {
      await browser?.close()
      await stopServer(child)
      await rm(cache, { recursive: true, force: true })
      await testInfo.attach("isolated-vite-log", { body: output, contentType: "text/plain" })
    }
  })
}
