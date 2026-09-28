import { NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react"

import { getShardBlock } from "../blocks/registry"
import { getBlockUI } from "../blocks/registry-ui"

import { focusAfterNodeView, hostEditorId, useNodeViewEditable } from "./node-view-utils"

/**
 * 通用围栏块的 NodeView：按 `lang` 查 UI 注册表分派（技术方案 §4.4）。
 *
 * 编辑器这一层不认识任何具体的块——加一个新围栏块只要在 `registry-ui.tsx`
 * 注册一次，这里、转换层与卡片渲染都不用动。没注册的语言退回带语言标签的
 * 只读源码块，内容原样保留，装上对应插件后会自动升级成组件。
 */
export function ShardBlockNodeView({
  editor,
  getPos,
  node,
  selected,
  updateAttributes,
}: ReactNodeViewProps) {
  const lang = String(node.attrs.lang ?? "")
  const source = String(node.attrs.source ?? "")
  const ui = getBlockUI(lang)
  const readOnly = !useNodeViewEditable(editor)

  return (
    <NodeViewWrapper
      className="shard-rich-block"
      contentEditable={false}
      data-selected={selected ? "true" : undefined}
      data-shard-rich-block={lang || "unknown"}
    >
      {ui ? (
        <ui.Editor
          allowDatasetActions={editor.storage.shardBlock.allowDatasetActions}
          editorId={hostEditorId(editor)}
          onChange={(next) => {
            // 走 updateAttributes 而不是自建事务：改动天然进撤销历史，
            // 连续输入由 ProseMirror 的 history 自行合并成一组。
            if (next !== source) updateAttributes({ source: next })
          }}
          onExit={() => focusAfterNodeView(editor, getPos, node)}
          readOnly={readOnly}
          source={source}
        />
      ) : (
        <div className="shard-rich-block-unknown">
          <span className="shard-rich-block-lang">
            {getShardBlock(lang)?.title ?? (lang || "未知块")}
          </span>
          <pre className="shard-rich-block-source">{source}</pre>
        </div>
      )}
    </NodeViewWrapper>
  )
}
