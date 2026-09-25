import type { Editor } from "@tiptap/core"
import type { Node as ProseMirrorNode } from "@tiptap/pm/model"
import { useEditorState } from "@tiptap/react"

/**
 * NodeView 共用的两条约定（技术方案 §4.4 末段）。
 *
 * 组件内部的输入框、按钮和输入法组合全部拦在 ProseMirror 之外：`stopEvent`
 * 恒 true，`ignoreMutation` 恒 true。这与旧 CodeMirror widget `ignoreEvent`
 * 恒 true 的经验一致——一旦漏一个事件，光标和组合态就会被 PM 抢走。
 */
export const ISOLATED_NODE_VIEW_OPTIONS = {
  ignoreMutation: () => true,
  stopEvent: () => true,
}

/**
 * 把焦点交回 ProseMirror，并把选区放到该节点之后。
 * 节点是文档最后一个块时先补一个空段落，否则「之后」没有可落脚的文本位置。
 */
export function focusAfterNodeView(
  editor: Editor,
  getPos: () => number | undefined,
  node: ProseMirrorNode
) {
  const pos = getPos()
  if (pos === undefined) {
    editor.commands.focus()
    return
  }

  const end = pos + node.nodeSize
  const chain = editor.chain().focus()
  if (end >= editor.state.doc.content.size) chain.insertContentAt(end, { type: "paragraph" })
  else chain.setTextSelection(end)
  chain.run()
}

/** NodeView 内的组件需要宿主 id 时从外壳的 data 属性取，不另建一条传参链路。 */
export function hostEditorId(editor: Editor) {
  const shell = editor.view.dom.closest("[data-shard-editor]")
  return shell?.getAttribute("data-shard-editor") ?? ""
}

/**
 * NodeView 里读 `editor.isEditable` 必须走这个 hook。
 *
 * React NodeView 只在节点或装饰变化时重渲染，宿主切只读（`setEditable`）
 * 不会让它重渲染；这里订阅编辑器事务，宿主切换后补发的空事务会把新值带进来。
 */
export function useNodeViewEditable(editor: Editor) {
  return useEditorState({
    editor,
    selector: ({ editor: current }) => current?.isEditable ?? false,
  })
}
