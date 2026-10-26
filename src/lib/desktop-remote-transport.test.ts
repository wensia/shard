import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * 桌面「连接服务器」的传输（S8a）：命令按显式清单分流——服务器命令经 Rust `remote_invoke` 转发、本机能力照常
 * 走本机 IPC、本地资料库 / Git 管理给替代结果或报错、读本机文件再写入的换成 Rust 的远程版本，未列出的默认转发。
 * Tauri 的 IPC 与事件用替身，只验证路由与参数。
 */

type EventHandler = (event: { event: string; payload: unknown }) => void

const tauri = vi.hoisted(() => {
  const listeners = new Map<string, Set<EventHandler>>()
  return {
    invoke: vi.fn(),
    isTauri: vi.fn(() => true),
    convertFileSrc: vi.fn((path: string, scheme: string) => `${scheme}://localhost/${encodeURIComponent(path)}`),
    listeners,
    listen: vi.fn(async (event: string, handler: EventHandler) => {
      const set = listeners.get(event) ?? new Set<EventHandler>()
      set.add(handler)
      listeners.set(event, set)
      return () => set.delete(handler)
    }),
    emit(event: string, payload: unknown = {}) {
      for (const handler of listeners.get(event) ?? []) handler({ event, payload })
    },
  }
})

vi.mock("@tauri-apps/api/core", () => ({
  invoke: tauri.invoke,
  isTauri: tauri.isTauri,
  convertFileSrc: tauri.convertFileSrc,
}))
vi.mock("@tauri-apps/api/event", () => ({ listen: tauri.listen }))

import {
  createDesktopRemoteTransport,
  isRemoteAuthRequired,
  LOCAL_COMMANDS,
  remoteConnectionState,
  REMOTE_WRITE_COMMANDS,
  remoteSyncStatus,
  resetRemoteConnectionForTests,
  type RemoteSyncNotice,
  subscribeRemoteSync,
  subscribeRemoteSyncNotices,
  REVISION_BYTES_COMMAND,
  routeCommand,
  startRemoteConnectionTracking,
  SUBSTITUTED_COMMANDS,
  subscribeRemoteAuthRequired,
  UNAVAILABLE_COMMANDS,
} from "@/lib/transport/desktop-remote"

type Reply = (args: Record<string, unknown> | Uint8Array | undefined, options?: unknown) => unknown

/** 按 Tauri 命令名回放；`remote_invoke` 再按里面的服务器命令名分。 */
function replay(local: Record<string, Reply>, server: Record<string, Reply> = {}) {
  tauri.invoke.mockImplementation(async (command: string, args?: Record<string, unknown> | Uint8Array, options?: unknown) => {
    if (command === "remote_invoke") {
      const inner = args as { command: string; args: Record<string, unknown> }
      const handler = server[inner.command]
      if (!handler) throw `服务器替身没有 ${inner.command}`
      return handler(inner.args)
    }
    const handler = local[command]
    if (!handler) throw new Error(`本机替身没有 ${command}`)
    return handler(args, options)
  })
}

function invokedCommands() {
  return tauri.invoke.mock.calls.map(([command]) => command as string)
}

function base64(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
}

beforeEach(() => {
  tauri.invoke.mockReset()
  tauri.listen.mockClear()
  tauri.listeners.clear()
  resetRemoteConnectionForTests()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("命令清单", () => {
  it("每一类都有代表，未知命令默认转发服务器", () => {
    expect(routeCommand("list_fragments")).toEqual({ kind: "server" })
    expect(routeCommand("restore_revision")).toEqual({ kind: "server" })
    expect(routeCommand("将来新增的命令")).toEqual({ kind: "server" })
    expect(routeCommand("write_export_file")).toEqual({ kind: "local" })
    expect(routeCommand("install_cli")).toEqual({ kind: "local" })
    expect(routeCommand("read_import_xlsx_file")).toEqual({ kind: "local" })
    expect(routeCommand("save_image_attachment_from_path")).toEqual({
      kind: "remote-write",
      command: "remote_save_image_from_path",
    })
    expect(routeCommand("import_library_files")).toEqual({ kind: "remote-write", command: "remote_import_library_files" })
    expect(routeCommand("watch_vault")).toEqual({ kind: "substitute" })
    expect(routeCommand("checkpoint_vault")).toEqual({ kind: "substitute" })
    expect(routeCommand("sync_vault").kind).toBe("unavailable")
    expect(routeCommand("open_vault_image").kind).toBe("unavailable")
  })

  it("各张表互不重叠：一个命令只有一条路", () => {
    const names = [
      ...LOCAL_COMMANDS,
      ...Object.keys(REMOTE_WRITE_COMMANDS),
      ...Object.keys(SUBSTITUTED_COMMANDS),
      ...Object.keys(UNAVAILABLE_COMMANDS),
    ]
    expect(new Set(names).size).toBe(names.length)
  })
})

describe("invoke 分流", () => {
  it("服务器命令经 remote_invoke 转发，参数原样", async () => {
    replay({}, { update_fragment: (args) => ({ id: (args as { id: string }).id, saved: true }) })
    const channel = createDesktopRemoteTransport()
    await expect(channel.invoke("update_fragment", { id: "a", content: "正文" })).resolves.toEqual({ id: "a", saved: true })
    expect(tauri.invoke).toHaveBeenCalledWith("remote_invoke", { command: "update_fragment", args: { id: "a", content: "正文" } })
  })

  it("服务器的错误原样交给调用方（与网页 readError 同形）", async () => {
    replay({}, { update_fragment: () => Promise.reject("STALE_BASE: 已在别处修改") })
    await expect(createDesktopRemoteTransport().invoke("update_fragment", {})).rejects.toBe("STALE_BASE: 已在别处修改")
  })

  it("本机能力照常走本机 IPC", async () => {
    replay({ set_window_controls_hidden: () => null })
    await createDesktopRemoteTransport().invoke("set_window_controls_hidden", { hidden: true })
    expect(tauri.invoke).toHaveBeenCalledWith("set_window_controls_hidden", { hidden: true })
    expect(invokedCommands()).not.toContain("remote_invoke")
  })

  it("读本机文件再写入资料库的命令换成 Rust 的远程版本", async () => {
    replay({
      remote_save_image_from_path: () => "assets/ab/abc.png",
      remote_import_library_files: () => ({ tree: { entries: [] }, imported: ["notes/a.png"], skipped: [] }),
    })
    const channel = createDesktopRemoteTransport()
    await expect(channel.invoke("save_image_attachment_from_path", { path: "/Users/me/a.png" })).resolves.toBe("assets/ab/abc.png")
    await channel.invoke("import_library_files", { paths: ["/Users/me/a.png"], directory: "notes" })
    expect(tauri.invoke.mock.calls).toEqual([
      ["remote_save_image_from_path", { path: "/Users/me/a.png" }],
      ["remote_import_library_files", { paths: ["/Users/me/a.png"], directory: "notes" }],
    ])
  })

  it("本地资料库管理不调后端，给网页端一致的结果", async () => {
    replay({}, { list_library_tree: () => ({ entries: ["服务器的树"] }) })
    const channel = createDesktopRemoteTransport()
    await expect(channel.invoke("watch_vault")).resolves.toBeNull()
    await expect(channel.invoke("checkpoint_vault", { trigger: "退出前" })).resolves.toMatchObject({
      status: "no_changes",
      changes: 0,
      git: { status: "no_git", hasRemote: false },
    })
    await expect(channel.invoke("apply_markdown_dialect_migration", { files: [] })).resolves.toBe(0)
    await expect(channel.invoke("preflight_outline_upgrade")).resolves.toEqual([])
    await expect(channel.invoke("migrate_legacy_notes")).resolves.toEqual({ migratedCount: 0, tree: { entries: ["服务器的树"] } })
    // 只有无需迁移时读目录树问了服务器。
    expect(tauri.invoke.mock.calls).toEqual([["remote_invoke", { command: "list_library_tree", args: {} }]])
  })

  it("没有意义的本机操作直接报错，不去问服务器", async () => {
    replay({})
    const channel = createDesktopRemoteTransport()
    await expect(channel.invoke("sync_vault")).rejects.toContain("没有本机目录与 Git")
    await expect(channel.invoke("open_csv_file", { path: "datasets/a.csv" })).rejects.toContain("不能用本机程序打开")
    expect(tauri.invoke).not.toHaveBeenCalled()
  })

  it("粘贴的图片先按原始字节上传拿 sha，再登记（与网页传输一致）", async () => {
    replay({ remote_upload_blob: () => "f".repeat(64) }, { save_fragment_image: () => "assets/ff/x.png" })
    const bytes = new Uint8Array([1, 2, 3])
    await expect(
      createDesktopRemoteTransport().invokeBytes("save_fragment_image", bytes, { "x-shard-file-name": encodeURIComponent("截图 1.png") })
    ).resolves.toBe("assets/ff/x.png")
    expect(tauri.invoke.mock.calls[0]).toEqual(["remote_upload_blob", bytes])
    expect(tauri.invoke.mock.calls[1]).toEqual([
      "remote_invoke",
      { command: "save_fragment_image", args: { fileName: "截图 1.png", blobSha: "f".repeat(64) } },
    ])
  })

  it("图片地址仍是 shard-asset（Rust 代理 /api/files）", () => {
    expect(createDesktopRemoteTransport().fileUrl("assets/ab/x.png")).toBe(`shard-asset://localhost/${encodeURIComponent("assets/ab/x.png")}`)
  })
})

describe("服务器通道（密匣客户端用）", () => {
  it("call 要带状态码的失败值", async () => {
    const failure = { status: 409, code: "LOCKBOX_UNAVAILABLE", detail: "这是密匣条目" }
    tauri.invoke.mockRejectedValueOnce(failure)
    const channel = createDesktopRemoteTransport()
    await expect(channel.server!.call("update_fragment", { id: "x" })).rejects.toEqual(failure)
    expect(tauri.invoke).toHaveBeenCalledWith("remote_invoke", { command: "update_fragment", args: { id: "x" }, detailed: true })
  })

  it("fetchText 读最新修订的原始字节：保留 BOM，sha 与修订一致", async () => {
    const text = "﻿---\nid: a\n---\n\n正文\n"
    const bytes = new TextEncoder().encode(text)
    replay(
      {},
      {
        list_revisions: () => ({ nodeId: 1, path: "fragments/a.md", revisions: [{ revId: 9, sha: "sha-9" }, { revId: 3, sha: "sha-3" }] }),
        [REVISION_BYTES_COMMAND]: (args) => {
          expect(args).toEqual({ revId: 9 })
          return { sha: "sha-9", contentType: "text/plain", data: base64(bytes) }
        },
      }
    )
    await expect(createDesktopRemoteTransport().server!.fetchText("fragments/a.md")).resolves.toEqual({ text, sha: "sha-9" })
    expect(tauri.invoke.mock.calls.map(([, args]) => (args as { detailed?: boolean }).detailed)).toEqual([true, true])
  })

  it("fetchText：没有内容报 404，字节对不上不当成读到", async () => {
    replay({}, { list_revisions: () => ({ revisions: [{ revId: 2, sha: null }] }) })
    await expect(createDesktopRemoteTransport().server!.fetchText("fragments/gone.md")).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" })

    replay(
      {},
      {
        list_revisions: () => ({ revisions: [{ revId: 4, sha: "sha-4" }] }),
        [REVISION_BYTES_COMMAND]: () => ({ sha: "sha-other", contentType: null, data: "" }),
      }
    )
    await expect(createDesktopRemoteTransport().server!.fetchText("fragments/a.md")).rejects.toMatchObject({ status: 409 })
  })
})

describe("事件", () => {
  it("vault-changed 等直接订阅 Rust 转发的同名 Tauri 事件", async () => {
    const seen: unknown[] = []
    const dispose = await createDesktopRemoteTransport().listen("vault-changed", (payload) => seen.push(payload))
    tauri.emit("vault-changed", { vault: "shard://x", changes: [{ path: "a.md", exists: true, sha: "1" }] })
    dispose()
    tauri.emit("vault-changed", { vault: "shard://x", changes: [] })
    expect(seen).toEqual([{ vault: "shard://x", changes: [{ path: "a.md", exists: true, sha: "1" }] }])
  })

  it("密匣可能变了：lockbox-changed、vault-resync、断线重连上都通知", async () => {
    replay({ remote_status: () => ({ connected: true, connection: "connected" }) })
    await startRemoteConnectionTracking("connected")
    const seen: unknown[] = []
    const dispose = await createDesktopRemoteTransport().listen("lockbox-changed", (payload) => {
      seen.push(payload)
    })
    // 服务器的 `{seq}` 原样交给密匣客户端；游标过旧、重连没有载荷。
    tauri.emit("lockbox-changed", { seq: 42 })
    tauri.emit("vault-resync")
    tauri.emit("remote-connection", { state: "reconnecting" })
    tauri.emit("remote-connection", { state: "connected" })
    expect(seen).toEqual([{ seq: 42 }, undefined, undefined])
    dispose()
    tauri.emit("lockbox-changed", { seq: 43 })
    expect(seen).toHaveLength(3)
  })

  it("连接状态：启动时补读，之后跟随事件；令牌失效只提示一次", async () => {
    replay({ remote_status: () => ({ connected: true, connection: "connected" }) })
    await startRemoteConnectionTracking("connecting")
    // 订阅前错过的「已连接」由第二次 remote_status 补上。
    expect(remoteConnectionState()).toBe("connected")
    let prompts = 0
    subscribeRemoteAuthRequired(() => {
      prompts += 1
    })
    tauri.emit("remote-connection", { state: "reconnecting" })
    expect(remoteConnectionState()).toBe("reconnecting")
    // 断开连接时 Rust 也发 signedOut：只改状态，不算令牌失效。
    tauri.emit("remote-connection", { state: "signedOut" })
    expect(remoteConnectionState()).toBe("signedOut")
    expect(isRemoteAuthRequired()).toBe(false)
    tauri.emit("remote-auth-required", { server: "https://shard.test" })
    tauri.emit("remote-auth-required", { server: "https://shard.test" })
    expect(isRemoteAuthRequired()).toBe(true)
    expect(prompts).toBe(1)
  })

  it("启动前令牌就已失效（页面订阅前收到 401）：补读到 signedOut 即算失效", async () => {
    replay({ remote_status: () => ({ connected: true, connection: "signedOut" }) })
    await startRemoteConnectionTracking("signedOut")
    expect(remoteConnectionState()).toBe("signedOut")
    expect(isRemoteAuthRequired()).toBe(true)
  })
})

describe("离线（S8b）", () => {
  it("同步状态：启动时取 remote_status 里的，之后跟随 sync-status；坏载荷忽略", async () => {
    replay({
      remote_status: () => ({ connected: true, connection: "connected", sync: { state: "offline", pending: 2, conflicts: 0, failed: 0 } }),
    })
    await startRemoteConnectionTracking("connected", { state: "syncing", pending: 0, conflicts: 0, failed: 0 })
    expect(remoteSyncStatus()).toEqual({ state: "offline", pending: 2, conflicts: 0, failed: 0 })
    const seen: unknown[] = []
    subscribeRemoteSync((status) => seen.push(status))
    tauri.emit("sync-status", { state: "syncing", pending: 2, conflicts: 1, failed: 0 })
    tauri.emit("sync-status", { state: "syncing", pending: 2, conflicts: 1, failed: 0 })
    tauri.emit("sync-status", { state: "奇怪的状态", pending: 9 })
    tauri.emit("sync-status", { state: "online", pending: -1, conflicts: 1.5, failed: "x" })
    expect(seen).toEqual([
      { state: "syncing", pending: 2, conflicts: 1, failed: 0 },
      { state: "online", pending: 0, conflicts: 1, failed: 0 },
    ])
  })

  it("离线时被拒绝：错误原样交给调用方，另外通知界面一次「需要联网」", async () => {
    const refusal = "需要联网：改名。现在连不上服务器，联网后再试。"
    replay({}, { rename_library_entry: () => Promise.reject(refusal), list_fragments: () => Promise.reject("别的错误") })
    const notices: RemoteSyncNotice[] = []
    subscribeRemoteSyncNotices((notice) => notices.push(notice))
    const remote = createDesktopRemoteTransport()
    await expect(remote.invoke("rename_library_entry", { path: "notes/a.md", newName: "b" })).rejects.toBe(refusal)
    await expect(remote.invoke("list_fragments")).rejects.toBe("别的错误")
    // 密匣客户端经服务器通道直达：同样提示。
    await expect(remote.server!.call("rename_library_entry", {})).rejects.toBe(refusal)
    expect(notices).toEqual([
      { kind: "offline", message: refusal },
      { kind: "offline", message: refusal },
    ])
  })

  it("冲突副本、补交失败、恢复后找回：转成界面提示", async () => {
    replay({ remote_status: () => ({ connected: true, connection: "connected" }) })
    await startRemoteConnectionTracking("connected")
    const notices: RemoteSyncNotice[] = []
    subscribeRemoteSyncNotices((notice) => notices.push(notice))
    tauri.emit("sync-conflict", { id: "f1", copyId: "f2", reason: "stale" })
    tauri.emit("sync-failed", { command: "update_fragment", target: "fragment:f1", message: "参数无效" })
    tauri.emit("sync-recovered", { pushed: 2, saved: 1, dir: "/tmp/r" })
    expect(notices).toEqual([
      { kind: "conflict", id: "f1", copyId: "f2", reason: "stale" },
      { kind: "failed", command: "update_fragment", message: "参数无效" },
      { kind: "recovered", pushed: 2, saved: 1, dir: "/tmp/r" },
    ])
  })
})

describe("启动时选传输", () => {
  async function freshTransport() {
    vi.resetModules()
    return import("@/lib/transport")
  }

  it("已连接：远程传输，数据以服务器为真相，但不是网页", async () => {
    replay({ remote_status: () => ({ connected: true, server: "https://shard.test", deviceId: "d1", name: "我的 Mac", connection: "connected" }) })
    const module = await freshTransport()
    await module.initTransport()
    expect(module.transport().kind).toBe("tauri-remote")
    expect(module.isServerBacked()).toBe(true)
    expect(module.isWebRuntime()).toBe(false)
    expect(module.canOpenLocalFiles()).toBe(false)
    expect(module.desktopRemoteStatus()).toMatchObject({ server: "https://shard.test", name: "我的 Mac" })
    // 套了密匣客户端：服务器通道在。
    expect(module.transport().server).toBeDefined()
  })

  it("未连接或问不到 Rust：与改造前一样走本机", async () => {
    replay({ remote_status: () => ({ connected: false, server: null, deviceId: null, name: null }) })
    let module = await freshTransport()
    await module.initTransport()
    expect(module.transport().kind).toBe("tauri")
    expect(module.isServerBacked()).toBe(false)
    expect(module.canOpenLocalFiles()).toBe(true)
    expect(module.desktopRemoteStatus()).toBeNull()

    replay({})
    module = await freshTransport()
    await module.initTransport()
    expect(module.transport().kind).toBe("tauri")
    // 本地模式不订阅远程事件。
    expect(tauri.listen).not.toHaveBeenCalled()
  })
})
