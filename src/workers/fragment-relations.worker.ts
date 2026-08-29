import {
  buildRelationsIndex,
  computeRelated,
  type FragmentRelationsWorkerRequest,
  type FragmentRelationsWorkerResponse,
} from "@/lib/relations"

let index = buildRelationsIndex([])
let indexVersion = 0

self.onmessage = (event: MessageEvent<FragmentRelationsWorkerRequest>) => {
  const request = event.data

  if (request.type === "index") {
    indexVersion = request.version
    index = buildRelationsIndex(request.fragments)
    postMessage({
      type: "ready",
      version: indexVersion,
    } satisfies FragmentRelationsWorkerResponse)
    return
  }

  if (request.version !== indexVersion) return

  postMessage({
    type: "results",
    version: indexVersion,
    requestId: request.requestId,
    related: computeRelated(index, request.targetId, request.limit),
  } satisfies FragmentRelationsWorkerResponse)
}
