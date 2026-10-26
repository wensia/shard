import { AUTH_REQUIRED_EVENT, type ServerFailure, type ShardTransport } from "./index"
import { subscribeLockboxEvents, subscribeVaultEvents } from "./sse"

const RPC_PREFIX = "/api/rpc/"
/** 网络失败或网关错误时的重试次数；重试用同一个幂等键，服务端保证只提交一次。 */
const MAX_RETRIES = 3
const RETRYABLE_STATUS = new Set([502, 503, 504])

export const NETWORK_ERROR_MESSAGE = "连不上服务器，请检查网络后重试。"

function idempotencyKey() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID()
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

/** 碎片 id 与 `fragments/YYYY/MM` 按客户端时区算（服务器一般跑 UTC）。 */
function utcOffsetMinutes() {
  return String(-new Date().getTimezoneOffset())
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

interface ErrorBody {
  code?: string
  message?: string
  /** 结构化错误（搜索命令）原样带回。 */
  error?: unknown
}

/** 失败的响应：`detail` 是界面该显示的内容（结构化错误或消息），另带状态码与错误码（密匣客户端要看）。 */
async function readFailure(response: Response): Promise<ServerFailure> {
  const body = (await response.json().catch(() => null)) as ErrorBody | null
  if (response.status === 401) {
    window.dispatchEvent(new CustomEvent(AUTH_REQUIRED_EVENT))
  }
  const detail = body?.error !== undefined ? body.error : (body?.message ?? `请求失败（${response.status}）`)
  return { status: response.status, code: body?.code, detail }
}

async function readError(response: Response): Promise<unknown> {
  return (await readFailure(response)).detail
}

/** 发一个请求；网络失败与 502/503/504 用同一个幂等键重试。 */
export async function request(url: string, init: RequestInit, fetcher: typeof fetch = fetch): Promise<Response> {
  for (let attempt = 0; ; attempt += 1) {
    let response: Response
    try {
      response = await fetcher(url, { credentials: "same-origin", ...init })
    } catch {
      if (attempt >= MAX_RETRIES) throw NETWORK_ERROR_MESSAGE
      await delay(300 * 2 ** attempt)
      continue
    }
    if (RETRYABLE_STATUS.has(response.status) && attempt < MAX_RETRIES) {
      await delay(300 * 2 ** attempt)
      continue
    }
    return response
  }
}

async function rpc<T>(command: string, body: BodyInit, contentType: string): Promise<T> {
  try {
    return await rpcWithFailure<T>(command, body, contentType)
  } catch (failure) {
    // 服务器的错误换成界面显示的内容；网络错误（已是提示字符串）原样抛出。
    throw typeof failure === "object" && failure !== null && "detail" in failure ? (failure as ServerFailure).detail : failure
  }
}

/** 同 {@link rpc}，失败时 reject 成带状态码与错误码的 {@link ServerFailure}。 */
async function rpcWithFailure<T>(command: string, body: BodyInit, contentType: string): Promise<T> {
  const response = await request(RPC_PREFIX + encodeURIComponent(command), {
    method: "POST",
    headers: {
      "content-type": contentType,
      "idempotency-key": idempotencyKey(),
      "x-shard-request": "1",
      "x-shard-utc-offset": utcOffsetMinutes(),
    },
    body,
  })
  if (!response.ok) throw await readFailure(response)
  return (await response.json()) as T
}

function decodeBase64(data: string) {
  const binary = atob(data)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

/**
 * 读一个资料库文件的原文与 sha（`/api/sync/fetch`）。移入密匣要整篇原文才能保住 frontmatter，
 * 并以它的 sha 作基线；保留 BOM，字节与服务器上的逐字一致。
 */
async function fetchVaultText(path: string): Promise<{ text: string; sha: string }> {
  const response = await request("/api/sync/fetch", {
    method: "POST",
    headers: { "content-type": "application/json", "x-shard-request": "1" },
    body: JSON.stringify({ paths: [path] }),
  })
  if (!response.ok) throw await readFailure(response)
  const { items } = (await response.json()) as {
    items?: Array<{ sha?: string; data?: string | null; blob?: boolean; missing?: boolean }>
  }
  const item = items?.[0]
  if (!item?.sha || item.missing) throw { status: 404, code: "NOT_FOUND", detail: `找不到 ${path}` } satisfies ServerFailure
  let bytes: Uint8Array
  if (item.blob) {
    const blob = await request(`/api/blobs/${item.sha}`, { method: "GET" })
    if (!blob.ok) throw await readFailure(blob)
    bytes = new Uint8Array(await blob.arrayBuffer())
  } else {
    bytes = decodeBase64(item.data ?? "")
  }
  return { text: new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes), sha: item.sha }
}

async function sha256Hex(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

/** 先按内容哈希上传字节（已有就跳过），返回 sha，再由调用方调命令登记。 */
export async function uploadBlob(bytes: Uint8Array) {
  const sha = await sha256Hex(bytes)
  const url = `/api/blobs/${sha}`
  const head = await request(url, { method: "HEAD" })
  if (head.status === 401) throw await readError(head)
  if (!head.ok) {
    const put = await request(url, {
      method: "PUT",
      headers: { "content-type": "application/octet-stream", "x-shard-request": "1" },
      body: bytes as BodyInit,
    })
    if (!put.ok) throw await readError(put)
  }
  return sha
}

export function filesUrl(reference: string) {
  const path = reference.trim().replace(/^\.\//u, "")
  return `/api/files/${path.split("/").map(encodeURIComponent).join("/")}`
}

export const httpTransport: ShardTransport = {
  kind: "http",
  invoke: (command, args) => rpc(command, JSON.stringify(args ?? {}), "application/json"),
  async invokeBytes(command, body, headers) {
    if (command === "save_fragment_image") {
      const blobSha = await uploadBlob(body)
      const fileName = decodeURIComponent(headers["x-shard-file-name"] ?? "")
      return rpc(command, JSON.stringify({ fileName, blobSha }), "application/json")
    }
    throw `网页版不支持这个操作（${command}）。`
  },
  listen(event, handler) {
    if (event === "lockbox-changed") return Promise.resolve(subscribeLockboxEvents(() => handler(undefined as never)))
    if (event !== "vault-changed") return Promise.resolve(() => {})
    return Promise.resolve(subscribeVaultEvents(handler as (payload: unknown) => void))
  },
  fileUrl: filesUrl,
  server: {
    call: (command, args) => rpcWithFailure(command, JSON.stringify(args), "application/json"),
    fetchText: fetchVaultText,
  },
}
