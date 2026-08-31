export const WORKSPACE_ROUTE_STORAGE_KEY = "shard.workspace-route"

export type ReviewWorkspaceMode = "dailyReview" | "insight" | "walk"

export type FragmentsRoute = {
  space: "fragments"
  params: Record<string, never>
}

export type LibraryRoute = {
  space: "library"
  params: Record<string, never>
}

/** 密匣一级空间：入口是资料库树上的上锁挂载点，安全区跟这个空间走。 */
export type LockboxRoute = {
  space: "lockbox"
  params: Record<string, never>
}

export type ReviewRoute = {
  space: "review"
  params: { mode: ReviewWorkspaceMode }
}

export type WorkspaceRoute =
  | FragmentsRoute
  | LibraryRoute
  | LockboxRoute
  | ReviewRoute

export const DEFAULT_WORKSPACE_ROUTE: WorkspaceRoute = {
  space: "fragments",
  params: {},
}

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

  if (value.space === "review") {
    return (
      hasOnlyKeys(value.params, ["mode"]) &&
      typeof value.params.mode === "string" &&
      REVIEW_MODES.includes(value.params.mode as ReviewWorkspaceMode)
    )
  }

  return (
    (value.space === "fragments" ||
      value.space === "library" ||
      value.space === "lockbox") &&
    hasOnlyKeys(value.params, [])
  )
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
