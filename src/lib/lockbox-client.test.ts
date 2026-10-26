import { afterEach, describe, expect, it, vi } from "vitest"

import { LOCKBOX_TTL_MS, type LockboxSessionState } from "@/lib/lockbox-client/client"
import type { LockboxEngine } from "@/lib/lockbox-client/engine"
import { createLockboxRouter, sortFragmentList } from "@/lib/lockbox-client/router"
import type { ServerChannel, ServerFailure } from "@/lib/transport"

/**
 * 密匣分流（传输层）的单元测试：wasm 引擎用替身，只验证分流、写回、回滚与租约。wasm 本身的行为由
 * `cargo test -p shard-lockbox-wasm` 与 tests/e2e/lockbox-web.spec.ts 覆盖。
 */

type Handler = (args: Record<string, unknown>) => unknown

function state(patch: Partial<LockboxSessionState> = {}): LockboxSessionState {
  return {
    loaded: true,
    configured: true,
    unlocked: false,
    webUnlock: true,
    itemsWithheld: false,
    itemIds: [],
    privacyEpoch: "1",
    pending: false,
    ...patch,
  }
}

function fakeEngine(handlers: Record<string, Handler>) {
  const calls: Array<{ method: string; args: Record<string, unknown> }> = []
  const engine: LockboxEngine = {
    async call<T>(method: string, args: Record<string, unknown>) {
      calls.push({ method, args })
      const handler = handlers[method]
      if (!handler) throw new Error(`没有替身：${method}`)
      return (await handler(args)) as T
    },
    reset() {},
  }
  return { engine, calls }
}

function fakeServer(handlers: Record<string, Handler>) {
  const calls: Array<{ command: string; args: Record<string, unknown> }> = []
  const server: ServerChannel = {
    async call<T>(command: string, args: Record<string, unknown>) {
      calls.push({ command, args })
      const handler = handlers[command]
      if (!handler) throw { status: 404, code: "NOT_FOUND", detail: `没有替身：${command}` } satisfies ServerFailure
      return (await handler(args)) as T
    },
    async fetchText(path: string) {
      calls.push({ command: "fetchText", args: { path } })
      return { text: `---\nid: p1\n---\n\n公开正文\n`, sha: "public-sha" }
    },
  }
  return { server, calls }
}

const publicVault = {
  vaultPath: "vault-id",
  fragments: [
    { id: "p1", path: "fragments/2026/10/p1.md", pinned: false, createdAt: "2026-10-20T08:00:00+08:00", lockbox: false },
    { id: "p2", path: "fragments/2026/10/p2.md", pinned: true, createdAt: "2026-10-01T08:00:00+08:00", lockbox: false },
  ],
  git: {},
  lockbox: { configured: true, unlocked: false, expiresAt: null, ttlSeconds: 900 },
}

function router(engineHandlers: Record<string, Handler>, serverHandlers: Record<string, Handler> = {}) {
  const engine = fakeEngine(engineHandlers)
  const server = fakeServer({ list_fragments: () => structuredClone(publicVault), lockbox_snapshot: () => ({}), ...serverHandlers })
  const emitted: unknown[] = []
  let notify: (() => void) | null = null
  const created = createLockboxRouter({
    server: server.server,
    engine: () => engine.engine,
    emitVaultChanged: (payload) => emitted.push(payload),
    onLockboxChanged: (handler) => {
      notify = handler
    },
  })
  return { router: created, engine: engine.calls, server: server.calls, emitted, lockboxChanged: () => notify?.() }
}

afterEach(() => {
  vi.useRealTimers()
})

describe("密匣分流", () => {
  it("不带密匣标签的新建直接交给服务器，不加载 wasm", async () => {
    const setup = router({}, { create_fragment: (args) => ({ id: "new", content: args.content }) })
    await expect(setup.router.invoke("create_fragment", { content: "公开的", tags: ["inbox"] })).resolves.toMatchObject({ id: "new" })
    expect(setup.engine).toEqual([])
    expect(setup.server.map((call) => call.command)).toEqual(["create_fragment"])
  })

  it("带密匣标签的新建在 wasm 里加密，服务器只收到密文写入，确认后推进基线", async () => {
    const setup = router(
      {
        load: () => ({ state: state(), changes: [] }),
        state: () => state(),
        create: () => ({
          result: { id: "secret", content: "", lockbox: true },
          write: { apply: { items: [{ op: "put", id: "secret", envelope: "{密文}", expectedSha: null }] }, seal: null },
        }),
        commit: () => state({ itemIds: ["secret"] }),
      },
      { lockbox_apply: () => ({ manifest: null, items: [{ id: "secret", sha: "s1", revision: 1 }] }) }
    )
    const created = await setup.router.invoke("create_fragment", { content: "私密正文", tags: ["inbox", "密匣"] })
    expect(created).toMatchObject({ id: "secret", lockbox: true })
    expect(setup.engine.map((call) => call.method)).toEqual(["load", "create", "commit"])
    expect(setup.engine[1].args).toMatchObject({ content: "私密正文", tags: ["inbox", "密匣"] })
    expect(setup.engine[2].args).toMatchObject({ apply: { items: [{ id: "secret", sha: "s1" }] }, seal: null })
    expect(JSON.stringify(setup.server)).not.toContain("私密正文")
    expect(setup.server.map((call) => call.command)).toEqual(["lockbox_snapshot", "lockbox_apply"])
    // 之后这个 id 的写命令都在本地执行。
    expect(setup.router.client.owns("secret")).toBe(true)
  })

  it("服务器 409：回滚、重取快照，把 STALE_BASE 原样交给界面", async () => {
    const setup = router(
      {
        load: () => ({ state: state({ itemIds: ["secret"] }), changes: [] }),
        update: () => ({ result: { id: "secret" }, write: { apply: { items: [] }, seal: null } }),
        rollback: () => state(),
      },
      {
        lockbox_apply: () => {
          throw { status: 409, code: "STALE_BASE", detail: "STALE_BASE: 密匣条目 secret 已在别处改过，刷新后再试。" }
        },
      }
    )
    await setup.router.client.ensureLoaded()
    await expect(setup.router.invoke("update_fragment", { id: "secret", content: "x", tags: [] })).rejects.toBe(
      "STALE_BASE: 密匣条目 secret 已在别处改过，刷新后再试。"
    )
    expect(setup.engine.map((call) => call.method)).toEqual(["load", "update", "rollback", "load"])
  })

  it("不认识的 id 交给服务器；服务器说是密匣条目时重取快照再在本地执行", async () => {
    let snapshots = 0
    const setup = router(
      {
        load: () => ({ state: state({ itemIds: snapshots > 1 ? ["late"] : [] }), changes: [] }),
        set_pinned: () => ({ result: { id: "late", pinned: true }, write: null }),
        state: () => state({ itemIds: ["late"] }),
      },
      {
        lockbox_snapshot: () => {
          snapshots += 1
          return {}
        },
        set_fragment_pinned: () => {
          throw { status: 409, code: "LOCKBOX_UNAVAILABLE", detail: "密匣内容暂时只能在桌面端处理。" }
        },
      }
    )
    await setup.router.client.ensureLoaded()
    await expect(setup.router.invoke("set_fragment_pinned", { id: "late", pinned: true })).resolves.toMatchObject({ pinned: true })
    expect(setup.server.map((call) => call.command)).toEqual(["lockbox_snapshot", "set_fragment_pinned", "lockbox_snapshot"])
  })

  it("公开碎片保存时带上密匣标签：取原文在本地移入，新正文不发给服务器", async () => {
    const setup = router(
      {
        load: () => ({ state: state(), changes: [] }),
        update_public: () => ({
          result: { id: "p1", lockbox: true },
          write: { apply: null, seal: { fragmentId: "p1", expectedFileSha: "public-sha", item: { id: "p1", envelope: "{密文}", path: "x" } } },
        }),
        commit: () => state({ itemIds: ["p1"] }),
      },
      { seal_fragment_into_lockbox: () => ({ removedPath: "fragments/2026/10/p1.md", item: { id: "p1", sha: "s" } }) }
    )
    await setup.router.invoke("list_fragments", {})
    const saved = await setup.router.invoke("update_fragment", { id: "p1", content: "新的私密正文", tags: ["密匣"] })
    expect(saved).toMatchObject({ lockbox: true })
    expect(JSON.stringify(setup.server)).not.toContain("新的私密正文")
    expect(setup.server.map((call) => call.command)).toEqual(["list_fragments", "lockbox_snapshot", "fetchText", "seal_fragment_into_lockbox"])
    expect(setup.engine.find((call) => call.method === "update_public")?.args).toMatchObject({
      path: "fragments/2026/10/p1.md",
      tagsOnly: false,
    })
  })

  it("列表：已解锁时合并密匣碎片并按桌面规则排序，租约到期自动上锁", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-10-27T10:00:00Z"))
    let unlocked = false
    const setup = router({
      load: () => ({ state: state({ unlocked }), changes: [] }),
      unlock: () => {
        unlocked = true
        return { result: null, write: null }
      },
      state: () => state({ unlocked }),
      lock: () => {
        unlocked = false
        return state()
      },
      list: () => (unlocked ? [{ id: "s1", pinned: false, createdAt: "2026-10-25T08:00:00+08:00", lockbox: true }] : []),
      dialect_list: () => [],
    })
    const unlockedState = (await setup.router.invoke("unlock_lockbox", { password: "pw" })) as typeof publicVault
    expect(unlockedState.fragments.map((fragment) => fragment.id)).toEqual(["p2", "s1", "p1"])
    expect(unlockedState.lockbox).toMatchObject({ configured: true, unlocked: true, webUnlock: true })
    expect(Date.parse(unlockedState.lockbox.expiresAt!)).toBe(Date.now() + LOCKBOX_TTL_MS)
    expect(JSON.stringify(setup.server)).not.toContain("pw")

    vi.setSystemTime(Date.now() + LOCKBOX_TTL_MS + 1)
    const expired = (await setup.router.invoke("list_fragments", {})) as typeof publicVault
    expect(expired.lockbox.unlocked).toBe(false)
    expect(expired.fragments.map((fragment) => fragment.id)).toEqual(["p1", "p2"])
    expect(setup.engine.some((call) => call.method === "lock")).toBe(true)
  })

  it("密匣范围的搜索在本地执行，公开范围照常问服务器", async () => {
    const setup = router(
      {
        load: () => ({ state: state(), changes: [] }),
        unlock: () => ({ result: null, write: null }),
        state: () => state({ unlocked: true }),
        list: () => [],
        search: () => ({ hits: [], total: 0 }),
      },
      { search_vault: () => ({ hits: ["public"] }) }
    )
    await setup.router.invoke("unlock_lockbox", { password: "pw" })
    await expect(setup.router.invoke("search_vault", { request: { scope: "public" } })).resolves.toEqual({ hits: ["public"] })
    const local = (await setup.router.invoke("search_vault", { request: { scope: "lockbox" } })) as { total: number; expiresAt: string }
    expect(local.total).toBe(0)
    expect(Date.parse(local.expiresAt)).toBeGreaterThan(Date.now())
    expect(setup.engine.find((call) => call.method === "search")?.args).toMatchObject({ vaultPath: "vault-id" })
  })

  it("别处写了密匣：重取快照，已解锁且有变化时以 vault-changed 推给界面", async () => {
    vi.useFakeTimers()
    let changes: unknown[] = []
    let unlocked = false
    const setup = router({ load: () => ({ state: state({ unlocked }), changes }) })
    await setup.router.client.ensureLoaded()
    changes = [{ path: "lockbox/fragments/2026/10/x.shard", exists: true, sha: "s" }]
    // 锁着：界面上本来就没有密匣内容，不打扰。
    setup.lockboxChanged()
    await vi.advanceTimersByTimeAsync(300)
    expect(setup.emitted).toEqual([])
    unlocked = true
    setup.lockboxChanged()
    setup.lockboxChanged()
    await vi.advanceTimersByTimeAsync(300)
    expect(setup.emitted).toEqual([{ vault: "", changes }])
    expect(setup.server.filter((call) => call.command === "lockbox_snapshot")).toHaveLength(3)
  })
})

describe("sortFragmentList", () => {
  it("置顶在前，再按创建时间新到旧，稳定", () => {
    const list = [
      { id: "a", pinned: false, createdAt: "2026-01-01" },
      { id: "b", pinned: true, createdAt: "2025-01-01" },
      { id: "c", pinned: false, createdAt: "2026-02-01" },
      { id: "d", pinned: false, createdAt: "2026-01-01" },
    ]
    expect(sortFragmentList(list).map((item) => item.id)).toEqual(["b", "c", "a", "d"])
  })
})
