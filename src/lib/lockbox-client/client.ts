import type { ServerChannel, ServerFailure } from "@/lib/transport"
import type { LockboxState } from "@/types"

import type { LockboxEngine } from "./engine"

/**
 * 以服务器为真相时的密匣会话外壳：桌面 src-tauri 的 `LockboxRuntime` 在浏览器 / 桌面远程模式里的对应物。
 *
 * - 会话（内存资料库、基线、主密钥）在 wasm 里（{@link LockboxEngine}，跑在 Worker 里），这里只管网络、租约与排队。
 * - 写命令在 wasm 里算出要写什么，这里交给服务器（`lockbox_apply` / `seal_fragment_into_lockbox`），
 *   确认后 `commit` 推进基线；409 等失败时回滚并重取快照，STALE_BASE 原样交给界面现有的冲突流程。
 * - 租约：解锁后 15 分钟，写入与打开搜索结果时续租（与桌面同一组续租点），过期即上锁。标签页隐藏不上锁。
 * - 上锁（用户上锁、租约到期、服务器扣下信封、Worker 崩溃）一律丢掉整个 Worker：主密钥随 wasm 内存一起消失，
 *   下次要用时重新加载。不是用户主动上锁时经 `onLockedOut` 通知界面藏起密匣内容。
 * - 见过的密匣 id 只增不减（{@link LockboxClient.isLockboxId}）：Worker 没了、快照被扣下时也还记得哪些 id
 *   属于密匣，这些 id 的写命令绝不转发服务器。
 * - 全部命令排成一队（相当于桌面的写门），不会有两个写入同时在途。
 */

/** 桌面 `LOCKBOX_TTL`。 */
export const LOCKBOX_TTL_MS = 15 * 60 * 1000

/** wasm 判断这不是密匣命令：调用方原样交给服务器。 */
export const FORWARD = Symbol("forward")

/** 服务器扣下信封或拒绝浏览器会话写 manifest 时给界面的话（与 wasm 里的同一句）。 */
export const WEB_UNLOCK_DISABLED_MESSAGE =
  "网页解锁已关闭：可在账号设置里打开「允许在网页解锁密匣」，或到桌面应用里使用密匣。"

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

/** 不是用户主动上锁：Worker 崩溃、服务器扣下了信封（网页解锁被关）、租约到期。 */
export type LockOutReason = "crashed" | "withheld" | "expired"

interface Snapshot {
  configured?: boolean
  manifest?: unknown
  items?: Array<{ id?: unknown }>
  itemsWithheld?: boolean
  webUnlock?: boolean
  lockboxSeq?: number
}

interface SnapshotMeta {
  configured: boolean
  webUnlock: boolean
  itemsWithheld: boolean
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

export interface RunOptions {
  /** 已解锁时先续租（桌面取读取密钥时续租的那些命令）。 */
  renew?: boolean
  /** 成功后开始新租约（设置、解锁、改口令、重置）。 */
  unlocks?: boolean
  /** 写回服务器失败时不报错：回滚、保持现状（解锁时顺带的 manifest 升级、旧条目路径迁移）。 */
  bestEffort?: boolean
  /** 写 manifest 遇到 STEP_UP_REQUIRED 时验证一次通行密钥再试（设置、改口令、重置）。 */
  stepUp?: boolean
}

export interface LockboxClientOptions {
  now?: () => number
  /** 快照有变化（别的设备 / 标签页写了密匣）：`vault-changed` 同形，界面据此刷新。 */
  onChanges?: (changes: LockboxFileChange[]) => void
  /** 不是用户主动上锁：界面该藏起已显示的密匣内容。 */
  onLockedOut?: (reason: LockOutReason) => void
  /** 验证一次通行密钥（网页端是 `webauthn.stepUp`）。 */
  stepUp?: () => Promise<void>
  /** `lockbox-changed` 的防抖（毫秒）。 */
  refreshDelayMs?: number
}

function describe(failure: unknown) {
  if (isServerFailure(failure)) {
    return failure.code === "LOCKBOX_WEB_DISABLED" ? WEB_UNLOCK_DISABLED_MESSAGE : failure.detail
  }
  return failure
}

export class LockboxClient {
  /** wasm 会话（Worker 活着时）。 */
  private session: LockboxSessionState | null = null
  /** 最近一份快照的概要：Worker 丢掉后也留着（界面要知道密匣设置过没有、网页能不能解锁）。 */
  private meta: SnapshotMeta | null = null
  private readonly known = new Set<string>()
  /** 最近一份快照对应的密匣 seq，以及之后自己写入的 seq：`lockbox-changed` 带的 seq 在其中就是回声。 */
  private snapshotSeq: number | null = null
  private readonly ownSeqs = new Set<number>()
  private pendingSeqs = new Set<number>()
  private pendingUnknown = false
  private refreshTimer: ReturnType<typeof setTimeout> | null = null
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

  /** 快照概要已知（不代表 Worker 在跑）。 */
  get loaded() {
    return this.meta !== null
  }

  /** 已解锁且租约有效。 */
  get unlocked() {
    return Boolean(this.session?.unlocked) && this.leaseValid()
  }

  get configured() {
    return Boolean(this.meta?.configured)
  }

  /** 服务器上的「允许在网页解锁密匣」设置（快照没载入时为 undefined）。 */
  get webUnlock() {
    return this.meta?.webUnlock
  }

  /** 这个客户端能不能解锁：服务器只对浏览器会话扣下密文（网页解锁关掉时）；桌面连服务器不受影响。 */
  get unlockAllowed() {
    return this.meta ? !this.meta.itemsWithheld : undefined
  }

  /** 这个 id 是（或曾经是）密匣条目：写命令绝不转发服务器。 */
  isLockboxId(id: unknown) {
    return typeof id === "string" && this.known.has(id)
  }

  remember(id: string) {
    this.known.add(id)
  }

  /** Worker 崩溃：会话与密钥都没了。 */
  forget() {
    const wasActive = this.session !== null
    this.session = null
    this.clearLease()
    if (wasActive) this.options.onLockedOut?.("crashed")
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
    this.session = state
    for (const id of state.itemIds) this.known.add(id)
    if (!state.unlocked) this.clearLease()
  }

  private async fetchSnapshot() {
    const snapshot = await this.server.call<Snapshot>("lockbox_snapshot", {})
    this.meta = {
      configured: snapshot.configured ?? Boolean(snapshot.manifest),
      webUnlock: snapshot.webUnlock !== false,
      itemsWithheld: Boolean(snapshot.itemsWithheld),
    }
    for (const item of snapshot.items ?? []) {
      if (typeof item.id === "string") this.known.add(item.id)
    }
    if (typeof snapshot.lockboxSeq === "number") {
      this.snapshotSeq = snapshot.lockboxSeq
      for (const seq of this.ownSeqs) if (seq <= snapshot.lockboxSeq) this.ownSeqs.delete(seq)
    }
    return snapshot
  }

  /** 拉快照并载入 wasm（会启动 Worker）。原来解锁、载入后锁了（快照被扣下、密钥对不上）就整个丢掉。 */
  private async loadSession() {
    const wasUnlocked = Boolean(this.session?.unlocked)
    const snapshot = await this.fetchSnapshot()
    const reply = await this.engineCall<{ state: LockboxSessionState; changes: LockboxFileChange[] }>("load", { snapshot })
    this.adopt(reply.state)
    if (wasUnlocked && !reply.state.unlocked) {
      this.lockOut("withheld")
      return
    }
    if (reply.changes.length > 0 && reply.state.unlocked) this.options.onChanges?.(reply.changes)
  }

  /** 只要快照概要（列表合并、网页解锁开关）：没有就拉一次，不启动 Worker。 */
  ensureLoaded() {
    if (this.loaded) return Promise.resolve()
    return this.serial(async () => {
      if (!this.loaded) await this.fetchSnapshot()
    })
  }

  /** 重取快照：Worker 在跑就载入 wasm（有变化通知界面，被扣下就上锁），否则只更新概要。 */
  refresh() {
    return this.serial(async () => {
      if (this.session) await this.loadSession()
      else await this.fetchSnapshot()
    })
  }

  /**
   * 服务器推来 `lockbox-changed`。`seq` 是那次提交的密匣 seq：已含在最近的快照里、或就是自己写入的回声时
   * 不必重取；没有 seq（重连、游标过旧、开关变化）一律重取。多次推送合并成一次。
   */
  remoteChanged(seq?: number) {
    if (typeof seq === "number") this.pendingSeqs.add(seq)
    else this.pendingUnknown = true
    if (this.refreshTimer !== null) clearTimeout(this.refreshTimer)
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null
      void this.serial(async () => {
        const unknown = this.pendingUnknown
        const seqs = [...this.pendingSeqs]
        this.pendingUnknown = false
        this.pendingSeqs = new Set()
        if (!this.loaded) return
        const covered = (value: number) => this.ownSeqs.has(value) || (this.snapshotSeq !== null && value <= this.snapshotSeq)
        if (!unknown && seqs.every(covered)) return
        if (this.session) await this.loadSession()
        else await this.fetchSnapshot()
      }).catch(() => undefined)
    }, this.options.refreshDelayMs ?? 200)
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
    if (!this.session?.unlocked) return
    this.clearLease()
    this.expiresAt = this.now() + LOCKBOX_TTL_MS
    this.expiryTimer = setTimeout(() => {
      void this.serial(async () => this.expireIfNeeded()).catch(() => undefined)
    }, LOCKBOX_TTL_MS + 50)
  }

  /** 桌面 `expire_session_if_needed`：租约到期就上锁（丢掉 Worker）。 */
  private expireIfNeeded() {
    if (this.session?.unlocked && !this.leaseValid()) this.lockOut("expired")
  }

  /** 丢掉 Worker（主密钥随之消失）。不是用户主动上锁时通知界面。 */
  private lockOut(reason: LockOutReason | null) {
    this.engine.reset()
    this.session = null
    this.clearLease()
    if (reason) this.options.onLockedOut?.(reason)
  }

  /** 给界面的 `LockboxState`：`configured` 以服务器为准，解锁状态与到期时间来自这里的租约。 */
  lockboxState(server: LockboxState): LockboxState {
    const unlocked = Boolean(server.configured && this.unlocked)
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

  /** 执行一个会话命令（需要时启动 Worker、载入快照）。返回 {@link FORWARD} 表示这不是密匣命令。 */
  run<T>(method: string, args: Record<string, unknown>, options: RunOptions = {}) {
    return this.serial(async (): Promise<T | typeof FORWARD> => {
      this.expireIfNeeded()
      if (!this.session) await this.loadSession()
      if (options.renew) this.renew()
      const reply = await this.engineCall<OpReply<T>>(method, args)
      if (reply.forward) return FORWARD
      if (reply.write) await this.push(reply.write, options)
      else this.adopt(await this.engineCall<LockboxSessionState>("state"))
      if (options.unlocks) this.renew()
      return reply.result as T
    })
  }

  /** 只读命令（列表、方言迁移列表、搜索）：不写服务器。 */
  read<T>(method: string, args: Record<string, unknown> = {}, options: { renew?: boolean } = {}) {
    return this.serial(async () => {
      this.expireIfNeeded()
      if (!this.session) await this.loadSession()
      if (options.renew) this.renew()
      return this.engineCall<T>(method, args)
    })
  }

  /** 用户上锁：丢掉 Worker。 */
  lock() {
    return this.serial(async () => {
      this.lockOut(null)
    })
  }

  private async apply(args: Record<string, unknown>, stepUp: boolean) {
    try {
      return await this.server.call<Record<string, unknown>>("lockbox_apply", args)
    } catch (failure) {
      if (!stepUp || !this.options.stepUp || !isServerFailure(failure) || failure.code !== "STEP_UP_REQUIRED") throw failure
      await this.options.stepUp()
      return this.server.call<Record<string, unknown>>("lockbox_apply", args)
    }
  }

  private async push(write: WritePayload, options: RunOptions) {
    let apply: Record<string, unknown> | null = null
    let seal: Record<string, unknown> | null = null
    try {
      if (write.apply) apply = await this.apply(write.apply, Boolean(options.stepUp))
      if (write.seal) seal = await this.server.call<Record<string, unknown>>("seal_fragment_into_lockbox", write.seal)
    } catch (failure) {
      this.adopt(await this.engineCall<LockboxSessionState>("rollback"))
      // 409（别处改过）、部分写入或结果不明：以服务器为准重取快照，再把原错误交给界面。
      await this.loadSession().catch(() => undefined)
      if (options.bestEffort) return
      throw describe(failure)
    }
    for (const response of [apply, seal]) {
      if (typeof response?.lockboxSeq === "number") this.ownSeqs.add(response.lockboxSeq)
    }
    this.adopt(await this.engineCall<LockboxSessionState>("commit", { apply, seal }))
  }
}
