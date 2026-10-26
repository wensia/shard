import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { AUTH_REQUIRED_EVENT } from "@/lib/transport"
import { filesUrl, httpTransport, NETWORK_ERROR_MESSAGE } from "@/lib/transport/http"
import { dispatchSseMessage, SseParser, subscribeLockboxEvents } from "@/lib/transport/sse"

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

type Call = { url: string; init: RequestInit }

function stubFetch(...responses: Array<Response | Error>) {
  const calls: Call[] = []
  const queue = [...responses]
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      const next = queue.shift()
      if (!next) throw new Error("没有更多桩响应")
      if (next instanceof Error) throw next
      return next
    })
  )
  return calls
}

function header(call: Call, name: string) {
  return (call.init.headers as Record<string, string>)[name]
}

beforeEach(() => {
  vi.stubGlobal("window", new EventTarget())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("网页传输层：RPC", () => {
  it("命令名与参数原样发到 /api/rpc，带上 CSRF 头、幂等键与时区", async () => {
    const calls = stubFetch(json(200, { ok: 1 }))
    await expect(httpTransport.invoke("update_fragment", { id: "a", content: "正文" })).resolves.toEqual({ ok: 1 })
    expect(calls[0].url).toBe("/api/rpc/update_fragment")
    expect(calls[0].init.method).toBe("POST")
    expect(calls[0].init.credentials).toBe("same-origin")
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ id: "a", content: "正文" })
    expect(header(calls[0], "x-shard-request")).toBe("1")
    expect(header(calls[0], "idempotency-key")).toBeTruthy()
    expect(header(calls[0], "x-shard-utc-offset")).toBe(String(-new Date().getTimezoneOffset()))
  })

  it("网络失败与 503 重试时沿用同一个幂等键，服务端只会提交一次", async () => {
    const calls = stubFetch(new TypeError("Failed to fetch"), json(503, {}), json(200, "done"))
    await expect(httpTransport.invoke("create_fragment", {})).resolves.toBe("done")
    expect(calls).toHaveLength(3)
    const keys = new Set(calls.map((call) => header(call, "idempotency-key")))
    expect(keys.size).toBe(1)
  })

  it("一直连不上时给出可读的提示", async () => {
    stubFetch(...Array.from({ length: 4 }, () => new TypeError("Failed to fetch")))
    await expect(httpTransport.invoke("list_fragments")).rejects.toBe(NETWORK_ERROR_MESSAGE)
  }, 10_000)

  it("领域错误与 Tauri 一样 reject 成字符串，STALE_BASE 前缀保留", async () => {
    stubFetch(json(409, { code: "STALE_BASE", message: "STALE_BASE:文件已被修改" }))
    await expect(httpTransport.invoke("update_fragment", {})).rejects.toBe("STALE_BASE:文件已被修改")
  })

  it("结构化错误（搜索）原样带回对象", async () => {
    stubFetch(json(400, { code: "SEARCH", message: "x", error: { code: "INDEX_UNAVAILABLE" } }))
    await expect(httpTransport.invoke("search_vault", {})).rejects.toEqual({ code: "INDEX_UNAVAILABLE" })
  })

  it("401 时广播需要登录", async () => {
    stubFetch(json(401, { code: "UNAUTHENTICATED", message: "需要登录。" }))
    const seen = vi.fn()
    window.addEventListener(AUTH_REQUIRED_EVENT, seen)
    await expect(httpTransport.invoke("list_fragments")).rejects.toBe("需要登录。")
    expect(seen).toHaveBeenCalledTimes(1)
  })
})

describe("网页传输层：图片上传", () => {
  it("先按 sha256 探测，没有就 PUT 字节，再调命令登记", async () => {
    const bytes = new TextEncoder().encode("图")
    const digest = await crypto.subtle.digest("SHA-256", bytes)
    const sha = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
    const calls = stubFetch(new Response(null, { status: 404 }), new Response(null, { status: 201 }), json(200, "assets/ab/x.png"))
    await expect(
      httpTransport.invokeBytes("save_fragment_image", bytes, { "x-shard-file-name": encodeURIComponent("截屏 1.png") })
    ).resolves.toBe("assets/ab/x.png")
    expect(calls.map((call) => [call.init.method, call.url])).toEqual([
      ["HEAD", `/api/blobs/${sha}`],
      ["PUT", `/api/blobs/${sha}`],
      ["POST", "/api/rpc/save_fragment_image"],
    ])
    expect(JSON.parse(String(calls[2].init.body))).toEqual({ fileName: "截屏 1.png", blobSha: sha })
  })

  it("服务器已有同样的字节就不再上传", async () => {
    const calls = stubFetch(new Response(null, { status: 200 }), json(200, "assets/ab/x.png"))
    await httpTransport.invokeBytes("save_fragment_image", new Uint8Array([1]), { "x-shard-file-name": "a.png" })
    expect(calls.map((call) => call.init.method)).toEqual(["HEAD", "POST"])
  })

  it("资料库路径编码成 /api/files 地址", () => {
    expect(filesUrl("notes/证件/营业执照 1.jpg")).toBe(
      `/api/files/notes/${encodeURIComponent("证件")}/${encodeURIComponent("营业执照 1.jpg")}`
    )
    expect(filesUrl("./assets/ab/x.png")).toBe("/api/files/assets/ab/x.png")
  })
})

describe("SSE 解析", () => {
  it("任意切分的块都能拼出完整消息，忽略注释行", () => {
    const parser = new SseParser()
    const text = ": keep-alive\n\nevent: vault-changed\nid: 7\ndata: {\"a\":\ndata: 1}\n\nevent: resync\r\nid: 9\r\ndata: {}\r\n\r\n"
    const messages = []
    for (let index = 0; index < text.length; index += 3) messages.push(...parser.push(text.slice(index, index + 3)))
    expect(messages).toEqual([
      { event: "vault-changed", id: "7", data: '{"a":\n1}' },
      { event: "resync", id: "9", data: "{}" },
    ])
  })
})

describe("密匣变化推送", () => {
  it("lockbox-changed 带的 {seq} 原样交给订阅者，游标过旧时没有载荷", () => {
    const seen: unknown[] = []
    const stop = subscribeLockboxEvents((payload) => seen.push(payload))
    dispatchSseMessage({ event: "lockbox-changed", data: '{"seq":42}' })
    dispatchSseMessage({ event: "lockbox-changed", data: "{}" })
    dispatchSseMessage({ event: "lockbox-changed", data: "不是 JSON" })
    dispatchSseMessage({ event: "resync", id: "7", data: "{}" })
    stop()
    dispatchSseMessage({ event: "lockbox-changed", data: '{"seq":43}' })
    expect(seen).toEqual([{ seq: 42 }, {}, undefined, undefined])
  })
})

