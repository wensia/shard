import { NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react"
import type { MouseEvent } from "react"

import { resolveWikilinkTarget } from "@/lib/wikilink"

import { getWikilinkHost } from "./wikilink"

/**
 * 双链芯片：行内原子节点，编辑态显示为可点击的芯片。
 *
 * 断链判定与 CM6 装饰一致——把目标交给 `resolveWikilinkTarget`，宿主给的候选
 * 集合里唯一命中才算已存在，否则挂 `--missing`。候选在每次渲染时现取：
 * 碎片列表先于输入到位，芯片不需要为候选变化单独订阅。
 *
 * 点击交给宿主的 `onNavigateWikilink`，碎片 / 笔记 / 导图 / CSV / 待建的分派
 * 规则留在宿主一侧，编辑器不认识这些业务类型。
 */
export function WikilinkNodeView({ editor, node }: ReactNodeViewProps) {
  const target = String(node.attrs.target ?? "")
  const alias = node.attrs.alias ? String(node.attrs.alias) : ""
  const host = getWikilinkHost(editor)
  const missing = resolveWikilinkTarget(target, host.getCandidates()) === null

  return (
    <NodeViewWrapper
      aria-label={`双链：${target}`}
      as="span"
      className={
        missing ? "shard-rich-wikilink shard-rich-wikilink--missing" : "shard-rich-wikilink"
      }
      contentEditable={false}
      data-wikilink-missing={missing ? "true" : undefined}
      data-wikilink-target={target}
      onClick={(event: MouseEvent) => {
        event.preventDefault()
        host.onNavigate?.(target)
      }}
      role="link"
    >
      {alias || target}
    </NodeViewWrapper>
  )
}
