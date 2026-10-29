import { useCallback, useEffect, useId, useState, type FormEvent, type ReactNode } from "react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { AUTH_REQUIRED_EVENT } from "@/lib/transport"

import {
  AuthError,
  checkSetupToken,
  emailProblem,
  fetchAuthState,
  login,
  MIN_PASSWORD_CHARS,
  newPasswordProblem,
  setupAccount,
  type SetupTokenInfo,
} from "./api"
import styles from "./auth-pages.module.css"
import { FormError, FormField, PasswordInput } from "./form-fields"
import { PasswordPromptHost } from "./password-prompt"

type Phase =
  | { kind: "loading" }
  | { kind: "offline"; message: string }
  | { kind: "setup"; token: string }
  | { kind: "login"; setupRequired: boolean }
  | { kind: "ready" }

function messageOf(error: unknown) {
  if (error instanceof AuthError || error instanceof Error) return error.message
  return String(error)
}

function goHome() {
  window.history.replaceState(null, "", "/")
}

/**
 * 网页端的入口门：没登录先用邮箱和密码登录；`/setup#token=…` 是服务器上 `shard-server setup`（首次设置）或
 * `shard-server reset-password`（忘记密码）生成的一次性链接。登录过期时（任意请求 401）退回登录页。
 * 已登录时挂上密码确认框的宿主，敏感操作前由它要密码。
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" })

  const refresh = useCallback(async () => {
    try {
      const state = await fetchAuthState()
      setPhase(state.authenticated ? { kind: "ready" } : { kind: "login", setupRequired: state.setupRequired })
    } catch (error) {
      setPhase({ kind: "offline", message: messageOf(error) })
    }
  }, [])

  useEffect(() => {
    if (window.location.pathname === "/setup") {
      const token = new URLSearchParams(window.location.hash.slice(1)).get("token") ?? ""
      setPhase({ kind: "setup", token })
      return
    }
    // 设备配对页已经取消（桌面与命令行改为直接输入邮箱和密码）：旧链接回首页。
    if (window.location.pathname === "/pair") goHome()
    void refresh()
  }, [refresh])

  useEffect(() => {
    const onAuthRequired = () => void refresh()
    window.addEventListener(AUTH_REQUIRED_EVENT, onAuthRequired)
    return () => window.removeEventListener(AUTH_REQUIRED_EVENT, onAuthRequired)
  }, [refresh])

  const enter = () => {
    if (window.location.pathname === "/setup") goHome()
    setPhase({ kind: "ready" })
  }

  switch (phase.kind) {
    case "loading":
      return <div className={styles.page} aria-busy="true" />
    case "offline":
      return <OfflineCard message={phase.message} onRetry={() => void refresh()} />
    case "setup":
      return <SetupPage token={phase.token} onDone={enter} />
    case "login":
      return <LoginPage setupRequired={phase.setupRequired} onDone={enter} />
    case "ready":
      return (
        <>
          {children}
          <PasswordPromptHost />
        </>
      )
  }
}

function AuthCard({ title, children }: { title: string; children: ReactNode }) {
  const titleId = useId()
  return (
    <main className={styles.page}>
      <section aria-labelledby={titleId} className={styles.card}>
        <p className={styles.brand}>Shard</p>
        <h1 className={styles.title} id={titleId}>
          {title}
        </h1>
        {children}
      </section>
    </main>
  )
}

function OfflineCard({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <AuthCard title="连不上服务器">
      <p className={styles.hint}>{message}</p>
      <Button className={styles.action} size="lg" variant="outline" onClick={onRetry}>
        重试
      </Button>
    </AuthCard>
  )
}

/** 表单提交的忙碌态与错误行。`fail` 用于前端预校验拦下的情况（不发请求）。 */
function useSubmit() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const run = async (action: () => Promise<void>, onError?: (error: unknown) => void) => {
    setBusy(true)
    setError("")
    try {
      await action()
    } catch (caught) {
      setError(messageOf(caught))
      onError?.(caught)
    } finally {
      setBusy(false)
    }
  }
  return { busy, error, fail: setError, run }
}

function LoginPage({ setupRequired, onDone }: { setupRequired: boolean; onDone: () => void }) {
  const { busy, error, fail, run } = useSubmit()
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const emailId = useId()
  const passwordId = useId()
  const errorId = useId()

  if (setupRequired) {
    return (
      <AuthCard title="还没有设置账号">
        <p className={styles.hint}>
          在服务器上运行 <code>shard-server setup</code>，打开它给出的链接设置邮箱和密码。
        </p>
      </AuthCard>
    )
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const problem = emailProblem(email) ?? (password ? null : "请填写密码。")
    if (problem) {
      fail(problem)
      return
    }
    void run(
      async () => {
        await login(email, password)
        onDone()
      },
      (caught) => {
        // 邮箱或密码不对：清空密码重输，邮箱留着。
        if (caught instanceof AuthError && caught.code === "INVALID_CREDENTIALS") setPassword("")
      }
    )
  }

  const describedBy = error ? errorId : undefined
  return (
    <AuthCard title="登录">
      <form className={styles.form} noValidate onSubmit={submit}>
        <FormField htmlFor={emailId} label="邮箱">
          <Input
            aria-describedby={describedBy}
            autoCapitalize="off"
            autoComplete="username"
            autoFocus
            className={styles.input}
            id={emailId}
            inputMode="email"
            onChange={(event) => setEmail(event.target.value)}
            spellCheck={false}
            type="email"
            value={email}
          />
        </FormField>
        <FormField htmlFor={passwordId} label="密码">
          <PasswordInput
            aria-describedby={describedBy}
            autoComplete="current-password"
            className={styles.input}
            id={passwordId}
            onChange={(event) => setPassword(event.target.value)}
            readOnly={busy}
            value={password}
          />
        </FormField>
        <FormError id={errorId} message={error} />
        <Button aria-busy={busy} className={styles.action} disabled={busy} size="lg" type="submit" variant="primary">
          {busy ? "正在登录…" : "登录"}
        </Button>
      </form>
      <p className={styles.hint}>
        忘记密码：在服务器上运行 <code>shard-server reset-password</code>，打开它给出的链接重设。
      </p>
    </AuthCard>
  )
}

type SetupCheck =
  | { kind: "checking" }
  | { kind: "invalid"; message: string }
  | { kind: "offline"; message: string }
  | { kind: "ready"; info: SetupTokenInfo }

/** 一次性链接：先问服务器链接还有没有效、是首次设置还是重置，再给对应的表单。 */
function SetupPage({ token, onDone }: { token: string; onDone: () => void }) {
  const [check, setCheck] = useState<SetupCheck>({ kind: "checking" })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!token) return
    let active = true
    setCheck({ kind: "checking" })
    checkSetupToken(token).then(
      (info) => {
        if (active) setCheck({ kind: "ready", info })
      },
      (error: unknown) => {
        if (!active) return
        setCheck(
          error instanceof AuthError && error.code === "SETUP_TOKEN_INVALID"
            ? { kind: "invalid", message: error.message }
            : { kind: "offline", message: messageOf(error) }
        )
      }
    )
    return () => {
      active = false
    }
  }, [token, attempt])

  if (!token) {
    return (
      <AuthCard title="链接不完整">
        <p className={styles.hint}>
          这个链接缺少令牌。请复制 <code>shard-server setup</code> 或 <code>shard-server reset-password</code>{" "}
          输出的完整链接重新打开。
        </p>
      </AuthCard>
    )
  }

  switch (check.kind) {
    case "checking":
      return <div className={styles.page} aria-busy="true" />
    case "offline":
      return <OfflineCard message={check.message} onRetry={() => setAttempt((value) => value + 1)} />
    case "invalid":
      return (
        <AuthCard title="链接无效或已过期">
          <p className={styles.hint}>{check.message}</p>
          <p className={styles.hint}>
            请在服务器上重新运行 <code>shard-server setup</code>（忘记密码用 <code>shard-server reset-password</code>
            ），打开新给出的链接。
          </p>
        </AuthCard>
      )
    case "ready":
      return <SetupForm info={check.info} token={token} onDone={onDone} />
  }
}

function SetupForm({ info, token, onDone }: { info: SetupTokenInfo; token: string; onDone: () => void }) {
  const { busy, error, fail, run } = useSubmit()
  const reset = info.purpose === "reset"
  const [email, setEmail] = useState(info.email ?? "")
  const [password, setPassword] = useState("")
  const [repeat, setRepeat] = useState("")
  const emailId = useId()
  const passwordId = useId()
  const repeatId = useId()
  const hintId = useId()
  const errorId = useId()

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const problem = emailProblem(email) ?? newPasswordProblem(password, repeat)
    if (problem) {
      fail(problem)
      return
    }
    void run(async () => {
      await setupAccount(token, email, password)
      onDone()
    })
  }

  const describedBy = error ? errorId : undefined
  return (
    <AuthCard title={reset ? "重置密码" : "设置账号"}>
      <p className={styles.hint}>
        {reset ? "为这个账号设置新密码，完成后直接登录。" : "设置登录用的邮箱和密码，完成后直接登录。"}
      </p>
      {/* 用户名 + 两个 new-password 字段在同一个表单里：Safari / iCloud 钥匙串据此建议并保存强密码。 */}
      <form className={styles.form} noValidate onSubmit={submit}>
        <FormField htmlFor={emailId} label="邮箱">
          <Input
            aria-describedby={describedBy}
            autoCapitalize="off"
            autoComplete="username"
            autoFocus={!reset}
            className={styles.input}
            id={emailId}
            inputMode="email"
            onChange={(event) => setEmail(event.target.value)}
            spellCheck={false}
            type="email"
            value={email}
          />
        </FormField>
        <FormField
          hint={`至少 ${MIN_PASSWORD_CHARS} 个字符。可以让浏览器或钥匙串生成并保存一个强密码。`}
          hintId={hintId}
          htmlFor={passwordId}
          label={reset ? "新密码" : "密码"}
        >
          <PasswordInput
            aria-describedby={describedBy ? `${hintId} ${describedBy}` : hintId}
            autoComplete="new-password"
            autoFocus={reset}
            className={styles.input}
            id={passwordId}
            minLength={MIN_PASSWORD_CHARS}
            onChange={(event) => setPassword(event.target.value)}
            readOnly={busy}
            value={password}
          />
        </FormField>
        <FormField htmlFor={repeatId} label={reset ? "确认新密码" : "确认密码"}>
          <PasswordInput
            aria-describedby={describedBy}
            autoComplete="new-password"
            className={styles.input}
            id={repeatId}
            minLength={MIN_PASSWORD_CHARS}
            onChange={(event) => setRepeat(event.target.value)}
            readOnly={busy}
            value={repeat}
          />
        </FormField>
        <FormError id={errorId} message={error} />
        <Button aria-busy={busy} className={styles.action} disabled={busy} size="lg" type="submit" variant="primary">
          {busy ? "正在保存…" : reset ? "重置并登录" : "设置并登录"}
        </Button>
      </form>
    </AuthCard>
  )
}
