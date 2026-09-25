import { Extension } from "@tiptap/core"
import { Plugin, PluginKey } from "@tiptap/pm/state"

import { getClipboardImageFiles } from "@/lib/clipboard-images"
import { parseShardDocumentLink } from "@/lib/document-link"
import type { ShardDocumentLink } from "@/types"

export interface ShardRichHostOptions {
  onSubmit?: () => void
  onToggleZen?: () => void
  /** Escape：宿主收尾（退出禅模式等）。不传即不处理。 */
  onEscape?: () => void
  onPasteFiles?: (files: File[]) => void
  onDropFiles?: (files: File[]) => void
  /** 组合输入结束后回调宿主补发 onChange（组合期间不报值）。 */
  onCompositionEnd?: () => void
  /** 点击正文里的图文档链接（`shard://map|flow/<id>`）。不传即按普通链接不处理。 */
  onOpenDocumentLink?: (link: ShardDocumentLink) => void
}

/** Backspace 在这些行内原子节点之后整体删除，不退化成「先选中再删」两步。 */
const ATOMIC_CHIPS = new Set(["tag", "wikilink"])

function droppedImageFiles(event: DragEvent) {
  const dataTransfer = event.dataTransfer
  if (!dataTransfer) return []
  return Array.from(dataTransfer.files).filter((file) => file.type.startsWith("image/"))
}

/**
 * 宿主键位与剪贴板桥接。
 *
 * - Mod-Enter 与 Ctrl-Enter 都提交：Mac 上 Mod 只映射 Cmd，Ctrl-Enter 要单独绑一次
 *   （沿用旧 CodeMirror keymap 的理由，现有用例按 Control+Enter 写）。
 * - Escape 转交宿主：ProseMirror 的 `captureKeyDown` 对 Esc 一律 `preventDefault`
 *   （prosemirror-view 内建，keyCode 27 直接返回 true），挂在 window 上、按
 *   `defaultPrevented` 让路的禅模式外壳因此永远等不到这个键。建议菜单开着时
 *   Suggestion 插件的 handleKeyDown 排在宿主 keymap 之前，会先把 Esc 吃掉关菜单。
 * - Backspace 在标签与双链芯片后整体删除原子节点，不让它退化成「先选中再删」两步。
 * - compositionend 后补一拍空事务：Suggestion 插件在组合期间被 `allow` 关掉，
 *   上屏后若没有新事务就不会重新求值，菜单会一直不出现。
 */
export const ShardRichHost = Extension.create<ShardRichHostOptions>({
  name: "shardRichHost",

  addOptions() {
    return {}
  },

  addKeyboardShortcuts() {
    const submit = () => {
      if (this.editor.view.composing || !this.options.onSubmit) return false
      this.options.onSubmit()
      return true
    }
    const toggleZen = () => {
      if (this.editor.view.composing || !this.options.onToggleZen) return false
      this.options.onToggleZen()
      return true
    }

    return {
      "Mod-Enter": submit,
      "Ctrl-Enter": submit,
      "Mod-Shift-f": toggleZen,
      "Ctrl-Shift-f": toggleZen,
      Escape: () => {
        if (this.editor.view.composing || !this.options.onEscape) return false
        this.options.onEscape()
        // 不认领这个键：Esc 本来就会被 preventDefault，返回 false 让后面的
        // 绑定（将来若有）还能接着看到它。
        return false
      },
      Backspace: () => {
        const { empty, $from } = this.editor.state.selection
        if (!empty) return false
        const before = $from.nodeBefore
        if (!before || !ATOMIC_CHIPS.has(before.type.name)) return false
        return this.editor.commands.deleteRange({
          from: $from.pos - before.nodeSize,
          to: $from.pos,
        })
      },
    }
  },

  addProseMirrorPlugins() {
    const options = this.options

    return [
      new Plugin({
        key: new PluginKey("shardRichHostDom"),
        props: {
          handleDOMEvents: {
            click: (view, event) => {
              if (!options.onOpenDocumentLink || !(event.target instanceof Element)) return false
              const anchor = event.target.closest("a[href]")
              if (!anchor || !view.dom.contains(anchor)) return false
              const link = parseShardDocumentLink(anchor.getAttribute("href") ?? "")
              if (!link) return false
              event.preventDefault()
              options.onOpenDocumentLink(link)
              return true
            },
            paste: (_view, event) => {
              const files = getClipboardImageFiles(event)
              if (files.length === 0 || !options.onPasteFiles) return false
              event.preventDefault()
              options.onPasteFiles(files)
              return true
            },
            drop: (_view, event) => {
              const files = droppedImageFiles(event)
              if (files.length === 0 || !options.onDropFiles) return false
              event.preventDefault()
              options.onDropFiles(files)
              return true
            },
            compositionend: (view) => {
              window.setTimeout(() => {
                if (view.isDestroyed || view.composing) return
                options.onCompositionEnd?.()
                // 空事务只为让 Suggestion 重新求值，不进历史、不改文档。
                view.dispatch(view.state.tr.setMeta("addToHistory", false))
              }, 0)
              return false
            },
          },
        },
      }),
    ]
  },
})
