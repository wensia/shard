import { invoke, isTauri } from "@tauri-apps/api/core"

import { withLockboxClient } from "@/lib/lockbox-client/transport"
import { initIOSNative } from "@/lib/ios-native"

import { createDesktopRemoteTransport, startRemoteConnectionTracking, type RemoteStatus } from "./desktop-remote"
import { httpTransport } from "./http"
import { tauriTransport } from "./tauri"

/**
 * 前端与后端之间唯一的通道。
 *
 * - 桌面（`tauri-remote`）：数据命令经 Rust 带设备令牌转发到 VPS，与网页同一套命令；
 *   本机能力（导出、红绿灯、Dock、终端命令）仍走本机 IPC。启动时由 {@link initTransport} 决定。
 * - 网页：`POST /api/rpc/<命令名>`，命令名与参数和 Tauri 命令一一对应；实时变化走 SSE。
 *
 * 旧本地 IPC 仅用于明确开启的 DEV 组件 fixture；正常桌面启动不再自动读取本地/GitHub 资料库。
 * 几种实现的错误形态一致：领域错误 reject 成字符串（`STALE_BASE:` 等前缀照旧），
 * 结构化错误（搜索）reject 成对象。
 */
export interface ShardTransport {
  readonly kind: "tauri" | "tauri-remote" | "http"
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>
  /** 请求体是原始字节的命令（粘贴图片）；`headers` 与 Tauri 的 IPC 头同名。 */
  invokeBytes<T>(command: string, body: Uint8Array, headers: Record<string, string>): Promise<T>
  /**
   * 订阅后端事件，返回取消函数。`vault-changed`；以服务器为真相的传输另有 `lockbox-changed`
   *（服务器只说密匣变了，也在断线重连、游标过旧时触发：密匣客户端据此重取快照）。
   */
  listen<T>(event: string, handler: (payload: T) => void): Promise<() => void>
  /** 资料库内图片引用 → `<img>` 地址。 */
  fileUrl(reference: string): string
  /** 以服务器为真相时才有：密匣客户端（{@link withLockboxClient}）经它读快照、写回密文、取公开原文。 */
  readonly server?: ServerChannel
}

/** 失败的服务器调用：`detail` 就是 `invoke` 会 reject 的内容（字符串或结构化错误），另带状态码与错误码。 */
export interface ServerFailure {
  status: number
  code?: string
  detail: unknown
}

/** 直达服务器的通道（网页走 HTTP；S8a 的桌面经 Tauri 转发）。 */
export interface ServerChannel {
  /** 调一个 RPC（不经密匣分流）；失败 reject 成 {@link ServerFailure}。 */
  call<T>(command: string, args: Record<string, unknown>): Promise<T>
  /** 读一个资料库文件的原文与 sha（字节与服务器上逐字一致）。 */
  fetchText(path: string): Promise<{ text: string; sha: string }>
}

let override: ShardTransport | null = null
let webTransport: ShardTransport | null = null
let desktopRemote: ShardTransport | null = null
let remoteStatus: RemoteStatus | null = null
let legacyDesktopFixture = false

/** Old component fixtures have no server IPC. This exception cannot enter a production build. */
function unsupportedLegacyFixture(value: unknown, failed = false) {
  if (!import.meta.env.DEV || import.meta.env.VITE_SHARD_LEGACY_UI_TESTS !== "1") return false
  if (!failed) return value === null || value === undefined
  const message = value instanceof Error ? value.message : String(value)
  return /\b(?:unhandled|unknown|unexpected)\b.*\bremote_status\b/iu.test(message)
}

export function isLegacyDesktopFixture() {
  return legacyDesktopFixture
}

/**
 * 启动时决定桌面走哪条通道，必须在任何命令发出之前完成（`main.tsx` 渲染前 await）。
 * 桌面始终使用服务器通道；未连接或无法读取凭据时由登录门阻止工作台渲染。
 */
export async function initTransport() {
  await initIOSNative()
  if (!isTauri()) return
  desktopRemote = withLockboxClient(createDesktopRemoteTransport())
  let status: RemoteStatus | null = null
  try {
    status = await invoke<RemoteStatus>("remote_status")
  } catch (error) {
    if (unsupportedLegacyFixture(error, true)) {
      legacyDesktopFixture = true
      desktopRemote = null
    }
    return
  }
  if (unsupportedLegacyFixture(status)) {
    legacyDesktopFixture = true
    desktopRemote = null
    return
  }
  if (!status || typeof status.connected !== "boolean") return
  remoteStatus = status
  if (!status.connected) return
  await startRemoteConnectionTracking(status.connection, status.sync)
}

export function transport(): ShardTransport {
  if (override) return override
  if (desktopRemote) return desktopRemote
  if (isTauri()) return tauriTransport
  // 网页：密匣命令在浏览器里（wasm）执行，再把密文写回服务器。
  webTransport ??= withLockboxClient(httpTransport)
  return webTransport
}

/** 单元测试用。 */
export function setTransportForTests(next: ShardTransport | null) {
  override = next
}

/** 网页端（浏览器直连服务器）。桌面专属能力（原生对话框、红绿灯、Dock）在这里不可用。只用于浏览器专属的界面行为。 */
export function isWebRuntime() {
  return transport().kind === "http"
}

/**
 * 数据以服务器为真相（密匣在客户端解密、经服务器同步）：网页，以及连接了服务器的桌面。密匣客户端的启用、
 * 密匣命令的分流、`lockbox-changed` 的监听、版本历史等数据路径一律看它，不看 {@link isWebRuntime}。
 */
export function isServerBacked() {
  const kind = transport().kind
  return kind === "http" || kind === "tauri-remote"
}

/** 资料库文件就在这台电脑上（桌面且没连接服务器）：「用默认程序打开」「在访达中显示」等入口才有意义。 */
export function canOpenLocalFiles() {
  return transport().kind === "tauri"
}

/** 桌面服务器状态（未登录时也可保留原服务器地址）；网页与旧组件 fixture 为 null。 */
export function desktopRemoteStatus(): RemoteStatus | null {
  return transport().kind === "tauri-remote" ? remoteStatus : null
}

/** 服务器要求重新登录时在 window 上派发；登录界面监听它。 */
export const AUTH_REQUIRED_EVENT = "shard:auth-required"
/** 登录成功后在 window 上派发：等待中的 SSE 连接据此重连。 */
export const AUTHENTICATED_EVENT = "shard:authenticated"
/** SSE 游标过旧或缓冲溢出：需要整体重新读取。 */
export const VAULT_RESYNC_EVENT = "shard:vault-resync"
/** SSE 收到 `lockbox-changed`（任一设备写了密匣）时在 window 上派发；`listen("lockbox-changed")` 据此回调。 */
export const LOCKBOX_CHANGED_EVENT = "shard:lockbox-changed"
