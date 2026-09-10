import { useState } from "react"
import { createRoot } from "react-dom/client"
import { undo, redo } from "@codemirror/commands"
import { ShardEditor, type ShardEditorHandle } from "@/editor/shard-editor"
import "@/index.css"
import "@fontsource/noto-sans-sc/400.css"

declare global {
  interface Window {
    __hmrHandle: ShardEditorHandle | null
    __hmrBeforeView: ShardEditorHandle["view"]
    __hmrRemount(): void
    __hmrUndo(): boolean
    __hmrRedo(): boolean
  }
}

function Harness() {
  const [value, setValue] = useState("")
  return <ShardEditor editorId="hmr" documentKey="hmr" variant="composer"
    value={value} onChange={setValue} autoFocus ref={(handle) => { window.__hmrHandle = handle }} />
}

const root = createRoot(document.getElementById("root")!)
let generation = 0
window.__hmrRemount = () => root.render(<Harness key={++generation} />)
window.__hmrUndo = () => undo(window.__hmrHandle!.view!)
window.__hmrRedo = () => redo(window.__hmrHandle!.view!)
window.__hmrRemount()
