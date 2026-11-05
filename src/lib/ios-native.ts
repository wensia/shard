import { COLOR_MODE_CHANGED_EVENT, getStoredColorMode, type ColorMode } from "@/lib/theme"

/** Native capabilities for the bundled Web app. Credentials stay in the iOS host. */
export interface IOSBridgeMessage {
  type: "bootstrap" | "request" | "stream" | "cancel" | "share" | "legacy" | "sync" | "appearance" | "voice"
  id?: string
  path?: string
  method?: string
  headers?: Record<string, string>
  bodyBase64?: string
  fileName?: string
}

export interface IOSBridgeReply {
  status: number
  headers: Record<string, string>
  bodyBase64: string
}

export interface IOSMessageHandler {
  postMessage(message: IOSBridgeMessage): Promise<IOSBridgeReply>
}

export interface IOSNativeState {
  serverURL: string
  email: string | null
  authenticated: boolean
  sync: { state: "online" | "offline" | "syncing"; pending: number }
  legacyAvailable: boolean
}

declare global {
  interface Window {
    webkit?: { messageHandlers?: { shardApp?: IOSMessageHandler } }
  }
}

export const IOS_NATIVE_EVENT = "shard:ios-event"
const API_PREFIX = "/api/"
const FORBIDDEN_HEADERS = new Set(["authorization", "cookie", "origin", "host", "referer"])
const BODYLESS_STATUS = new Set([204, 205, 304])
const BASE64_CHUNK = 32_764
let nativeState: IOSNativeState | null = null
let stateRefresh: Promise<void> | null = null
const stateListeners = new Set<() => void>()
let refreshAgain = false
let installed = false
let appearanceMode: ColorMode = "system"
let lastAppearance = ""
let appearanceQueue: Promise<void> = Promise.resolve()

export function isIOSNative() {
  return typeof window !== "undefined" && typeof window.webkit?.messageHandlers?.shardApp?.postMessage === "function"
}

export function iosNativeState() {
  return nativeState
}

export function subscribeIOSNativeState(listener: () => void) {
  stateListeners.add(listener)
  return () => { stateListeners.delete(listener) }
}

function handler() {
  const value = window.webkit?.messageHandlers?.shardApp
  if (!value) throw new Error("iOS 连接尚未准备好。")
  return value
}

function abortError(signal: AbortSignal) {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError")
}

function checkAbort(signal?: AbortSignal) {
  if (signal?.aborted) throw abortError(signal)
}

function yieldToUI() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0))
}

/** Base64 work is bounded per turn, including large image requests and downloads. */
export async function encodeIOSBytes(bytes: Uint8Array, signal?: AbortSignal) {
  const chunks: string[] = []
  const chunkSize = 32_766 // A multiple of 3, so only the final piece has padding.
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    checkAbort(signal)
    chunks.push(btoa(String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))))
    if (offset > 0 && offset % (chunkSize * 8) === 0) await yieldToUI()
  }
  checkAbort(signal)
  return chunks.join("")
}

export async function decodeIOSBytes(base64: string, signal?: AbortSignal) {
  if (typeof base64 !== "string" || base64.length % 4 !== 0) throw new Error("iOS 连接响应无效。")
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0
  const bytes = new Uint8Array(base64.length / 4 * 3 - padding)
  let position = 0
  for (let offset = 0; offset < base64.length; offset += BASE64_CHUNK) {
    checkAbort(signal)
    const piece = base64.slice(offset, offset + BASE64_CHUNK)
    if (/[^A-Za-z0-9+/=]/u.test(piece)) throw new Error("iOS 连接响应无效。")
    if (offset + BASE64_CHUNK < base64.length && piece.includes("=")) throw new Error("iOS 连接响应无效。")
    let binary: string
    try { binary = atob(piece) } catch { throw new Error("iOS 连接响应无效。") }
    for (let index = 0; index < binary.length; index += 1) bytes[position++] = binary.charCodeAt(index)
    if (offset > 0 && offset % (BASE64_CHUNK * 8) === 0) await yieldToUI()
  }
  if (position !== bytes.length) throw new Error("iOS 连接响应无效。")
  checkAbort(signal)
  return bytes
}

function validateReply(value: IOSBridgeReply) {
  if (!value || !Number.isInteger(value.status) || value.status < 200 || value.status > 599 ||
      typeof value.bodyBase64 !== "string" || !value.headers || typeof value.headers !== "object" || Array.isArray(value.headers) ||
      Object.values(value.headers).some((header) => typeof header !== "string")) {
    throw new Error("iOS 连接响应无效。")
  }
  return value
}

function responseHeaders(reply: IOSBridgeReply) {
  const headers = new Headers(reply.headers)
  // Cookies belong to the native HTTPS session, never the JS page.
  for (const name of ["set-cookie", "set-cookie2", "cookie", "authorization", "content-length", "content-encoding", "transfer-encoding"]) {
    headers.delete(name)
  }
  return headers
}

async function responseFromReply(raw: IOSBridgeReply, method = "GET", signal?: AbortSignal) {
  const reply = validateReply(raw)
  const bytes = await decodeIOSBytes(reply.bodyBase64, signal)
  const body = method === "HEAD" || BODYLESS_STATUS.has(reply.status) ? null : bytes as BodyInit
  return new Response(body, { status: reply.status, headers: responseHeaders(reply) })
}

function cancel(native: IOSMessageHandler, id: string) {
  void native.postMessage({ type: "cancel", id }).catch(() => undefined)
}

async function requestNative(native: IOSMessageHandler, message: IOSBridgeMessage, signal: AbortSignal) {
  checkAbort(signal)
  const id = crypto.randomUUID()
  let abort: (() => void) | undefined
  const interrupted = new Promise<never>((_, reject) => {
    abort = () => {
      cancel(native, id)
      reject(abortError(signal))
    }
    signal.addEventListener("abort", abort, { once: true })
  })
  try {
    return await Promise.race([native.postMessage({ ...message, id }), interrupted])
  } finally {
    if (abort) signal.removeEventListener("abort", abort)
  }
}

async function streamNative(native: IOSMessageHandler, message: IOSBridgeMessage, signal: AbortSignal, events: EventTarget) {
  checkAbort(signal)
  const id = crypto.randomUUID()
  let closed = false
  let cancelled = false
  const stopNative = () => {
    if (cancelled) return
    cancelled = true
    cancel(native, id)
  }
  let control: ReadableStreamDefaultController<Uint8Array>
  let rejectEarly: (error: unknown) => void = () => {}
  const earlyFailure = new Promise<never>((_, reject) => { rejectEarly = reject })
  const cleanup = () => {
    signal.removeEventListener("abort", abort)
    events.removeEventListener(IOS_NATIVE_EVENT, receive)
  }
  const fail = (error: unknown) => {
    if (closed) return
    closed = true
    cleanup()
    control.error(error)
    rejectEarly(error)
  }
  const abort = () => {
    fail(abortError(signal))
    stopNative()
  }
  const receive = (event: Event) => {
    const detail = (event as CustomEvent).detail
    if (closed || !detail || detail.type !== "stream" || detail.id !== id) return
    if (typeof detail.error === "string") {
      fail(new Error(detail.error))
      stopNative()
      return
    }
    if (typeof detail.chunk === "string") control.enqueue(new TextEncoder().encode(detail.chunk))
    if (detail.done === true) {
      closed = true
      cleanup()
      control.close()
    }
  }
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      control = controller
      events.addEventListener(IOS_NATIVE_EVENT, receive)
      signal.addEventListener("abort", abort, { once: true })
    },
    cancel() {
      closed = true
      cleanup()
      stopNative()
    },
  })
  try {
    const reply = validateReply(await Promise.race([native.postMessage({ ...message, id }), earlyFailure]))
    if (reply.status < 200 || reply.status >= 300) {
      if (!closed) {
        closed = true
        cleanup()
        control!.close()
      }
      stopNative()
      return responseFromReply(reply, message.method, signal)
    }
    return new Response(body, { status: reply.status, headers: responseHeaders(reply) })
  } catch (error) {
    fail(error)
    stopNative()
    throw error
  }
}

function sameOrigin(a: URL, b: URL) {
  // Custom-scheme origins can both report "null" even when their hosts differ.
  return a.protocol === b.protocol && a.hostname === b.hostname && a.port === b.port
}

function canRequestSession(path: string, method: string) {
  // These lists are mounted in settings; only the explicit management action may ask for a password.
  if (method === "GET" && /^\/api\/(?:auth\/sessions|devices)(?:\?|$)/u.test(path)) return false
  return !/^\/api\/auth\/(?:state|login|logout|stepup|setup)(?:\/|\?|$)/u.test(path)
}

export function createIOSFetch(native: IOSMessageHandler, pageURL: string, originalFetch: typeof fetch, events: EventTarget = window): typeof fetch {
  const page = new URL(pageURL)
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), page)
    if (!sameOrigin(url, page) || !url.pathname.startsWith(API_PREFIX)) return originalFetch(input, init)
    if (url.username || url.password) throw new TypeError("iOS 请求地址无效。")
    const supplied = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
    for (const name of FORBIDDEN_HEADERS) {
      if (supplied.has(name)) throw new TypeError("iOS 请求不能提交身份认证请求头。")
    }
    const request = input instanceof Request ? new Request(input, init) : new Request(url.href, init)
    checkAbort(request.signal)
    const headers = Object.fromEntries(request.headers.entries())
    const path = url.pathname + url.search
    const message: IOSBridgeMessage = { type: "request", path, method: request.method, headers }
    if (request.body) message.bodyBase64 = await encodeIOSBytes(new Uint8Array(await request.arrayBuffer()), request.signal)
    if (url.pathname === "/api/events" && request.method === "GET") {
      return streamNative(native, { ...message, type: "stream" }, request.signal, events)
    }
    const send = async () => responseFromReply(await requestNative(native, message, request.signal), request.method, request.signal)
    const response = await send()
    if (response.status !== 403 || !canRequestSession(path, request.method)) return response
    const problem = await response.clone().json().catch(() => null) as { code?: string } | null
    if (problem?.code !== "SESSION_REQUIRED") return response
    await import("@/features/auth/api").then((auth) => auth.stepUp())
    checkAbort(request.signal)
    // The request body and idempotency key are unchanged after password confirmation.
    return send()
  }
}

async function applyNativeState(response: Response) {
  if (!response.ok) throw new Error("无法读取 iOS 连接状态。")
  const state = await response.json() as IOSNativeState
  if (!state || typeof state.serverURL !== "string" || !(state.email === null || typeof state.email === "string") ||
      typeof state.authenticated !== "boolean" || typeof state.legacyAvailable !== "boolean" ||
      !state.sync || !["online", "offline", "syncing"].includes(state.sync.state) ||
      !Number.isInteger(state.sync.pending) || state.sync.pending < 0) throw new Error("iOS 连接状态无效。")
  nativeState = state
  for (const listener of stateListeners) listener()
}

export async function refreshIOSNativeState() {
  if (!isIOSNative()) return
  await applyNativeState(await responseFromReply(await handler().postMessage({ type: "bootstrap" })))
}

/** Manual retry uses the native queue, never the desktop's Tauri commands. */
export async function requestIOSSync() {
  await applyNativeState(await responseFromReply(await handler().postMessage({ type: "sync" })))
}

function syncAppearance() {
  const mode = appearanceMode
  const key = `${mode}:${document.documentElement.classList?.contains("dark") ?? false}`
  if (key === lastAppearance) return
  lastAppearance = key
  appearanceQueue = appearanceQueue.catch(() => undefined).then(async () => {
    const bodyBase64 = await encodeIOSBytes(new TextEncoder().encode(JSON.stringify({ mode })))
    const response = await responseFromReply(await handler().postMessage({ type: "appearance", bodyBase64 }))
    if (!response.ok) throw new Error("无法同步 iOS 外观。")
  }).catch(() => undefined)
}

function installAppearanceSync() {
  appearanceMode = getStoredColorMode()
  window.addEventListener(COLOR_MODE_CHANGED_EVENT, (event) => {
    const mode = (event as CustomEvent).detail?.mode
    if (mode !== "system" && mode !== "light" && mode !== "dark") return
    appearanceMode = mode
    syncAppearance()
  })
  if (typeof MutationObserver !== "undefined") {
    const observer = new MutationObserver(() => syncAppearance())
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] })
  }
  // Preserve "system" as a choice; the current .dark class is only a change signal.
  syncAppearance()
}

function handleStateChanged() {
  if (stateRefresh) {
    refreshAgain = true
    return
  }
  const before = nativeState?.authenticated
  stateRefresh = refreshIOSNativeState().then(() => {
    if (before !== nativeState?.authenticated) {
      window.dispatchEvent(new CustomEvent(nativeState?.authenticated ? "shard:authenticated" : "shard:auth-required"))
    }
  }).catch(() => undefined).finally(() => {
    stateRefresh = null
    if (refreshAgain) {
      refreshAgain = false
      handleStateChanged()
    }
  })
}

export async function initIOSNative() {
  if (!isIOSNative() || installed) return
  installed = true
  document.documentElement.dataset.platform = "ios"
  window.fetch = createIOSFetch(handler(), window.location.href, window.fetch.bind(window))
  window.addEventListener(IOS_NATIVE_EVENT, (event) => {
    if ((event as CustomEvent).detail?.type === "state-changed") handleStateChanged()
  })
  await refreshIOSNativeState()
  installAppearanceSync()
}

export async function shareIOSBlob(blob: Blob, fileName: string) {
  const bodyBase64 = await encodeIOSBytes(new Uint8Array(await blob.arrayBuffer()))
  const response = await responseFromReply(await handler().postMessage({
    type: "share", fileName, bodyBase64, headers: { "content-type": blob.type || "application/octet-stream" },
  }))
  if (!response.ok) throw new Error("无法分享文件。")
}

/**
 * Speech commands run in the iOS host: microphone, Keychain and the speech service request never
 * enter the page. `command` mirrors the desktop Tauri command name; the reply keeps its HTTP shape.
 */
export async function invokeIOSVoice(command: string, args: Record<string, unknown> = {}) {
  const bodyBase64 = await encodeIOSBytes(new TextEncoder().encode(JSON.stringify(args)))
  return responseFromReply(await handler().postMessage({ type: "voice", path: command, bodyBase64 }))
}

export async function openIOSLegacy() {
  const response = await responseFromReply(await handler().postMessage({ type: "legacy" }))
  if (!response.ok) throw new Error("无法打开 GitHub 资料库。")
}
