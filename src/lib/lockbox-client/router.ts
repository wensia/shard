import type { Fragment, VaultState } from "@/types"

import type { ServerChannel } from "@/lib/transport"

import { FORWARD, isServerFailure, LockboxClient, type LockboxFileChange, type LockOutReason } from "./client"
import type { LockboxEngine } from "./engine"

/**
 * 以服务器为真相时的密匣分流：桌面本地模式在 Rust 命令里按「目标是不是密匣」分流，这里在传输层的同一个位置分流——
 * 密匣分支在客户端里（wasm）执行，再把密文写回服务器；其余照常发给服务器。返回值形状与桌面一致。
 *
 * **失败即关闭**：明文只在客户端里。带正文、标签或属性值的写命令只有**确认**目标是公开 id（出现在服务器的
 * 公开列表里）时才发给服务器；见过的密匣 id（只增不减）的写命令一律在本地执行，本地执行不了就报 `lockbox_locked`，
 * 绝不退回服务器。带密匣标签的新建 / 保存先用宽松的字符串检查（标签里出现「密匣」二字）决定要不要问 wasm，
 * 最终以 wasm 里与桌面相同的规整规则为准——wasm 只在确认没有密匣标签时才交回服务器。
 */

/** 密匣标签（shard_core::LOCKBOX_TAG）。 */
const LOCKBOX_TAG = "密匣"

/** 不是用户主动上锁（Worker 崩溃、服务器扣下密文、租约到期）时在 window 上派发：界面藏起已显示的密匣内容。 */
export const LOCKBOX_LOCKED_OUT_EVENT = "shard:lockbox-locked-out"

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

/** 带正文、标签或属性值的写命令：目标不能确认是公开 id 时绝不发给服务器。 */
const CONTENT_COMMANDS = new Set(["update_fragment", "update_fragment_tags", "set_fragment_property", "remove_fragment_property"])

type Args = Record<string, unknown>

export interface LockboxRouterDeps {
  server: ServerChannel
  engine: () => LockboxEngine
  /** 把快照变化以 `vault-changed` 推给界面（与服务器推来的同形）。 */
  emitVaultChanged: (payload: { vault: string; changes: LockboxFileChange[] }) => void
  /** 订阅「密匣可能变了」：服务器推来 `lockbox-changed`（带这次的 `seq`），以及重连、游标过旧（没有 seq）。 */
  onLockboxChanged: (handler: (seq?: number) => void) => void
  /** 验证一次通行密钥：浏览器会话写 manifest 要求最近验证过。 */
  stepUp?: () => Promise<void>
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

function isFragment(value: unknown): value is Fragment {
  return typeof value === "object" && value !== null && typeof (value as Fragment).id === "string" && "lockbox" in value
}

export function createLockboxRouter(deps: LockboxRouterDeps) {
  let vaultPath = ""
  const publicIds = new Map<string, string>()
  /** 交给界面显示过的密匣条目（id → 路径）：被迫上锁时据此让界面藏起它们。 */
  const shown = new Map<string, string>()
  let engine: LockboxEngine | null = null
  const client = new LockboxClient(
    {
      call: (method, args) => (engine ??= deps.engine()).call(method, args),
      reset: () => engine?.reset(),
    },
    deps.server,
    {
      onChanges: (changes) => deps.emitVaultChanged({ vault: vaultPath, changes }),
      onLockedOut: lockedOut,
      stepUp: deps.stepUp,
    }
  )

  deps.onLockboxChanged((seq) => client.remoteChanged(seq))

  /** 被迫上锁：让界面把显示过的密匣条目当作已删除（重读列表时它们不再出现），并派发事件给想立即收起编辑器的界面。 */
  function lockedOut(reason: LockOutReason) {
    const changes = [...shown.values()].map((path) => ({ path, exists: false, sha: null }))
    shown.clear()
    if (changes.length > 0) deps.emitVaultChanged({ vault: vaultPath, changes })
    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(LOCKBOX_LOCKED_OUT_EVENT, { detail: { reason } }))
  }

  /** 交给界面的密匣碎片：记住 id（只增不减）与路径。 */
  function noteShown<T>(value: T): T {
    const fragments = Array.isArray(value) ? value : [value]
    for (const fragment of fragments) {
      if (isFragment(fragment) && fragment.lockbox) {
        client.remember(fragment.id)
        shown.set(fragment.id, fragment.path)
      }
    }
    return value
  }

  const server = <T>(command: string, args: Args) => deps.server.call<T>(command, args)

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
    publicIds.clear()
    for (const fragment of state.fragments) {
      if (!fragment.lockbox) publicIds.set(fragment.id, fragment.path)
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
    if (client.unlocked) lockbox = noteShown(await client.read<Fragment[]>("list"))
    return {
      ...state,
      fragments: lockbox.length > 0 ? sortFragmentList([...state.fragments, ...lockbox]) : state.fragments,
      lockbox: client.lockboxState(state.lockbox),
    }
  }

  /** 这个 id 是不是公开碎片 / 笔记：以服务器的公开列表为准，不在就重读一次。 */
  async function publicPath(id: string) {
    if (!publicIds.has(id)) notePublic(await serverOrDetail<VaultState>("list_fragments", {}))
    return publicIds.get(id) ?? null
  }

  /** 密匣条目的写命令：只在本地执行；wasm 找不到它（快照被扣下、刚重建）也不退回服务器。 */
  async function lockboxItem(command: string, args: Args) {
    const result = await client.run<Fragment>(ITEM_COMMANDS[command], args, { renew: true })
    if (result === FORWARD) throw "lockbox_locked"
    return noteShown(result)
  }

  /** 公开碎片的保存带上了密匣标签：桌面把整篇移入密匣。正文与标签不发给服务器。 */
  async function saveIntoLockbox(command: string, args: Args) {
    const id = String(args.id ?? "")
    const path = await publicPath(id)
    if (!path) throw `找不到片段 ${id}`
    const { text } = await deps.server.fetchText(path).catch((failure) => {
      throw isServerFailure(failure) ? failure.detail : failure
    })
    const result = await client.run<Fragment>(
      "update_public",
      { ...args, path, text, tagsOnly: command === "update_fragment_tags" },
      { renew: true }
    )
    // wasm 确认规整后的标签里没有密匣：这是一次普通的公开保存。
    return result === FORWARD ? serverOrDetail(command, args) : noteShown(result)
  }

  /** 只带 id、不带内容的写命令（置顶、回收）：不认识的 id 照常发给服务器；服务器说是密匣条目就重取快照再在本地执行。 */
  async function publicOrLockbox(command: string, args: Args) {
    try {
      return await server(command, args)
    } catch (failure) {
      if (!isServerFailure(failure) || failure.code !== "LOCKBOX_UNAVAILABLE") {
        throw isServerFailure(failure) ? failure.detail : failure
      }
      await client.refresh()
      if (client.isLockboxId(args.id)) return lockboxItem(command, args)
      throw "lockbox_locked"
    }
  }

  /** 碎片写命令的分流。 */
  async function itemWrite(command: string, args: Args) {
    const id = args.id
    if (client.isLockboxId(id)) return lockboxItem(command, args)
    if (!CONTENT_COMMANDS.has(command)) return publicOrLockbox(command, args)
    if ((command === "update_fragment" || command === "update_fragment_tags") && mentionsLockbox(args.tags)) {
      return saveIntoLockbox(command, args)
    }
    if (typeof id === "string" && (await publicPath(id))) return serverOrDetail(command, args)
    // 既不是已知的密匣条目，也不在公开列表里：重取密匣快照再判断；仍不属于本地就拒绝，内容不发给服务器。
    await client.refresh()
    if (client.isLockboxId(id)) return lockboxItem(command, args)
    throw "lockbox_locked"
  }

  async function vaultWithRecoveryKey(method: string, args: Args) {
    const result = (await client.run<{ recoveryKey: string }>(method, args, { unlocks: true, stepUp: true })) as {
      recoveryKey: string
    }
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
        // 解锁时顺带的 manifest 升级是尽力而为：写不回去就保持已解锁、下次解锁再升级。
        await client.run("unlock", { password: args.password }, { unlocks: true, bestEffort: true })
        // 旧条目的服务器路径还带着标题：迁到只由 id 推出的路径（同样尽力而为）。
        if (client.unlocked) await client.run("conceal", {}, { bestEffort: true }).catch(() => undefined)
        return listFragments()
      case "change_lockbox_password":
        await client.run(
          "change_password",
          { currentPassword: args.currentPassword, newPassword: args.newPassword },
          { unlocks: true, stepUp: true }
        )
        return listFragments()
      case "lock_lockbox":
        shown.clear()
        await client.lock()
        return listFragments()
      case "list_lockbox_dialect_migration":
        return client.read("dialect_list", {}, { renew: true })
      case "apply_lockbox_dialect_migration":
        return client.run("dialect_apply", { files: args.files }, { renew: true })
      case "create_fragment": {
        if (!mentionsLockbox(args.tags)) return serverOrDetail(command, args)
        const result = await client.run<Fragment>("create", args, { renew: true })
        return result === FORWARD ? serverOrDetail(command, args) : noteShown(result)
      }
      case "update_fragment":
      case "update_fragment_tags":
      case "set_fragment_pinned":
      case "set_fragment_archived":
      case "set_fragment_property":
      case "remove_fragment_property":
        return itemWrite(command, args)
      case "move_fragment_to_lockbox": {
        const id = String(args.id ?? "")
        const path = await publicPath(id)
        if (!path) throw `找不到片段 ${id}`
        const { text } = await deps.server.fetchText(path).catch((failure) => {
          throw isServerFailure(failure) ? failure.detail : failure
        })
        noteShown(await client.run("move_public", { id, path, text }, { renew: true }))
        return listFragments()
      }
      case "search_vault":
      case "read_search_target":
        return search(command, args)
      default:
        return serverOrDetail(command, args)
    }
  }

  /** 公开范围照常问服务器；密匣范围只在客户端内存里搜（服务器的密匣范围一律 locked），查询词也不发出去。 */
  async function search(command: string, args: Args) {
    const request = (args.request ?? {}) as { scope?: string; target?: { scope?: string } }
    const scope = command === "search_vault" ? request.scope : request.target?.scope
    if (scope !== "lockbox") return serverOrDetail(command, args)
    if (!client.unlocked) throw { code: "locked" }
    const reading = command === "read_search_target"
    // 桌面：搜索只看租约不续租，打开一条结果续租。
    const response = await client.read<Record<string, unknown>>(
      reading ? "read_search_target" : "search",
      { vaultPath, request: args.request },
      { renew: reading }
    )
    if (reading) noteShown(response.fragment)
    return { ...response, expiresAt: client.expiresAtIso() }
  }

  return {
    invoke,
    client,
    /** 账号设置里改了「允许在网页解锁密匣」：写服务器后重取快照，关掉时本页立即上锁。 */
    async setWebUnlock(allowed: boolean) {
      await server("set_lockbox_web_unlock", { allowed })
      await client.refresh()
    },
    /** 网页解锁开关的当前值（会拉一次快照概要）。 */
    async webUnlock() {
      await client.ensureLoaded()
      return client.webUnlock
    },
    /** Worker 崩溃。 */
    forget: () => client.forget(),
    refresh: () => client.refresh(),
  }
}

export type LockboxRouter = ReturnType<typeof createLockboxRouter>
