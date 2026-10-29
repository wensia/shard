import { useState, type ComponentProps, type ReactNode } from "react"

import { EyeIcon, EyeOffIcon } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"

import styles from "./auth-pages.module.css"

/*
 * 网页端账号表单的积木：登录页、设置 / 重置页、密码确认框、设置里的「修改邮箱或密码」共用。
 */

/**
 * 一个字段：标签在上、控件在下，可带一行说明。标签用 htmlFor 关联而不包住控件——
 * 密码框里有「显示密码」按钮，包在 label 里会把按钮名并进输入框的可访问名称。
 */
export function FormField({
  children,
  hint,
  hintId,
  htmlFor,
  label,
}: {
  children: ReactNode
  hint?: ReactNode
  hintId?: string
  htmlFor: string
  label: ReactNode
}) {
  return (
    <div className={styles.field}>
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {hint ? (
        <p className={styles.fieldHint} id={hintId}>
          {hint}
        </p>
      ) : null}
    </div>
  )
}

/** 表单底部的错误行：屏幕阅读器立即读出。 */
export function FormError({ id, message }: { id?: string; message: string }) {
  if (!message) return null
  return (
    <p className={styles.error} id={id} role="alert">
      {message}
    </p>
  )
}

/**
 * 账号密码框（kiln Password Input：框内右侧带显示 / 隐藏按钮）。
 *
 * 这里是真的 `type="password"`：浏览器与 iCloud 钥匙串据此识别、填充、保存账号密码，配合
 * `autoComplete="new-password"` 还会建议强密码。只用在网页端——桌面 WKWebView 会在 type="password"
 * 上画实底大写锁定指示器，桌面的密码框用 LockboxPasswordInput（见 frontend-rules.css）。
 */
export function PasswordInput({ className, disabled, ...props }: Omit<ComponentProps<typeof Input>, "type">) {
  const [visible, setVisible] = useState(false)
  return (
    <div className={styles.passwordBox}>
      <Input
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        {...props}
        className={cn(styles.passwordInput, className)}
        disabled={disabled}
        type={visible ? "text" : "password"}
      />
      <span className={styles.passwordToggle}>
        <Button
          aria-label={visible ? "隐藏密码" : "显示密码"}
          aria-pressed={visible}
          className="text-muted-foreground hover:text-foreground"
          disabled={disabled}
          onClick={() => setVisible((value) => !value)}
          // 点按不抢走输入框焦点，光标留在原位继续输入
          onMouseDown={(event) => event.preventDefault()}
          size="icon-sm"
          type="button"
          variant="ghost"
        >
          {visible ? <EyeOffIcon /> : <EyeIcon />}
        </Button>
      </span>
    </div>
  )
}
