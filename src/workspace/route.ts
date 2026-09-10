export const WORKSPACE_ROUTE_STORAGE_KEY = "shard.workspace-route"

export type FragmentsView = "all" | "trash"

export type FragmentsRoute = {
  space: "fragments"
  params: { view?: FragmentsView }
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

export type WorkspaceRoute =
  | FragmentsRoute
  | LibraryRoute
  | LockboxRoute

export const DEFAULT_WORKSPACE_ROUTE: WorkspaceRoute = {
  space: "fragments",
  params: {},
}

const FRAGMENT_VIEWS: readonly FragmentsView[] = ["all", "trash"]

export function isWorkspaceRoute(value: unknown): value is WorkspaceRoute {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["space", "params"]) ||
    !isRecord(value.params)
  ) {
    return false
  }

  if (value.space === "fragments") {
    return (
      hasOnlyKeys(value.params, []) ||
      (hasOnlyKeys(value.params, ["view"]) &&
        typeof value.params.view === "string" &&
        FRAGMENT_VIEWS.includes(value.params.view as FragmentsView))
    )
  }

  return (
    (value.space === "library" ||
      value.space === "lockbox") &&
    hasOnlyKeys(value.params, [])
  )
}

export function readWorkspaceRoute(): WorkspaceRoute {
  try {
    const serialized = window.localStorage.getItem(WORKSPACE_ROUTE_STORAGE_KEY)
    if (!serialized) return DEFAULT_WORKSPACE_ROUTE

    const route: unknown = JSON.parse(serialized)
    return normalizeWorkspaceRoute(route)
  } catch {
    return DEFAULT_WORKSPACE_ROUTE
  }
}

/** Unsupported or removed workspace routes return to the fragment stream. */
export function normalizeWorkspaceRoute(value: unknown): WorkspaceRoute {
  return isWorkspaceRoute(value) ? value : DEFAULT_WORKSPACE_ROUTE
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
