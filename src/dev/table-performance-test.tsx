// DEV only. Real Tauri reads, no mock transport, mutations, fixture writes or cache resets.
import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { isTauri } from "@tauri-apps/api/core";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TableWorkspace } from "@/features/tables/table-workspace";
import "../index.css";
import "@fontsource/noto-sans-sc/400.css";
import "@fontsource/noto-sans-sc/500.css";
import "@fontsource/noto-sans-sc/600.css";

type MeasurementMode = "frame-ready-proxy" | "data-react-ready-no-frame";
type Run = { index: number; startedAt: number; measurementMode: MeasurementMode };
type Sample = { index: number; status: "ready" | "error"; totalMs: number; measurementMode: MeasurementMode; visibility: string; documentFocus: boolean; canvas?: { width: number; height: number }; records?: string; error?: string; diagnostics?: Record<string, unknown> };
const COMMON_METHOD = "Warm app/cache: the Tauri process is already running; no process restart or cache purge. Twenty sequential React remounts include read_table, codec, Worker and React readiness. All samples, including the first, are retained; the first may include codec/font initialization. ";
const METHODS: Record<MeasurementMode, string> = {
  "frame-ready-proxy": COMMON_METHOD + "Two requestAnimationFrame boundaries are a frame-readiness proxy, not measurement of actual pixels or input-to-pixel latency.",
  "data-react-ready-no-frame": COMMON_METHOD + "Stops when save state is saved, the loading node is gone and Canvas geometry is usable. No requestAnimationFrame or pixel/presentation wait; this measures data and React preparation only, including when the native document remains hidden. It does not pass the frame-readiness gate or measure visible/input-to-pixel latency.",
};

function MeasuredWorkspace({ path, run, onComplete }: { path: string; run: Run; onComplete(sample: Sample): void }) {
  const host = useRef<HTMLDivElement>(null);
  const state = useRef("loading");
  const inspect = useRef<() => void>(() => undefined);
  const onState = useCallback((next: string) => { state.current = next; inspect.current(); }, []);
  useEffect(() => {
    const element = host.current!;
    let done = false, measuring = false, firstFrame = 0, secondFrame = 0, frameStage = 0;
    const finish = (result: Omit<Sample, "index" | "totalMs" | "measurementMode" | "visibility" | "documentFocus">) => {
      if (done) return;
      done = true; observer.disconnect(); clearTimeout(timeout);
      onComplete({ index: run.index, totalMs: performance.now() - run.startedAt, measurementMode: run.measurementMode, visibility: document.visibilityState, documentFocus: document.hasFocus(), ...result });
    };
    const check = () => {
      if (done) return;
      if (state.current === "error") { finish({ status: "error", error: element.querySelector('[role="alert"]')?.textContent?.trim() || "读取失败" }); return; }
      if (measuring || state.current !== "saved" || element.querySelector('.table-workspace-empty[role="status"]')) return;
      // disabled intentionally leaves aria-busy=true; observe the real loading
      // node and usable canvas geometry instead. Inspect no records or cell DOM.
      const canvas = element.querySelector<HTMLCanvasElement>(".table-workspace-grid canvas");
      const bounds = canvas?.getBoundingClientRect();
      if (!bounds || bounds.width <= 1 || bounds.height <= 1) return;
      if (run.measurementMode === "data-react-ready-no-frame") {
        finish({ status: "ready", canvas: { width: bounds.width, height: bounds.height }, records: element.querySelector(".table-workspace-footer > span")?.textContent ?? "" });
        return;
      }
      measuring = true;
      firstFrame = requestAnimationFrame(() => { frameStage = 1; secondFrame = requestAnimationFrame(() => {
        frameStage = 2;
        if (done) return;
        const finalBounds = canvas?.getBoundingClientRect();
        if (state.current !== "saved" || !canvas?.isConnected || !finalBounds || finalBounds.width <= 1 || finalBounds.height <= 1) { measuring = false; check(); return; }
        finish({ status: "ready", canvas: { width: finalBounds.width, height: finalBounds.height }, records: element.querySelector(".table-workspace-footer > span")?.textContent ?? "" });
      }); });
    };
    const observer = new MutationObserver(check);
    const timeout = setTimeout(() => {
      const canvas = element.querySelector(".table-workspace-grid canvas");
      const bounds = canvas?.getBoundingClientRect();
      const loading = !!element.querySelector('.table-workspace-empty[role="status"]');
      const diagnostics = { saveState: state.current, hasCanvas: !!canvas, geometry: bounds ? { width: bounds.width, height: bounds.height } : null, loadingNode: loading, measuring, frameStage, visibility: document.visibilityState, documentFocus: document.hasFocus() };
      finish({ status: "error", error: `30s s:${state.current} c:${bounds?.width ?? 0}×${bounds?.height ?? 0} l:${loading} m:${measuring} rAF:${frameStage} ${document.visibilityState} focus:${document.hasFocus()}`, diagnostics });
    }, 30_000);
    inspect.current = check;
    observer.observe(element, { subtree: true, childList: true, attributes: true, attributeFilter: ["style", "width", "height"] });
    check();
    return () => { done = true; inspect.current = () => undefined; observer.disconnect(); clearTimeout(timeout); cancelAnimationFrame(firstFrame); cancelAnimationFrame(secondFrame); };
  }, [run, onComplete]);
  return <div ref={host} style={{ flex: 1, minHeight: 0, minWidth: 0 }}><TableWorkspace path={path} title={path.split("/").slice(-1)[0] || "性能验收"} disabled onSaveStateChange={onState} /></div>;
}

function PerformanceHarness() {
  const [path, setPath] = useState(new URLSearchParams(location.search).get("path") ?? "");
  const native = isTauri();
  const [run, setRun] = useState<Run | null>(null);
  const [samples, setSamples] = useState<Sample[]>([]);
  const [busy, setBusy] = useState(false);
  const [startedAt, setStartedAt] = useState<string | null>(null);
  const [measurementMode, setMeasurementMode] = useState<MeasurementMode>("frame-ready-proxy");
  const pending = useRef<{ index: number; resolve(sample: Sample): void } | null>(null);
  const onComplete = useCallback((sample: Sample) => { if (pending.current?.index === sample.index) { const work = pending.current; pending.current = null; work.resolve(sample); } }, []);
  async function measure(mode: MeasurementMode) {
    if (busy || !native || !path) return;
    setBusy(true); setSamples([]); setStartedAt(new Date().toISOString()); setMeasurementMode(mode);
    try {
      for (let index = 1; index <= 20; index++) {
        // A new key unmounts the previous workspace and creates a fresh table Worker.
        const sample = await new Promise<Sample>(resolve => { pending.current = { index, resolve }; setRun({ index, startedAt: performance.now(), measurementMode: mode }); });
        setSamples(previous => [...previous, sample]);
        if (sample.status === "error") break;
      }
    } finally { setBusy(false); }
  }
  const timings = samples.filter(sample => sample.status === "ready").map(sample => sample.totalMs).sort((a, b) => a - b);
  const percentile = (p: number) => timings.length ? timings[Math.ceil(timings.length * p) - 1] : null;
  const report = { path, runtime: native ? "real Tauri" : "unavailable: native Tauri required", measurementMode, method: METHODS[measurementMode], startedAt, viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
    summary: { requested: 20, completed: timings.length, p50Ms: percentile(0.5), p95Ms: percentile(0.95), maxMs: timings[timings.length - 1] ?? null }, samples };
  return <main style={{ display: "flex", flexDirection: "column", height: "100dvh", minHeight: 0, overflow: "hidden", background: "var(--background)", color: "var(--foreground)", fontFamily: '"Noto Sans SC", var(--font-sans)' }}>
    <header style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", flexWrap: "wrap", padding: "var(--space-3)", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
      <strong>数据表只读加载测量</strong><Button size="sm" disabled={!native || !path || busy} onClick={() => { void measure("frame-ready-proxy"); }}>重挂载并测量 20 次</Button><Button size="sm" variant="outline" disabled={!native || !path || busy} onClick={() => { void measure("data-react-ready-no-frame"); }}>仅测读取与 React 就绪 20 次</Button><output role="status">{busy ? `测量 ${run?.index ?? 1} / 20` : samples.length ? "测量结束" : "等待开始"}</output>
      <label style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", flex: "1 1 calc(var(--space-12) * 6)", minWidth: 0 }}>路径<Input aria-label="数据表路径" value={path} disabled={busy} onChange={event => { setPath(event.target.value); setRun(null); setSamples([]); setStartedAt(null); }} /></label>
      <span style={{ color: "var(--muted-foreground)", fontSize: "var(--text-meta)" }}>暖应用/缓存；双 rAF 仅帧边界代理。独立读取/React 模式不含 rAF 或像素就绪。</span>
    </header>
    {!native || !path ? <p style={{ padding: "var(--space-4)" }}>{!native ? "需要真实 Tauri 环境；此入口不提供 mock。" : "请通过 ?path=notes/文件.shardtable.json 指定只读路径。"}</p>
      : run ? <MeasuredWorkspace key={`${startedAt}:${run.index}`} path={path} run={run} onComplete={onComplete} /> : <p style={{ flex: 1, padding: "var(--space-4)" }}>路径：{path}。点击开始，只读取文件，不修改资料库。</p>}
    <output aria-label="测量摘要" style={{ flexShrink: 0, paddingInline: "var(--space-3)", fontSize: "var(--text-meta)" }}>{measurementMode === "data-react-ready-no-frame" ? "仅读取/React，无帧计时" : "双 rAF 帧代理"}；完成 {timings.length}/20；p50 {percentile(0.5)?.toFixed(3) ?? "—"} ms；p95 {percentile(0.95)?.toFixed(3) ?? "—"} ms；max {report.summary.maxMs?.toFixed(3) ?? "—"} ms</output>
    <div role="list" aria-label="样本明细" style={{ flexShrink: 0, height: "15vh", overflow: "auto", paddingInline: "var(--space-3)", fontSize: "var(--text-meta)" }}>{samples.map(sample => <div role="listitem" key={sample.index}>{`样本 ${sample.index} ${sample.status} ${sample.totalMs.toFixed(3)} ms；宽 ${sample.canvas?.width ?? "—"} 高 ${sample.canvas?.height ?? "—"}；${sample.visibility} focus:${sample.documentFocus}；${sample.records || sample.error || ""}`.slice(0, 150)}</div>)}</div>
    <pre aria-label="测量结果" style={{ flexShrink: 0, maxHeight: "20vh", overflow: "auto", padding: "var(--space-3)", borderTop: "1px solid var(--border)", fontFamily: "var(--font-mono)", fontSize: "var(--text-meta)", whiteSpace: "pre-wrap" }}>{JSON.stringify(report, null, 2)}</pre>
  </main>;
}

if (import.meta.env.DEV) {
  const root = createRoot(document.getElementById("root")!); root.render(<PerformanceHarness />);
  import.meta.hot?.dispose(() => root.unmount());
}
