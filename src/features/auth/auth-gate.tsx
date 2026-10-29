import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react"

import { PasswordInput } from "@/components/shard/password-input"
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
  passwordProblem,
  repeatProblem,
  setupAccount,
  type SetupTokenInfo,
} from "./api"
import styles from "./auth-pages.module.css"
import { fieldProps, FormError, FormField, useFieldErrors, type FieldErrors } from "./form-fields"
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
      return phase.setupRequired ? <SetupRequiredCard /> : <LoginForm onDone={enter} />
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

/** 还没有账号：说明下一步在哪里做（kiln 空状态：为什么没有、接下来怎么办）。 */
function SetupRequiredCard() {
  return (
    <AuthCard title="还没有设置账号">
      <p className={styles.hint}>
        在服务器上运行 <code>shard-server setup</code>，用它给出的链接设置邮箱和密码。
      </p>
    </AuthCard>
  )
}

/** 提交的忙碌态与表单级错误（服务器拒绝、连不上）。字段自己的错误各自放在字段下方。 */
function useSubmit() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const run = async (action: () => Promise<void>, onError?: (error: unknown) => boolean | void) => {
    setBusy(true)
    setError("")
    try {
      await action()
    } catch (caught) {
      // onError 返回 true 表示它已把错误放到了某个字段下，不再显示成表单级错误
      if (onError?.(caught) !== true) setError(messageOf(caught))
    } finally {
      setBusy(false)
    }
  }
  return { busy, error, run }
}

type LoginField = "email" | "password"

function LoginForm({ onDone }: { onDone: () => void }) {
  const { busy, error, run } = useSubmit()
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const emailRef = useRef<HTMLInputElement>(null)
  const passwordRef = useRef<HTMLInputElement>(null)
  const emailId = useId()
  const passwordId = useId()
  const { errors, setErrors, revalidate } = useFieldErrors<LoginField>()
  const missingPassword = (value: string) => (value ? null : "请填写密码。")

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const next = { email: emailProblem(email) ?? undefined, password: missingPassword(password) ?? undefined }
    setErrors(next)
    if (next.email || next.password) {
      ;(next.email ? emailRef : passwordRef).current?.focus()
      return
    }
    void run(
      async () => {
        await login(email, password)
        onDone()
      },
      (caught) => {
        // 邮箱或密码不对：清空密码重输，邮箱留着。
        if (caught instanceof AuthError && caught.code === "INVALID_CREDENTIALS") {
          setPassword("")
          passwordRef.current?.focus()
        }
      }
    )
  }

  return (
    <AuthCard title="登录">
      <form className={styles.form} noValidate onSubmit={submit}>
        <FormField error={errors.email} htmlFor={emailId} label="邮箱">
          <Input
            {...fieldProps(emailId, errors.email)}
            autoCapitalize="off"
            autoComplete="username"
            autoFocus
            id={emailId}
            inputMode="email"
            onChange={(event) => {
              setEmail(event.target.value)
              revalidate("email", emailProblem(event.target.value))
            }}
            ref={emailRef}
            spellCheck={false}
            type="email"
            value={email}
          />
        </FormField>
        <FormField error={errors.password} htmlFor={passwordId} label="密码">
          <PasswordInput
            {...fieldProps(passwordId, errors.password)}
            credential="current-password"
            id={passwordId}
            onChange={(event) => {
              setPassword(event.target.value)
              revalidate("password", missingPassword(event.target.value))
            }}
            readOnly={busy}
            ref={passwordRef}
            value={password}
          />
        </FormField>
        <FormError message={error} />
        <Button aria-busy={busy} className={styles.action} disabled={busy} size="lg" type="submit" variant="primary">
          {busy ? "正在登录…" : "登录"}
        </Button>
      </form>
    </AuthCard>
  )
}

type SetupCheck =
  | { kind: "checking" }
  | { kind: "invalid" }
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
            ? { kind: "invalid" }
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
        <p className={styles.hint}>请复制服务器输出的完整链接重新打开。</p>
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
          <p className={styles.hint}>
            链接只能用一次，24 小时内有效。请在服务器上重新运行 <code>shard-server setup</code>（忘记密码用{" "}
            <code>shard-server reset-password</code>）。
          </p>
        </AuthCard>
      )
    case "ready":
      return <SetupForm info={check.info} token={token} onDone={onDone} />
  }
}

type SetupField = "email" | "password" | "repeat"

const PASSWORD_HINT = `至少 ${MIN_PASSWORD_CHARS} 个字符。`

function SetupForm({ info, token, onDone }: { info: SetupTokenInfo; token: string; onDone: () => void }) {
  const { busy, error, run } = useSubmit()
  const reset = info.purpose === "reset"
  const [email, setEmail] = useState(info.email ?? "")
  const [password, setPassword] = useState("")
  const [repeat, setRepeat] = useState("")
  const refs = {
    email: useRef<HTMLInputElement>(null),
    password: useRef<HTMLInputElement>(null),
    repeat: useRef<HTMLInputElement>(null),
  }
  const emailId = useId()
  const passwordId = useId()
  const repeatId = useId()
  const { errors, setErrors, revalidate } = useFieldErrors<SetupField>()

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const weak = passwordProblem(password)
    const next: FieldErrors<SetupField> = {
      email: emailProblem(email) ?? undefined,
      password: weak ?? undefined,
      // 新密码本身不合格时先只提示它，确认框等新密码改好再比
      repeat: weak ? undefined : (repeatProblem(password, repeat) ?? undefined),
    }
    setErrors(next)
    const first = (["email", "password", "repeat"] as const).find((field) => next[field])
    if (first) {
      refs[first].current?.focus()
      return
    }
    void run(
      async () => {
        await setupAccount(token, email, password)
        onDone()
      },
      (caught) => {
        // 服务器的格式校验落到对应字段下；其余（链接失效、连不上）是表单级错误
        if (caught instanceof AuthError && caught.code === "INVALID_EMAIL") {
          setErrors({ email: caught.message })
          return true
        }
        if (caught instanceof AuthError && caught.code === "WEAK_PASSWORD") {
          setErrors({ password: caught.message })
          return true
        }
      }
    )
  }

  return (
    <AuthCard title={reset ? "重置密码" : "设置账号"}>
      {/* 用户名 + 两个 new-password 字段在同一个表单里：Safari / iCloud 钥匙串据此建议并保存强密码。 */}
      <form className={styles.form} noValidate onSubmit={submit}>
        <FormField error={errors.email} htmlFor={emailId} label="邮箱">
          <Input
            {...fieldProps(emailId, errors.email)}
            autoCapitalize="off"
            autoComplete="username"
            autoFocus={!reset}
            id={emailId}
            inputMode="email"
            onChange={(event) => {
              setEmail(event.target.value)
              revalidate("email", emailProblem(event.target.value))
            }}
            ref={refs.email}
            spellCheck={false}
            type="email"
            value={email}
          />
        </FormField>
        <FormField error={errors.password} hint={PASSWORD_HINT} htmlFor={passwordId} label={reset ? "新密码" : "密码"}>
          <PasswordInput
            {...fieldProps(passwordId, errors.password, PASSWORD_HINT)}
            autoFocus={reset}
            credential="new-password"
            id={passwordId}
            onChange={(event) => {
              setPassword(event.target.value)
              revalidate("password", passwordProblem(event.target.value))
              revalidate("repeat", repeatProblem(event.target.value, repeat))
            }}
            readOnly={busy}
            ref={refs.password}
            value={password}
          />
        </FormField>
        <FormField error={errors.repeat} htmlFor={repeatId} label={reset ? "确认新密码" : "确认密码"}>
          <PasswordInput
            {...fieldProps(repeatId, errors.repeat)}
            credential="new-password"
            id={repeatId}
            onChange={(event) => {
              setRepeat(event.target.value)
              revalidate("repeat", repeatProblem(password, event.target.value))
            }}
            readOnly={busy}
            ref={refs.repeat}
            value={repeat}
          />
        </FormField>
        <FormError message={error} />
        <Button aria-busy={busy} className={styles.action} disabled={busy} size="lg" type="submit" variant="primary">
          {busy ? "正在保存…" : reset ? "重置并登录" : "设置并登录"}
        </Button>
      </form>
    </AuthCard>
  )
}
