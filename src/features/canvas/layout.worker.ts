import { layoutMindMap } from "@/lib/mind-map-layout"
import type { ShardMapFile } from "@/types"

// A worker owns recursive measurement; rendering and pointer handlers never run it.
self.onmessage = (event: MessageEvent<{ requestId: number; map: ShardMapFile }>) => {
  const { requestId, map } = event.data
  try {
    self.postMessage({ requestId, layout: layoutMindMap(map) })
  } catch (error) {
    self.postMessage({ requestId, error: String(error) })
  }
}
