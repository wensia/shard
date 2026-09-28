import { describe, expect, it } from "vitest"

import {
  DEFAULT_WORKSPACE_ROUTE,
  isWorkspaceRoute,
  normalizeWorkspaceRoute,
  type WorkspaceRoute,
} from "@/workspace/route"

describe("WorkspaceRoute", () => {
  it.each<WorkspaceRoute>([
    DEFAULT_WORKSPACE_ROUTE,
    { space: "fragments", params: {} },
    { space: "library", params: {} },
    { space: "calendar", params: {} },
    { space: "lockbox", params: {} },
    { space: "fragments", params: { view: "all" } },
    { space: "fragments", params: { view: "trash" } },
    { space: "fragments", params: { view: "tag", tag: "项目" } },
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
    { space: "fragments", params: { view: "unknown" } },
    { space: "fragments", params: { view: "tag" } },
    { space: "fragments", params: { view: "tag", tag: "" } },
    { space: "fragments", params: { view: "tag", tag: "项目", extra: true } },
    { space: "fragments", params: { view: "all", noteId: "1" } },
    // 密匣已从碎片 filter 提为一级空间，旧 localStorage 值必须回退默认路由
    { space: "fragments", params: { filter: "lockbox" } },
    { space: "lockbox", params: { noteId: "1" } },
    { space: "library", params: { noteId: "1" } },
    { space: "calendar", params: { date: "2026-09-26" } },
    { space: "review", params: { mode: "archive" } },
    { space: "review", params: { mode: "walk" }, onOpen: () => undefined },
  ])("rejects invalid or non-route shapes", (value) => {
    expect(isWorkspaceRoute(value)).toBe(false)
  })

  it.each(["dailyReview", "insight", "walk"])("falls back from removed %s routes", (mode) => {
    for (const route of [
      { space: "review", params: { mode } },
      { space: "fragments", params: { view: mode } },
    ]) {
      expect(isWorkspaceRoute(route)).toBe(false)
      expect(normalizeWorkspaceRoute(route)).toEqual(DEFAULT_WORKSPACE_ROUTE)
    }
  })

  it("rejects unknown legacy views without interpreting extra navigation state", () => {
    expect(normalizeWorkspaceRoute({ space: "review", params: { mode: "archive" } })).toEqual(DEFAULT_WORKSPACE_ROUTE)
    expect(normalizeWorkspaceRoute({ space: "review", params: { mode: "walk", noteId: "1" } })).toEqual(DEFAULT_WORKSPACE_ROUTE)
  })
})
