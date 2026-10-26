/**
 * 密匣引擎：wasm 会话跑在专用 Web Worker 里（设置密匣时生成 RSA 密钥对约 1 秒，解锁的 Argon2 约 20 ms，
 * 都不能占主线程）。主线程只拿到结果 JSON，主密钥只在 Worker 的 wasm 内存里。
 */

export interface LockboxEngine {
  /** 执行一个会话命令。领域错误 reject 成字符串（与桌面同一句），搜索错误 reject 成 `{ code }` 对象。 */
  call<T>(method: string, args: Record<string, unknown>): Promise<T>
  /** 丢掉会话（Worker 出错时）：密钥随之消失，下一次调用重新开一个。 */
  reset(): void
}

interface WorkerReply {
  id: number
  /** `LockboxSession.call` 的原样返回：`{ ok }`、`{ error }` 或 `{ searchError }`。 */
  reply?: string
  /** wasm 加载失败或崩溃（panic）。 */
  crash?: string
}

type Waiter = { resolve: (value: unknown) => void; reject: (reason: unknown) => void }

export const LOCKBOX_ENGINE_CRASHED = "密匣组件出错，已自动上锁。请刷新页面后重试。"

export function createWorkerEngine(onCrash: () => void): LockboxEngine {
  let worker: Worker | null = null
  let nextId = 0
  const waiting = new Map<number, Waiter>()

  function failAll(reason: string) {
    for (const waiter of waiting.values()) waiter.reject(reason)
    waiting.clear()
  }

  function reset() {
    worker?.terminate()
    worker = null
  }

  function crash(reason: string) {
    failAll(reason)
    reset()
    onCrash()
  }

  function spawn() {
    const next = new Worker(new URL("./worker.ts", import.meta.url), { type: "module", name: "shard-lockbox" })
    next.onmessage = (event: MessageEvent<WorkerReply>) => {
      const { id, reply, crash: crashed } = event.data
      const waiter = waiting.get(id)
      waiting.delete(id)
      if (crashed !== undefined) {
        waiter?.reject(crashed)
        crash(crashed)
        return
      }
      if (!waiter) return
      const parsed = JSON.parse(reply ?? "{}") as { ok?: unknown; error?: string; searchError?: unknown }
      if ("ok" in parsed) waiter.resolve(parsed.ok)
      else if (parsed.searchError !== undefined) waiter.reject(parsed.searchError)
      else waiter.reject(parsed.error ?? LOCKBOX_ENGINE_CRASHED)
    }
    next.onerror = (event) => {
      event.preventDefault()
      crash(LOCKBOX_ENGINE_CRASHED)
    }
    return next
  }

  return {
    call<T>(method: string, args: Record<string, unknown>) {
      worker ??= spawn()
      const id = (nextId += 1)
      const target = worker
      return new Promise<T>((resolve, reject) => {
        waiting.set(id, { resolve: resolve as (value: unknown) => void, reject })
        target.postMessage({ id, method, args: JSON.stringify(args) })
      })
    },
    reset() {
      failAll(LOCKBOX_ENGINE_CRASHED)
      reset()
    },
  }
}
