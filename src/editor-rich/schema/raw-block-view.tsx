import { NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react"

import { Button } from "@/components/ui/button"
import { Trash2Icon } from "@/components/icons"

import { useNodeViewEditable } from "./node-view-utils"

const PREVIEW_LINES = 3

/**
 * 原始块：方言不认识的块级 HTML、注释、链接引用定义。
 * 不可编辑，只显示前几行源码与一个「删除」；内容原样保存，往返无损。
 */
export function RawBlockNodeView({ deleteNode, editor, node, selected }: ReactNodeViewProps) {
  const editable = useNodeViewEditable(editor)
  const source = String(node.attrs.source ?? "")
  const lines = source.split("\n")
  const preview = lines.slice(0, PREVIEW_LINES).join("\n")
  const truncated = lines.length > PREVIEW_LINES

  return (
    <NodeViewWrapper
      className="shard-rich-block shard-rich-raw-block"
      contentEditable={false}
      data-selected={selected ? "true" : undefined}
      data-shard-rich-block="raw"
    >
      <div className="shard-rich-block-head">
        <span className="shard-rich-block-lang">原始内容</span>
        {editable ? (
          <Button
            aria-label="删除原始内容"
            className="shard-rich-block-action"
            onClick={() => deleteNode()}
            size="icon-sm"
            variant="ghost"
          >
            <Trash2Icon />
            <span className="sr-only">删除</span>
          </Button>
        ) : null}
      </div>
      <pre className="shard-rich-block-source">
        {preview}
        {truncated ? "\n…" : ""}
      </pre>
    </NodeViewWrapper>
  )
}
