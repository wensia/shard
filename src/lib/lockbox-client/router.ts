import type { Fragment, VaultState } from "@/types"

import type { ServerChannel } from "@/lib/transport"

import { FORWARD, isServerFailure, LockboxClient, type LockboxFileChange } from "./client"
import type { LockboxEngine } from "./engine"

/**
 * 以服务器为真相时的密匣分流：桌面本地模式在 Rust 命令里按「目标是不是密匣」分流，这里在传输层的同一个位置分流——
 * 密匣分支在浏览器里（wasm）执行，再把密文写回服务器；其余照常发给服务器。返回值形状与桌面一致。
 *
 * 明文只在浏览器里：带密匣标签的新建 / 保存、密匣条目的任何写入都不会把正文或标签发给服务器。
 * 判断「带不带密匣标签」时先用宽松的字符串检查（标签里出现「密匣」二字）决定要不要问 wasm，
 * 最终以 wasm 里与桌面相同的规整规则为准。
 */

/** 密匣标签（shard_core::LOCKBOX_TAG）。 */
const LOCKBOX_TAG = "密匣"

/** 经这里分流的命令；其余命令直接发给服务器。 */
export const LOCKBOX_ROUTED_COMMANDS = new Set([
  "list_fragments",
  "setup_lockbox",
  "unlock_lockbox",
  "lock_lockbox",
  "change_lockbox_password",
  "reset_lockbox_password",
  "list_lockbox_dialect_migration",
  "apply_lockbox_dialect_migration",
  "create_fragment",
  "update_fragment",
  "update_fragment_tags",
  "set_fragment_pinned",
  "set_fragment_archived",
  "set_fragment_property",
  "remove_fragment_property",
  "move_fragment_to_lockbox",
  "search_vault",
  "read_search_target",
])

/** 只带 id 的写命令 → wasm 里的方法名。 */
const ITEM_COMMANDS: Record<string, string> = {
  update_fragment: "update",
  update_fragment_tags: "update_tags",
  set_fragment_pinned: "set_pinned",
  set_fragment_archived: "set_archived",
  set_fragment_property: "set_property",
  remove_fragment_property: "remove_property",
}

type Args = Record<string, unknown>

interface PublicEntry {
  path: string
}

export interface LockboxRouterDeps {
  server: ServerChannel
  engine: () => LockboxEngine
  /** 把快照变化以 `vault-changed` 推给界面（与服务器推来的同形）。 */
  emitVaultChanged: (payload: { vault: string; changes: LockboxFileChange[] }) => void
  /** 订阅「密匣可能变了」（`lockbox-changed`、重连、游标过旧）。 */
  onLockboxChanged: (handler: () => void) => void
}

function mentionsLockbox(tags: unknown) {
  return Array.isArray(tags) && tags.some((tag) => typeof tag === "string" && tag.includes(LOCKBOX_TAG))
}

/** 桌面 `sort_fragment_list`：置顶在前，再按创建时间新到旧（稳定排序，比较 RFC 3339 原文）。 */
export function sortFragmentList<T extends Pick<Fragment, "pinned" | "createdAt">>(fragments: T[]) {
  return fragments.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
    if (a.createdAt === b.createdAt) return 0
    return a.createdAt > b.createdAt ? -1 : 1
  })
}

export function createLockboxRouter(deps: LockboxRouterDeps) {
  let vaultPath = ""
  const publicIndex = new Map<string, PublicEntry>()
  let engine: LockboxEngine | null = null
  const client = new LockboxClient(
    {
      call: (method, args) => (engine ??= deps.engine()).call(method, args),
      reset: () => engine?.reset(),
    },
    deps.server,
    { onChanges: (changes) => deps.emitVaultChanged({ vault: vaultPath, changes }) }
  )

  const server = <T>(command: string, args: Args) => deps.server.call<T>(command, args)

  // 别的设备 / 标签页写了密匣（`lockbox-changed`）、断线重连、游标过旧：重取快照。
  // 自己刚写的也会收到回声，快照与基线相同就没有变化、不打扰界面。
  let refreshTimer: ReturnType<typeof setTimeout> | null = null
  function scheduleRefresh() {
    if (!client.loaded) return
    if (refreshTimer !== null) clearTimeout(refreshTimer)
    refreshTimer = setTimeout(() => {
      refreshTimer = null
      void client.refresh().catch(() => undefined)
    }, 200)
  }
  deps.onLockboxChanged(scheduleRefresh)

  /** 服务器的错误按传输层的约定交给界面：字符串或结构化对象。 */
  async function serverOrDetail<T>(command: string, args: Args) {
    try {
      return await server<T>(command, args)
    } catch (failure) {
      throw isServerFailure(failure) ? failure.detail : failure
    }
  }

  function notePublic(state: VaultState) {
    vaultPath = state.vaultPath
    publicIndex.clear()
    for (const fragment of state.fragments) {
      if (!fragment.lockbox) publicIndex.set(fragment.id, { path: fragment.path })
    }
  }

  /** `list_fragments`：服务器的公开列表 + 已解锁时的密匣碎片，按桌面规则排序；`lockbox` 状态来自这里。 */
  async function listFragments(): Promise<VaultState> {
    const state = await serverOrDetail<VaultState>("list_fragments", {})
    notePublic(state)
    if (!state.lockbox.configured && !client.loaded) return state
    await client.ensureLoaded()
    // 别处刚设置好密匣、快照还没跟上：先重取，免得锁着记入时报「尚未设置」。
    if (client.configured !== state.lockbox.configured) await client.refresh()
    let lockbox: Fragment[] = []
    if (client.unlocked) lockbox = await client.read<Fragment[]>("list")
    return {
      ...state,
      fragments: lockbox.length > 0 ? sortFragmentList([...state.fragments, ...lockbox]) : state.fragments,
      lockbox: client.lockboxState(state.lockbox),
    }
  }

  async function publicEntry(id: string) {
    if (!publicIndex.has(id)) notePublic(await serverOrDetail<VaultState>("list_fragments", {}))
    return publicIndex.get(id) ?? null
  }

  /** 已在密匣里的条目：在 wasm 里执行；wasm 说不是（基线刚变）就交回服务器。 */
  async function itemCommand(command: string, args: Args) {
    const result = await client.run<Fragment>(ITEM_COMMANDS[command], args, { renew: true })
    return result === FORWARD ? serverOrDetail(command, args) : result
  }

  /** 公开碎片的保存带上了密匣标签：桌面把整篇移入密匣。正文与标签不发给服务器。 */
  async function saveIntoLockbox(command: string, args: Args) {
    const id = String(args.id ?? "")
    const entry = await publicEntry(id)
    if (!entry) return serverOrDetail(command, args)
    const { text } = await deps.server.fetchText(entry.path).catch((failure) => {
      throw isServerFailure(failure) ? failure.detail : failure
    })
    const result = await client.run<Fragment>(
      "update_public",
      { ...args, path: entry.path, text, tagsOnly: command === "update_fragment_tags" },
      { renew: true }
    )
    return result === FORWARD ? serverOrDetail(command, args) : result
  }

  /** 不认识的 id：照常发给服务器；服务器说这是密匣条目（快照过期）就重取快照再在本地执行。 */
  async function publicOrLockbox(command: string, args: Args) {
    try {
      return await server(command, args)
    } catch (failure) {
      if (!isServerFailure(failure) || failure.code !== "LOCKBOX_UNAVAILABLE") {
        throw isServerFailure(failure) ? failure.detail : failure
      }
      await client.refresh()
      if (client.owns(args.id)) return itemCommand(command, args)
      throw "lockbox_locked"
    }
  }

  async function vaultWithRecoveryKey(method: string, args: Args) {
    const result = (await client.run<{ recoveryKey: string }>(method, args, { unlocks: true })) as { recoveryKey: string }
    return { recoveryKey: result.recoveryKey, vault: await listFragments() }
  }

  async function invoke(command: string, args: Args): Promise<unknown> {
    switch (command) {
      case "list_fragments":
        return listFragments()
      case "setup_lockbox":
        return vaultWithRecoveryKey("setup", { password: args.password })
      case "reset_lockbox_password":
        return vaultWithRecoveryKey("reset_password", { recoveryKey: args.recoveryKey, newPassword: args.newPassword })
      case "unlock_lockbox":
        await client.run("unlock", { password: args.password }, { unlocks: true })
        return listFragments()
      case "change_lockbox_password":
        await client.run(
          "change_password",
          { currentPassword: args.currentPassword, newPassword: args.newPassword },
          { unlocks: true }
        )
        return listFragments()
      case "lock_lockbox":
        await client.lock()
        return listFragments()
      case "list_lockbox_dialect_migration":
        return client.read("dialect_list", {}, { renew: true })
      case "apply_lockbox_dialect_migration":
        return client.run("dialect_apply", { files: args.files }, { renew: true })
      case "create_fragment": {
        if (!mentionsLockbox(args.tags)) return serverOrDetail(command, args)
        const result = await client.run<Fragment>("create", args, { renew: true })
        return result === FORWARD ? serverOrDetail(command, args) : result
      }
      case "update_fragment":
      case "update_fragment_tags":
        if (client.owns(args.id)) return itemCommand(command, args)
        if (mentionsLockbox(args.tags)) return saveIntoLockbox(command, args)
        return publicOrLockbox(command, args)
      case "set_fragment_pinned":
      case "set_fragment_archived":
      case "set_fragment_property":
      case "remove_fragment_property":
        return client.owns(args.id) ? itemCommand(command, args) : publicOrLockbox(command, args)
      case "move_fragment_to_lockbox": {
        const id = String(args.id ?? "")
        const entry = await publicEntry(id)
        if (!entry) throw `找不到片段 ${id}`
        const { text } = await deps.server.fetchText(entry.path).catch((failure) => {
          throw isServerFailure(failure) ? failure.detail : failure
        })
        await client.run("move_public", { id, path: entry.path, text }, { renew: true })
        return listFragments()
      }
      case "search_vault":
      case "read_search_target":
        return search(command, args)
      default:
        return serverOrDetail(command, args)
    }
  }

  /** 公开范围照常问服务器；密匣范围只在浏览器内存里搜（服务器的密匣范围一律 locked）。 */
  async function search(command: string, args: Args) {
    const request = (args.request ?? {}) as { scope?: string; target?: { scope?: string } }
    const scope = command === "search_vault" ? request.scope : request.target?.scope
    if (scope !== "lockbox") return serverOrDetail(command, args)
    const reading = command === "read_search_target"
    // 桌面：搜索只看租约不续租，打开一条结果续租。
    const response = await client.read<Record<string, unknown>>(
      reading ? "read_search_target" : "search",
      { vaultPath, request: args.request },
      { renew: reading }
    )
    return { ...response, expiresAt: client.expiresAtIso() }
  }

  return {
    invoke,
    client,
    /** 账号设置里改了「允许在网页解锁密匣」之后：重取快照，关掉时立刻上锁。 */
    refresh: () => client.refresh(),
    /** 改「允许在网页解锁密匣」（敏感操作，调用方套 withStepUp）。关掉时本页立即上锁。 */
    async setWebUnlock(allowed: boolean) {
      await server("set_lockbox_web_unlock", { allowed })
      await client.refresh()
    },
    /** 网页解锁开关的当前值（会载入快照）。 */
    async webUnlock() {
      await client.ensureLoaded()
      return client.webUnlock
    },
    forget: () => client.forget(),
  }
}

export type LockboxRouter = ReturnType<typeof createLockboxRouter>
