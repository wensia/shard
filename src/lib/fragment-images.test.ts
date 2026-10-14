import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { vaultImageUrl } from "./fragment-images"

// isTauri() 看 globalThis.isTauri，convertFileSrc 取 window.__TAURI_INTERNALS__。
const globals = globalThis as unknown as Record<string, unknown>

describe("vaultImageUrl", () => {
  beforeEach(() => {
    globals.isTauri = true
    globals.window = {
      __TAURI_INTERNALS__: {
        convertFileSrc: (path: string, scheme: string) =>
          `${scheme}://localhost/${encodeURIComponent(path)}`,
      },
    }
  })

  afterEach(() => {
    delete globals.isTauri
    delete globals.window
  })

  it("routes vault paths through the shard-asset protocol", () => {
    expect(vaultImageUrl("notes/证件/营业执照 1.jpg")).toBe(
      `shard-asset://localhost/${encodeURIComponent("notes/证件/营业执照 1.jpg")}`
    )
    expect(vaultImageUrl(" assets/ab/x.png ")).toBe("shard-asset://localhost/assets%2Fab%2Fx.png")
  })

  it("keeps the attachment scheme for the backend to resolve", () => {
    const hash = "a".repeat(64)
    expect(vaultImageUrl(`shard-attachment:${hash}`)).toBe(
      `shard-asset://localhost/${encodeURIComponent(`shard-attachment:${hash}`)}`
    )
  })

  it("passes remote, data and blob addresses through untouched", () => {
    for (const source of ["https://e.com/a.png", "data:image/png;base64,AA", "blob:x", "//cdn/a.png"]) {
      expect(vaultImageUrl(source)).toBe(source)
    }
  })

  it("appends a cache-busting version only when given", () => {
    expect(vaultImageUrl("notes/a.png", "2026-10-15T00:00:00Z-12")).toBe(
      "shard-asset://localhost/notes%2Fa.png?v=2026-10-15T00%3A00%3A00Z-12"
    )
    expect(vaultImageUrl("notes/a.png", null)).toBe("shard-asset://localhost/notes%2Fa.png")
  })

  it("returns nothing outside the desktop runtime or for empty references", () => {
    expect(vaultImageUrl("   ")).toBe("")
    delete globals.isTauri
    expect(vaultImageUrl("notes/a.png")).toBe("")
  })
})
