import { parseMarkdown, type MarkdownParseRequest } from "./parser.js"

// Keep this entry independent of React, DOM access, and application adapters.
const workerScope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<MarkdownParseRequest>) => void) | null
  postMessage: (message: unknown) => void
}

workerScope.onmessage = (event) => {
  try {
    workerScope.postMessage({ result: parseMarkdown(event.data) })
  } catch (error) {
    workerScope.postMessage({ error: error instanceof Error ? error.message : String(error) })
  }
}
