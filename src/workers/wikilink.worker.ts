import {
  parseWikilinks,
  type WikilinkWorkerRequest,
  type WikilinkWorkerResponse,
} from "@/lib/wikilink"

self.onmessage = (event: MessageEvent<WikilinkWorkerRequest>) => {
  const request = event.data
  if (request.type !== "parse") return

  postMessage({
    links: parseWikilinks(request.content),
    requestId: request.requestId,
    type: "parsed",
  } satisfies WikilinkWorkerResponse)
}
