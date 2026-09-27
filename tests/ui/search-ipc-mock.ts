import type { Page } from "@playwright/test"

export interface SearchIpcMockControl {
  indexState: "indexing" | "ready" | "stale"
  delayMs: number
  nextError: { command: "search_vault" | "read_search_target"; error: unknown; query?: string } | null
  warning: unknown | null
  calls: Array<{ command: string; request: Record<string, unknown> }>
}

/**
 * Adds the two search commands around a test's existing Tauri dispatcher.
 * The browser-side function is deliberately self-contained: Playwright serializes it,
 * so it must not close over imports or Node-side helpers.
 */
export async function installSearchIpcMock(page: Page) {
  await page.addInitScript(() => {
    type Invoke = (
      command: string,
      args?: Record<string, unknown> | Uint8Array,
      options?: unknown
    ) => Promise<unknown>
    type Internals = {
      invoke: Invoke
      __SHARD_SEARCH_IPC_WRAPPED__?: boolean
      [key: string]: unknown
    }
    type Fragment = {
      id: string
      path: string
      content: string
      tags: string[]
      createdAt: string
      updatedAt: string
      archived: boolean
      lockbox: boolean
      kind?: string
      [key: string]: unknown
    }
    type VaultState = {
      vaultPath: string
      fragments: Fragment[]
      lockbox: { configured: boolean; unlocked: boolean; expiresAt: string | null }
    }
    type Root = typeof globalThis & {
      __TAURI_INTERNALS__?: Internals
      __SHARD_SEARCH_IPC_MOCK__?: SearchIpcMockControl
    }

    const root = globalThis as Root
    if (root.__SHARD_SEARCH_IPC_MOCK__) return

    const control: SearchIpcMockControl = {
      indexState: "ready",
      delayMs: 0,
      nextError: null,
      warning: null,
      calls: [],
    }
    root.__SHARD_SEARCH_IPC_MOCK__ = control

    const clone = <T,>(value: T): T => structuredClone(value)
    const pause = (milliseconds: number) =>
      new Promise<void>((resolve) => globalThis.setTimeout(resolve, milliseconds))
    const kindOf = (fragment: Fragment) => {
      if (fragment.tags.includes("note")) return "note"
      if (fragment.tags.includes("outline")) return "outline"
      if (fragment.tags.includes("document")) return "document"
      return "fragment"
    }
    const scopeOf = (fragment: Fragment) =>
      fragment.lockbox || fragment.path.startsWith("lockbox/")
        ? "lockbox"
        : "public"
    const jsonOutlineTitle = (content: string) => {
      const match = /(?:^|\n)```shardmap\r?\n([\s\S]*?)\r?\n```(?:\n|$)/u.exec(content)
      if (!match) return null
      try {
        const file = JSON.parse(match[1]) as {
          nodes?: Record<string, { text?: unknown }>
          rootId?: unknown
        }
        if (typeof file.rootId !== "string") return null
        const text = file.nodes?.[file.rootId]?.text
        return typeof text === "string" && text.trim() ? text.trim() : null
      } catch {
        return null
      }
    }
    const titleOf = (fragment: Fragment) => {
      const outlineTitle = fragment.tags.includes("outline")
        ? jsonOutlineTitle(fragment.content)
        : null
      if (outlineTitle) return outlineTitle
      const first = fragment.content
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .find(Boolean)
      return (first ?? "未命名").replace(/^#{1,6}\s+/u, "").replace(/^[-*+]\s+/u, "")
    }
    const revisionOf = (fragment: Fragment) => {
      const source = JSON.stringify([
        fragment.id,
        fragment.path,
        fragment.content,
        fragment.tags,
        fragment.updatedAt,
      ])
      let hash = 2166136261
      for (let index = 0; index < source.length; index += 1) {
        hash ^= source.charCodeAt(index)
        hash = Math.imul(hash, 16777619)
      }
      return `mock-${(hash >>> 0).toString(16).padStart(8, "0")}`
    }
    const targetOf = (vaultPath: string, fragment: Fragment) => {
      const scope = scopeOf(fragment)
      return {
        key: JSON.stringify([vaultPath, scope, fragment.path]),
        vaultPath,
        scope,
        path: fragment.path,
        kind: kindOf(fragment),
        objectId: fragment.id,
        archived: Boolean(fragment.archived),
      }
    }
    const contextOf = (state: VaultState) => ({
      vaultPath: state.vaultPath,
      vaultEpoch: "1",
      privacyEpoch: state.lockbox.unlocked ? "1" : "0",
    })
    const parts = (text: string, terms: string[]) => {
      if (terms.length === 0) return []
      const normalized = text.toLocaleLowerCase("en-US")
      const ranges: Array<[number, number]> = []
      for (const term of terms) {
        let start = 0
        while (start < normalized.length) {
          const found = normalized.indexOf(term, start)
          if (found < 0) break
          ranges.push([found, found + term.length])
          start = found + Math.max(term.length, 1)
        }
      }
      if (ranges.length === 0) return [{ text, hit: false }]
      ranges.sort((left, right) => left[0] - right[0])
      const merged: Array<[number, number]> = []
      for (const range of ranges) {
        const previous = merged.at(-1)
        if (previous && range[0] <= previous[1]) previous[1] = Math.max(previous[1], range[1])
        else merged.push([...range])
      }
      const result: Array<{ text: string; hit: boolean }> = []
      let offset = 0
      for (const [start, end] of merged) {
        if (start > offset) result.push({ text: text.slice(offset, start), hit: false })
        result.push({ text: text.slice(start, end), hit: true })
        offset = end
      }
      if (offset < text.length) result.push({ text: text.slice(offset), hit: false })
      return result
    }
    const fallbackState = (vaultPath: string): VaultState => ({
      vaultPath,
      fragments: [],
      lockbox: { configured: false, unlocked: false, expiresAt: null },
    })
    const readState = async (invoke: Invoke, expectedVaultPath: string) => {
      try {
        const state = await invoke("list_fragments", {})
        if (
          typeof state === "object" &&
          state !== null &&
          typeof (state as VaultState).vaultPath === "string" &&
          Array.isArray((state as VaultState).fragments)
        ) {
          return state as VaultState
        }
      } catch {
        // Test-only pages without a workbench vault have an empty search fixture.
      }
      return fallbackState(expectedVaultPath)
    }
    const validateContext = (
      state: VaultState,
      request: Record<string, unknown>
    ) => {
      if (request.expectedVaultPath !== state.vaultPath) throw { code: "vaultChanged" }
      const context = contextOf(state)
      const requested = request.context
      if (requested !== null && JSON.stringify(requested) !== JSON.stringify(context)) {
        throw { code: "contextExpired" }
      }
      return context
    }
    const beforeCommand = async (
      command: "search_vault" | "read_search_target",
      request: Record<string, unknown>
    ) => {
      control.calls.push({ command, request: clone(request) })
      if (control.delayMs > 0) await pause(control.delayMs)
      if (
        control.nextError?.command === command &&
        (control.nextError.query === undefined || control.nextError.query === request.query)
      ) {
        const error = clone(control.nextError.error)
        control.nextError = null
        throw error
      }
    }
    const dispatchSearch = async (
      invoke: Invoke,
      command: "search_vault" | "read_search_target",
      args: Record<string, unknown> | Uint8Array | undefined
    ) => {
      if (args instanceof Uint8Array || typeof args !== "object" || args === null) {
        throw { code: "invalidRequest", reason: "invalidEnvelope" }
      }
      const request = args.request
      if (typeof request !== "object" || request === null) {
        throw { code: "invalidRequest", reason: "invalidEnvelope" }
      }
      const typedRequest = request as Record<string, unknown>
      await beforeCommand(command, typedRequest)
      const expectedVaultPath = String(typedRequest.expectedVaultPath ?? "")
      const state = await readState(invoke, expectedVaultPath)
      const context = validateContext(state, typedRequest)

      if (command === "search_vault") {
        const scope = typedRequest.scope
        if (scope === "lockbox" && !state.lockbox.unlocked) throw { code: "locked" }
        if (scope !== "public" && scope !== "lockbox") {
          throw { code: "invalidRequest", reason: "invalidScope" }
        }
        if (control.indexState === "indexing") {
          return {
            clientRequestId: typedRequest.clientRequestId,
            context,
            snapshotId: null,
            indexState: "indexing",
            expiresAt: scope === "lockbox" ? state.lockbox.expiresAt : null,
            hits: [],
            total: null,
            skippedFiles: 0,
            warning: control.warning,
          }
        }

        const terms = String(typedRequest.query ?? "")
          .toLocaleLowerCase("en-US")
          .split(/\s+/u)
          .filter(Boolean)
        const includeTrash = Boolean(typedRequest.includeTrash)
        const matches = state.fragments
          .filter((fragment) => scopeOf(fragment) === scope)
          .filter((fragment) => includeTrash || !fragment.archived)
          .map((fragment) => {
            const title = titleOf(fragment)
            const fields = {
              title: title.toLocaleLowerCase("en-US"),
              tags: fragment.tags.join(" ").toLocaleLowerCase("en-US"),
              body: fragment.content.toLocaleLowerCase("en-US"),
            }
            if (
              terms.some(
                (term) =>
                  !fields.title.includes(term) &&
                  !fields.tags.includes(term) &&
                  !fields.body.includes(term)
              )
            ) {
              return null
            }
            const matchedFields = (Object.keys(fields) as Array<keyof typeof fields>)
              .filter((field) => terms.some((term) => fields[field].includes(term)))
            return {
              target: targetOf(state.vaultPath, fragment),
              title,
              titleParts: parts(title, terms),
              tags: clone(fragment.tags),
              updatedAt: fragment.updatedAt ?? null,
              revision: revisionOf(fragment),
              matchedFields,
              preview: parts(fragment.content.replace(/^#{1,6}\s+/u, ""), terms),
              revealHint: "text",
            }
          })
          .filter((hit): hit is NonNullable<typeof hit> => hit !== null)
        const limit = Math.max(0, Number(typedRequest.limit ?? 50))
        return {
          clientRequestId: typedRequest.clientRequestId,
          context,
          snapshotId: "mock-snapshot-1",
          indexState: control.indexState,
          expiresAt: scope === "lockbox" ? state.lockbox.expiresAt : null,
          hits: matches.slice(0, limit),
          total: matches.length,
          skippedFiles: 0,
          warning: control.warning,
        }
      }

      const target = typedRequest.target as Record<string, unknown> | undefined
      if (!target) throw { code: "invalidRequest", reason: "missingTarget" }
      if (target.scope === "lockbox" && !state.lockbox.unlocked) throw { code: "locked" }
      const fragment = state.fragments.find(
        (candidate) =>
          candidate.path === target.path && scopeOf(candidate) === target.scope
      )
      if (!fragment) throw { code: "notFound" }
      const actualTarget = targetOf(state.vaultPath, fragment)
      if (actualTarget.objectId !== target.objectId || actualTarget.kind !== target.kind) {
        throw { code: "targetChanged" }
      }
      const stored = clone(fragment)
      delete stored.kind
      return {
        clientRequestId: typedRequest.clientRequestId,
        context,
        expiresAt: target.scope === "lockbox" ? state.lockbox.expiresAt : null,
        target: actualTarget,
        revision: revisionOf(fragment),
        readOnly: Boolean(fragment.archived),
        fragment: stored,
      }
    }
    const wrap = (internals: Internals | undefined) => {
      if (!internals || internals.__SHARD_SEARCH_IPC_WRAPPED__) return internals
      const invoke = internals.invoke.bind(internals)
      internals.invoke = async (command, args, options) => {
        if (command === "search_vault" || command === "read_search_target") {
          return dispatchSearch(invoke, command, args)
        }
        return invoke(command, args, options)
      }
      Object.defineProperty(internals, "__SHARD_SEARCH_IPC_WRAPPED__", {
        configurable: false,
        enumerable: false,
        value: true,
      })
      return internals
    }

    let current = wrap(root.__TAURI_INTERNALS__)
    const descriptor = Object.getOwnPropertyDescriptor(root, "__TAURI_INTERNALS__")
    if (!descriptor || descriptor.configurable) {
      Object.defineProperty(root, "__TAURI_INTERNALS__", {
        configurable: true,
        enumerable: true,
        get: () => current,
        set: (value: Internals) => {
          current = wrap(value)
        },
      })
    } else if (current) {
      root.__TAURI_INTERNALS__ = current
    }
  })
}

export function updateSearchIpcMock(
  page: Page,
  patch: Partial<Omit<SearchIpcMockControl, "calls">>
) {
  return page.evaluate((next) => {
    const control = (
      globalThis as typeof globalThis & {
        __SHARD_SEARCH_IPC_MOCK__: SearchIpcMockControl
      }
    ).__SHARD_SEARCH_IPC_MOCK__
    Object.assign(control, next)
  }, patch)
}
