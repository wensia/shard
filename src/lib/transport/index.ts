import { isTauri } from "@tauri-apps/api/core"

import { httpTransport } from "./http"
import { tauriTransport } from "./tauri"

/**
 * 前端与后端之间唯一的通道。
 *
 * - 桌面（Tauri）：IPC 直达 Rust 命令，行为与改造前一致。
 * - 网页：`POST /api/rpc/<命令名>`，命令名与参数和 Tauri 命令一一对应；实时变化走 SSE。
 *
 * 两种实现的错误形态一致：领域错误 reject 成字符串（`STALE_BASE:` 等前缀照旧），
 * 结构化错误（搜索）reject 成对象。
 */
export interface ShardTransport {
  readonly kind: "tauri" | "http"
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>
  /** 请求体是原始字节的命令（粘贴图片）；`headers` 与 Tauri 的 IPC 头同名。 */
  invokeBytes<T>(command: string, body: Uint8Array, headers: Record<string, string>): Promise<T>
  /** 订阅后端事件，返回取消函数。目前只有 `vault-changed`。 */
  listen<T>(event: string, handler: (payload: T) => void): Promise<() => void>
  /** 资料库内图片引用 → `<img>` 地址。 */
  fileUrl(reference: string): string
}

let override: ShardTransport | null = null

export function transport(): ShardTransport {
  if (override) return override
  return isTauri() ? tauriTransport : httpTransport
}

/** 单元测试用。 */
export function setTransportForTests(next: ShardTransport | null) {
  override = next
}

/** 网页端（浏览器直连服务器）。桌面专属能力（原生对话框、红绿灯、Dock）在这里不可用。 */
export function isWebRuntime() {
  return transport().kind === "http"
}

/** 服务器要求重新登录时在 window 上派发；登录界面监听它。 */
export const AUTH_REQUIRED_EVENT = "shard:auth-required"
/** 登录成功后在 window 上派发：等待中的 SSE 连接据此重连。 */
export const AUTHENTICATED_EVENT = "shard:authenticated"
/** SSE 游标过旧或缓冲溢出：需要整体重新读取。 */
export const VAULT_RESYNC_EVENT = "shard:vault-resync"
