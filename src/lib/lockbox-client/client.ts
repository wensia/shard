import type { ServerChannel, ServerFailure } from "@/lib/transport"
import type { LockboxState } from "@/types"

import type { LockboxEngine } from "./engine"

/**
 * 网页端的密匣会话外壳：桌面 src-tauri 的 `LockboxRuntime` 在浏览器里的对应物。
 *
 * - 会话（内存资料库、基线、主密钥）在 wasm 里（{@link LockboxEngine}），这里只管网络、租约与排队。
 * - 写命令在 wasm 里算出要写什么，这里交给服务器（`lockbox_apply` / `seal_fragment_into_lockbox`），
 *   确认后 `commit` 推进基线；409 等失败时回滚并重取快照，STALE_BASE 原样交给界面现有的冲突流程。
 * - 租约：解锁后 15 分钟，写入与打开搜索结果时续租（与桌面同一组续租点），过期即上锁。标签页隐藏不上锁。
 * - 全部命令排成一队（相当于桌面的写门），不会有两个写入同时在途。
 */

/** 桌面 `LOCKBOX_TTL`。 */
export const LOCKBOX_TTL_MS = 15 * 60 * 1000

/** wasm 判断这不是密匣命令：调用方原样交给服务器。 */
export const FORWARD = Symbol("forward")

export interface LockboxSessionState {
  loaded: boolean
  configured: boolean
  unlocked: boolean
  webUnlock: boolean
  itemsWithheld: boolean
  itemIds: string[]
  privacyEpoch: string
  pending: boolean
}

/** `vault-changed` 同形的一条变化。 */
export interface LockboxFileChange {
  path: string
  exists: boolean
  sha: string | null
}

export function isServerFailure(value: unknown): value is ServerFailure {
  return typeof value === "object" && value !== null && "status" in value && "detail" in value
}

interface WritePayload {
  apply: Record<string, unknown> | null
  seal: Record<string, unknown> | null
}

interface OpReply<T> {
  forward?: true
  result?: T
  write?: WritePayload | null
}

export interface LockboxClientOptions {
  now?: () => number
  /** 快照有变化（别的设备 / 标签页写了密匣）：`vault-changed` 同形，界面据此刷新。 */
  onChanges?: (changes: LockboxFileChange[]) => void
}

function describe(failure: unknown) {
  return isServerFailure(failure) ? failure.detail : failure
}

export class LockboxClient {
  private state: LockboxSessionState | null = null
  private expiresAt: number | null = null
  private expiryTimer: ReturnType<typeof setTimeout> | null = null
  private tail: Promise<unknown> = Promise.resolve()
  private readonly now: () => number

  constructor(
    private readonly engine: LockboxEngine,
    private readonly server: ServerChannel,
    private readonly options: LockboxClientOptions = {}
  ) {
    this.now = options.now ?? Date.now
  }

  get loaded() {
    return Boolean(this.state?.loaded)
  }

  /** wasm 里有没有解锁（不看租约；租约过期会在下一次调用前上锁）。 */
  get unlocked() {
    return Boolean(this.state?.unlocked)
  }

  get configured() {
    return Boolean(this.state?.configured)
  }

  /** 服务器上的「允许在网页解锁密匣」设置（快照没载入时为 undefined）。 */
  get webUnlock() {
    return this.state?.webUnlock
  }

  /** 这个客户端能不能解锁：服务器只对浏览器会话扣下密文（网页解锁关掉时）；桌面连服务器不受影响。 */
  get unlockAllowed() {
    return this.state ? !this.state.itemsWithheld : undefined
  }

  owns(id: unknown) {
    return typeof id === "string" && Boolean(this.state?.itemIds.includes(id))
  }

  /** Worker 崩溃：会话与密钥都没了，按未载入处理。 */
  forget() {
    this.state = null
    this.clearLease()
  }

  /** 排队执行：同一时间只有一个会话操作在途。 */
  private serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.tail.then(task, task)
    this.tail = run.catch(() => undefined)
    return run
  }

  private engineCall<T>(method: string, args: Record<string, unknown> = {}) {
    const now = this.now()
    return this.engine.call<T>(method, {
      ...args,
      clock: { nowMs: now, utcOffsetMinutes: -new Date(now).getTimezoneOffset() },
    })
  }

  private adopt(state: LockboxSessionState) {
    this.state = state
    if (!state.unlocked) this.clearLease()
  }

  private async loadSnapshot() {
    const wasUnlocked = this.unlocked
    const snapshot = await this.server.call<unknown>("lockbox_snapshot", {})
    const reply = await this.engineCall<{ state: LockboxSessionState; changes: LockboxFileChange[] }>("load", { snapshot })
    this.adopt(reply.state)
    if (reply.changes.length > 0 && (wasUnlocked || this.unlocked)) this.options.onChanges?.(reply.changes)
    return reply.state
  }

  ensureLoaded() {
    if (this.loaded) return Promise.resolve()
    return this.serial(async () => {
      if (!this.loaded) await this.loadSnapshot()
    })
  }

  /** 重取快照（SSE `lockbox-changed`、重连、409 之后）。 */
  refresh() {
    return this.serial(() => this.loadSnapshot())
  }

  // ---- 租约 ----

  private leaseValid() {
    return this.expiresAt !== null && this.now() < this.expiresAt
  }

  private clearLease() {
    this.expiresAt = null
    if (this.expiryTimer !== null) clearTimeout(this.expiryTimer)
    this.expiryTimer = null
  }

  private renew() {
    if (!this.unlocked) return
    this.clearLease()
    this.expiresAt = this.now() + LOCKBOX_TTL_MS
    this.expiryTimer = setTimeout(() => {
      void this.serial(() => this.expireIfNeeded()).catch(() => undefined)
    }, LOCKBOX_TTL_MS + 50)
  }

  /** 桌面 `expire_session_if_needed`：租约到期就上锁、清掉密钥。 */
  private async expireIfNeeded() {
    if (this.unlocked && !this.leaseValid()) this.adopt(await this.engineCall<LockboxSessionState>("lock"))
  }

  /** 给界面的 `LockboxState`：`configured` 以服务器为准，解锁状态与到期时间来自这里的租约。 */
  lockboxState(server: LockboxState): LockboxState {
    const unlocked = Boolean(server.configured && this.unlocked && this.leaseValid())
    return {
      ...server,
      unlocked,
      expiresAt: unlocked && this.expiresAt !== null ? new Date(this.expiresAt).toISOString() : null,
      webUnlock: this.unlockAllowed ?? server.webUnlock,
    }
  }

  expiresAtIso() {
    return this.unlocked && this.expiresAt !== null ? new Date(this.expiresAt).toISOString() : null
  }

  // ---- 命令 ----

  /**
   * 执行一个会话命令。`renew`：已解锁时先续租（桌面取读取密钥时续租的那些命令）；`unlocks`：成功后开始新租约
   * （设置、解锁、改口令、重置），写回服务器失败时上锁。返回 {@link FORWARD} 表示这不是密匣命令。
   */
  run<T>(method: string, args: Record<string, unknown>, options: { renew?: boolean; unlocks?: boolean } = {}) {
    return this.serial(async (): Promise<T | typeof FORWARD> => {
      if (!this.loaded) await this.loadSnapshot()
      await this.expireIfNeeded()
      if (options.renew) this.renew()
      const reply = await this.engineCall<OpReply<T>>(method, args)
      if (reply.forward) return FORWARD
      try {
        if (reply.write) await this.push(reply.write)
        else this.adopt(await this.engineCall<LockboxSessionState>("state"))
      } catch (error) {
        if (options.unlocks) this.adopt(await this.engineCall<LockboxSessionState>("lock"))
        throw error
      }
      if (options.unlocks) this.renew()
      return reply.result as T
    })
  }

  /** 只读命令（列表、方言迁移列表、搜索）：不写服务器。 */
  read<T>(method: string, args: Record<string, unknown> = {}, options: { renew?: boolean } = {}) {
    return this.serial(async () => {
      if (!this.loaded) await this.loadSnapshot()
      await this.expireIfNeeded()
      if (options.renew) this.renew()
      return this.engineCall<T>(method, args)
    })
  }

  lock() {
    return this.serial(async () => {
      if (!this.loaded) return
      this.adopt(await this.engineCall<LockboxSessionState>("lock"))
      this.clearLease()
    })
  }

  private async push(write: WritePayload) {
    let apply: unknown = null
    let seal: unknown = null
    try {
      if (write.apply) apply = await this.server.call("lockbox_apply", write.apply)
      if (write.seal) seal = await this.server.call("seal_fragment_into_lockbox", write.seal)
    } catch (failure) {
      await this.engineCall("rollback")
      // 409（别处改过）、部分写入或结果不明：以服务器为准重取快照，再把原错误交给界面。
      await this.loadSnapshot().catch(() => undefined)
      throw describe(failure)
    }
    this.adopt(await this.engineCall<LockboxSessionState>("commit", { apply, seal }))
  }
}
