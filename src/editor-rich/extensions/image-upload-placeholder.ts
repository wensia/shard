import { Extension, type Editor } from "@tiptap/core"
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state"
import { Decoration, DecorationSet } from "@tiptap/pm/view"

import { notify } from "@/lib/notify"

type PlaceholderMeta = { add: { id: string; pos: number } } | { remove: string }

const placeholderKey = new PluginKey<DecorationSet>("shardImageUploadPlaceholder")
let nextPlaceholderId = 0

/** 宿主存好一张图后给编辑器的结果：vault 相对路径与 alt。返回 null 表示没存（被拒或取消）。 */
export interface RichUploadedImage {
  alt: string
  path: string
}

export type RichImageUpload = () => Promise<RichUploadedImage | null>

function placeholderElement() {
  const element = document.createElement("span")
  element.className = "shard-rich-image-uploading"
  element.setAttribute("role", "status")
  element.textContent = "图片上传中…"
  return element
}

/**
 * 图片上传占位：粘贴、拖放、`/图片` 时先在落点放一个装饰，上传在后台进行；
 * 装饰随每个事务映射位置，用户期间继续打字也不会把图片插错地方。
 * 装饰不进文档，序列化与自动保存都看不到它。
 */
export const ShardImageUploadPlaceholder = Extension.create({
  name: "shardImageUploadPlaceholder",

  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: placeholderKey,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, set) {
            let next = set.map(tr.mapping, tr.doc)
            const meta = tr.getMeta(placeholderKey) as PlaceholderMeta | undefined
            if (meta && "add" in meta) {
              next = next.add(tr.doc, [
                Decoration.widget(meta.add.pos, placeholderElement, {
                  id: meta.add.id,
                  key: meta.add.id,
                  side: -1,
                }),
              ])
            } else if (meta && "remove" in meta) {
              next = next.remove(next.find(undefined, undefined, (spec) => spec.id === meta.remove))
            }
            return next
          },
        },
        props: {
          decorations: (state) => placeholderKey.getState(state),
        },
      }),
    ]
  },
})

function placeholderPos(state: EditorState, id: string) {
  const found = placeholderKey.getState(state)?.find(undefined, undefined, (spec) => spec.id === id)
  return found?.[0]?.from ?? null
}

/**
 * 依次跑完上传，每张图在自己的占位处换成图片节点；失败或被拒的只撤掉占位。
 * 多张图按顺序排在同一处，后一张接在前一张后面。
 */
export async function insertImageUploads(editor: Editor, uploads: RichImageUpload[], pos: number) {
  let at = Math.max(0, Math.min(pos, editor.state.doc.content.size))
  for (const upload of uploads) {
    if (editor.isDestroyed) return
    const id = `upload-${++nextPlaceholderId}`
    editor.view.dispatch(
      editor.state.tr.setMeta(placeholderKey, { add: { id, pos: at } }).setMeta("addToHistory", false)
    )
    let result: RichUploadedImage | null = null
    try {
      result = await upload()
    } catch {
      result = null
    }
    if (editor.isDestroyed) return
    const current = placeholderPos(editor.state, id)
    editor.view.dispatch(
      editor.state.tr.setMeta(placeholderKey, { remove: id }).setMeta("addToHistory", false)
    )
    if (!result) continue
    if (current === null || !editor.isEditable) {
      // 图片已经存进附件仓，只是这时文档插不进去（只读、占位已随所在段落被删）。
      notify.warning("图片已保存，但没有插入文档", { description: result.path })
      continue
    }
    const before = editor.state.doc.content.size
    // 不移动选区：用户在上传期间接着打的字留在原处，光标也不会被拽到图片后面。
    editor
      .chain()
      .insertContentAt(
        current,
        { type: "image", attrs: { src: result.path, alt: result.alt } },
        { updateSelection: false }
      )
      .run()
    // 落在块边界时图片会被包进新段落，按文档实际增长量算出下一张的位置，多图顺序不反。
    at = current + (editor.state.doc.content.size - before)
  }
}
