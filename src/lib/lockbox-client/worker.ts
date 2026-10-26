/**
 * 密匣 Worker：加载 `shard-lockbox-wasm`（scripts/build-lockbox-wasm.sh 生成到 ./wasm/，不进 Git），
 * 持有唯一一个 `LockboxSession`。消息只有一种：`{ id, method, args }` → `{ id, reply }`。
 *
 * 用 `import.meta.glob` 引胶水：没有构建 wasm 时 tsc 与 vite 照常通过，运行到这里才给出构建提示
 * （`pnpm dev` / `pnpm build` 会先构建，正常不会走到）。
 */

interface WasmSession {
  call(method: string, args: string): string
}

interface WasmModule {
  default(input?: { module_or_path?: string | URL }): Promise<unknown>
  LockboxSession: new () => WasmSession
}

const glue = import.meta.glob<WasmModule>("./wasm/shard_lockbox_wasm.js", { eager: true })
const binary = import.meta.glob<string>("./wasm/shard_lockbox_wasm_bg.wasm", {
  eager: true,
  import: "default",
  query: "?url",
})

const MISSING_WASM =
  "网页端的密匣组件还没有构建。请在仓库根目录运行 scripts/build-lockbox-wasm.sh（需要 rustup target add wasm32-unknown-unknown，以及 cargo install wasm-bindgen-cli --version 0.2.122 --locked），再刷新页面。"

let session: WasmSession | null = null
let ready: Promise<WasmSession> | null = null

async function load(): Promise<WasmSession> {
  const module = Object.values(glue)[0]
  const url = Object.values(binary)[0]
  if (!module || !url) throw new Error(MISSING_WASM)
  await module.default({ module_or_path: url })
  session = new module.LockboxSession()
  return session
}

/** Worker 全局（不引 webworker lib：它与 DOM lib 同时加载会冲突）。 */
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<{ id: number; method: string; args: string }>) => void) | null
  postMessage(message: unknown): void
}

scope.onmessage = async (event: MessageEvent<{ id: number; method: string; args: string }>) => {
  const { id, method, args } = event.data
  try {
    ready ??= load()
    const current = session ?? (await ready)
    scope.postMessage({ id, reply: current.call(method, args) })
  } catch (error) {
    // 加载失败或 wasm 崩溃（panic 之后实例不可再用）：交给主线程丢掉整个 Worker。
    ready = null
    session = null
    scope.postMessage({ id, crash: error instanceof Error ? error.message : String(error) })
  }
}
