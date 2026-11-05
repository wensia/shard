import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { stepUp } from "@/features/auth/api"
import { request } from "@/lib/transport/http"
import {
  createIOSFetch, decodeIOSBytes, encodeIOSBytes, IOS_NATIVE_EVENT,
  type IOSBridgeMessage, type IOSBridgeReply, type IOSMessageHandler,
} from "./ios-native"

vi.mock("@/features/auth/api", () => ({ stepUp: vi.fn() }))

function reply(status = 200, value: unknown = { ok: true }): IOSBridgeReply {
  return {
    status,
    headers: { "content-type": "application/json" },
    bodyBase64: btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value)))),
  }
}

function fixture(respond: (message: IOSBridgeMessage) => Promise<IOSBridgeReply> = async () => reply()) {
  const messages: IOSBridgeMessage[] = []
  const native: IOSMessageHandler = { postMessage: vi.fn(async (message) => {
    messages.push(message)
    return respond(message)
  }) }
  const events = new EventTarget()
  const original = vi.fn<typeof fetch>(async () => new Response("browser"))
  const fetcher = createIOSFetch(native, "shard://app/index.html", original, events)
  return { native, messages, events, original, fetcher }
}

beforeEach(() => { vi.mocked(stepUp).mockReset() })
afterEach(() => { vi.unstubAllGlobals() })

describe("iOS native request boundary", () => {
  it("preserves external/resource requests, including opaque origins with a different host", async () => {
    const { fetcher, native, original } = fixture()
    for (const path of ["https://example.test/api/rpc/list_fragments", "shard://other/api/auth/state", "/assets/app.js", "blob:example"]) {
      expect(await (await fetcher(path)).text()).toBe("browser")
    }
    expect(original).toHaveBeenCalledTimes(4)
    expect(native.postMessage).not.toHaveBeenCalled()
  })

  it("round-trips UTF-8 bodies and keeps native credentials out of JS response headers", async () => {
    const { fetcher, messages } = fixture(async () => ({
      ...reply(201, { text: "多行\n正文" }),
      headers: { "content-type": "application/json", "set-cookie": "secret", authorization: "secret" },
    }))
    const result = await fetcher("/api/rpc/create_fragment", {
      method: "POST", headers: { "content-type": "application/json", "idempotency-key": "stable" },
      body: JSON.stringify({ content: "第一行\n第二行" }),
    })
    expect(messages[0]).toMatchObject({ type: "request", path: "/api/rpc/create_fragment", method: "POST" })
    expect(JSON.parse(new TextDecoder().decode(await decodeIOSBytes(messages[0].bodyBase64!)))).toEqual({ content: "第一行\n第二行" })
    expect(result.status).toBe(201)
    expect(await result.json()).toEqual({ text: "多行\n正文" })
    expect(result.headers.has("set-cookie")).toBe(false)
    expect(result.headers.has("authorization")).toBe(false)
  })

  it.each(["Authorization", "Cookie", "Origin", "Host", "Referer"])("rejects caller-supplied %s", async (name) => {
    const { fetcher, native } = fixture()
    await expect(fetcher("/api/auth/state", { headers: { [name]: "not-allowed" } })).rejects.toThrow("身份认证请求头")
    expect(native.postMessage).not.toHaveBeenCalled()
  })

  it("keeps HEAD and 204 responses bodyless", async () => {
    const { fetcher } = fixture(async (message) => message.method === "HEAD" ? reply(200, "unused") : reply(204))
    expect((await fetcher("/api/blobs/hash", { method: "HEAD" })).body).toBeNull()
    expect((await fetcher("/api/auth/logout", { method: "POST" })).body).toBeNull()
  })

  it("rejects invalid native replies and malformed base64", async () => {
    const { fetcher } = fixture(async () => ({ ...reply(), bodyBase64: "???=" }))
    await expect(fetcher("/api/auth/state")).rejects.toThrow("响应无效")
    const invalid = fixture(async () => ({ ...reply(), status: 0 }))
    await expect(invalid.fetcher("/api/auth/state")).rejects.toThrow("响应无效")
  })

  it("does not begin a cancelled request and cancels an in-flight native request once", async () => {
    const before = new AbortController()
    before.abort()
    const unused = fixture()
    await expect(unused.fetcher("/api/auth/state", { signal: before.signal })).rejects.toMatchObject({ name: "AbortError" })
    expect(unused.messages).toHaveLength(0)

    const during = new AbortController()
    const current = fixture(async (message) => message.type === "cancel" ? reply() : new Promise(() => {}))
    const pending = current.fetcher("/api/auth/state", { signal: during.signal })
    const rejection = expect(pending).rejects.toMatchObject({ name: "AbortError" })
    during.abort()
    await rejection
    expect(current.messages.filter((message) => message.type === "cancel")).toHaveLength(1)
    expect(current.messages[1].id).toBe(current.messages[0].id)
  })

  it("encodes and decodes large binary payloads across chunk boundaries", async () => {
    const source = Uint8Array.from({ length: 800_009 }, (_, index) => index % 251)
    expect(await decodeIOSBytes(await encodeIOSBytes(source))).toEqual(source)
    await expect(decodeIOSBytes("YWJj\n===")).rejects.toThrow("响应无效")
  })
})

describe("iOS session step-up", () => {
  it.each(["/api/auth/sessions", "/api/devices", "/api/devices?after=1"])("does not prompt for the background account list %s", async (path) => {
    const { fetcher, messages } = fixture(async () => reply(403, { code: "SESSION_REQUIRED" }))
    expect((await fetcher(path)).status).toBe(403)
    expect(stepUp).not.toHaveBeenCalled()
    expect(messages).toHaveLength(1)
  })

  it("still prompts for an explicitly requested lockbox snapshot", async () => {
    let attempts = 0
    vi.mocked(stepUp).mockResolvedValue(undefined)
    const { fetcher } = fixture(async () => ++attempts === 1 ? reply(403, { code: "SESSION_REQUIRED" }) : reply())
    expect((await fetcher("/api/rpc/lockbox_snapshot", { method: "POST", body: "{}" })).status).toBe(200)
    expect(stepUp).toHaveBeenCalledOnce()
  })

  it("confirms once, then retries the original body and idempotency key unchanged", async () => {
    let attempts = 0
    vi.mocked(stepUp).mockResolvedValue(undefined)
    const { fetcher, messages } = fixture(async () => ++attempts === 1 ? reply(403, { code: "SESSION_REQUIRED" }) : reply())
    expect((await fetcher("/api/rpc/set_lockbox_manifest", {
      method: "POST", headers: { "idempotency-key": "same-operation" }, body: "exact bytes",
    })).status).toBe(200)
    expect(stepUp).toHaveBeenCalledOnce()
    expect(messages).toHaveLength(2)
    expect(messages[0].bodyBase64).toBe(messages[1].bodyBase64)
    expect(messages[0].headers?.["idempotency-key"]).toBe(messages[1].headers?.["idempotency-key"])
  })

  it("never recursively confirms the step-up request", async () => {
    const { fetcher } = fixture(async () => reply(403, { code: "SESSION_REQUIRED" }))
    expect((await fetcher("/api/auth/stepup", { method: "POST", body: "{}" })).status).toBe(403)
    expect(stepUp).not.toHaveBeenCalled()
  })

  it("a cancelled password prompt does not enter the HTTP network-retry loop", async () => {
    const cancellation = Object.assign(new Error("已取消"), { code: "CANCELLED" })
    vi.mocked(stepUp).mockRejectedValue(cancellation)
    const { fetcher, messages } = fixture(async () => reply(403, { code: "SESSION_REQUIRED" }))
    await expect(request("/api/rpc/set_lockbox_manifest", { method: "POST", body: "{}" }, fetcher)).rejects.toBe(cancellation)
    expect(messages).toHaveLength(1)
    expect(stepUp).toHaveBeenCalledOnce()
  })
})

describe("iOS SSE stream", () => {
  it("streams complete Unicode chunks and closes without retaining its listener", async () => {
    const { fetcher, messages, events } = fixture()
    const removed = vi.spyOn(events, "removeEventListener")
    const response = await fetcher("/api/events", { headers: { "last-event-id": "23" } })
    expect(messages[0]).toMatchObject({ type: "stream", path: "/api/events", headers: { "last-event-id": "23" } })
    const reader = response.body!.getReader()
    const text = "event: vault-changed\ndata: {\"文字\":\"你好🚲\"}\n\n"
    events.dispatchEvent(new CustomEvent(IOS_NATIVE_EVENT, { detail: { type: "stream", id: messages[0].id, chunk: text } }))
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(text)
    events.dispatchEvent(new CustomEvent(IOS_NATIVE_EVENT, { detail: { type: "stream", id: messages[0].id, done: true } }))
    expect((await reader.read()).done).toBe(true)
    expect(removed).toHaveBeenCalledWith(IOS_NATIVE_EVENT, expect.any(Function))
  })

  it("aborting after response headers errors the reader and stops native work once", async () => {
    const signal = new AbortController()
    const { fetcher, messages, events } = fixture()
    const removed = vi.spyOn(events, "removeEventListener")
    const reader = (await fetcher("/api/events", { signal: signal.signal })).body!.getReader()
    const read = expect(reader.read()).rejects.toMatchObject({ name: "AbortError" })
    signal.abort()
    await read
    expect(messages.filter((message) => message.type === "cancel")).toHaveLength(1)
    expect(removed).toHaveBeenCalledWith(IOS_NATIVE_EVENT, expect.any(Function))
  })

  it("a failed handshake returns its HTTP status and clears the stream listener", async () => {
    const { fetcher, messages, events } = fixture(async () => reply(401, { code: "UNAUTHENTICATED" }))
    const removed = vi.spyOn(events, "removeEventListener")
    const response = await fetcher("/api/events")
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ code: "UNAUTHENTICATED" })
    expect(messages.filter((message) => message.type === "cancel")).toHaveLength(1)
    expect(removed).toHaveBeenCalledWith(IOS_NATIVE_EVENT, expect.any(Function))
  })
})

describe("iOS bootstrap and local capabilities", () => {
  it("installs before API requests, refreshes native auth state, and shares through the host", async () => {
    vi.resetModules()
    const module = await import("./ios-native")
    let authenticated = true
    let pending = 1
    const messages: IOSBridgeMessage[] = []
    const native = {
      postMessage: vi.fn(async (message: IOSBridgeMessage) => {
        messages.push(message)
        if (message.type === "sync") pending = 0
        return message.type === "bootstrap" || message.type === "sync" ? reply(200, {
          serverURL: "https://shard.example.test", email: "me@example.test", authenticated,
          sync: { state: pending ? "offline" : "online", pending }, legacyAvailable: true,
        }) : reply()
      }),
    }
    const nativeWindow = Object.assign(new EventTarget(), {
      webkit: { messageHandlers: { shardApp: native } },
      location: { href: "shard://app/index.html" }, fetch: vi.fn<typeof fetch>(),
    })
    const classes = new Set<string>()
    const element = { dataset: {} as Record<string, string>, classList: { contains: (name: string) => classes.has(name) } }
    let mutated = () => {}
    vi.stubGlobal("MutationObserver", class {
      constructor(callback: () => void) { mutated = callback }
      observe() {}
    })
    vi.stubGlobal("window", nativeWindow)
    vi.stubGlobal("document", { documentElement: element })
    await module.initIOSNative()
    await vi.waitFor(() => expect(messages.some((message) => message.type === "appearance")).toBe(true))
    expect(element.dataset.platform).toBe("ios")
    expect(module.iosNativeState()?.sync.pending).toBe(1)
    await nativeWindow.fetch("/api/auth/state")
    expect(messages.find((message) => message.type === "request")?.path).toBe("/api/auth/state")
    await module.requestIOSSync()
    expect(messages.some((message) => message.type === "sync")).toBe(true)
    expect(module.iosNativeState()?.sync.pending).toBe(0)
    const appearanceModes = () => messages.filter((message) => message.type === "appearance").map((message) =>
      JSON.parse(atob(message.bodyBase64!)).mode as string)
    expect(appearanceModes()).toEqual(["system"])
    classes.add("dark")
    nativeWindow.dispatchEvent(new CustomEvent("shard:color-mode-changed", { detail: { mode: "dark" } }))
    mutated()
    await vi.waitFor(() => expect(appearanceModes()).toEqual(["system", "dark"]))
    nativeWindow.dispatchEvent(new CustomEvent("shard:color-mode-changed", { detail: { mode: "system" } }))
    await vi.waitFor(() => expect(appearanceModes()).toEqual(["system", "dark", "system"]))
    classes.delete("dark")
    mutated()
    await vi.waitFor(() => expect(appearanceModes()).toEqual(["system", "dark", "system", "system"]))
    const changed = vi.fn()
    const stop = module.subscribeIOSNativeState(changed)
    const signedOut = vi.fn()
    nativeWindow.addEventListener("shard:auth-required", signedOut)
    authenticated = false
    nativeWindow.dispatchEvent(new CustomEvent(IOS_NATIVE_EVENT, { detail: { type: "state-changed" } }))
    await vi.waitFor(() => expect(signedOut).toHaveBeenCalledOnce())
    expect(changed).toHaveBeenCalledOnce()
    stop()
    await module.shareIOSBlob(new Blob(["恢复密钥"], { type: "text/plain" }), "recovery.txt")
    const share = messages.find((message) => message.type === "share")!
    expect(share.fileName).toBe("recovery.txt")
    expect(new TextDecoder().decode(await module.decodeIOSBytes(share.bodyBase64!))).toBe("恢复密钥")
    expect(share.headers).toEqual({ "content-type": "text/plain" })
  })
})
