import { useMemo, useState } from "react"

import { isTypeTag } from "@/lib/content-kind"
import { isPublicStreamFragment } from "@/lib/fragment-space"
import { LOCKBOX_TAG, publicFragments } from "@/lib/lockbox"
import type { Fragment } from "@/types"

export function useFragments() {
  const [fragments, setFragments] = useState<Fragment[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isCreating, setIsCreating] = useState(false)
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

  return {
    archivedFragments,
    fragments,
    inboxFragments,
    isCreating,
    isLoading,
    lockboxFragments,
    publicActiveFragments,
    publicOnlyFragments,
    setFragments,
    setIsCreating,
    setIsLoading,
    taggedFragments,
  }
}
