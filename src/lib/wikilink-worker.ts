import {
  parseWikilinks,
  type WikilinkMatch,
  type WikilinkWorkerRequest,
  type WikilinkWorkerResponse,
} from "@/lib/wikilink"

interface PendingParse {
  reject: (error: Error) => void
  resolve: (links: WikilinkMatch[]) => void
}

let worker: Worker | null = null
let nextRequestId = 0
const pending = new Map<string, PendingParse>()

export function parseWikilinksInWorker(content: string) {
  if (typeof Worker === "undefined") {
    return Promise.resolve(parseWikilinks(content))
  }

  const activeWorker = getWorker()
  const requestId = `wikilink:${nextRequestId + 1}`
  nextRequestId += 1

  return new Promise<WikilinkMatch[]>((resolve, reject) => {
    pending.set(requestId, { reject, resolve })
    activeWorker.postMessage({
      content,
      requestId,
      type: "parse",
    } satisfies WikilinkWorkerRequest)
  })
}

function getWorker() {
  if (worker) return worker

  worker = new Worker(new URL("../workers/wikilink.worker.ts", import.meta.url), {
    type: "module",
  })
  worker.onmessage = (event: MessageEvent<WikilinkWorkerResponse>) => {
    const response = event.data
    const request = pending.get(response.requestId)
    if (!request) return
    pending.delete(response.requestId)
    request.resolve(response.links)
  }
  worker.onerror = () => {
    for (const request of pending.values()) {
      request.reject(new Error("wikilink 解析 worker 运行失败"))
    }
    pending.clear()
    worker?.terminate()
    worker = null
  }

  return worker
}
