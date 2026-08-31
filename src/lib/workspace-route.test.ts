import { describe, expect, it } from "vitest"

import {
  DEFAULT_WORKSPACE_ROUTE,
  isWorkspaceRoute,
  type WorkspaceRoute,
} from "@/workspace/route"

describe("WorkspaceRoute", () => {
  it.each<WorkspaceRoute>([
    DEFAULT_WORKSPACE_ROUTE,
    { space: "fragments", params: {} },
    { space: "library", params: {} },
    { space: "lockbox", params: {} },
    { space: "review", params: { mode: "insight" } },
  ])("remains pure data after JSON round-trip", (route) => {
    const restored: unknown = JSON.parse(JSON.stringify(route))

    expect(isWorkspaceRoute(restored)).toBe(true)
    expect(restored).toEqual(route)
  })

  it.each([
    null,
    { space: "fragments", params: { filter: "inbox" } },
    { space: "fragments", params: { filter: "tagged" } },
    { space: "fragments", params: { filter: "inbox", month: "2026-08" } },
    { space: "fragments", params: { month: "2026-08" } },
    { space: "fragments", params: { filter: "insight" } },
    // 密匣已从碎片 filter 提为一级空间，旧 localStorage 值必须回退默认路由
    { space: "fragments", params: { filter: "lockbox" } },
    { space: "lockbox", params: { noteId: "1" } },
    { space: "library", params: { noteId: "1" } },
    { space: "review", params: { mode: "archive" } },
    { space: "review", params: { mode: "walk" }, onOpen: () => undefined },
  ])("rejects invalid or non-route shapes", (value) => {
    expect(isWorkspaceRoute(value)).toBe(false)
  })
})
