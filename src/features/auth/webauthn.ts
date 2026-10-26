import { AUTHENTICATED_EVENT } from "@/lib/transport"

/**
 * 网页端的通行密钥流程：服务器（webauthn-rs）给出 JSON 选项，浏览器调用
 * `navigator.credentials`，再把结果以 JSON 交回。二进制字段一律 base64url；
 * 手动转换而不依赖 `PublicKeyCredential.parseCreationOptionsFromJSON`，旧版 Safari 也能用。
 */

export interface AuthState {
  authenticated: boolean
  setupRequired: boolean
  stepUpValid: boolean
  vaultId: string
}

export class AuthError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
  }
}

function fromBase64Url(value: string): ArrayBuffer {
  const base64 = value.replace(/-/gu, "+").replace(/_/gu, "/").padEnd(Math.ceil(value.length / 4) * 4, "=")
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes.buffer
}

function toBase64Url(buffer: ArrayBuffer | null | undefined): string | null {
  if (!buffer) return null
  let binary = ""
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "")
}

interface JsonDescriptor {
  id: string
  type: PublicKeyCredentialType
  transports?: AuthenticatorTransport[]
}

function descriptors(list: JsonDescriptor[] | undefined): PublicKeyCredentialDescriptor[] | undefined {
  return list?.map((item) => ({ ...item, id: fromBase64Url(item.id) }))
}

/** webauthn-rs 的 `CreationChallengeResponse` → `navigator.credentials.create` 的参数。 */
export function creationOptions(json: { publicKey: Record<string, unknown> }): CredentialCreationOptions {
  const publicKey = json.publicKey as unknown as PublicKeyCredentialCreationOptions & {
    challenge: string
    user: { id: string; name: string; displayName: string }
    excludeCredentials?: JsonDescriptor[]
  }
  return {
    publicKey: {
      ...publicKey,
      challenge: fromBase64Url(publicKey.challenge),
      user: { ...publicKey.user, id: fromBase64Url(publicKey.user.id) },
      excludeCredentials: descriptors(publicKey.excludeCredentials),
    },
  }
}

/** webauthn-rs 的 `RequestChallengeResponse` → `navigator.credentials.get` 的参数。 */
export function requestOptions(json: { publicKey: Record<string, unknown> }): CredentialRequestOptions {
  const publicKey = json.publicKey as unknown as PublicKeyCredentialRequestOptions & {
    challenge: string
    allowCredentials?: JsonDescriptor[]
  }
  return {
    publicKey: {
      ...publicKey,
      challenge: fromBase64Url(publicKey.challenge),
      allowCredentials: descriptors(publicKey.allowCredentials),
    },
  }
}

export function registrationJson(credential: PublicKeyCredential) {
  const response = credential.response as AuthenticatorAttestationResponse
  return {
    id: credential.id,
    rawId: toBase64Url(credential.rawId),
    type: credential.type,
    extensions: credential.getClientExtensionResults(),
    response: {
      clientDataJSON: toBase64Url(response.clientDataJSON),
      attestationObject: toBase64Url(response.attestationObject),
      transports: typeof response.getTransports === "function" ? response.getTransports() : undefined,
    },
  }
}

export function assertionJson(credential: PublicKeyCredential) {
  const response = credential.response as AuthenticatorAssertionResponse
  return {
    id: credential.id,
    rawId: toBase64Url(credential.rawId),
    type: credential.type,
    extensions: credential.getClientExtensionResults(),
    response: {
      clientDataJSON: toBase64Url(response.clientDataJSON),
      authenticatorData: toBase64Url(response.authenticatorData),
      signature: toBase64Url(response.signature),
      userHandle: toBase64Url(response.userHandle),
    },
  }
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json", "x-shard-request": "1" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = (await response.json().catch(() => ({}))) as { code?: string; message?: string }
  if (!response.ok) throw new AuthError(data.code ?? "ERROR", data.message ?? `请求失败（${response.status}）`)
  return data as T
}

export async function fetchAuthState(): Promise<AuthState> {
  const response = await fetch("/api/auth/state", { credentials: "same-origin" })
  if (!response.ok) throw new AuthError("ERROR", `连不上服务器（${response.status}）`)
  return (await response.json()) as AuthState
}

type Ceremony = { ceremonyId: string; options: { publicKey: Record<string, unknown> } }

/** 用户在系统弹窗里取消、超时都会抛 NotAllowedError：统一成可读的提示。 */
function describeBrowserError(error: unknown): never {
  if (error instanceof DOMException && error.name === "NotAllowedError") {
    throw new AuthError("CANCELLED", "已取消，或通行密钥没有响应。")
  }
  if (error instanceof DOMException && error.name === "InvalidStateError") {
    throw new AuthError("ALREADY_REGISTERED", "这台设备上的通行密钥已经注册过了。")
  }
  throw error
}

async function getAssertion(ceremony: Ceremony) {
  const credential = (await navigator.credentials.get(requestOptions(ceremony.options)).catch(describeBrowserError)) as
    | PublicKeyCredential
    | null
  if (!credential) throw new AuthError("CANCELLED", "已取消。")
  return assertionJson(credential)
}

async function createCredential(ceremony: Ceremony) {
  const credential = (await navigator.credentials.create(creationOptions(ceremony.options)).catch(describeBrowserError)) as
    | PublicKeyCredential
    | null
  if (!credential) throw new AuthError("CANCELLED", "已取消。")
  return registrationJson(credential)
}

function announceLogin() {
  window.dispatchEvent(new CustomEvent(AUTHENTICATED_EVENT))
}

/** 首次设置或恢复：凭服务器上生成的一次性链接注册通行密钥，成功即登录。 */
export async function registerWithSetupToken(token: string, label: string) {
  const ceremony = await post<Ceremony>("/api/auth/setup/start", { token })
  const credential = await createCredential(ceremony)
  await post("/api/auth/setup/finish", { ceremonyId: ceremony.ceremonyId, credential, label })
  announceLogin()
}

export async function loginWithPasskey() {
  const ceremony = await post<Ceremony>("/api/auth/login/start")
  const credential = await getAssertion(ceremony)
  await post("/api/auth/login/finish", { ceremonyId: ceremony.ceremonyId, credential })
  announceLogin()
}

/** 敏感操作前重新验证通行密钥（10 分钟内有效）。 */
export async function stepUp() {
  const ceremony = await post<Ceremony>("/api/auth/stepup/start")
  const credential = await getAssertion(ceremony)
  await post("/api/auth/stepup/finish", { ceremonyId: ceremony.ceremonyId, credential })
}

/** 需要二次验证的操作：先试一次，要求验证就验证后再试。 */
export async function withStepUp<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action()
  } catch (error) {
    if (!(error instanceof AuthError) || error.code !== "STEP_UP_REQUIRED") throw error
    await stepUp()
    return action()
  }
}

export function approvePairing(userCode: string) {
  return withStepUp(() => post<{ ok: boolean; name: string }>("/api/device/approve", { userCode }))
}

export function logout() {
  return post("/api/auth/logout")
}

/** 注册时给通行密钥起的默认名字：方便在设置里分辨是哪台设备。 */
export function defaultPasskeyLabel(userAgent = navigator.userAgent) {
  if (/iPhone/u.test(userAgent)) return "iPhone"
  if (/iPad/u.test(userAgent)) return "iPad"
  if (/Android/u.test(userAgent)) return "Android 手机"
  if (/Macintosh/u.test(userAgent)) return "Mac"
  if (/Windows/u.test(userAgent)) return "Windows 电脑"
  return "这台设备"
}

// ---------- 账号与安全（设置页） ----------

async function call<T>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: method === "GET" ? {} : { "content-type": "application/json", "x-shard-request": "1" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = (await response.json().catch(() => ({}))) as { code?: string; message?: string }
  if (!response.ok) throw new AuthError(data.code ?? "ERROR", data.message ?? `请求失败（${response.status}）`)
  return data as T
}

export interface PasskeyInfo {
  id: string
  label: string | null
  createdAt: string
  lastUsedAt: string | null
}

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

export async function listPasskeys() {
  return (await call<{ passkeys: PasskeyInfo[] }>("GET", "/api/auth/passkeys")).passkeys
}

export async function listSessions() {
  return (await call<{ sessions: SessionInfo[] }>("GET", "/api/auth/sessions")).sessions
}

export async function listDevices() {
  return (await call<{ devices: DeviceInfo[] }>("GET", "/api/devices")).devices
}

/** 在当前设备上再注册一把通行密钥（需要二次验证）。 */
export async function addPasskey(label: string) {
  const ceremony = await withStepUp(() => call<Ceremony>("POST", "/api/auth/passkeys/start"))
  const credential = await createCredential(ceremony)
  await call("POST", "/api/auth/passkeys/finish", { ceremonyId: ceremony.ceremonyId, credential, label })
}

export function revokePasskey(id: string) {
  return withStepUp(() => call("DELETE", `/api/auth/passkeys/${encodeURIComponent(id)}`))
}

export function revokeSession(id: string) {
  return withStepUp(() => call("DELETE", `/api/auth/sessions/${encodeURIComponent(id)}`))
}

export function revokeDevice(id: string) {
  return withStepUp(() => call("DELETE", `/api/devices/${encodeURIComponent(id)}`))
}
