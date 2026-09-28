// Isolated development harness. Native mode always uses the real Tauri commands.
import { useEffect, useMemo, useRef, useState } from "react"
import { createRoot } from "react-dom/client"
import { isTauri } from "@tauri-apps/api/core"
import { Button } from "@/components/ui/button"
import { CanvasWorkspace, type CanvasWorkspaceHandle } from "@/features/canvas/canvas-workspace"
import { createCanvas } from "@/features/canvas/api"
import { createCanvasFile, createCanvasMindMap, createCanvasNode, type CanvasReadResult, type CanvasFile } from "@/features/canvas/model"
import { listFragments, readGraphFragment, writeGraphFragment } from "@/lib/api"
import type { Fragment, PropertyRegistry, ShardDocumentLink } from "@/types"
import "../index.css"
import "@fontsource/noto-sans-sc/400.css"
import "@fontsource/noto-sans-sc/500.css"
import "@fontsource/noto-sans-sc/600.css"

type CanvasMock = {
  disk: CanvasReadResult; calls: { command: string; request: Record<string, unknown> }[]
  failSave: boolean; fragment: Fragment; hold: boolean; release(): void; missing: boolean
}
declare global {
  interface Window {
    __canvasMock?: CanvasMock
    __canvasHarness: { flush(): Promise<boolean>; dirty(): boolean; block(value: boolean): void; reopen(): Promise<void>; opened: ShardDocumentLink[]; closed: number }
  }
}
const stamp = "2026-09-07T00:00:00.000Z"
const fragments: Fragment[] = [
  { id: "canvas-fragment", content: "项目研究资料\n先整理需求，再绘制流程。", tags: ["inbox"], path: "fragments/2026/09/reference.md" },
  { id: "canvas-note", content: "# 设计笔记\n这是一篇引用来源。", tags: ["inbox", "note"], path: "notes/设计笔记.md" },
].map(item => ({ ...item, kind: item.tags.includes("note") ? "note" : "fragment", createdAt: stamp, updatedAt: stamp, category: null, gitStatus: "committed", error: null, archived: false, lockbox: false, pinned: false, related: [] }))

function installMock() {
  const params = new URLSearchParams(location.search)
  const waiters: (() => void)[] = []
  const file = createCanvasFile("验收画布")
  file.revision = 1
  if (params.has("legacy")) {
    file.kind = "shard.canvas"
    file.nodes = [createCanvasNode("mindmap", { x: 0, y: 0 }), createCanvasNode("process", { x: 500, y: 0 })]
    file.edges = [{ id: "cross-link", source: file.nodes[0].id, target: file.nodes[1].id, label: "依据" }]
  }
  const map = createCanvasMindMap("现有导图")
  const fragment: Fragment = {
    ...fragments[0],
    id: "flowchart-fragment",
    content: "---\ntags:\n  - flowchart\n阶段: 草稿\n---\n\n```shardflow\n{}\n```",
    fileSha: "a".repeat(64),
    kind: "flowchart",
    path: "fragments/2026/09/flowchart-fragment.md",
    properties: [{ key: "阶段", value: { kind: "text", text: "草稿" }, editable: true }],
    tags: ["flowchart"],
  }
  const registry: PropertyRegistry = { version: 1, properties: { 阶段: { type: "text" } } }
  let registrySha = "registry-sha-1"
  let revision = 1
  const mock: CanvasMock = {
    disk: { file, path: params.has("fragment") ? fragment.path : file.kind === "shard.canvas" ? "notes/验收画布.shardcanvas.json" : "notes/验收流程.shardflow.json", lastSavedHash: "a".repeat(64) },
    calls: [], failSave: false, fragment, hold: false,
    missing: params.has("missing"),
    release() { mock.hold = false; waiters.splice(0).forEach(resolve => resolve()) },
  }
  window.__canvasMock = mock
  Object.assign(window, { isTauri: true, __TAURI_INTERNALS__: { invoke: async (command: string, args: Record<string, unknown> | Uint8Array) => {
    const raw = args instanceof Uint8Array
    const request = raw ? JSON.parse(new TextDecoder().decode(args)) as Record<string, unknown> : args
    mock.calls.push({ command, request: structuredClone(request) })
    let response: unknown
    if (command === "read_canvas") {
      if (mock.missing) throw new Error("画布文件不存在")
      response = structuredClone(mock.disk)
    } else if (command === "read_graph_fragment") {
      response = { fragment: structuredClone(mock.fragment), graph: structuredClone(mock.disk.file) }
    } else if (command === "write_canvas") {
      if (mock.hold) await new Promise<void>(resolve => waiters.push(resolve))
      if (mock.failSave) throw new Error("测试保存失败，草稿已保留")
      if (request.expectedRevision !== mock.disk.file.revision || request.lastSavedHash !== mock.disk.lastSavedHash) throw new Error("画布冲突，外部版本已保留")
      const revision = mock.disk.file.revision + 1
      mock.disk = { ...mock.disk, file: { ...structuredClone(request.file as CanvasFile), revision, updatedAt: new Date().toISOString() }, lastSavedHash: revision.toString(16).padStart(64, "0") }
      response = structuredClone(mock.disk)
    } else if (command === "write_graph_fragment") {
      if (mock.hold) await new Promise<void>(resolve => waiters.push(resolve))
      if (mock.failSave) throw new Error("测试保存失败，草稿已保留")
      if (request.expectedFileSha !== mock.fragment.fileSha) throw new Error("STALE_BASE:保存基线过期")
      const nextRevision = mock.disk.file.revision + 1
      mock.fragment.fileSha = `graph-sha-${++revision}`
      mock.disk = {
        ...mock.disk,
        file: { ...structuredClone(request.graph as CanvasFile), revision: nextRevision, updatedAt: new Date().toISOString() },
        lastSavedHash: mock.fragment.fileSha,
      }
      response = { fragment: structuredClone(mock.fragment), graph: structuredClone(mock.disk.file) }
    } else if (command === "read_property_registry") {
      response = { registry: structuredClone(registry), sha: registrySha }
    } else if (command === "register_property_type") {
      if (request.expectedSha !== registrySha) throw new Error("登记表已变化")
      registry.properties[String(request.key)] = { type: String(request.propertyType) as "text" }
      registrySha = `registry-sha-${++revision}`
      response = { registry: structuredClone(registry), sha: registrySha }
    } else if (command === "set_fragment_property" || command === "remove_fragment_property") {
      const index = mock.fragment.properties!.findIndex(item => item.key === request.key)
      if (command === "remove_fragment_property") {
        if (index >= 0) mock.fragment.properties!.splice(index, 1)
      } else {
        const input = request.value as { type: string; value: unknown }
        const value = input.value === null ? { kind: "null" as const }
          : input.type === "checkbox" ? { kind: "bool" as const, value: Boolean(input.value) }
          : input.type === "list" ? { kind: "list" as const, items: input.value as string[] }
          : input.type === "number" ? { kind: "number" as const, text: String(input.value) }
          : { kind: "text" as const, text: String(input.value) }
        const property = { key: String(request.key), value, editable: true }
        if (index >= 0) mock.fragment.properties![index] = property
        else mock.fragment.properties!.push(property)
      }
      mock.fragment.fileSha = `property-sha-${++revision}`
      mock.disk.lastSavedHash = mock.fragment.fileSha
      response = structuredClone(mock.fragment)
    } else if (command === "list_diagram_documents") {
      response = [{ id: map.id, title: map.title, kind: "mindmap", nodeCount: 1, path: "notes/现有导图.shardmap.json" },
        { id: "linked-flow", title: "关联流程", kind: "flowchart", nodeCount: 2, path: "notes/关联流程.shardflow.json" }]
    } else if (command === "split_canvas") {
      if (mock.failSave) throw new Error("测试拆分失败，原画布已保留")
      response = { documents: [{ id: "split-map", title: "中心主题", kind: "mindmap", nodeCount: 1, path: "notes/中心主题.shardmap.json" },
        { id: "split-flow", title: "验收流程", kind: "flowchart", nodeCount: 1, path: "notes/验收流程.shardflow.json" }], indexPath: "notes/验收画布-关联说明.md" }
    } else if (command === "list_mind_maps") {
      response = [{ id: map.id, title: map.title, createdAt: map.createdAt, updatedAt: map.updatedAt, nodeCount: 1, path: "notes/现有导图.shardmap.json" }]
    } else if (command === "read_mind_map") response = { file: map, path: "notes/现有导图.shardmap.json", lastSavedHash: "b".repeat(64) }
    else throw new Error(`Unexpected canvas test command: ${command}`)
    return raw ? new TextEncoder().encode(JSON.stringify(response)).buffer : response
  } } })
}

function Harness() {
  const handle = useRef<CanvasWorkspaceHandle>(null)
  const params = new URLSearchParams(location.search)
  const fragmentMode = params.has("fragment")
  const [path, setPath] = useState(window.__canvasMock?.disk.path ?? params.get("path") ?? localStorage.getItem("shard.canvas-acceptance-path"))
  const [sources, setSources] = useState<Fragment[]>(window.__canvasMock ? fragments : [])
  const [fragment, setFragment] = useState<Fragment | undefined>(fragmentMode ? window.__canvasMock?.fragment : undefined)
  const [generation, setGeneration] = useState(0)
  const [message, setMessage] = useState("")
  const [state, setState] = useState("saved")
  const [closed, setClosed] = useState(false)
  const fragmentStorage = useMemo(() => fragmentMode ? {
    async readFromStorage() {
      const result = await readGraphFragment("flowchart-fragment")
      if (!result.fragment.fileSha) throw new Error("流程图片段缺少文件保存基线。")
      return { file: result.graph as CanvasFile, lastSavedHash: result.fragment.fileSha, path: result.fragment.path }
    },
    async saveTransport(request: { file: CanvasFile; lastSavedHash: string }) {
      const result = await writeGraphFragment<CanvasFile>("flowchart-fragment", request.file, request.lastSavedHash)
      if (!result.fragment.fileSha) throw new Error("流程图片段缺少文件保存基线。")
      setFragment(result.fragment)
      return { file: result.graph, lastSavedHash: result.fragment.fileSha, path: result.fragment.path }
    },
  } : null, [fragmentMode])
  useEffect(() => { if (!window.__canvasMock) void listFragments().then(result => setSources(result.fragments), error => setMessage(String(error))) }, [])
  window.__canvasHarness = {
    flush: () => handle.current?.flush() ?? Promise.resolve(true), dirty: () => handle.current?.isDirty() ?? false,
    block: value => handle.current?.setInteractionBlocked(value),
    reopen: async () => { if (await handle.current?.flush()) setGeneration(value => value + 1) },
    opened: window.__canvasHarness?.opened ?? [], closed: window.__canvasHarness?.closed ?? 0,
  }
  return <main style={{ height: "100dvh", display: "flex", flexDirection: "column", overflow: "hidden" }}>
    <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", padding: "var(--space-2)", flexShrink: 0 }}>
      <span>{window.__canvasMock ? "浏览器模拟存储" : "原生临时资料库"}</span>
      {!path && <Button onClick={() => { void createCanvas("notes", "原生画布验收", createCanvasFile("原生画布验收")).then(result => { setPath(result.path); localStorage.setItem("shard.canvas-acceptance-path", result.path) }, error => setMessage(String(error))) }}>新建验收画布</Button>}
      <Button onClick={() => { void window.__canvasHarness.reopen() }}>重新打开</Button>
      <Button onClick={() => { void (async () => { if (await window.__canvasHarness.flush()) { window.__canvasHarness.closed++; setClosed(true) } })() }}>离开画布</Button>
      <output aria-label="验收保存状态">{state}</output>
    </div>
    {path && !closed && <CanvasWorkspace key={`${path}:${generation}`} ref={handle} path={path} fragment={fragment} fragmentMode={fragmentMode} fragments={sources}
      onFragmentUpdated={setFragment}
      readFromStorage={fragmentStorage?.readFromStorage} saveTransport={fragmentStorage?.saveTransport}
      onRecovered={nextPath => { setPath(nextPath); if (!window.__canvasMock) localStorage.setItem("shard.canvas-acceptance-path", nextPath) }}
      onSplit={result => { setMessage(`已打开关联说明：${result.indexPath}`) }}
      onSaveStateChange={setState} onOpenLink={link => { window.__canvasHarness.opened.push(link); setMessage("已打开引用来源") }} />}
    {closed && <p>已离开画布</p>}
    {message && <output>{message}</output>}
  </main>
}

if (import.meta.env.DEV) {
  if (!isTauri() && new URLSearchParams(location.search).get("mock") === "1") installMock()
  const root = createRoot(document.getElementById("root")!)
  root.render(<Harness />)
  import.meta.hot?.dispose(() => root.unmount())
}
