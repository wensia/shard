import { describe, expect, it } from "vitest"

import { isLocalImageRef, isRemoteImageRef, parseCellImageRefs } from "./cell-image-refs"

describe("cell image refs", () => {
  it("recognises vault paths, legacy attachments and remote image URLs", () => {
    for (const local of ["notes/证件/营业执照 1.jpg", "./notes/a.PNG", "assets/ab/abc.png", "assets/2026/06/x-png", "a.heic", `shard-attachment:${"a".repeat(64)}`]) {
      expect(isLocalImageRef(local), local).toBe(true)
    }
    for (const notLocal of ["", "https://e.com/a.png", "/etc/a.png", "#a.png", "notes/a.md", "notes/../a.png", "notes\\a.png", ".png", "shard-attachment:abc"]) {
      expect(isLocalImageRef(notLocal), notLocal).toBe(false)
    }
    expect(isRemoteImageRef("https://cdn.example.com/p/1.webp?w=200")).toBe(true)
    expect(isRemoteImageRef("https://example.com/page")).toBe(false)
    expect(isRemoteImageRef("ftp://example.com/a.png")).toBe(false)
  })

  it("treats a cell as images only when every non-empty line is one", () => {
    expect(parseCellImageRefs("notes/a.png\n./assets/ab/c.jpg\n")).toEqual(["notes/a.png", "assets/ab/c.jpg"])
    expect(parseCellImageRefs("https://e.com/a.png")).toEqual(["https://e.com/a.png"])
    expect(parseCellImageRefs("notes/a.png\n说明文字")).toBeNull()
    expect(parseCellImageRefs("12.5")).toBeNull()
    expect(parseCellImageRefs("   ")).toBeNull()
    expect(parseCellImageRefs("")).toBeNull()
  })
})
