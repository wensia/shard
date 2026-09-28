import { validateCanvasFile, type CanvasFile } from "@/features/canvas/model"
import { findGraphRegion } from "@/lib/graph-region"

export interface FlowchartContent {
  format: "json"
  file: CanvasFile
}

/** 读取碎片正文中唯一的受管流程图区域；非法或非流程图数据返回 null。 */
export function readFlowchartContent(content: string): FlowchartContent | null {
  try {
    const region = findGraphRegion(content, "flowchart")
    const file: unknown = JSON.parse(region.jsonText)
    validateCanvasFile(file)
    return file.kind === "shard.flow" ? { format: "json", file } : null
  } catch {
    return null
  }
}
