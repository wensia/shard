import { useCallback, useEffect, useId, useState, type FormEvent, type ReactNode } from "react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { AUTH_REQUIRED_EVENT } from "@/lib/transport"

import styles from "./auth-pages.module.css"
import {
  AuthError,
  approvePairing,
  defaultPasskeyLabel,
  fetchAuthState,
  loginWithPasskey,
  registerWithSetupToken,
} from "./webauthn"

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
 * 网页端的入口门：没登录先登录；`/setup#token=…` 是服务器上 `shard-server setup` 生成的一次性注册链接；
 * `/pair` 是桌面或命令行配对时要打开的批准页。登录过期时（任意请求 401）退回登录页。
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" })
  const [path, setPath] = useState(() => window.location.pathname)

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
    void refresh()
  }, [refresh])

  useEffect(() => {
    const onAuthRequired = () => void refresh()
    window.addEventListener(AUTH_REQUIRED_EVENT, onAuthRequired)
    return () => window.removeEventListener(AUTH_REQUIRED_EVENT, onAuthRequired)
  }, [refresh])

  const enter = () => {
    if (window.location.pathname === "/setup") goHome()
    setPath(window.location.pathname)
    setPhase({ kind: "ready" })
  }

  switch (phase.kind) {
    case "loading":
      return <div className={styles.page} aria-busy="true" />
    case "offline":
      return (
        <AuthCard title="连不上服务器">
          <p className={styles.hint}>{phase.message}</p>
          <Button className={styles.action} size="lg" variant="outline" onClick={() => void refresh()}>
            重试
          </Button>
        </AuthCard>
      )
    case "setup":
      return <SetupPage token={phase.token} onDone={enter} />
    case "login":
      return <LoginPage setupRequired={phase.setupRequired} onDone={enter} />
    case "ready":
      return path === "/pair" ? (
        <PairPage
          onDone={() => {
            goHome()
            setPath("/")
          }}
        />
      ) : (
        children
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

function useAction() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    setError("")
    try {
      await action()
    } catch (caught) {
      setError(messageOf(caught))
    } finally {
      setBusy(false)
    }
  }
  return { busy, error, run }
}

function LoginPage({ setupRequired, onDone }: { setupRequired: boolean; onDone: () => void }) {
  const { busy, error, run } = useAction()
  if (setupRequired) {
    return (
      <AuthCard title="还没有设置通行密钥">
        <p className={styles.hint}>
          在服务器上运行 <code>shard-server setup</code>，用这台设备打开它给出的链接，注册第一把通行密钥。
        </p>
      </AuthCard>
    )
  }
  return (
    <AuthCard title="登录">
      <p className={styles.hint}>用这台设备上的通行密钥登录，面容、指纹或设备密码确认即可。</p>
      <Button
        aria-busy={busy}
        className={styles.action}
        disabled={busy}
        size="lg"
        variant="primary"
        onClick={() => void run(async () => {
          await loginWithPasskey()
          onDone()
        })}
      >
        {busy ? "等待确认…" : "用通行密钥登录"}
      </Button>
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
    </AuthCard>
  )
}

function SetupPage({ token, onDone }: { token: string; onDone: () => void }) {
  const { busy, error, run } = useAction()
  const [label, setLabel] = useState(() => defaultPasskeyLabel())
  const labelId = useId()

  if (!token) {
    return (
      <AuthCard title="链接不完整">
        <p className={styles.hint}>
          这个设置链接缺少令牌。请复制 <code>shard-server setup</code> 输出的完整链接重新打开。
        </p>
      </AuthCard>
    )
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    void run(async () => {
      await registerWithSetupToken(token, label.trim() || defaultPasskeyLabel())
      onDone()
    })
  }

  return (
    <AuthCard title="注册通行密钥">
      <p className={styles.hint}>
        通行密钥保存在这台设备上（iPhone 与 Mac 会经 iCloud 钥匙串同步），以后用面容、指纹或设备密码登录，没有密码可被盗。
      </p>
      <form className={styles.form} onSubmit={submit}>
        <label className={styles.field} htmlFor={labelId}>
          名称
          <Input
            autoComplete="off"
            id={labelId}
            maxLength={60}
            value={label}
            onChange={(event) => setLabel(event.target.value)}
          />
        </label>
        <Button aria-busy={busy} className={styles.action} disabled={busy} size="lg" type="submit" variant="primary">
          {busy ? "等待确认…" : "注册并登录"}
        </Button>
      </form>
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
    </AuthCard>
  )
}

function PairPage({ onDone }: { onDone: () => void }) {
  const { busy, error, run } = useAction()
  const [code, setCode] = useState("")
  const [approved, setApproved] = useState<string | null>(null)
  const codeId = useId()

  if (approved) {
    return (
      <AuthCard title="已批准">
        <p className={styles.success}>「{approved}」已经可以访问你的资料库。回到那台设备继续。</p>
        <Button className={styles.action} size="lg" variant="outline" onClick={onDone}>
          返回 Shard
        </Button>
      </AuthCard>
    )
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    void run(async () => {
      const result = await approvePairing(code)
      setApproved(result.name)
    })
  }

  return (
    <AuthCard title="批准设备">
      <p className={styles.hint}>
        要连接的电脑或终端上会显示一个 8 位配对码。只批准你自己正在操作的设备；批准前会再验证一次通行密钥。
      </p>
      <form className={styles.form} onSubmit={submit}>
        <label className={styles.field} htmlFor={codeId}>
          配对码
          <Input
            autoCapitalize="characters"
            autoComplete="off"
            id={codeId}
            inputMode="text"
            maxLength={9}
            placeholder="ABCD-EFGH"
            spellCheck={false}
            value={code}
            onChange={(event) => setCode(event.target.value.toUpperCase())}
          />
        </label>
        <Button
          aria-busy={busy}
          className={styles.action}
          disabled={busy || code.replace(/[^A-Z0-9]/gu, "").length !== 8}
          size="lg"
          type="submit"
          variant="primary"
        >
          {busy ? "等待确认…" : "批准"}
        </Button>
      </form>
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
      <Button className={styles.action} size="lg" variant="ghost" onClick={onDone}>
        取消
      </Button>
    </AuthCard>
  )
}
