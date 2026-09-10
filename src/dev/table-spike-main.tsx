import { SelectControl } from "@/components/ui/select"
// Isolated dev entry: no App, Workbench, Tauri commands, or vault access.
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import DataEditor, { GridCellKind, type GridCell, type Item } from "@glideapps/glide-data-grid";
import "@glideapps/glide-data-grid/dist/index.css";
import "../index.css";
import "@fontsource/noto-sans-sc/400.css";
import "@fontsource/noto-sans-sc/500.css";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { readKilnGridTheme } from "@/features/tables/kiln-grid-theme";
import { provideTableTextEditor } from "@/features/tables/text-cell-editor";
import type { SpikeRequest, SpikeResponse } from "./table-spike.worker";
import "./table-spike.css";

declare global {
  interface Window { __tableSpike: { events: { type: string; data: string | null; composing: boolean; time: number }[]; samples: { kind: string; total: number; worker: number }[]; snapshot: () => SpikeResponse | undefined } }
}

function TableSpike() {
  const host = useRef<HTMLDivElement>(null);
  const worker = useRef<Worker | null>(null);
  const requests = useRef(new Map<number, { start: number; kind: string }>());
  const requestId = useRef(0);
  const dataRef = useRef<SpikeResponse | undefined>(undefined);
  const [data, setData] = useState<SpikeResponse>();
  const [metrics, setMetrics] = useState<ReturnType<typeof readKilnGridTheme>>();
  const [busy, setBusy] = useState(true);
  const [query, setQuery] = useState("");
  const [size, setSize] = useState(1000);
  const [columns, setColumns] = useState(20);
  const [status, setStatus] = useState("准备字体与合成数据…");
  const [active, setActive] = useState<Item>([0, 0]);
  const [eventCount, setEventCount] = useState(0);
  const send = useCallback((request: Omit<Extract<SpikeRequest, { kind: "generate" }>, "id"> | Omit<Extract<SpikeRequest, { kind: "project" }>, "id"> | Omit<Extract<SpikeRequest, { kind: "edit" }>, "id">) => {
    const id = ++requestId.current;
    requests.current.set(id, { start: performance.now(), kind: request.kind });
    setBusy(true);
    worker.current?.postMessage({ ...request, id });
  }, []);
  useEffect(() => {
    window.__tableSpike = { events: [], samples: [], snapshot: () => dataRef.current };
    const instance = new Worker(new URL("./table-spike.worker.ts", import.meta.url), { type: "module" });
    worker.current = instance;
    instance.onmessage = ({ data: response }: MessageEvent<SpikeResponse>) => {
      const request = requests.current.get(response.id);
      if (!request) return;
      const elapsed = performance.now() - request.start;
      requests.current.delete(response.id);
      dataRef.current = response;
      setData(response);
      setBusy(requests.current.size > 0);
      setStatus(`${response.rows.length.toLocaleString()} 行 · 后台 ${response.elapsed.toFixed(1)} ms · 含传输 ${elapsed.toFixed(1)} ms`);
      window.__tableSpike.samples.push({ kind: request.kind, total: elapsed, worker: response.elapsed });
    };
    instance.onerror = (event) => { setBusy(false); setStatus(`后台失败：${event.message}`); };
    void document.fonts.ready.then(() => {
      if (host.current && worker.current === instance) {
        setMetrics(readKilnGridTheme(host.current));
        send({ kind: "generate", rows: 1000, columns: 20 });
      }
    });
    const log = (event: Event) => {
      const input = event as InputEvent;
      window.__tableSpike.events.push({ type: event.type, data: input.data ?? null, composing: input.isComposing ?? false, time: performance.now() });
    };
    const events = ["compositionstart", "compositionupdate", "compositionend", "beforeinput", "input", "paste", "copy"];
    events.forEach((name) => document.addEventListener(name, log, true));
    const counter = window.setInterval(() => setEventCount(window.__tableSpike.events.length), 500);
    return () => { clearInterval(counter); instance.terminate(); worker.current = null; events.forEach((name) => document.removeEventListener(name, log, true)); };
  }, [send]);
  const getCellContent = useCallback(([col, row]: Item): GridCell => {
    const text = data?.rows[data.order[row]]?.[col] ?? "";
    return { kind: GridCellKind.Text, data: text, displayData: text, allowOverlay: true };
  }, [data]);
  const activeValue = data?.rows[data.order[active[1]]]?.[active[0]] ?? "";
  // Column identity must survive editor/input telemetry updates; otherwise Glide
  // resets its overlay while a native composition is still in progress.
  const gridColumns = useMemo(() => Array.from({ length: columns }, (_, col) => ({ id: `field-${col}`, title: col === 0 ? "名称" : `字段 ${col + 1}`, width: metrics?.columnWidth ?? 0 })), [columns, metrics]);
  return <main className="table-spike" ref={host}>
    <header className="table-spike-toolbar"><strong>表格兼容性试验</strong><span>合成数据 · 不连接资料库</span>
      <label>规模 <SelectControl aria-label="数据规模" value={String(size)} onValueChange={selected => { const value = Number(selected); setSize(value); setColumns(value === 1000 ? 20 : 30); send({ kind: "generate", rows: value, columns: value === 1000 ? 20 : 30 }); }} disabled={busy}
        options={[{ value: "1000", label: "1,000 × 20" }, { value: "10000", label: "10,000 × 30" }, { value: "50000", label: "50,000 × 30" }]} /></label>
      <Input aria-label="按名称筛选" placeholder="按名称筛选" value={query} onChange={(event) => setQuery(event.target.value)} />
      <Button variant="outline" disabled={busy} onClick={() => send({ kind: "project", query, descending: true })}>筛选并倒序</Button>
    </header>
    <section className="table-spike-grid" aria-label="可编辑表格" aria-busy={busy}>
      {metrics && data && <DataEditor width="100%" height="100%" columns={gridColumns}
        rows={data.order.length} getCellContent={getCellContent} theme={metrics.theme} rowHeight={metrics.rowHeight} headerHeight={metrics.headerHeight}
        rowMarkers="number" getCellsForSelection={true} onPaste={true} onCellActivated={setActive} provideEditor={provideTableTextEditor}
        onCellsEdited={(edits) => { send({ kind: "edit", cells: edits.flatMap(({ location: [col, row], value }) => value.kind === GridCellKind.Text ? [{ col, row: data.order[row], value: value.data }] : []) }); return true; }}
        smoothScrollX smoothScrollY />}
    </section>
    <footer className="table-spike-footer"><output role="status">{status}</output><span>输入事件 {eventCount}</span></footer>
    <aside className="table-spike-accessible"><label>当前单元格（可访问编辑器）<Input aria-label="当前单元格内容" key={`${active}-${activeValue}`} defaultValue={activeValue} onBlur={(event) => { if (event.target.value !== activeValue && data) send({ kind: "edit", cells: [{ col: active[0], row: data.order[active[1]], value: event.target.value }] }); }} /></label><p>双击单元格编辑；Enter 确认、Esc 取消。使用系统中文输入法与 Cmd+C / Cmd+V 检查真实交互。</p></aside>
  </main>;
}

if (import.meta.env.DEV) {
  const root = createRoot(document.getElementById("root")!);
  root.render(<React.StrictMode><TableSpike /></React.StrictMode>);
  import.meta.hot?.dispose(() => root.unmount());
}
