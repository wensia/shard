// Browser storage is a test double; native mode uses the real vault and commands.
import { useRef, useState } from "react"
import { createRoot } from "react-dom/client"
import { isTauri } from "@tauri-apps/api/core"
import { MindMapCanvas, type MindMapCanvasHandle } from "@/components/shard/mind-map-workspace"
import { Button } from "@/components/ui/button"
import type { MindMapReadResult, ShardDocumentLink, ShardMapFile } from "@/types"
import "../index.css"
import "@fontsource/noto-sans-sc/400.css"
import "@fontsource/noto-sans-sc/500.css"
import "@fontsource/noto-sans-sc/600.css"

const stamp = "2026-09-07T00:00:00.000Z"
const rootId = "root"
const fixture: ShardMapFile = {
  kind: "shard.map", schemaVersion: 1, id: "document-map", title: "中心主题", createdAt: stamp, updatedAt: stamp,
  savedWithAppVersion: "0.1.3", revision: 1, rootId, hasProtectedLinks: false,
  nodes: Object.fromEntries(["中心主题", "主题甲", "主题乙", "主题丙"].map((text, index) => {
    const id = index ? `branch-${index}` : rootId
    return [id, { id, text, parentId: index ? rootId : null, sortKey: String(index), createdAt: stamp, updatedAt: stamp }]
  })),
}
type Mock = { disk: MindMapReadResult; failSave: boolean; hold: boolean; writes: number; release(): void }
declare global {
  interface Window {
    __mindMapDocumentMock?: Mock
    __mindMapDocumentHarness: { save(): Promise<boolean>; reopen(): Promise<void>; block(value: boolean): void; dirty(): boolean; opened: ShardDocumentLink[] }
  }
}

function installMock() {
  const waiters: (() => void)[] = []
  const mock: Mock = {
    disk: { file: fixture, path: "notes/中心主题.shardmap.json", lastSavedHash: "a".repeat(64) },
    failSave: false, hold: false, writes: 0,
    release() { mock.hold = false; waiters.splice(0).forEach(resolve => resolve()) },
  }
  window.__mindMapDocumentMock = mock
  Object.assign(window, { isTauri: true, __TAURI_INTERNALS__: { invoke: async (command: string, request: Record<string, unknown>) => {
    if (command === "read_mind_map") {
      if (new URLSearchParams(location.search).has("missing")) throw new Error("思维导图文件不存在")
      return structuredClone(mock.disk)
    }
    if (command === "list_mind_maps") return []
    if (command === "list_diagram_documents") return [
      { id: "reference-flow", title: "审批流程", path: "notes/审批流程.shardflow.json", kind: "flowchart", nodeCount: 3 },
      { id: "reference-map", title: "资料结构", path: "notes/资料结构.shardmap.json", kind: "mindmap", nodeCount: 5 },
    ]
    if (command === "set_canvas_grab_cursor") return
    if (command === "write_mind_map") {
      mock.writes++
      if (mock.hold) await new Promise<void>(resolve => waiters.push(resolve))
      if (mock.failSave) throw new Error("模拟保存失败")
      if (request.expectedRevision !== mock.disk.file.revision || request.lastSavedHash !== mock.disk.lastSavedHash) throw new Error("模拟保存冲突")
      const file = structuredClone(request.file as ShardMapFile)
      file.revision = mock.disk.file.revision + 1
      mock.disk = { ...mock.disk, file, lastSavedHash: String(file.revision).padStart(64, "0") }
      return structuredClone(mock.disk)
    }
    throw new Error(`Unexpected mind map test command: ${command}`)
  } } })
}

function Harness() {
  const handle = useRef<MindMapCanvasHandle>(null)
  const [generation, setGeneration] = useState(0)
  const [message, setMessage] = useState("")
  const mapId = new URLSearchParams(location.search).get("id") ?? fixture.id
  window.__mindMapDocumentHarness = {
    save: () => handle.current?.save() ?? Promise.resolve(false),
    reopen: async () => { if (await handle.current?.save()) setGeneration(value => value + 1) },
    block: value => handle.current?.setInteractionBlocked(value),
    dirty: () => handle.current?.isDirty() ?? false,
    opened: window.__mindMapDocumentHarness?.opened ?? [],
  }
  return <main style={{ height: "100dvh", overflow: "hidden", display: "flex", flexDirection: "column" }}>
    <div style={{ display: "flex", gap: "var(--space-2)", padding: "var(--space-2)" }}><span>{window.__mindMapDocumentMock ? "浏览器模拟存储" : "原生临时资料库"}</span>
      <Button size="sm" variant="outline" onClick={() => void window.__mindMapDocumentHarness.reopen()}>重新打开</Button><output>{message}</output></div>
    <MindMapCanvas key={`${mapId}:${generation}`} ref={handle} mapId={mapId} onOpenLink={link => { window.__mindMapDocumentHarness.opened.push(link); setMessage("已打开关联文档") }} />
  </main>
}

if (import.meta.env.DEV) {
  if (!isTauri() && new URLSearchParams(location.search).get("mock") === "1") installMock()
  const root = createRoot(document.getElementById("root")!)
  root.render(<Harness />)
  import.meta.hot?.dispose(() => root.unmount())
}
