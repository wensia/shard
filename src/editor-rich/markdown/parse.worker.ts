import { parseShardMarkdown } from "./parse"

self.onmessage = (event: MessageEvent<string>) => {
  try {
    self.postMessage({ result: parseShardMarkdown(event.data, { sourcePositions: true }) })
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) })
  }
}
