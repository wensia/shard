export type GraphRegionKind = "outline" | "flowchart"

export interface GraphRegion {
  /** 受管区域起点（包含开围栏），使用 JavaScript 字符串索引。 */
  start: number
  /** 受管区域终点（不包含闭围栏后的换行），使用 JavaScript 字符串索引。 */
  end: number
  jsonText: string
}

export const MISSING_GRAPH_REGION_ERROR = "正文中没有受管 JSON 区域。"
export const MULTIPLE_GRAPH_REGIONS_ERROR =
  "正文中有多个同类型的受管 JSON 区域。"
export const UNCLOSED_GRAPH_REGION_ERROR = "正文中的受管 JSON 区域未闭合。"
export const MIXED_GRAPH_REGIONS_ERROR =
  "正文中不能同时包含大纲与流程图区域。"

const FENCE_NAMES: Record<GraphRegionKind, "shardmap" | "shardflow"> = {
  outline: "shardmap",
  flowchart: "shardflow",
}

interface FenceLine {
  contentEnd: number
  end: number
  start: number
  text: string
}

function lines(body: string): FenceLine[] {
  const result: FenceLine[] = []
  let start = 0

  while (start < body.length) {
    const newline = body.indexOf("\n", start)
    const end = newline === -1 ? body.length : newline + 1
    let contentEnd = newline === -1 ? body.length : newline
    if (contentEnd > start && body[contentEnd - 1] === "\r") {
      contentEnd -= 1
    }
    result.push({
      contentEnd,
      end,
      start,
      text: body.slice(start, contentEnd),
    })
    if (newline === -1) break
    start = newline + 1
  }

  return result
}

function isOpeningFence(line: string, fenceName: string) {
  return line.trimEnd() === `\`\`\`${fenceName}`
}

export function findGraphRegion(
  body: string,
  kind: GraphRegionKind
): GraphRegion {
  const bodyLines = lines(body)
  const fenceName = FENCE_NAMES[kind]
  const otherFenceName = FENCE_NAMES[kind === "outline" ? "flowchart" : "outline"]
  const openings = bodyLines
    .map((line, index) => ({ index, line }))
    .filter(({ line }) => isOpeningFence(line.text, fenceName))
  const hasOtherKind = bodyLines.some((line) =>
    isOpeningFence(line.text, otherFenceName)
  )

  if (openings.length > 0 && hasOtherKind) {
    throw new Error(MIXED_GRAPH_REGIONS_ERROR)
  }
  if (openings.length === 0) {
    throw new Error(MISSING_GRAPH_REGION_ERROR)
  }
  if (openings.length > 1) {
    throw new Error(MULTIPLE_GRAPH_REGIONS_ERROR)
  }

  const opening = openings[0]
  const closing = bodyLines
    .slice(opening.index + 1)
    .find(({ text }) => text === "```")

  if (!closing) {
    throw new Error(UNCLOSED_GRAPH_REGION_ERROR)
  }

  let jsonEnd = closing.start
  if (jsonEnd >= opening.line.end + 2 && body.slice(jsonEnd - 2, jsonEnd) === "\r\n") {
    jsonEnd -= 2
  } else if (jsonEnd > opening.line.end && body[jsonEnd - 1] === "\n") {
    jsonEnd -= 1
  }

  return {
    start: opening.line.start,
    end: closing.contentEnd,
    jsonText: body.slice(opening.line.end, jsonEnd),
  }
}

export function renderGraphRegion(kind: GraphRegionKind, jsonText: string) {
  return `\`\`\`${FENCE_NAMES[kind]}\n${jsonText.replace(/[\r\n]+$/u, "")}\n\`\`\``
}

export function replaceGraphRegion(
  body: string,
  kind: GraphRegionKind,
  jsonText: string
) {
  const region = findGraphRegion(body, kind)
  return `${body.slice(0, region.start)}${renderGraphRegion(kind, jsonText)}${body.slice(region.end)}`
}
