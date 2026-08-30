export const WORKSPACE_ROUTE_STORAGE_KEY = "shard.workspace-route"

export type FragmentWorkspaceFilter =
  | "inbox"
  | "tagged"
  | "lockbox"
  | "archive"

export type ReviewWorkspaceMode = "dailyReview" | "insight" | "walk"

export type FragmentsRoute = {
  space: "fragments"
  params: { filter: FragmentWorkspaceFilter; month?: string }
}

export type LibraryRoute = {
  space: "library"
  params: Record<string, never>
}

export type ReviewRoute = {
  space: "review"
  params: { mode: ReviewWorkspaceMode }
}

export type WorkspaceRoute = FragmentsRoute | LibraryRoute | ReviewRoute

export const DEFAULT_WORKSPACE_ROUTE: WorkspaceRoute = {
  space: "fragments",
  params: { filter: "inbox" },
}

const FRAGMENT_FILTERS: readonly FragmentWorkspaceFilter[] = [
  "inbox",
  "tagged",
  "lockbox",
  "archive",
]

const REVIEW_MODES: readonly ReviewWorkspaceMode[] = [
  "dailyReview",
  "insight",
  "walk",
]

export function isWorkspaceRoute(value: unknown): value is WorkspaceRoute {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["space", "params"]) ||
    !isRecord(value.params)
  ) {
    return false
  }

  if (value.space === "fragments") {
    const hasMonth = Object.prototype.hasOwnProperty.call(value.params, "month")
    if (!hasOnlyKeys(value.params, hasMonth ? ["filter", "month"] : ["filter"])) {
      return false
    }

    if (
      typeof value.params.filter !== "string" ||
      !FRAGMENT_FILTERS.includes(value.params.filter as FragmentWorkspaceFilter)
    ) {
      return false
    }

    return !hasMonth || (
      value.params.filter === "inbox" &&
      typeof value.params.month === "string" &&
      /^\d{4}-(0[1-9]|1[0-2])$/u.test(value.params.month)
    )
  }

  if (value.space === "review") {
    return (
      hasOnlyKeys(value.params, ["mode"]) &&
      typeof value.params.mode === "string" &&
      REVIEW_MODES.includes(value.params.mode as ReviewWorkspaceMode)
    )
  }

  return value.space === "library" && hasOnlyKeys(value.params, [])
}

export function readWorkspaceRoute(): WorkspaceRoute {
  try {
    const serialized = window.localStorage.getItem(WORKSPACE_ROUTE_STORAGE_KEY)
    if (!serialized) return DEFAULT_WORKSPACE_ROUTE

    const route: unknown = JSON.parse(serialized)
    return isWorkspaceRoute(route) ? route : DEFAULT_WORKSPACE_ROUTE
  } catch {
    return DEFAULT_WORKSPACE_ROUTE
  }
}

export function writeWorkspaceRoute(route: WorkspaceRoute): void {
  if (!isWorkspaceRoute(route)) return

  try {
    window.localStorage.setItem(
      WORKSPACE_ROUTE_STORAGE_KEY,
      JSON.stringify(route)
    )
  } catch {
    // Storage can be unavailable (for example in a restricted webview).
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[]
) {
  const keys = Object.keys(value)
  return (
    keys.length === expectedKeys.length &&
    keys.every((key) => expectedKeys.includes(key))
  )
}
