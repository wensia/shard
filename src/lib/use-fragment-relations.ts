import { useCallback, useEffect, useRef, useState } from "react"

import type { Fragment } from "@/types"
import type {
  FragmentRelationsWorkerRequest,
  FragmentRelationsWorkerResponse,
  RelatedFragment,
} from "@/lib/relations"

interface PendingRequest {
  resolve: (related: RelatedFragment[]) => void
  version: number
}

export function useFragmentRelations(fragments: Fragment[]) {
  const workerRef = useRef<Worker | null>(null)
  const versionRef = useRef(0)
  const readyVersionRef = useRef(0)
  const nextRequestIdRef = useRef(0)
  const pendingRequestsRef = useRef(new Map<string, PendingRequest>())
  const mountedRef = useRef(false)
  const [isReady, setIsReady] = useState(false)

  useEffect(() => {
    mountedRef.current = true
    const worker = new Worker(
      new URL("../workers/fragment-relations.worker.ts", import.meta.url),
      { type: "module" }
    )
    workerRef.current = worker

    worker.onmessage = (
      event: MessageEvent<FragmentRelationsWorkerResponse>
    ) => {
      const response = event.data
      if (!mountedRef.current || response.version !== versionRef.current) return

      if (response.type === "ready") {
        readyVersionRef.current = response.version
        setIsReady(true)
        return
      }

      const pending = pendingRequestsRef.current.get(response.requestId)
      if (!pending || pending.version !== response.version) return

      pendingRequestsRef.current.delete(response.requestId)
      pending.resolve(response.related)
    }

    worker.onerror = () => {
      if (!mountedRef.current) return

      readyVersionRef.current = 0
      setIsReady(false)
      for (const pending of pendingRequestsRef.current.values()) {
        pending.resolve([])
      }
      pendingRequestsRef.current.clear()
    }

    return () => {
      mountedRef.current = false
      worker.onmessage = null
      worker.onerror = null
      worker.terminate()
      if (workerRef.current === worker) workerRef.current = null
      for (const pending of pendingRequestsRef.current.values()) {
        pending.resolve([])
      }
      pendingRequestsRef.current.clear()
    }
  }, [])

  useEffect(() => {
    const worker = workerRef.current
    if (!worker) return

    const version = versionRef.current + 1
    versionRef.current = version
    readyVersionRef.current = 0
    setIsReady(false)

    for (const pending of pendingRequestsRef.current.values()) {
      pending.resolve([])
    }
    pendingRequestsRef.current.clear()

    worker.postMessage({
      type: "index",
      version,
      fragments,
    } satisfies FragmentRelationsWorkerRequest)
  }, [fragments])

  const requestRelated = useCallback((targetId: string, limit?: number) => {
    const worker = workerRef.current
    const version = versionRef.current
    if (!worker || readyVersionRef.current !== version) {
      return Promise.resolve([])
    }

    const requestId = `${version}:${nextRequestIdRef.current + 1}`
    nextRequestIdRef.current += 1

    return new Promise<RelatedFragment[]>((resolve) => {
      pendingRequestsRef.current.set(requestId, { resolve, version })
      worker.postMessage({
        type: "query",
        version,
        requestId,
        targetId,
        ...(limit !== undefined ? { limit } : {}),
      } satisfies FragmentRelationsWorkerRequest)
    })
  }, [])

  return { indexVersion: readyVersionRef.current, isReady, requestRelated }
}
