self.onmessage = ({ data }: MessageEvent<{ id: number; operation: "encode" | "decode"; value: unknown }>) => {
  try {
    if (data.operation === "encode") {
      const bytes = new TextEncoder().encode(JSON.stringify(data.value))
      self.postMessage({ id: data.id, value: bytes }, { transfer: [bytes.buffer] })
    } else {
      const bytes = data.value as ArrayBuffer
      self.postMessage({ id: data.id, value: JSON.parse(new TextDecoder().decode(bytes)) })
    }
  } catch (error) { self.postMessage({ id: data.id, error: String(error) }) }
}

export {}
