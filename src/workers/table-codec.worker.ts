// Tauri raw IPC keeps large JSON encode/decode away from the WKWebView UI thread.
self.onmessage = ({ data }: MessageEvent<{ id: number; operation: "encode" | "decode"; value: unknown }>) => {
  try {
    const value = data.operation === "encode" ? new TextEncoder().encode(JSON.stringify(data.value)) : JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data.value as ArrayBuffer));
    if (value instanceof Uint8Array) self.postMessage({ id: data.id, value }, { transfer: [value.buffer] });
    else self.postMessage({ id: data.id, value });
  } catch (error) { self.postMessage({ id: data.id, error: error instanceof Error ? error.message : String(error) }); }
};
export {};
