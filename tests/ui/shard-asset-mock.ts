import type { Page } from "@playwright/test"

/** 1×1 透明 PNG。 */
export const ONE_PIXEL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="

/**
 * 测试浏览器里没有 Tauri 注册的 `shard-asset` 协议。各 spec 的 mock 让
 * `__TAURI_INTERNALS__.convertFileSrc` 返回同源地址：
 *   convertFileSrc: (path, scheme) => `/__${scheme ?? "asset"}/${encodeURIComponent(path)}`
 * 这里把这些请求接住回一张 1×1 PNG；
 * `missing` 里的引用回 404，用来测取图失败。
 */
export async function routeShardAssets(page: Page, options: { missing?: string[] } = {}) {
  const missing = new Set(options.missing ?? [])
  const requested: string[] = []
  await page.route("**/__shard-asset/**", async (route) => {
    const url = new URL(route.request().url())
    const reference = decodeURIComponent(url.pathname.replace(/^\/__shard-asset\//u, ""))
    requested.push(reference)
    if (missing.has(reference)) {
      await route.fulfill({ status: 404, body: "" })
      return
    }
    await route.fulfill({
      status: 200,
      contentType: "image/png",
      body: Buffer.from(ONE_PIXEL_PNG_BASE64, "base64"),
    })
  })
  return requested
}
