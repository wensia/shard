import { AUTH_REQUIRED_EVENT, AUTHENTICATED_EVENT, LOCKBOX_CHANGED_EVENT, VAULT_RESYNC_EVENT } from "./index"

/**
 * `/api/events` 的 SSE 客户端。用 fetch 流而不是 EventSource：能读到 401（EventSource 只会静默关闭），
 * 也能自己带 `Last-Event-ID` 断线续传。全页共享一条连接，最后一个订阅者退出时断开。
 */

type Handler = (payload: unknown) => void

export interface SseMessage {
  event: string
  id?: string
  data: string
}

/** 增量解析 SSE 文本：喂进任意切分的块，吐出完整的消息。 */
export class SseParser {
  private buffer = ""
  private event = "message"
  private id: string | undefined
  private data: string[] = []

  push(chunk: string): SseMessage[] {
    this.buffer += chunk
    const messages: SseMessage[] = []
    let newline = this.buffer.search(/\r\n|\r|\n/u)
    while (newline >= 0) {
      // 块边界可能正好切开 `\r\n`：末尾单独一个 `\r` 先别当换行，等下一块。
      if (newline === this.buffer.length - 1 && this.buffer[newline] === "\r") break
      const line = this.buffer.slice(0, newline)
      const width = this.buffer.startsWith("\r\n", newline) ? 2 : 1
      this.buffer = this.buffer.slice(newline + width)
      if (line === "") {
        if (this.data.length > 0) messages.push({ event: this.event, id: this.id, data: this.data.join("\n") })
        this.event = "message"
        this.data = []
      } else if (!line.startsWith(":")) {
        const colon = line.indexOf(":")
        const field = colon < 0 ? line : line.slice(0, colon)
        const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /u, "")
        if (field === "event") this.event = value
        else if (field === "data") this.data.push(value)
        else if (field === "id") this.id = value
      }
      newline = this.buffer.search(/\r\n|\r|\n/u)
    }
    return messages
  }
}

/** 与服务器实时通道的状态：状态栏据此显示「已连接 / 正在重连 / 需要重新登录」。 */
export type ConnectionState = "connecting" | "connected" | "reconnecting" | "signedOut"

const connectionListeners = new Set<(state: ConnectionState) => void>()
let connectionState: ConnectionState = "connecting"

function setConnection(next: ConnectionState) {
  if (next === connectionState) return
  connectionState = next
  for (const listener of connectionListeners) listener(next)
}

export function getConnectionState() {
  return connectionState
}

export function subscribeConnection(listener: (state: ConnectionState) => void) {
  connectionListeners.add(listener)
  return () => {
    connectionListeners.delete(listener)
  }
}

const handlers = new Set<Handler>()
let controller: AbortController | null = null
let lastEventId: string | undefined
let retryMs = 1000

function dispatch(message: SseMessage) {
  if (message.id) lastEventId = message.id
  if (message.event === "resync") {
    window.dispatchEvent(new CustomEvent(VAULT_RESYNC_EVENT))
    return
  }
  if (message.event === "lockbox-changed") {
    // 服务器不知道密匣内容，只说「变了」：密匣客户端重取快照，算出变化后以 vault-changed 推给界面。
    window.dispatchEvent(new CustomEvent(LOCKBOX_CHANGED_EVENT))
    return
  }
  if (message.event !== "vault-changed") return
  let payload: unknown
  try {
    payload = JSON.parse(message.data)
  } catch {
    return
  }
  for (const handler of handlers) handler(payload)
}

/** 登录成功（登录界面派发 AUTHENTICATED_EVENT）或连接被取消时返回。 */
function waitForLogin(signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const done = () => {
      window.removeEventListener(AUTHENTICATED_EVENT, done)
      signal.removeEventListener("abort", done)
      resolve()
    }
    window.addEventListener(AUTHENTICATED_EVENT, done)
    signal.addEventListener("abort", done)
  })
}

async function connect(signal: AbortSignal) {
  while (!signal.aborted) {
    try {
      const response = await fetch("/api/events", {
        credentials: "same-origin",
        headers: lastEventId ? { "last-event-id": lastEventId } : {},
        signal,
      })
      if (response.status === 401) {
        setConnection("signedOut")
        window.dispatchEvent(new CustomEvent(AUTH_REQUIRED_EVENT))
        await waitForLogin(signal)
        continue
      }
      if (!response.ok || !response.body) throw new Error(`SSE ${response.status}`)
      setConnection("connected")
      retryMs = 1000
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      const parser = new SseParser()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        for (const message of parser.push(decoder.decode(value, { stream: true }))) dispatch(message)
      }
    } catch {
      if (signal.aborted) return
    }
    setConnection("reconnecting")
    // 断线重连：1 秒起翻倍，最多 60 秒，带抖动避免同时重连。
    const wait = retryMs * (0.5 + Math.random() / 2)
    retryMs = Math.min(retryMs * 2, 60_000)
    await new Promise((resolve) => setTimeout(resolve, wait))
  }
}

export function subscribeVaultEvents(handler: Handler): () => void {
  handlers.add(handler)
  if (!controller) {
    controller = new AbortController()
    void connect(controller.signal)
  }
  return () => {
    handlers.delete(handler)
    if (handlers.size === 0 && controller) {
      controller.abort()
      controller = null
    }
  }
}

/**
 * 密匣可能变了：SSE 推来 `lockbox-changed`、游标过旧（`resync`）、断线后重连上（期间的 `lockbox-changed`
 * 不会补发）。不单独开连接——碎片列表的 `vault-changed` 订阅一直开着它。
 */
export function subscribeLockboxEvents(handler: () => void): () => void {
  const notify = () => handler()
  window.addEventListener(LOCKBOX_CHANGED_EVENT, notify)
  window.addEventListener(VAULT_RESYNC_EVENT, notify)
  let previous = connectionState
  const stop = subscribeConnection((next) => {
    if (next === "connected" && previous === "reconnecting") handler()
    previous = next
  })
  return () => {
    window.removeEventListener(LOCKBOX_CHANGED_EVENT, notify)
    window.removeEventListener(VAULT_RESYNC_EVENT, notify)
    stop()
  }
}
