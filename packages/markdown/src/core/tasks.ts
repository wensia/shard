import type { shardMarkdownParser } from "./syntax.js"

type MarkdownNode = ReturnType<typeof shardMarkdownParser.parse>["topNode"]

export interface MarkdownTask {
  from: number
  to: number
  markerFrom: number
  markerTo: number
  checked: boolean
}

/** 从共同的 Markdown 语法树确定任务展示范围，保留缩进、引用和有序编号。 */
export function markdownTaskFromNode(
  node: MarkdownNode,
  sourceSlice: (from: number, to: number) => string,
): MarkdownTask | null {
  if (node.name !== "TaskMarker") return null

  const task = node.parent
  const item = task?.parent
  const list = item?.parent
  const listMarker = item?.getChild("ListMark")
  if (
    task?.name !== "Task" ||
    item?.name !== "ListItem" ||
    !listMarker ||
    (list?.name !== "BulletList" && list?.name !== "OrderedList")
  ) {
    return null
  }

  let to = node.to
  // 只读取紧邻标记的空白，避免复制可能跨多行的整个任务正文。
  while (to < task.to && /^[^\S\r\n]$/u.test(sourceSlice(to, to + 1))) to += 1

  // ListMark 和 TaskMarker 可能分属两行；内联 widget 不能吞掉换行与引用结构。
  const hideListMarker = list.name === "BulletList" &&
    /^[^\S\r\n]*$/u.test(sourceSlice(listMarker.to, node.from))

  return {
    from: hideListMarker ? listMarker.from : node.from,
    to,
    markerFrom: node.from,
    markerTo: node.to,
    checked: sourceSlice(node.from + 1, node.from + 2).toLowerCase() === "x",
  }
}
