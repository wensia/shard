import { describe, expect, it } from "vitest"

import {
  acceptsSearchSessionIdentity,
  captureSearchSessionIdentity,
  createSearchSession,
  createVaultStateGenerationGate,
  legacyWorkerFragmentsForScope,
  revokeSearchSession,
  scopeForSpace,
} from "@/lib/search-session"
import type { Fragment } from "@/types"

function fragment(overrides: Partial<Fragment>): Fragment {
  return {
    id: "fragment",
    content: "正文",
    kind: "fragment",
    createdAt: "2026-09-25T10:00:00.000Z",
    updatedAt: "2026-09-25T10:00:00.000Z",
    tags: ["inbox"],
    category: null,
    path: "fragments/2026/09/fragment.md",
    gitStatus: "saved",
    error: null,
    archived: false,
    lockbox: false,
    pinned: false,
    related: [],
    ...overrides,
  }
}

describe("search session boundaries", () => {
  it("scope_is_derived_from_current_space", () => {
    expect(scopeForSpace("fragments")).toBe("public")
    expect(scopeForSpace("library")).toBe("public")
    expect(scopeForSpace("lockbox")).toBe("lockbox")
  })

  it("public_worker_payload_never_contains_lockbox_objects", () => {
    const publicEntry = fragment({ id: "public" })
    const privateEntry = fragment({
      id: "private",
      lockbox: true,
      path: "lockbox/fragments/private.shard",
    })

    expect(
      legacyWorkerFragmentsForScope(
        [publicEntry, privateEntry],
        "public"
      ).map((entry) => entry.id)
    ).toEqual(["public"])
    expect(
      legacyWorkerFragmentsForScope(
        [publicEntry, privateEntry],
        "lockbox"
      )
    ).toEqual([])
  })

  it("revoke_rejects_late_query_and_vault_state", () => {
    const session = createSearchSession({
      id: "session-1",
      scope: "lockbox",
      uiEpoch: 7,
      vaultPath: "/vault/A",
    })
    session.drafts.fullText = "私密计划"
    session.hits = [
      {
        target: {
          key: '["/vault/A","lockbox","lockbox/notes/plan.shard"]',
          vaultPath: "/vault/A",
          scope: "lockbox",
          path: "lockbox/notes/plan.shard",
          kind: "note",
          objectId: "private-note",
          archived: false,
        },
        title: "私密计划",
        titleParts: [{ text: "私密计划", hit: true }],
        tags: [],
        updatedAt: null,
        revision: "revision-1",
        matchedFields: ["body"],
        preview: [{ text: "私密计划", hit: true }],
        revealHint: "text",
      },
    ]
    session.pendingNavigation = {
      requestId: "navigation-1",
      targetKey: session.hits[0].target.key,
    }
    const identity = captureSearchSessionIdentity(session)
    const sessionRef = { current: session }
    const uiEpochRef = { current: session.uiEpoch }
    const observed: Array<{ epoch: number; session: unknown }> = []

    revokeSearchSession(
      {
        sessionRef,
        uiEpochRef,
        clear: () => {
          observed.push({
            epoch: uiEpochRef.current,
            session: sessionRef.current,
          })
        },
      },
      "locked"
    )

    expect(observed).toEqual([{ epoch: 8, session: null }])
    expect(acceptsSearchSessionIdentity(sessionRef.current, identity)).toBe(false)

    const vaultGate = createVaultStateGenerationGate()
    const staleRead = vaultGate.begin("/vault/A")
    vaultGate.invalidate()
    expect(vaultGate.accepts(staleRead, "/vault/A")).toBe(false)
  })

  it("vault_A_B_A_does_not_accept_old_A_response", () => {
    const gate = createVaultStateGenerationGate()
    const oldA = gate.begin("/vault/A")
    gate.invalidate()
    const currentA = gate.begin("/vault/A")

    expect(gate.accepts(oldA, "/vault/A")).toBe(false)
    expect(gate.accepts(currentA, "/vault/A")).toBe(true)
  })

  it("read_refresh_does_not_invalidate_in_flight_privacy_change", () => {
    const gate = createVaultStateGenerationGate()
    const unlock = gate.begin("/vault/A", "privacy")
    const refresh = gate.begin("/vault/A", "read")

    expect(gate.accepts(refresh, "/vault/A")).toBe(true)
    expect(gate.accepts(unlock, "/vault/A")).toBe(true)

    gate.completePrivacyChange()
    expect(gate.accepts(refresh, "/vault/A")).toBe(false)
  })

  it("privacy_revocation_invalidates_in_flight_unlock", () => {
    const gate = createVaultStateGenerationGate()
    const unlock = gate.begin("/vault/A", "privacy")

    gate.invalidate()

    expect(gate.accepts(unlock, "/vault/A")).toBe(false)
  })
})
