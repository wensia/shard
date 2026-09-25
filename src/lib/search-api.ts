import { desktopInvokeRaw, hydrateFragment } from "@/lib/api"
import type {
  ReadSearchTargetRequest,
  ReadSearchTargetResponse,
  SearchError,
  SearchVaultRequest,
  SearchVaultResponse,
  StoredSearchFragment,
} from "@/lib/search-contract"

type StoredReadSearchTargetResponse = Omit<
  ReadSearchTargetResponse,
  "fragment"
> & {
  fragment: StoredSearchFragment
}

const SIMPLE_ERROR_CODES = new Set([
  "vaultChanged",
  "contextExpired",
  "locked",
  "notFound",
  "targetChanged",
  "unsupportedTarget",
])

function internalError(): SearchError {
  return { code: "internal", retryable: false }
}

export function normalizeSearchError(error: unknown): SearchError {
  if (typeof error !== "object" || error === null) return internalError()

  const payload = error as Record<string, unknown>
  if (
    payload.code === "invalidRequest" &&
    typeof payload.reason === "string" &&
    payload.reason.length > 0
  ) {
    return { code: "invalidRequest", reason: payload.reason }
  }
  if (typeof payload.code === "string" && SIMPLE_ERROR_CODES.has(payload.code)) {
    return { code: payload.code } as SearchError
  }
  if (
    (payload.code === "io" || payload.code === "internal") &&
    typeof payload.retryable === "boolean"
  ) {
    return { code: payload.code, retryable: payload.retryable }
  }

  return internalError()
}

function invokeSearch<T>(command: string, request: Record<string, unknown>) {
  return desktopInvokeRaw<T>(command, { request }).catch((error: unknown) =>
    Promise.reject(normalizeSearchError(error))
  )
}

export function searchVault(
  request: SearchVaultRequest
): Promise<SearchVaultResponse> {
  return invokeSearch<SearchVaultResponse>(
    "search_vault",
    request as unknown as Record<string, unknown>
  )
}

export function readSearchTarget(
  request: ReadSearchTargetRequest
): Promise<ReadSearchTargetResponse> {
  return invokeSearch<StoredReadSearchTargetResponse>(
    "read_search_target",
    request as unknown as Record<string, unknown>
  ).then((response) => ({
    ...response,
    fragment: hydrateFragment(response.fragment),
  }))
}
