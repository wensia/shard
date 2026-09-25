import { useCallback, useMemo, useRef, useState } from "react"

import { isTypeTag } from "@/lib/content-kind"
import { isPublicStreamFragment } from "@/lib/fragment-space"
import { LOCKBOX_TAG, publicFragments } from "@/lib/lockbox"
import {
  createVaultStateGenerationGate,
  type VaultStateRequestKind,
  type VaultStateRequestToken,
} from "@/lib/search-session"
import type { Fragment } from "@/types"

export function useFragments() {
  const [fragments, setFragments] = useState<Fragment[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isCreating, setIsCreating] = useState(false)
  const vaultStateGateRef = useRef(createVaultStateGenerationGate())
  const publicOnlyFragments = useMemo(
    () => publicFragments(fragments),
    [fragments]
  )
  const activeFragments = useMemo(
    () => fragments.filter((fragment) => !fragment.archived),
    [fragments]
  )
  const publicActiveFragments = useMemo(
    () => publicOnlyFragments.filter((fragment) => !fragment.archived),
    [publicOnlyFragments]
  )
  const archivedFragments = useMemo(
    () => publicOnlyFragments.filter((fragment) => fragment.archived),
    [publicOnlyFragments]
  )
  const lockboxFragments = useMemo(
    () => activeFragments.filter((fragment) => fragment.lockbox),
    [activeFragments]
  )
  const taggedFragments = useMemo(
    () =>
      publicActiveFragments.filter((fragment) =>
        fragment.tags.some(
          (tag) => tag !== "inbox" && tag !== LOCKBOX_TAG && !isTypeTag(tag)
        )
      ),
    [publicActiveFragments]
  )
  const inboxFragments = useMemo(
    () =>
      publicActiveFragments.filter(isPublicStreamFragment),
    [publicActiveFragments]
  )
  const beginVaultStateRequest = useCallback(
    (
      expectedVaultPath: string | null,
      kind: VaultStateRequestKind = "read"
    ): VaultStateRequestToken =>
      vaultStateGateRef.current.begin(expectedVaultPath, kind),
    []
  )
  const acceptsVaultStateResponse = useCallback(
    (token: VaultStateRequestToken, actualVaultPath: string) =>
      vaultStateGateRef.current.accepts(token, actualVaultPath),
    []
  )
  const revokeVaultStateRequests = useCallback(
    () => vaultStateGateRef.current.invalidate(),
    []
  )
  const completeVaultPrivacyChange = useCallback(
    () => vaultStateGateRef.current.completePrivacyChange(),
    []
  )

  return {
    acceptsVaultStateResponse,
    archivedFragments,
    beginVaultStateRequest,
    completeVaultPrivacyChange,
    fragments,
    inboxFragments,
    isCreating,
    isLoading,
    lockboxFragments,
    publicActiveFragments,
    publicOnlyFragments,
    revokeVaultStateRequests,
    setFragments,
    setIsCreating,
    setIsLoading,
    taggedFragments,
  }
}
