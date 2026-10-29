import { useEffect, useId, useRef, useState, type FormEvent } from "react"

import { PasswordInput } from "@/components/shard/password-input"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"

import { AuthError, confirmPassword, currentAccountEmail, registerPasswordPrompt } from "./api"
import styles from "./auth-pages.module.css"
import { fieldProps, FormField } from "./form-fields"

interface PendingPrompt {
  resolve: () => void
  reject: (error: unknown) => void
}

function cancelled() {
  return new AuthError("CANCELLED", "已取消。")
}

/**
 * 敏感操作前的密码确认框宿主（挂在 AuthGate 已登录的分支里）：`stepUp()` 经它弹出确认框，
 * 密码对了 resolve，取消以 CANCELLED reject。登录失效、宿主卸下时，等着的操作按取消处理。
 */
export function PasswordPromptHost() {
  const [pending, setPending] = useState<PendingPrompt | null>(null)
  const pendingRef = useRef<PendingPrompt | null>(null)

  useEffect(() => {
    const unregister = registerPasswordPrompt(
      () =>
        new Promise<void>((resolve, reject) => {
          const next = { resolve, reject }
          pendingRef.current = next
          setPending(next)
        })
    )
    return () => {
      unregister()
      pendingRef.current?.reject(cancelled())
      pendingRef.current = null
    }
  }, [])

  function settle(confirmed: boolean) {
    const current = pendingRef.current
    pendingRef.current = null
    setPending(null)
    if (confirmed) current?.resolve()
    else current?.reject(cancelled())
  }

  return pending ? <PasswordPromptDialog onCancel={() => settle(false)} onConfirmed={() => settle(true)} /> : null
}

function PasswordPromptDialog({ onCancel, onConfirmed }: { onCancel: () => void; onConfirmed: () => void }) {
  const [password, setPassword] = useState("")
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const passwordId = useId()
  // 隐藏的用户名字段：密码管理器据此认出是哪个账号的密码。
  const [email] = useState(currentAccountEmail)

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    if (!password) {
      setError("请输入密码。")
      inputRef.current?.focus()
      return
    }
    setBusy(true)
    setError("")
    try {
      await confirmPassword(password)
      onConfirmed()
    } catch (caught) {
      setBusy(false)
      setError(caught instanceof Error ? caught.message : String(caught))
      // 密码不对：清空重输。输入框忙碌时只读而不禁用，焦点一直留在里面。
      if (caught instanceof AuthError && caught.code === "INVALID_CREDENTIALS") setPassword("")
      inputRef.current?.focus()
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onCancel()}>
      <DialogContent aria-busy={busy} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>输入密码确认</DialogTitle>
        </DialogHeader>
        <form className={styles.form} noValidate onSubmit={(event) => void submit(event)}>
          {email ? <input autoComplete="username" hidden readOnly type="email" value={email} /> : null}
          {/* 只有一个字段：任何错误（密码不对、太频繁、连不上）都放在它下方那一行 */}
          <FormField error={error} htmlFor={passwordId} label="密码">
            <PasswordInput
              {...fieldProps(passwordId, error)}
              autoFocus
              credential="current-password"
              id={passwordId}
              onChange={(event) => {
                setPassword(event.target.value)
                setError("")
              }}
              readOnly={busy}
              ref={inputRef}
              value={password}
            />
          </FormField>
          <DialogFooter>
            <Button disabled={busy} onClick={onCancel} type="button" variant="outline">
              取消
            </Button>
            <Button aria-busy={busy} disabled={busy} type="submit">
              {busy ? "正在确认…" : "确认"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
