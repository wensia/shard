import type { Range } from "@codemirror/state"
import { syntaxTree } from "@codemirror/language"
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view"

// Frozen previous DOM contract. Do not derive this from git HEAD: the regression
// must still exercise the incompatible widget after the fix has been committed.
class LegacyCheckbox extends WidgetType {
  toDOM() {
    const checkbox = document.createElement("span")
    checkbox.className = "shard-task-checkbox shard-cm-task-checkbox"
    checkbox.setAttribute("role", "checkbox")
    checkbox.setAttribute("aria-checked", "false")
    return checkbox
  }
}

function build(view: EditorView) {
  const decorations: Range<Decoration>[] = []
  syntaxTree(view.state).iterate({ enter(node) {
    if (node.name === "TaskMarker") {
      decorations.push(Decoration.replace({ widget: new LegacyCheckbox() }).range(node.from, node.to))
    }
  } })
  return Decoration.set(decorations, true)
}

const plugin = ViewPlugin.fromClass(class {
  decorations: DecorationSet
  constructor(view: EditorView) { this.decorations = build(view) }
  update(update: ViewUpdate) { if (update.docChanged) this.decorations = build(update.view) }
}, { decorations: (value) => value.decorations })

export function createShardLivePreview() { return plugin }
