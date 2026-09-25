import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  readPublicOpenRecent,
  recordPublicOpen,
  removePublicOpen,
} from "@/lib/search-recent"
import { searchTargetKey, type SearchScope, type SearchTarget } from "@/lib/search-contract"

const vaultPath = "/vault"
const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage")

class MemoryStorage {
  readonly values = new Map<string, string>()

  getItem(key: string) {
    return this.values.get(key) ?? null
  }

  removeItem(key: string) {
    this.values.delete(key)
  }

  setItem(key: string, value: string) {
    this.values.set(key, value)
  }
}

function target(path: string, scope: SearchScope = "public"): SearchTarget {
  return {
    archived: false,
    key: searchTargetKey(vaultPath, scope, path),
    kind: "document",
    objectId: path,
    path,
    scope,
    vaultPath,
  }
}

describe("public open recent", () => {
  let storage: MemoryStorage

  beforeEach(() => {
    storage = new MemoryStorage()
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: storage,
    })
  })

  afterEach(() => {
    if (originalLocalStorage) {
      Object.defineProperty(globalThis, "localStorage", originalLocalStorage)
    } else {
      Reflect.deleteProperty(globalThis, "localStorage")
    }
  })

  it("lockbox_target_is_never_written_to_recent", () => {
    recordPublicOpen(target("lockbox/private.shard", "lockbox"), 100)

    expect(readPublicOpenRecent(vaultPath).size).toBe(0)
    expect(storage.values.size).toBe(0)
  })

  it("keeps only key and openedAt for the newest 30 public targets per vault", () => {
    for (let index = 0; index < 35; index += 1) {
      recordPublicOpen(target(`notes/${index}.md`), index)
    }

    const recent = readPublicOpenRecent(vaultPath)
    expect(recent.size).toBe(30)
    expect(recent.has(target("notes/34.md").key)).toBe(true)
    expect(recent.has(target("notes/0.md").key)).toBe(false)

    const stored = JSON.parse(Array.from(storage.values.values())[0]) as unknown[]
    expect(stored[0]).toEqual({ key: target("notes/34.md").key, openedAt: 34 })
  })

  it("removes deleted or privatized public targets", () => {
    const removed = target("notes/moved.md")
    const kept = target("notes/kept.md")
    recordPublicOpen(removed, 1)
    recordPublicOpen(kept, 2)

    removePublicOpen(vaultPath, removed.key)

    expect(Array.from(readPublicOpenRecent(vaultPath).keys())).toEqual([kept.key])
  })

  it("treats storage read and write failures as a disabled optional feature", () => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem() {
          throw new Error("blocked")
        },
        removeItem() {
          throw new Error("blocked")
        },
        setItem() {
          throw new Error("blocked")
        },
      },
    })

    expect(() => recordPublicOpen(target("notes/a.md"), 1)).not.toThrow()
    expect(readPublicOpenRecent(vaultPath).size).toBe(0)
    expect(() => removePublicOpen(vaultPath, target("notes/a.md").key)).not.toThrow()
  })
})
