import { isServerBacked, transport, type ShardTransport } from "@/lib/transport"

import type { LockboxFileChange } from "./client"
import { createWorkerEngine } from "./engine"
import { createLockboxRouter, LOCKBOX_ROUTED_COMMANDS, type LockboxRouter } from "./router"

/** 套了密匣客户端的传输：另能取到它的密匣分流（账号设置里的网页解锁开关要用）。 */
export interface LockboxTransport extends ShardTransport {
  lockbox(): LockboxRouter | null
}

/**
 * 给任意以服务器为真相的传输（`base.server` 存在）套上密匣客户端：密匣相关命令在浏览器 / 客户端里（wasm）
 * 执行，再经 `base.server` 把密文写回服务器；其余命令原样交给 `base`。网页套在 HTTP 传输上；S8a 的桌面
 * 「连接服务器」套在经 Tauri 转发的传输上。
 *
 * 是否分流看 {@link isServerBacked}（数据路径），不看是不是浏览器。密匣快照的变化以 `vault-changed` 同形
 * 推给经本传输 `listen("vault-changed")` 的订阅者。
 */
export function withLockboxClient(base: ShardTransport): LockboxTransport {
  const vaultHandlers = new Set<(payload: unknown) => void>()
  let router: LockboxRouter | null = null

  function lockbox(): LockboxRouter | null {
    if (router) return router
    const server = base.server
    if (!server || !isServerBacked()) return null
    const created = createLockboxRouter({
      server,
      engine: () => createWorkerEngine(() => created.forget()),
      emitVaultChanged: (payload: { vault: string; changes: LockboxFileChange[] }) => {
        for (const handler of vaultHandlers) handler(payload)
      },
      onLockboxChanged: (handler) => {
        void base.listen("lockbox-changed", handler)
      },
    })
    router = created
    return created
  }

  return {
    get kind() {
      return base.kind
    },
    get server() {
      return base.server
    },
    invoke<T>(command: string, args?: Record<string, unknown>) {
      const routed = LOCKBOX_ROUTED_COMMANDS.has(command) ? lockbox() : null
      return routed ? (routed.invoke(command, args ?? {}) as Promise<T>) : base.invoke<T>(command, args)
    },
    invokeBytes: (command, body, headers) => base.invokeBytes(command, body, headers),
    async listen<T>(event: string, handler: (payload: T) => void) {
      const dispose = await base.listen(event, handler)
      if (event !== "vault-changed") return dispose
      const local = handler as (payload: unknown) => void
      vaultHandlers.add(local)
      return () => {
        vaultHandlers.delete(local)
        dispose()
      }
    },
    fileUrl: (reference) => base.fileUrl(reference),
    lockbox,
  }
}

/** 当前传输的密匣分流；不以服务器为真相（桌面本地模式）时为 null。 */
export function serverLockbox(): LockboxRouter | null {
  if (!isServerBacked()) return null
  return (transport() as Partial<LockboxTransport>).lockbox?.() ?? null
}
