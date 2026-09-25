import { Extension } from "@tiptap/core"
import { Plugin, PluginKey } from "@tiptap/pm/state"
import type { EditorView } from "@tiptap/pm/view"

import { attachSelectionBand } from "@/lib/selection-band"

/** Tiptap 初始将编辑器建在游离容器中，实际宿主需要在挂载后解析。 */
class SelectionBandView {
  private host: HTMLElement | null = null
  private detach: (() => void) | null = null
  private frame = 0

  constructor(private readonly view: EditorView) {
    this.scheduleHost()
  }

  update() {
    this.resolveHost()
  }

  destroy() {
    cancelAnimationFrame(this.frame)
    this.detach?.()
    this.detach = null
    this.host = null
  }

  private resolveHost = () => {
    const host = this.view.dom.parentElement
    if (!host?.isConnected) {
      if (!this.view.isDestroyed) this.scheduleHost()
      return
    }
    if (host === this.host) return
    this.detach?.()
    this.host = host
    this.detach = attachSelectionBand(this.view.dom, host)
  }

  private scheduleHost() {
    if (this.frame) return
    this.frame = requestAnimationFrame(() => {
      this.frame = 0
      this.resolveHost()
    })
  }
}

export const ShardSelectionBand = Extension.create({
  name: "shardSelectionBand",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("shardSelectionBand"),
        view: (view) => new SelectionBandView(view),
      }),
    ]
  },
})
