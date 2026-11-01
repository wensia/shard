import type { Node as ProseMirrorNode } from "@tiptap/pm/model"

export const NESTED_LIST_TYPES = new Set(["taskList", "bulletList", "orderedList"])

/** 只有子列表仍是普通任务；备注块或标题里的换行才让任务成为备忘卡片。 */
export function taskItemHasDetail(node: ProseMirrorNode) {
  for (let index = 1; index < node.childCount; index += 1) {
    if (!NESTED_LIST_TYPES.has(node.child(index).type.name)) return true
  }

  const title = node.firstChild
  if (!title) return false

  let hasBreak = false
  title.descendants((child) => {
    if (hasBreak) return false
    if (child.type.name === "hardBreak") hasBreak = true
    else if (child.isText && (child.text ?? "").includes("\n")) hasBreak = true
    return !hasBreak
  })
  return hasBreak
}
