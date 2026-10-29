import { AUTHENTICATED_EVENT } from "@/lib/transport"

/**
 * 网页端的账号接口：邮箱 + 密码登录、凭服务器上生成的一次性链接设置或重置密码、敏感操作前输入密码确认，
 * 以及设置页「账号与安全」用到的会话与设备管理。非 GET 请求都带 `x-shard-request`（服务器据此挡跨站请求）。
 */

export interface AuthState {
  authenticated: boolean
  setupRequired: boolean
  stepUpValid: boolean
  vaultId: string
  /** 只在已登录时有值。 */
  email: string | null
}

export class AuthError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
  }
}

/** 用户在密码确认框里点了取消：调用方静默放弃，不再报错。 */
export function isCancelled(error: unknown) {
  return error instanceof AuthError && error.code === "CANCELLED"
}

// ---------- 规则（与服务器 auth/password.rs 一致；前端先拦一道，服务器是最终裁决） ----------

export const MIN_PASSWORD_CHARS = 12
export const MAX_PASSWORD_CHARS = 256
const MAX_EMAIL_CHARS = 254

/** 邮箱只当登录名：去首尾空白、转小写后提交与比较。 */
export function normalizeEmail(value: string) {
  return value.trim().toLowerCase()
}

/** 邮箱格式问题；没问题返回 null。只要求恰好一个 `@`、两边非空、不含空白。 */
export function emailProblem(value: string) {
  const email = normalizeEmail(value)
  if (!email) return "请填写邮箱。"
  const parts = email.split("@")
  const valid =
    [...email].length <= MAX_EMAIL_CHARS && !/\s/u.test(email) && parts.length === 2 && parts[0] !== "" && parts[1] !== ""
  return valid ? null : "邮箱格式不对。"
}

/** 新密码的问题（长度按 Unicode 字符计，与服务器一致）；没问题返回 null。 */
export function newPasswordProblem(password: string, repeat: string) {
  const length = [...password].length
  if (length < MIN_PASSWORD_CHARS) return `密码至少 ${MIN_PASSWORD_CHARS} 个字符。`
  if (length > MAX_PASSWORD_CHARS) return `密码最多 ${MAX_PASSWORD_CHARS} 个字符。`
  if (password !== repeat) return "两次输入的密码不一致。"
  return null
}

// ---------- 请求 ----------

/** fetch 本身失败（断网、服务器没开）时浏览器给的是英文 TypeError：换成给人看的话。 */
async function send(path: string, init: RequestInit) {
  try {
    return await fetch(path, { credentials: "same-origin", ...init })
  } catch {
    throw new AuthError("NETWORK", "连不上服务器，请检查网络后重试。")
  }
}

async function call<T>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<T> {
  const response = await send(path, {
    method,
    headers: method === "GET" ? {} : { "content-type": "application/json", "x-shard-request": "1" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = (await response.json().catch(() => ({}))) as { code?: string; message?: string }
  if (!response.ok) throw new AuthError(data.code ?? "ERROR", data.message ?? `请求失败（${response.status}）`)
  return data as T
}

/** 最近一次知道的登录邮箱：密码确认框拿它填隐藏的用户名字段，密码管理器才认得是哪个账号。 */
let knownEmail: string | null = null

export function currentAccountEmail() {
  return knownEmail
}

export async function fetchAuthState(): Promise<AuthState> {
  const response = await send("/api/auth/state", {})
  if (!response.ok) throw new AuthError("ERROR", `连不上服务器（${response.status}）`)
  const state = (await response.json()) as AuthState
  knownEmail = state.authenticated ? (state.email ?? null) : null
  return { ...state, email: knownEmail }
}

function announceLogin(email: string) {
  knownEmail = email
  window.dispatchEvent(new CustomEvent(AUTHENTICATED_EVENT))
}

export interface SetupTokenInfo {
  /** `setup` 是首次设置；`reset` 是管理员发的重置链接。 */
  purpose: "setup" | "reset"
  /** 重置时是当前邮箱（预填）；首次设置为 null。 */
  email: string | null
}

/** 先看一次性链接还有没有效、是首次设置还是重置。 */
export function checkSetupToken(token: string) {
  return call<SetupTokenInfo>("POST", "/api/auth/setup/check", { token })
}

/** 凭一次性链接设置邮箱和密码，成功即登录。 */
export async function setupAccount(token: string, email: string, password: string) {
  const normalized = normalizeEmail(email)
  await call("POST", "/api/auth/setup", { token, email: normalized, password })
  announceLogin(normalized)
}

export async function login(email: string, password: string) {
  const normalized = normalizeEmail(email)
  await call("POST", "/api/auth/login", { email: normalized, password })
  announceLogin(normalized)
}

export function logout() {
  return call("POST", "/api/auth/logout")
}

// ---------- 敏感操作前输入密码确认 ----------

/** 弹出密码确认框：确认成功 resolve，取消以 CANCELLED reject。由 password-prompt.tsx 的宿主注册。 */
type PasswordPrompter = () => Promise<void>

let prompter: PasswordPrompter | null = null
/** 几处同时要求确认（例如两个请求都被拒）时共用一个确认框。 */
let pendingStepUp: Promise<void> | null = null

export function registerPasswordPrompt(next: PasswordPrompter) {
  prompter = next
  return () => {
    if (prompter === next) prompter = null
  }
}

/** 把密码交给服务器确认，之后 10 分钟内的敏感操作不再要求（登录本身也算一次）。密码确认框调用。 */
export function confirmPassword(password: string) {
  return call("POST", "/api/auth/stepup", { password })
}

/** 敏感操作前输入密码确认（10 分钟内有效）。 */
export function stepUp(): Promise<void> {
  if (pendingStepUp) return pendingStepUp
  if (!prompter) return Promise.reject(new AuthError("ERROR", "需要输入密码确认，请刷新页面后重试。"))
  pendingStepUp = prompter().finally(() => {
    pendingStepUp = null
  })
  return pendingStepUp
}

/** 需要输入密码确认的操作：先试一次，服务器要求确认就确认后再试。 */
export async function withStepUp<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action()
  } catch (error) {
    if (!(error instanceof AuthError) || error.code !== "STEP_UP_REQUIRED") throw error
    await stepUp()
    return action()
  }
}

// ---------- 账号与安全（设置页） ----------

export interface SessionInfo {
  id: string
  current: boolean
  createdAt: string
  lastSeenAt: string
  userAgent: string | null
  ip: string | null
}

export interface DeviceInfo {
  id: string
  name: string
  kind: "desktop" | "cli"
  createdAt: string
  lastSeenAt: string | null
  lastIp: string | null
}

/**
 * 改邮箱或密码：凭当前密码，`newPassword` 不给就只改邮箱。
 * 改了密码，服务器会让其他浏览器会话全部退出（当前会话保留）。
 */
export async function updateAccount(input: { currentPassword: string; email: string; newPassword?: string }) {
  const email = normalizeEmail(input.email)
  await call("POST", "/api/auth/account", {
    currentPassword: input.currentPassword,
    email,
    ...(input.newPassword ? { newPassword: input.newPassword } : {}),
  })
  knownEmail = email
}

export async function listSessions() {
  return (await call<{ sessions: SessionInfo[] }>("GET", "/api/auth/sessions")).sessions
}

export async function listDevices() {
  return (await call<{ devices: DeviceInfo[] }>("GET", "/api/devices")).devices
}

export function revokeSession(id: string) {
  return withStepUp(() => call("DELETE", `/api/auth/sessions/${encodeURIComponent(id)}`))
}

export function revokeDevice(id: string) {
  return withStepUp(() => call("DELETE", `/api/devices/${encodeURIComponent(id)}`))
}
