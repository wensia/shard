import { useState, type ReactNode } from "react"

import styles from "./auth-pages.module.css"

/*
 * 网页端账号表单的积木：登录页、设置 / 重置页、密码确认框、设置里的「修改邮箱或密码」共用。
 * 密码框用全应用共享的 PasswordInput（components/shard/password-input.tsx，网页账号密码传 credential）。
 */

/** 字段下方那一行（说明或错误）的 id：输入框用 aria-describedby 指向它。 */
function subtextId(htmlFor: string) {
  return `${htmlFor}-subtext`
}

/**
 * 输入框的无障碍属性：出错时标红（aria-invalid 由共享 Input 画成错误边框与环），
 * 并关联到字段下方那一行。
 */
export function fieldProps(htmlFor: string, error: string | undefined, hint?: ReactNode) {
  return {
    "aria-invalid": error ? true : undefined,
    "aria-describedby": error || hint ? subtextId(htmlFor) : undefined,
  }
}

/**
 * 一个字段：标签在上、控件在下，下方最多一行字（kiln Field Group）——出错时错误替换说明，
 * 改对后说明回来。标签用 htmlFor 关联而不包住控件：密码框里有「显示密码」按钮，
 * 包在 label 里会把按钮名并进输入框的可访问名称。
 */
export function FormField({
  children,
  error,
  hint,
  htmlFor,
  label,
}: {
  children: ReactNode
  error?: string
  hint?: ReactNode
  htmlFor: string
  label: ReactNode
}) {
  return (
    <div className={styles.field}>
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {error ? (
        <p className={styles.fieldError} id={subtextId(htmlFor)} role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className={styles.fieldHint} id={subtextId(htmlFor)}>
          {hint}
        </p>
      ) : null}
    </div>
  )
}

/** 表单级的状态（服务器拒绝、连不上）：放在提交按钮旁边，屏幕阅读器立即读出。字段自己的错误用 FormField 的 error。 */
export function FormError({ message }: { message: string }) {
  if (!message) return null
  return (
    <p className={styles.error} role="alert">
      {message}
    </p>
  )
}

export type FieldErrors<Field extends string> = Partial<Record<Field, string>>

/**
 * 字段错误：提交时才校验（kiln：校验在意图之后，不在打开时）；出过错的字段在用户改的过程中
 * 按新值重新检查，改对了错误就消失。
 */
export function useFieldErrors<Field extends string>() {
  const [errors, setErrors] = useState<FieldErrors<Field>>({})
  /** 字段改动后：只更新已经报过错的字段（`problem` 按新值算好传进来）。 */
  const revalidate = (field: Field, problem: string | null) =>
    setErrors((current) => (current[field] ? { ...current, [field]: problem ?? undefined } : current))
  return { errors, setErrors, revalidate }
}
