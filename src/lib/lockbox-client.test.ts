import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { LOCKBOX_TTL_MS, WEB_UNLOCK_DISABLED_MESSAGE, type LockboxSessionState } from "@/lib/lockbox-client/client"
import type { LockboxEngine } from "@/lib/lockbox-client/engine"
import { createLockboxRouter, LOCKBOX_LOCKED_OUT_EVENT, sortFragmentList } from "@/lib/lockbox-client/router"
import type { ServerChannel, ServerFailure } from "@/lib/transport"

/**
 * 密匣分流（传输层）的单元测试：wasm 引擎用替身，只验证分流、写回、回滚、租约与「明文不出客户端」。
 * wasm 本身的行为由 `cargo test -p shard-lockbox-wasm` 与 tests/e2e/lockbox-web.spec.ts 覆盖。
 */

type Handler = (args: Record<string, unknown>) => unknown

const SECRET = "机密正文-不能出客户端"
const SECRET_VALUE = "机密属性值"

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

const publicVault = {
  vaultPath: "vault-id",
  fragments: [
    { id: "p1", path: "fragments/2026/10/p1.md", pinned: false, createdAt: "2026-10-20T08:00:00+08:00", lockbox: false },
    { id: "p2", path: "fragments/2026/10/p2.md", pinned: true, createdAt: "2026-10-01T08:00:00+08:00", lockbox: false },
  ],
  git: {},
  lockbox: { configured: true, unlocked: false, expiresAt: null, ttlSeconds: 900 },
}

const secretFragment = { id: "secret", path: "lockbox/notes/项目/周报.shard", pinned: false, createdAt: "2026-10-25T08:00:00+08:00", lockbox: true }

/** 一个模拟的服务器与 wasm 会话：服务器快照按 `items` / `withheld` 给，wasm 按 `unlocked` 回答。 */
function setup(options: { items?: string[]; engine?: Record<string, Handler>; server?: Record<string, Handler> } = {}) {
  const world = { items: options.items ?? ["secret"], withheld: false, unlocked: false, seq: 5 }
  const engineCalls: Array<{ method: string; args: Record<string, unknown> }> = []
  const serverCalls: Array<{ command: string; args: Record<string, unknown> }> = []
  let resets = 0
  const sessionState = () => state({ unlocked: world.unlocked && !world.withheld, itemsWithheld: world.withheld, itemIds: world.withheld ? [] : world.items })
  const engineHandlers: Record<string, Handler> = {
    load: () => ({ state: sessionState(), changes: [] }),
    state: () => sessionState(),
    unlock: () => {
      world.unlocked = true
      return { result: null, write: null }
    },
    lock: () => sessionState(),
    list: () => (world.unlocked ? [secretFragment] : []),
    rollback: () => sessionState(),
    commit: () => sessionState(),
    ...options.engine,
  }
  const engine: LockboxEngine = {
    async call<T>(method: string, args: Record<string, unknown>) {
      engineCalls.push({ method, args })
      const handler = engineHandlers[method]
      if (!handler) throw new Error(`没有替身：${method}`)
      return (await handler(args)) as T
    },
    reset() {
      resets += 1
      world.unlocked = false
    },
  }
  const serverHandlers: Record<string, Handler> = {
    list_fragments: () => structuredClone(publicVault),
    lockbox_snapshot: () => ({
      configured: true,
      manifest: { body: "{}", sha: "m" },
      items: world.withheld ? [] : world.items.map((id) => ({ id, envelope: "{}", sha: id })),
      itemsWithheld: world.withheld,
      webUnlock: !world.withheld,
      lockboxSeq: world.seq,
    }),
    ...options.server,
  }
  const server: ServerChannel = {
    async call<T>(command: string, args: Record<string, unknown>) {
      serverCalls.push({ command, args })
      const handler = serverHandlers[command]
      if (!handler) throw { status: 409, code: "LOCKBOX_UNAVAILABLE", detail: "密匣内容暂时只能在桌面端处理。" } satisfies ServerFailure
      return (await handler(args)) as T
    },
    async fetchText(path: string) {
      serverCalls.push({ command: "fetchText", args: { path } })
      return { text: `---\nid: p1\n---\n\n公开正文\n`, sha: "public-sha" }
    },
  }
  const emitted: Array<{ vault: string; changes: unknown[] }> = []
  let notify: ((seq?: number) => void) | null = null
  const stepUp = vi.fn(async () => undefined)
  const router = createLockboxRouter({
    server,
    engine: () => engine,
    emitVaultChanged: (payload) => emitted.push(payload),
    onLockboxChanged: (handler) => {
      notify = handler
    },
    stepUp,
  })
  return {
    router,
    world,
    engineCalls,
    serverCalls,
    emitted,
    stepUp,
    resets: () => resets,
    lockboxChanged: (seq?: number) => notify?.(seq),
    sent: () => JSON.stringify(serverCalls),
    snapshots: () => serverCalls.filter((call) => call.command === "lockbox_snapshot").length,
  }
}

/** 解锁并读一次列表：界面上显示着密匣碎片 secret。 */
async function unlockAndShow(test: ReturnType<typeof setup>) {
  await test.router.invoke("unlock_lockbox", { password: "pw" })
  const listed = (await test.router.invoke("list_fragments", {})) as typeof publicVault
  expect(listed.fragments.map((fragment) => fragment.id)).toContain("secret")
}

let lockedOut: string[] = []

beforeEach(() => {
  lockedOut = []
  const target = new EventTarget()
  target.addEventListener(LOCKBOX_LOCKED_OUT_EVENT, (event) => lockedOut.push((event as CustomEvent).detail.reason))
  vi.stubGlobal("window", target)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe("密匣分流：明文不出客户端", () => {
  it("不带密匣标签的新建直接交给服务器，不启动 wasm", async () => {
    const test = setup({ server: { create_fragment: (args) => ({ id: "new", content: args.content, lockbox: false }) } })
    await expect(test.router.invoke("create_fragment", { content: "公开的", tags: ["inbox"] })).resolves.toMatchObject({ id: "new" })
    expect(test.engineCalls).toEqual([])
    expect(test.serverCalls.map((call) => call.command)).toEqual(["create_fragment"])
  })

  it("带密匣标签的新建在 wasm 里加密，服务器只收到密文；之后这个 id 只在本地写", async () => {
    const test = setup({
      items: [],
      engine: {
        create: () => ({
          result: { id: "new-secret", content: "", lockbox: true, path: "lockbox/fragments/2026/10/new-secret.shard" },
          write: { apply: { items: [{ op: "put", id: "new-secret", envelope: "{密文}", expectedSha: null }] }, seal: null },
        }),
        commit: () => state({ itemIds: ["new-secret"] }),
        update: () => {
          throw "lockbox_locked"
        },
      },
      server: { lockbox_apply: () => ({ manifest: null, items: [{ id: "new-secret", sha: "s1" }], lockboxSeq: 6 }) },
    })
    await test.router.invoke("create_fragment", { content: SECRET, tags: ["inbox", "密匣"] })
    expect(test.sent()).not.toContain(SECRET)
    expect(test.engineCalls.map((call) => call.method)).toEqual(["load", "create", "commit"])
    expect(test.router.client.isLockboxId("new-secret")).toBe(true)
    // 锁着改它：本地报 lockbox_locked，不发服务器。
    test.engineCalls.length = 0
    const before = test.serverCalls.length
    await expect(test.router.invoke("update_fragment", { id: "new-secret", content: SECRET, tags: [] })).rejects.toBe("lockbox_locked")
    expect(test.serverCalls.slice(before).map((call) => call.command)).toEqual([])
  })

  it("服务器 409：回滚、重取快照，把 STALE_BASE 原样交给界面", async () => {
    const test = setup({
      engine: { update: () => ({ result: { id: "secret", lockbox: true }, write: { apply: { items: [] }, seal: null } }) },
      server: {
        lockbox_apply: () => {
          throw { status: 409, code: "STALE_BASE", detail: "STALE_BASE: 密匣条目 secret 已在别处改过，刷新后再试。" }
        },
      },
    })
    await unlockAndShow(test)
    test.engineCalls.length = 0
    await expect(test.router.invoke("update_fragment", { id: "secret", content: "x", tags: [] })).rejects.toBe(
      "STALE_BASE: 密匣条目 secret 已在别处改过，刷新后再试。"
    )
    expect(test.engineCalls.map((call) => call.method)).toEqual(["update", "rollback", "load"])
  })

  it("不认识的 id 带内容的写命令：既不是公开 id 也不是密匣 id 时拒绝，内容不发给服务器", async () => {
    const test = setup({ items: [] })
    await test.router.invoke("list_fragments", {})
    for (const [command, args] of [
      ["update_fragment", { id: "ghost", content: SECRET, tags: [] }],
      ["update_fragment_tags", { id: "ghost", tags: [SECRET] }],
      ["set_fragment_property", { id: "ghost", key: "提示", value: { type: "text", value: SECRET_VALUE } }],
      ["remove_fragment_property", { id: "ghost", key: SECRET_VALUE }],
    ] as const) {
      await expect(test.router.invoke(command, args)).rejects.toBe("lockbox_locked")
    }
    expect(test.sent()).not.toContain(SECRET)
    expect(test.sent()).not.toContain(SECRET_VALUE)
    // 先重读公开列表、再重取密匣快照，都只读不写。
    expect(new Set(test.serverCalls.map((call) => call.command))).toEqual(new Set(["list_fragments", "lockbox_snapshot"]))
  })

  it("确认是公开 id 的写命令照常发给服务器", async () => {
    const test = setup({ server: { update_fragment: (args) => ({ id: args.id, lockbox: false }) } })
    await test.router.invoke("list_fragments", {})
    await expect(test.router.invoke("update_fragment", { id: "p1", content: "公开正文", tags: [] })).resolves.toMatchObject({ id: "p1" })
    expect(test.engineCalls.filter((call) => call.method !== "load")).toEqual([])
  })

  it("不带内容的写命令（置顶）对不认识的 id 照常发服务器；服务器说是密匣条目就重取快照在本地执行", async () => {
    let items: string[] = []
    const test = setup({
      items: [],
      engine: { set_pinned: () => ({ result: { id: "late", pinned: true, lockbox: true }, write: null }) },
      server: {
        set_fragment_pinned: () => {
          items = ["late"]
          throw { status: 409, code: "LOCKBOX_UNAVAILABLE", detail: "密匣内容暂时只能在桌面端处理。" }
        },
      },
    })
    test.world.items = items
    await test.router.invoke("list_fragments", {})
    test.world.items = ["late"]
    await expect(test.router.invoke("set_fragment_pinned", { id: "late", pinned: true })).resolves.toMatchObject({ pinned: true })
  })

  it("Worker 崩溃后：界面收到隐藏通知，密匣碎片的自动保存与属性都不发给服务器", async () => {
    const locked = () => {
      throw "lockbox_locked"
    }
    const test = setup({ engine: { update: locked, set_property: locked } })
    test.engineCalls.length = 0
    await unlockAndShow(test)
    test.router.forget()
    expect(lockedOut).toEqual(["crashed"])
    expect(test.emitted[test.emitted.length - 1]).toEqual({ vault: "vault-id", changes: [{ path: secretFragment.path, exists: false, sha: null }] })
    // 编辑器还开着：自动保存。崩溃后的新 Worker 是锁着的。
    const engine = test.engineCalls
    engine.length = 0
    await expect(test.router.invoke("update_fragment", { id: "secret", content: SECRET, tags: ["工作"] })).rejects.toBeDefined()
    await expect(
      test.router.invoke("set_fragment_property", { id: "secret", key: "提示", value: { type: "text", value: SECRET_VALUE } })
    ).rejects.toBeDefined()
    expect(test.sent()).not.toContain(SECRET)
    expect(test.sent()).not.toContain(SECRET_VALUE)
  })

  it("另一页关掉网页解锁（快照被扣下）时编辑器仍开着密匣碎片：本页上锁、丢掉 Worker，保存一律不外泄", async () => {
    const test = setup({
      engine: {
        update: () => {
          throw "lockbox_locked"
        },
        set_property: () => {
          throw "lockbox_locked"
        },
      },
    })
    await unlockAndShow(test)
    vi.useFakeTimers()
    test.world.withheld = true
    test.lockboxChanged()
    await vi.advanceTimersByTimeAsync(300)
    expect(lockedOut).toEqual(["withheld"])
    expect(test.resets()).toBeGreaterThan(0)
    expect(test.emitted[test.emitted.length - 1]?.changes).toEqual([{ path: secretFragment.path, exists: false, sha: null }])
    vi.useRealTimers()

    await expect(test.router.invoke("update_fragment", { id: "secret", content: SECRET, tags: [] })).rejects.toBe("lockbox_locked")
    await expect(
      test.router.invoke("set_fragment_property", { id: "secret", key: "提示", value: { type: "text", value: SECRET_VALUE } })
    ).rejects.toBe("lockbox_locked")
    // 正文里带 #密匣：已知是密匣条目，同样只在本地处理。
    await expect(test.router.invoke("update_fragment", { id: "secret", content: `${SECRET} #密匣`, tags: ["密匣"] })).rejects.toBe(
      "lockbox_locked"
    )
    expect(test.sent()).not.toContain(SECRET)
    expect(test.sent()).not.toContain(SECRET_VALUE)
    const listed = (await test.router.invoke("list_fragments", {})) as typeof publicVault
    expect(listed.lockbox).toMatchObject({ unlocked: false, webUnlock: false })
  })

  it("#密匣 正文 + 在公开列表里找不到：报「找不到片段」，正文不发给服务器", async () => {
    const test = setup({ items: [] })
    await test.router.invoke("list_fragments", {})
    await expect(test.router.invoke("update_fragment", { id: "ghost", content: `${SECRET} #密匣`, tags: ["密匣"] })).rejects.toBe(
      "找不到片段 ghost"
    )
    await expect(test.router.invoke("update_fragment_tags", { id: "ghost", tags: ["密匣", SECRET] })).rejects.toBe("找不到片段 ghost")
    expect(test.sent()).not.toContain(SECRET)
  })

  it("公开碎片保存时带上密匣标签：取原文在本地移入，新正文不发给服务器", async () => {
    const test = setup({
      items: [],
      engine: {
        update_public: () => ({
          result: { id: "p1", lockbox: true, path: "lockbox/fragments/2026/10/p1.shard" },
          write: { apply: null, seal: { fragmentId: "p1", expectedFileSha: "public-sha", item: { id: "p1", envelope: "{密文}", path: "x" } } },
        }),
        commit: () => state({ itemIds: ["p1"] }),
      },
      server: { seal_fragment_into_lockbox: () => ({ removedPath: "fragments/2026/10/p1.md", item: { id: "p1", sha: "s" }, lockboxSeq: 9 }) },
    })
    await test.router.invoke("list_fragments", {})
    const saved = await test.router.invoke("update_fragment", { id: "p1", content: SECRET, tags: ["密匣"] })
    expect(saved).toMatchObject({ lockbox: true })
    expect(test.sent()).not.toContain(SECRET)
    expect(test.serverCalls.map((call) => call.command)).toEqual(["list_fragments", "lockbox_snapshot", "fetchText", "lockbox_snapshot", "seal_fragment_into_lockbox"])
    expect(test.router.client.isLockboxId("p1")).toBe(true)
  })

  it("已知的密匣条目，wasm 却说不是它的（返回 forward）：直接报错，不转发", async () => {
    const test = setup({ engine: { update: () => ({ forward: true }) } })
    await unlockAndShow(test)
    const before = test.serverCalls.length
    await expect(test.router.invoke("update_fragment", { id: "secret", content: SECRET, tags: [] })).rejects.toBe("lockbox_locked")
    expect(test.serverCalls.slice(before)).toEqual([])
  })
})

describe("密匣分流：回声、通行密钥、上锁", () => {
  it("自己写入的 lockbox-changed 回声与已含在快照里的 seq 不重取快照；别人的、没有 seq 的照常重取", async () => {
    vi.useFakeTimers()
    const test = setup({
      engine: { set_pinned: () => ({ result: { id: "secret", lockbox: true }, write: { apply: { items: [] }, seal: null } }) },
      server: { lockbox_apply: () => ({ manifest: null, items: [], lockboxSeq: 7 }) },
    })
    await unlockAndShow(test)
    await test.router.invoke("set_fragment_pinned", { id: "secret", pinned: true })
    const base = test.snapshots()
    for (const seq of [7, 5, 3]) {
      test.lockboxChanged(seq)
      await vi.advanceTimersByTimeAsync(300)
    }
    expect(test.snapshots()).toBe(base)
    test.lockboxChanged(8)
    await vi.advanceTimersByTimeAsync(300)
    expect(test.snapshots()).toBe(base + 1)
    test.lockboxChanged()
    test.lockboxChanged(7)
    await vi.advanceTimersByTimeAsync(300)
    expect(test.snapshots()).toBe(base + 2)
  })

  it("设置密匣遇到 STEP_UP_REQUIRED：验证一次通行密钥后重试", async () => {
    let attempts = 0
    const test = setup({
      items: [],
      engine: {
        setup: () => ({ result: { recoveryKey: "shard-abc" }, write: { apply: { manifest: { body: "{}", expectedSha: null }, items: [] }, seal: null } }),
        commit: () => state({ unlocked: true }),
      },
      server: {
        lockbox_apply: () => {
          attempts += 1
          if (attempts === 1) throw { status: 403, code: "STEP_UP_REQUIRED", detail: "这个操作需要重新验证通行密钥。" }
          return { manifest: { sha: "m2" }, items: [], lockboxSeq: 6 }
        },
      },
    })
    const result = (await test.router.invoke("setup_lockbox", { password: "pw" })) as { recoveryKey: string }
    expect(result.recoveryKey).toBe("shard-abc")
    expect(test.stepUp).toHaveBeenCalledTimes(1)
    expect(attempts).toBe(2)
    expect(test.sent()).not.toContain("pw")
  })

  it("网页解锁已关闭时改口令被拒：给界面「网页解锁已关闭」", async () => {
    const test = setup({
      engine: {
        change_password: () => ({ result: null, write: { apply: { manifest: { body: "{}", expectedSha: "m" }, items: [] }, seal: null } }),
      },
      server: {
        lockbox_apply: () => {
          throw { status: 403, code: "LOCKBOX_WEB_DISABLED", detail: "网页解锁已关闭，不能在网页上修改密匣设置。" }
        },
      },
    })
    await unlockAndShow(test)
    await expect(test.router.invoke("change_lockbox_password", { currentPassword: "pw", newPassword: "pw2" })).rejects.toBe(
      WEB_UNLOCK_DISABLED_MESSAGE
    )
    expect(test.stepUp).not.toHaveBeenCalled()
  })

  it("解锁时顺带的 manifest 升级被拒：仍然解锁，不要求通行密钥", async () => {
    const test = setup({
      engine: {
        unlock: () => ({ result: null, write: { apply: { manifest: { body: "{}", expectedSha: "m" }, items: [] }, seal: null } }),
        rollback: () => state({ unlocked: true, itemIds: ["secret"] }),
        load: () => ({ state: state({ unlocked: test.world.unlocked, itemIds: ["secret"] }), changes: [] }),
        conceal: () => ({ result: 0, write: null }),
      },
      server: {
        lockbox_apply: () => {
          throw { status: 403, code: "STEP_UP_REQUIRED", detail: "这个操作需要重新验证通行密钥。" }
        },
      },
    })
    test.world.unlocked = true
    const unlocked = (await test.router.invoke("unlock_lockbox", { password: "pw" })) as typeof publicVault
    expect(unlocked.lockbox.unlocked).toBe(true)
    expect(test.stepUp).not.toHaveBeenCalled()
  })

  it("上锁丢掉 Worker；之后读列表不再启动它", async () => {
    const test = setup()
    await unlockAndShow(test)
    const resets = test.resets()
    await test.router.invoke("lock_lockbox", {})
    expect(test.resets()).toBe(resets + 1)
    test.engineCalls.length = 0
    const listed = (await test.router.invoke("list_fragments", {})) as typeof publicVault
    expect(listed.lockbox.unlocked).toBe(false)
    expect(test.engineCalls).toEqual([])
    // 主动上锁不发「被迫上锁」通知（界面自己收起）。
    expect(lockedOut).toEqual([])
  })

  it("列表：已解锁时合并密匣碎片并按桌面规则排序；租约到期丢掉 Worker 并通知界面", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-10-27T10:00:00Z"))
    const test = setup()
    const unlocked = (await test.router.invoke("unlock_lockbox", { password: "pw" })) as typeof publicVault
    expect(unlocked.fragments.map((fragment) => fragment.id)).toEqual(["p2", "secret", "p1"])
    expect(unlocked.lockbox).toMatchObject({ configured: true, unlocked: true, webUnlock: true })
    expect(Date.parse(unlocked.lockbox.expiresAt!)).toBe(Date.now() + LOCKBOX_TTL_MS)

    const resets = test.resets()
    await vi.advanceTimersByTimeAsync(LOCKBOX_TTL_MS + 100)
    expect(test.resets()).toBe(resets + 1)
    expect(lockedOut).toEqual(["expired"])
    const expired = (await test.router.invoke("list_fragments", {})) as typeof publicVault
    expect(expired.lockbox.unlocked).toBe(false)
    expect(expired.fragments.map((fragment) => fragment.id)).toEqual(["p1", "p2"])
  })

  it("密匣范围的搜索在本地执行，查询词不发给服务器；锁着直接报 locked", async () => {
    const test = setup({ engine: { search: () => ({ hits: [], total: 0 }) }, server: { search_vault: () => ({ hits: ["public"] }) } })
    await expect(test.router.invoke("search_vault", { request: { scope: "lockbox", query: SECRET } })).rejects.toEqual({ code: "locked" })
    await unlockAndShow(test)
    await expect(test.router.invoke("search_vault", { request: { scope: "public" } })).resolves.toEqual({ hits: ["public"] })
    const local = (await test.router.invoke("search_vault", { request: { scope: "lockbox", query: SECRET } })) as { total: number; expiresAt: string }
    expect(local.total).toBe(0)
    expect(Date.parse(local.expiresAt)).toBeGreaterThan(Date.now())
    expect(test.sent()).not.toContain(SECRET)
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
