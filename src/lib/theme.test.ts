import { beforeEach, afterEach, expect, it, vi } from "vitest"

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => false }))

beforeEach(() => { vi.resetModules() })
afterEach(() => { vi.unstubAllGlobals() })

function environment(dark = false) {
  const classes = new Set<string>()
  const query = Object.assign(new EventTarget(), { matches: dark })
  const nativeWindow = Object.assign(new EventTarget(), { matchMedia: () => query })
  const stored = new Map<string, string>()
  const storage = {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => { stored.set(key, value) },
  }
  vi.stubGlobal("window", nativeWindow)
  vi.stubGlobal("localStorage", storage)
  vi.stubGlobal("document", { documentElement: { classList: {
    toggle(name: string, enabled: boolean) { if (enabled) classes.add(name); else classes.delete(name) },
  } } })
  return { nativeWindow, query, classes, stored, storage }
}

it("publishes the explicit color-mode choice after updating the page", async () => {
  const env = environment()
  const theme = await import("./theme")
  const seen: unknown[] = []
  env.nativeWindow.addEventListener(theme.COLOR_MODE_CHANGED_EVENT, (event) => seen.push((event as CustomEvent).detail))
  theme.applyColorMode("dark")
  expect(env.classes.has("dark")).toBe(true)
  expect(env.stored.get("shard.colorMode")).toBe("dark")
  expect(seen).toEqual([{ mode: "dark" }])
})

it("keeps system as the choice when the OS currently uses dark mode", async () => {
  const env = environment(true)
  const theme = await import("./theme")
  const seen: unknown[] = []
  env.nativeWindow.addEventListener(theme.COLOR_MODE_CHANGED_EVENT, (event) => seen.push((event as CustomEvent).detail))
  theme.applyColorMode("system")
  expect(env.classes.has("dark")).toBe(true)
  expect(seen).toEqual([{ mode: "system" }])
  env.query.matches = false
  env.query.dispatchEvent(new Event("change"))
  expect(env.classes.has("dark")).toBe(false)
  expect(theme.getStoredColorMode()).toBe("system")
})

it("notifies the host even if persisting the preference is unavailable", async () => {
  const env = environment()
  vi.spyOn(env.storage, "setItem").mockImplementation(() => { throw new Error("unavailable") })
  const theme = await import("./theme")
  const seen: unknown[] = []
  env.nativeWindow.addEventListener(theme.COLOR_MODE_CHANGED_EVENT, (event) => seen.push((event as CustomEvent).detail))
  theme.applyColorMode("light")
  expect(env.classes.has("dark")).toBe(false)
  expect(seen).toEqual([{ mode: "light" }])
})
