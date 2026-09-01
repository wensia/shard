import { describe, expect, it } from "vitest"

import { formatBytes, formatModifiedAt } from "./file-metadata"

describe("file metadata formatting", () => {
  it("formats byte sizes without adding a dependency", () => {
    expect(formatBytes(0)).toBe("0 B")
    expect(formatBytes(1024)).toBe("1.0 KB")
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB")
    expect(formatBytes(1024 * 1024 * 1024)).toBe("1.0 GB")
  })

  it("returns an empty label for missing or invalid timestamps", () => {
    expect(formatModifiedAt("")).toBe("")
    expect(formatModifiedAt("not-a-date")).toBe("")
  })
})
