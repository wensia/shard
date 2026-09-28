// Browser storage is a test double; native mode uses the real vault and commands.
import { useMemo, useRef, useState } from "react"
import { createRoot } from "react-dom/client"
import { isTauri } from "@tauri-apps/api/core"
import {
  MindMapCanvas,
  type MindMapCanvasHandle,
  type MindMapCanvasStorage,
} from "@/components/shard/mind-map-workspace"
import { Button } from "@/components/ui/button"
import { Toaster } from "@/components/ui/sonner"
import type { Fragment, MindMapReadResult, ShardDocumentLink, ShardMapFile } from "@/types"
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
type Mock = {
  disk: MindMapReadResult
  failSave: boolean
  fragment: Fragment
  hold: boolean
  propertyWrites: number
  writeBaselines: string[]
  writes: number
  release(): void
}
declare global {
  interface Window {
    __mindMapDocumentMock?: Mock
    __mindMapDocumentHarness: { save(): Promise<boolean>; reopen(): Promise<void>; block(value: boolean): void; dirty(): boolean; opened: ShardDocumentLink[] }
  }
}

function installMock() {
  const waiters: (() => void)[] = []
  const mock: Mock = {
    disk: { file: structuredClone(fixture), path: "notes/中心主题.shardmap.json", lastSavedHash: "a".repeat(64) },
    failSave: false,
    fragment: {
      id: fixture.id,
      content: "```shardmap\n{}\n```",
      fileSha: "fragment-sha-1",
      kind: "outline",
      createdAt: stamp,
      updatedAt: stamp,
      tags: ["outline"],
      category: null,
      path: "notes/中心主题.md",
      gitStatus: "committed",
      error: null,
      archived: false,
      lockbox: false,
      pinned: false,
      related: [],
      properties: [
        { key: "客户", value: { kind: "text", text: "甲" }, editable: true },
      ],
    },
    hold: false,
    propertyWrites: 0,
    writeBaselines: [],
    writes: 0,
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
    if (command === "read_property_registry") return {
      registry: { version: 1, properties: { 客户: { type: "text" } } },
      sha: "registry-sha-1",
    }
    if (command === "register_property_type") return {
      registry: {
        version: 1,
        properties: {
          客户: { type: "text" },
          [String(request.key)]: { type: String(request.propertyType) },
        },
      },
      sha: "registry-sha-2",
    }
    if (command === "set_fragment_property") {
      const key = String(request.key)
      const input = request.value as { type: string; value: unknown }
      const value = input.value === null
        ? { kind: "null" as const }
        : input.type === "checkbox"
          ? { kind: "bool" as const, value: Boolean(input.value) }
          : input.type === "list"
            ? { kind: "list" as const, items: input.value as string[] }
            : input.type === "number"
              ? { kind: "number" as const, text: String(input.value) }
              : { kind: "text" as const, text: String(input.value) }
      const properties = mock.fragment.properties ?? []
      const index = properties.findIndex(property => property.key === key)
      const property = { key, value, editable: true }
      if (index >= 0) properties[index] = property
      else properties.push(property)
      mock.propertyWrites += 1
      mock.fragment = {
        ...mock.fragment,
        fileSha: `property-sha-${mock.propertyWrites}`,
        properties,
      }
      return structuredClone(mock.fragment)
    }
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
  const fragmentMode = new URLSearchParams(location.search).has("fragment")
  const fragmentStorage = useMemo<MindMapCanvasStorage>(() => ({
    isConflict: error => String(error).includes("STALE_BASE"),
    async read() {
      const mock = window.__mindMapDocumentMock!
      return structuredClone({
        baseline: mock.fragment.fileSha,
        file: mock.disk.file,
        fragment: mock.fragment,
      })
    },
    async write(_id, file, baseline) {
      const mock = window.__mindMapDocumentMock!
      mock.writes += 1
      mock.writeBaselines.push(String(baseline))
      if (mock.failSave) throw new Error("模拟保存失败")
      if (baseline !== mock.fragment.fileSha) throw new Error("STALE_BASE: 模拟保存冲突")
      const savedFile = structuredClone(file)
      savedFile.revision = mock.disk.file.revision + 1
      mock.fragment = { ...mock.fragment, fileSha: `graph-sha-${savedFile.revision}` }
      mock.disk = { ...mock.disk, file: savedFile }
      return structuredClone({
        baseline: mock.fragment.fileSha,
        file: savedFile,
        fragment: mock.fragment,
      })
    },
  }), [])
  window.__mindMapDocumentHarness = {
    save: () => handle.current?.save() ?? Promise.resolve(false),
    reopen: async () => { if (await handle.current?.save()) setGeneration(value => value + 1) },
    block: value => handle.current?.setInteractionBlocked(value),
    dirty: () => handle.current?.isDirty() ?? false,
    opened: window.__mindMapDocumentHarness?.opened ?? [],
  }
  return <>
    <main style={{ height: "100dvh", overflow: "hidden", display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", gap: "var(--space-2)", padding: "var(--space-2)" }}><span>{window.__mindMapDocumentMock ? "浏览器模拟存储" : "原生临时资料库"}</span>
        <Button size="sm" variant="outline" onClick={() => void window.__mindMapDocumentHarness.reopen()}>重新打开</Button><output>{message}</output></div>
      <MindMapCanvas key={`${mapId}:${generation}`} ref={handle} mapId={mapId} onOpenLink={link => { window.__mindMapDocumentHarness.opened.push(link); setMessage("已打开关联文档") }} storage={fragmentMode ? fragmentStorage : undefined} />
    </main>
    <Toaster />
  </>
}

if (import.meta.env.DEV) {
  if (!isTauri() && new URLSearchParams(location.search).get("mock") === "1") installMock()
  const root = createRoot(document.getElementById("root")!)
  root.render(<Harness />)
  import.meta.hot?.dispose(() => root.unmount())
}
