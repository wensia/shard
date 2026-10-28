import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

// 网页版的 CSP 是 script-src 'self'（crates/shard-server 的安全响应头）：内联脚本会被浏览器拦掉，
// 端到端测试走 Vite 开发服务器、没有这条 CSP，测不出来，所以在这里卡住入口页。
describe("index.html", () => {
  it("不含内联脚本", () => {
    const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8")
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)]
    expect(scripts.length).toBeGreaterThan(0)
    for (const [, attributes, body] of scripts) {
      expect(attributes).toMatch(/\bsrc=/)
      expect(body.trim()).toBe("")
    }
  })
})
