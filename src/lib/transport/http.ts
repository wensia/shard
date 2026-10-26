import { AUTH_REQUIRED_EVENT, type ShardTransport } from "./index"
import { subscribeVaultEvents } from "./sse"

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

async function readError(response: Response): Promise<unknown> {
  const body = (await response.json().catch(() => null)) as ErrorBody | null
  if (response.status === 401) {
    window.dispatchEvent(new CustomEvent(AUTH_REQUIRED_EVENT))
  }
  if (body?.error !== undefined) return body.error
  return body?.message ?? `请求失败（${response.status}）`
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
  if (!response.ok) throw await readError(response)
  return (await response.json()) as T
}

async function sha256Hex(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

/** 先按内容哈希上传字节（已有就跳过），再调命令登记。 */
async function uploadBlob(bytes: Uint8Array) {
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
    if (event !== "vault-changed") return Promise.resolve(() => {})
    return Promise.resolve(subscribeVaultEvents(handler as (payload: unknown) => void))
  },
  fileUrl: filesUrl,
}
