import {
  buildFragmentSearchIndex,
  searchFragmentIndex,
  type FragmentSearchWorkerRequest,
  type FragmentSearchWorkerResponse,
} from "@/lib/fragment-search"

let index = buildFragmentSearchIndex([])
let indexVersion = 0

self.onmessage = (event: MessageEvent<FragmentSearchWorkerRequest>) => {
  const request = event.data

  if (request.type === "index") {
    indexVersion = request.version
    index = buildFragmentSearchIndex(request.documents, Number.POSITIVE_INFINITY)
    postMessage({
      type: "ready",
      version: indexVersion,
    } satisfies FragmentSearchWorkerResponse)
    return
  }

  if (request.version !== indexVersion) return

  const response = searchFragmentIndex(
    index,
    request.query,
    request.scope,
    request.limit
  )
  postMessage({
    requestId: request.requestId,
    response,
    type: "results",
    version: indexVersion,
  } satisfies FragmentSearchWorkerResponse)
}
