import { invoke } from "@tauri-apps/api/core"
import { listen as tauriListen } from "@tauri-apps/api/event"

import type { CheckpointResult, GitInfo } from "@/types"

import type { ServerChannel, ServerFailure, ShardTransport } from "./index"
import type { ConnectionState } from "./sse"
import { tauriTransport } from "./tauri"

/**
 * 桌面「连接服务器」（S8a 在线客户端）的传输：界面与网页一致，数据以服务器为真相。
 *
 * 每个命令按下面几张显式的表分流，没列出的一律转发给服务器（Rust `remote_invoke` 带设备令牌调
 * `/api/rpc/<命令>`，失败与网页 `readError` 同形）：
 *
 * 1. 密匣命令：外面套的 `withLockboxClient` 先在本机（wasm）执行，只有读快照、写密文经 {@link ServerChannel}。
 * 2. 本机能力（导出文件、复制图片、红绿灯、Dock 角标、终端命令）：原样走本机 IPC（{@link LOCAL_COMMANDS}）。
 * 3. 本地资料库 / Git 管理：服务器上没有，不调后端，给与网页端一致的结果或明确的报错
 *    （{@link SUBSTITUTED_COMMANDS}、{@link UNAVAILABLE_COMMANDS}）；界面上相应入口隐藏。
 * 4. 读本机文件再写进资料库：换成 Rust 的远程版本，读文件 → 按内容哈希上传 → 网页同款的 blob 命令
 *    （{@link REMOTE_WRITE_COMMANDS}）；只读本机文件的转换照常本地。
 */

/** Rust `remote_status`。 */
export interface RemoteStatus {
  connected: boolean
  server: string | null
  deviceId: string | null
  name: string | null
  /** 实时通道当前的状态；webview 订阅事件之前发生的变化靠它补上。 */
  connection?: string | null
}

/** Rust 在本机直接读、不转发 RPC 的「命令」：一条修订的原始字节（与 `remote_client::REVISION_BYTES_COMMAND` 同名）。 */
export const REVISION_BYTES_COMMAND = "remote:revision_bytes"

const LOCAL_VAULT_MESSAGE = "已连接服务器：资料库在服务器上，没有本机目录与 Git 可管理。"
const LOCAL_FILE_MESSAGE = "已连接服务器：资料库文件不在这台电脑上，不能用本机程序打开。"

/** 第 2 类：桌面本机能力；以及第 4 类里只读本机文件的转换。连接服务器后照常走本机 Tauri 命令。 */
export const LOCAL_COMMANDS: ReadonlySet<string> = new Set([
  "copy_exported_image",
  "save_exported_image",
  "write_export_file",
  "save_recovery_key",
  "set_canvas_grab_cursor",
  "set_window_controls_hidden",
  "set_reminder_schedule",
  "cli_install_status",
  "install_cli",
  "uninstall_cli",
  "set_cli_install_declined",
  "read_import_csv_file",
  "read_import_xlsx_file",
  "convert_table_document_to_markdown",
])

/** 第 4 类写资料库：Rust 读本机文件、按内容哈希上传，再调网页端同款的 blob 命令。参数与本地命令同形。 */
export const REMOTE_WRITE_COMMANDS: Readonly<Record<string, string>> = {
  save_image_attachment_from_path: "remote_save_image_from_path",
  import_library_files: "remote_import_library_files",
}

type ServerInvoke = <T>(command: string, args: Record<string, unknown>) => Promise<T>

/** 服务器的 Git 状态（服务器模式没有版本控制，与 `shard_vault::no_git_info` 一致）。 */
function noGitInfo(): GitInfo {
  return { branch: "main", shortCommit: "no git", hasRemote: false, status: "no_git", error: null, ahead: 0, behind: 0 }
}

/**
 * 第 3 类里有替代结果的：与网页端一致——实时变化由 Rust 的 SSE 桥推送（不需要开始监视）、服务器自己记版本
 *（没有要提交的检查点）、导入前置检查保证没有旧笔记、旧方言与旧大纲。
 */
export const SUBSTITUTED_COMMANDS: Readonly<Record<string, (server: ServerInvoke) => unknown>> = {
  watch_vault: () => null,
  checkpoint_vault: (): CheckpointResult => ({ status: "no_changes", changes: 0, reason: null, skippedLarge: [], git: noGitInfo() }),
  migrate_legacy_notes: async (server) => ({ migratedCount: 0, tree: await server("list_library_tree", {}) }),
  apply_markdown_dialect_migration: () => 0,
  preflight_outline_upgrade: () => [],
}

/** 第 3 类里没有意义的本机操作：界面已隐藏入口，误调时给明确的说明，不去问服务器。 */
export const UNAVAILABLE_COMMANDS: Readonly<Record<string, string>> = {
  set_vault_path: LOCAL_VAULT_MESSAGE,
  initialize_vault_git: LOCAL_VAULT_MESSAGE,
  set_vault_remote: LOCAL_VAULT_MESSAGE,
  create_github_vault_repo: LOCAL_VAULT_MESSAGE,
  github_cli_status: LOCAL_VAULT_MESSAGE,
  sync_vault: LOCAL_VAULT_MESSAGE,
  run_outline_upgrade: LOCAL_VAULT_MESSAGE,
  organize_fragments: LOCAL_VAULT_MESSAGE,
  // 远程版「下载副本到临时目录再打开」暂缓（见 S8a 清单），入口先隐藏。
  open_vault_image: LOCAL_FILE_MESSAGE,
  open_csv_file: LOCAL_FILE_MESSAGE,
  fragment_image_file_path: LOCAL_FILE_MESSAGE,
  reveal_fragment_image_in_dir: LOCAL_FILE_MESSAGE,
}

export type CommandRoute =
  | { kind: "server" }
  | { kind: "local" }
  | { kind: "remote-write"; command: string }
  | { kind: "substitute" }
  | { kind: "unavailable"; message: string }

function listed(table: object, command: string) {
  return Object.prototype.hasOwnProperty.call(table, command)
}

/** 一个命令走哪条路；没列出的（服务器上的 RPC，以及将来新增的）默认转发给服务器。 */
export function routeCommand(command: string): CommandRoute {
  if (LOCAL_COMMANDS.has(command)) return { kind: "local" }
  if (listed(REMOTE_WRITE_COMMANDS, command)) return { kind: "remote-write", command: REMOTE_WRITE_COMMANDS[command] }
  if (listed(SUBSTITUTED_COMMANDS, command)) return { kind: "substitute" }
  if (listed(UNAVAILABLE_COMMANDS, command)) return { kind: "unavailable", message: UNAVAILABLE_COMMANDS[command] }
  return { kind: "server" }
}

/** 转发给服务器；失败 reject 成与网页 `invoke` 相同的内容（字符串或结构化错误）。 */
function serverInvoke<T>(command: string, args: Record<string, unknown>) {
  return invoke<T>("remote_invoke", { command, args })
}

/** 同 {@link serverInvoke}，失败时 reject 成带状态码与错误码的 {@link ServerFailure}（网络失败仍是说明文字）。 */
function serverCall<T>(command: string, args: Record<string, unknown>) {
  return invoke<T>("remote_invoke", { command, args, detailed: true })
}

function decodeBase64(data: string) {
  const binary = atob(data)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

interface RawRevision {
  sha: string
  contentType: string | null
  data: string
}

interface RevisionListing {
  revisions: Array<{ revId: number; sha: string | null }>
}

/** 一条修订的原始字节（版本历史的预览与下载）。失败 reject 成说明文字。 */
export async function readRemoteRevision(revId: number) {
  const raw = await serverInvoke<RawRevision>(REVISION_BYTES_COMMAND, { revId })
  return { bytes: decodeBase64(raw.data), contentType: raw.contentType, sha: raw.sha }
}

/**
 * 读一个资料库文件的原文与 sha（移入密匣要整篇原文才能保住 frontmatter，并以它的 sha 作基线）。
 * 网页走 `/api/sync/fetch`；桌面经设备令牌读得到的是修订原文：每次写入都记一条修订，最新一条就是当前内容，
 * Rust 按收到的字节重算 sha，与修订记录的 sha 一致才算读到。保留 BOM，字节与服务器上的逐字一致。
 */
async function fetchVaultText(path: string): Promise<{ text: string; sha: string }> {
  const listing = await serverCall<RevisionListing>("list_revisions", { path })
  const latest = listing.revisions[0]
  if (!latest?.sha) throw { status: 404, code: "NOT_FOUND", detail: `找不到 ${path}` } satisfies ServerFailure
  const raw = await serverCall<RawRevision>(REVISION_BYTES_COMMAND, { revId: latest.revId })
  if (raw.sha !== latest.sha) {
    throw { status: 409, code: "STALE_BASE", detail: `读取 ${path} 的原文时内容不一致，请重试。` } satisfies ServerFailure
  }
  return { text: new TextDecoder("utf-8", { ignoreBOM: true }).decode(decodeBase64(raw.data)), sha: raw.sha }
}

// ---- 与服务器的实时通道状态（状态栏、重新连接提示） ----

const CONNECTION_STATES: ReadonlySet<string> = new Set(["connecting", "connected", "reconnecting", "signedOut"])

function isConnectionState(value: unknown): value is ConnectionState {
  return typeof value === "string" && CONNECTION_STATES.has(value)
}

let connection: ConnectionState = "connecting"
let authRequired = false
const connectionListeners = new Set<(state: ConnectionState) => void>()
const authListeners = new Set<() => void>()

function setConnection(next: ConnectionState) {
  if (next === connection) return
  connection = next
  for (const listener of connectionListeners) listener(next)
}

/**
 * 设备令牌失效（被吊销）：Rust 发 `remote-auth-required`。实时通道的 signedOut 事件本身不算——断开连接时
 * Rust 也发它；只有启动时补读到的 signedOut（失效发生在页面订阅之前）才当作失效。
 */
function markAuthRequired() {
  setConnection("signedOut")
  if (authRequired) return
  authRequired = true
  for (const listener of authListeners) listener()
}

export function remoteConnectionState() {
  return connection
}

export function subscribeRemoteConnection(listener: (state: ConnectionState) => void) {
  connectionListeners.add(listener)
  return () => {
    connectionListeners.delete(listener)
  }
}

/** 这台设备的连接是否已失效（需要重新配对）。 */
export function isRemoteAuthRequired() {
  return authRequired
}

export function subscribeRemoteAuthRequired(listener: () => void) {
  authListeners.add(listener)
  return () => {
    authListeners.delete(listener)
  }
}

/**
 * 开始跟踪 Rust 的 `remote-connection` 与 `remote-auth-required`。Rust 在 webview 订阅之前就连上了服务器，
 * 那之前发出的事件收不到：先用 `remote_status` 给的状态，订阅好后再问一次补上中间的变化。
 */
export async function startRemoteConnectionTracking(initial: unknown) {
  const applyStatus = (state: unknown) => {
    if (!isConnectionState(state)) return
    if (state === "signedOut") markAuthRequired()
    else setConnection(state)
  }
  applyStatus(initial)
  try {
    await tauriListen<{ state?: unknown }>("remote-connection", (event) => {
      if (isConnectionState(event.payload?.state)) setConnection(event.payload.state)
    })
    await tauriListen("remote-auth-required", () => markAuthRequired())
    applyStatus((await invoke<RemoteStatus>("remote_status"))?.connection)
  } catch {
    // 没有事件能力的宿主：停在启动时的状态。
  }
}

/** 单元测试用：回到初始状态。 */
export function resetRemoteConnectionForTests() {
  connection = "connecting"
  authRequired = false
  connectionListeners.clear()
  authListeners.clear()
}

/**
 * 密匣可能变了：服务器推来 `lockbox-changed`（载荷是服务器给的 `{seq}`，原样交出）、游标过旧（`vault-resync`）、
 * 断线后重连上（期间的 `lockbox-changed` 不会补发）——后两种没有载荷。与网页 `subscribeLockboxEvents` 同一口径。
 */
async function listenLockboxChanged(handler: (payload: unknown) => void) {
  const disposers = await Promise.all([
    tauriListen("lockbox-changed", (event) => handler(event.payload)),
    tauriListen("vault-resync", () => handler(undefined)),
  ])
  let previous = connection
  const stop = subscribeRemoteConnection((next) => {
    if (next === "connected" && previous === "reconnecting") handler(undefined)
    previous = next
  })
  return () => {
    for (const dispose of disposers) dispose()
    stop()
  }
}

const server: ServerChannel = {
  call: serverCall,
  fetchText: fetchVaultText,
}

export function createDesktopRemoteTransport(): ShardTransport {
  return {
    kind: "tauri-remote",
    async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
      const route = routeCommand(command)
      switch (route.kind) {
        case "local":
          return invoke<T>(command, args)
        case "remote-write":
          return invoke<T>(route.command, args)
        case "substitute":
          return (await SUBSTITUTED_COMMANDS[command](serverInvoke)) as T
        case "unavailable":
          throw route.message
        case "server":
          return serverInvoke<T>(command, args ?? {})
      }
    },
    async invokeBytes<T>(command: string, body: Uint8Array, headers: Record<string, string>): Promise<T> {
      // 粘贴的图片：与网页一样先按内容哈希上传字节，再用 sha 登记。
      if (command === "save_fragment_image") {
        const blobSha = await invoke<string>("remote_upload_blob", body)
        const fileName = decodeURIComponent(headers["x-shard-file-name"] ?? "")
        return serverInvoke<T>(command, { fileName, blobSha })
      }
      if (LOCAL_COMMANDS.has(command)) return invoke<T>(command, body, { headers })
      throw `连接服务器时不支持这个操作（${command}）。`
    },
    async listen<T>(event: string, handler: (payload: T) => void) {
      if (event === "lockbox-changed") return listenLockboxChanged((payload) => handler(payload as T))
      // vault-changed（与本地文件监听同形）、vault-resync 等：Rust 把服务器的 SSE 转成同名 Tauri 事件。
      return tauriListen<T>(event, (message) => handler(message.payload))
    },
    // 图片仍是 shard-asset 地址：连接服务器时 Rust 带设备令牌代理 `/api/files`。
    fileUrl: (reference) => tauriTransport.fileUrl(reference),
    server,
  }
}
