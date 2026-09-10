export type SpikeRequest =
  | { id: number; kind: "generate"; rows: number; columns: number }
  | { id: number; kind: "project"; query: string; descending: boolean }
  | { id: number; kind: "edit"; cells: { row: number; col: number; value: string }[] };
export interface SpikeResponse { id: number; rows: string[][]; order: number[]; elapsed: number }
let rows: string[][] = [];
let order: number[] = [];
self.onmessage = ({ data }: MessageEvent<SpikeRequest>) => {
  const started = performance.now();
  if (data.kind === "generate") {
    rows = Array.from({ length: data.rows }, (_, row) => Array.from({ length: data.columns }, (_, col) => col === 0 ? `记录 ${row + 1} 中文测试` : `${col + 1}-${row + 1}`));
    order = rows.map((_, i) => i);
  } else if (data.kind === "project") {
    order = rows.flatMap((row, i) => row[0].includes(data.query) ? [i] : []);
    const collator = new Intl.Collator("zh-CN", { numeric: true });
    order.sort((a, b) => (data.descending ? -1 : 1) * collator.compare(rows[a][0], rows[b][0]) || a - b);
  } else {
    for (const cell of data.cells) if (rows[cell.row]?.[cell.col] !== undefined) rows[cell.row][cell.col] = cell.value;
  }
  self.postMessage({ id: data.id, rows, order, elapsed: performance.now() - started } satisfies SpikeResponse);
};
