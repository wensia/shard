import { NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react"

import { CsvPreview } from "@/components/shard/csv-preview"

/**
 * `![[x.csv]]` 的编辑态：只读预览，与卡片渲染共用 `CsvPreview`。
 * 本阶段不做 CSV ↔ 数据表的转换，嵌入就是嵌入。
 */
export function CsvEmbedNodeView({ editor, node, selected }: ReactNodeViewProps) {
  const path = String(node.attrs.path ?? "")
  const maxRows = editor.storage.csvEmbed.maxRows

  return (
    <NodeViewWrapper
      className="shard-rich-block"
      contentEditable={false}
      data-selected={selected ? "true" : undefined}
      data-shard-rich-block="csv-embed"
    >
      <p className="shard-rich-block-note">CSV 嵌入</p>
      <CsvPreview maxRows={maxRows} path={path} />
    </NodeViewWrapper>
  )
}
