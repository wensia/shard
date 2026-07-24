import {
  LockKeyholeIcon,
  XIcon,
} from "lucide-react"
import { useEffect, useMemo, useState, type FormEvent } from "react"
import { save } from "@tauri-apps/plugin-dialog"

import { Button } from "@astryxdesign/core/Button"
import { TextInput } from "@astryxdesign/core/TextInput"
import { useToast } from "@astryxdesign/core/Toast"
import { getApiErrorMessage, saveRecoveryKey } from "@/lib/api"

export type LockboxDialogMode = "change" | "reset" | "setup" | "unlock"

interface LockboxDialogProps {
  mode: LockboxDialogMode | null
  recoveryKey: string | null
  onChangePassword: (currentPassword: string, newPassword: string) => Promise<void>
  onClose: () => void
  onModeChange: (mode: LockboxDialogMode) => void
  onReset: (recoveryKey: string, newPassword: string) => Promise<void>
  onSetup: (password: string) => Promise<void>
  onUnlock: (password: string) => Promise<void>
}

export function LockboxDialog({
  mode,
  recoveryKey,
  onChangePassword,
  onClose,
  onModeChange,
  onReset,
  onSetup,
  onUnlock,
}: LockboxDialogProps) {
  const [currentPassword, setCurrentPassword] = useState("")
  const [error, setError] = useState("")
  const [isBusy, setIsBusy] = useState(false)
  const [newPassword, setNewPassword] = useState("")
  const [password, setPassword] = useState("")
  const [recoveryInput, setRecoveryInput] = useState("")
  const [recoveryVerify, setRecoveryVerify] = useState("")
  const [repeatPassword, setRepeatPassword] = useState("")
  const recoveryCode = useMemo(
    () => getRecoveryConfirmationCode(recoveryKey),
    [recoveryKey]
  )

  useEffect(() => {
    setCurrentPassword("")
    setError("")
    setIsBusy(false)
    setNewPassword("")
    setPassword("")
    setRecoveryInput("")
    setRecoveryVerify("")
    setRepeatPassword("")
  }, [mode, recoveryKey])

  if (!mode) return null

  async function submit(action: () => Promise<void>) {
    setError("")
    setIsBusy(true)
    try {
      await action()
    } catch (error) {
      setError(getApiErrorMessage(error))
    } finally {
      setIsBusy(false)
    }
  }

  function validateNewPassword() {
    if (newPassword.length < 8) {
      setError("密匣密码至少需要 8 个字符。")
      return false
    }
    if (newPassword !== repeatPassword) {
      setError("两次输入的密码不一致。")
      return false
    }
    return true
  }

  function title() {
    if (recoveryKey) return "保存恢复密钥"
    if (mode === "setup") return "设置密匣"
    if (mode === "unlock") return "解锁密匣"
    if (mode === "reset") return "重置密匣密码"
    return "修改密匣密码"
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-background/[var(--shard-alpha-89)] px-[var(--shard-content-inset)] py-[var(--shard-space-4)] backdrop-blur-sm">
      <section
        aria-labelledby="lockbox-dialog-title"
        aria-modal="true"
        className="relative w-full max-w-[520px] rounded-[var(--shard-surface-radius)] border border-border bg-card shadow-popover"
        role="dialog"
      >
        <Button
          className="absolute top-[var(--shard-space-3)] right-[var(--shard-space-3)]"
          icon={<XIcon data-icon="inline-start" />}
          isDisabled={isBusy || Boolean(recoveryKey)}
          isIconOnly
          label="关闭密匣弹窗"
          onClick={onClose}
          size="sm"
          type="button"
          variant="ghost"
        />

        <header className="border-b border-border px-[var(--shard-space-5)] py-[var(--shard-space-4)] pr-[calc(var(--shard-space-8)+32px)]">
          <div className="flex items-center gap-[var(--shard-space-3)]">
            <span className="flex size-9 items-center justify-center rounded-[var(--shard-radius-control)] border border-border bg-background text-[color:var(--shard-sapphire)]">
              <LockKeyholeIcon className="size-[18px] stroke-[1.75]" />
            </span>
            <div className="min-w-0">
              <h2
                className="text-base leading-6 font-semibold text-balance"
                id="lockbox-dialog-title"
              >
                {title()}
              </h2>
              <p className="mt-1 text-xs leading-5 text-pretty text-muted-foreground">
                本地加密，解锁后 15 分钟闲置自动上锁。
              </p>
            </div>
          </div>
        </header>

        <div className="grid gap-[var(--shard-space-4)] px-[var(--shard-space-5)] py-[var(--shard-space-5)]">
          {recoveryKey ? (
            <RecoveryKeyStep
              code={recoveryCode}
              recoveryKey={recoveryKey}
              recoveryVerify={recoveryVerify}
              setRecoveryVerify={setRecoveryVerify}
              onClose={onClose}
            />
          ) : mode === "setup" ? (
            <PasswordPairForm
              busyLabel="设置中"
              isBusy={isBusy}
              newPassword={newPassword}
              repeatPassword={repeatPassword}
              submitLabel="设置密匣"
              onNewPassword={setNewPassword}
              onRepeatPassword={setRepeatPassword}
              onSubmit={(event) => {
                event.preventDefault()
                if (!validateNewPassword()) return
                void submit(() => onSetup(newPassword))
              }}
            />
          ) : mode === "unlock" ? (
            <form
              className="grid gap-[var(--shard-space-3)]"
              onSubmit={(event) => {
                event.preventDefault()
                void submit(() => onUnlock(password))
              }}
            >
              <TextInput
                hasAutoFocus
                isDisabled={isBusy}
                isLabelHidden
                label="密匣密码"
                onChange={(value) => setPassword(value)}
                placeholder="密匣密码"
                type="password"
                value={password}
              />
              <div className="flex items-center justify-between gap-[var(--shard-space-3)]">
                <Button
                  isDisabled={isBusy}
                  label="忘记密码"
                  onClick={() => onModeChange("reset")}
                  type="button"
                  variant="ghost"
                />
                <Button
                  isDisabled={isBusy || !password}
                  label={isBusy ? "解锁中" : "解锁"}
                  type="submit"
                  variant="primary"
                />
              </div>
            </form>
          ) : mode === "reset" ? (
            <form
              className="grid gap-[var(--shard-space-3)]"
              onSubmit={(event) => {
                event.preventDefault()
                if (!validateNewPassword()) return
                void submit(() => onReset(recoveryInput, newPassword))
              }}
            >
              <TextInput
                isDisabled={isBusy}
                isLabelHidden
                label="恢复密钥"
                onChange={(value) => setRecoveryInput(value)}
                placeholder="恢复密钥"
                value={recoveryInput}
              />
              <PasswordPairFields
                isBusy={isBusy}
                newPassword={newPassword}
                repeatPassword={repeatPassword}
                onNewPassword={setNewPassword}
                onRepeatPassword={setRepeatPassword}
              />
              <div className="flex justify-between gap-[var(--shard-space-3)]">
                <Button
                  isDisabled={isBusy}
                  label="返回解锁"
                  onClick={() => onModeChange("unlock")}
                  type="button"
                  variant="ghost"
                />
                <Button
                  isDisabled={isBusy || !recoveryInput}
                  label={isBusy ? "重置中" : "重置密码"}
                  type="submit"
                  variant="primary"
                />
              </div>
            </form>
          ) : mode === "change" ? (
            <form
              className="grid gap-[var(--shard-space-3)]"
              onSubmit={(event) => {
                event.preventDefault()
                if (!validateNewPassword()) return
                void submit(() => onChangePassword(currentPassword, newPassword))
              }}
            >
              <TextInput
                hasAutoFocus
                isDisabled={isBusy}
                isLabelHidden
                label="当前密码"
                onChange={(value) => setCurrentPassword(value)}
                placeholder="当前密码"
                type="password"
                value={currentPassword}
              />
              <PasswordPairFields
                isBusy={isBusy}
                newPassword={newPassword}
                repeatPassword={repeatPassword}
                onNewPassword={setNewPassword}
                onRepeatPassword={setRepeatPassword}
              />
              <Button
                isDisabled={isBusy || !currentPassword}
                label={isBusy ? "修改中" : "修改密码"}
                type="submit"
                variant="primary"
              />
            </form>
          ) : null}

          {error ? (
            <div className="rounded-[var(--shard-radius-control)] border border-[rgb(var(--shard-ruby-rgb)/var(--shard-alpha-34))] bg-[rgb(var(--shard-ruby-rgb)/var(--shard-alpha-8))] px-[var(--shard-space-3)] py-[var(--shard-space-2)] text-xs leading-5 text-[color:var(--shard-ruby)]">
              {error}
            </div>
          ) : null}
        </div>
      </section>
    </div>
  )
}

function PasswordPairForm({
  busyLabel,
  isBusy,
  newPassword,
  repeatPassword,
  submitLabel,
  onNewPassword,
  onRepeatPassword,
  onSubmit,
}: {
  busyLabel: string
  isBusy: boolean
  newPassword: string
  repeatPassword: string
  submitLabel: string
  onNewPassword: (value: string) => void
  onRepeatPassword: (value: string) => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
}) {
  return (
    <form className="grid gap-[var(--shard-space-3)]" onSubmit={onSubmit}>
      <PasswordPairFields
        isBusy={isBusy}
        newPassword={newPassword}
        repeatPassword={repeatPassword}
        onNewPassword={onNewPassword}
        onRepeatPassword={onRepeatPassword}
      />
      <Button
        isDisabled={isBusy}
        label={isBusy ? busyLabel : submitLabel}
        type="submit"
        variant="primary"
      />
    </form>
  )
}

function PasswordPairFields({
  isBusy,
  newPassword,
  repeatPassword,
  onNewPassword,
  onRepeatPassword,
}: {
  isBusy: boolean
  newPassword: string
  repeatPassword: string
  onNewPassword: (value: string) => void
  onRepeatPassword: (value: string) => void
}) {
  return (
    <>
      <TextInput
        hasAutoFocus
        isDisabled={isBusy}
        isLabelHidden
        label="新密码，至少 8 个字符"
        onChange={(value) => onNewPassword(value)}
        placeholder="新密码，至少 8 个字符"
        type="password"
        value={newPassword}
      />
      <TextInput
        isDisabled={isBusy}
        isLabelHidden
        label="再次输入新密码"
        onChange={(value) => onRepeatPassword(value)}
        placeholder="再次输入新密码"
        type="password"
        value={repeatPassword}
      />
    </>
  )
}

function RecoveryKeyStep({
  code,
  recoveryKey,
  recoveryVerify,
  setRecoveryVerify,
  onClose,
}: {
  code: string
  recoveryKey: string
  recoveryVerify: string
  setRecoveryVerify: (value: string) => void
  onClose: () => void
}) {
  const toast = useToast()
  const [isDownloading, setIsDownloading] = useState(false)
  const confirmed = recoveryVerify.trim().toLowerCase() === code.toLowerCase()

  async function downloadRecoveryKey() {
    setIsDownloading(true)
    try {
      const path = await save({
        defaultPath: getRecoveryKeyFileName(code),
        filters: [{ name: "Text", extensions: ["txt"] }],
        title: "下载恢复密钥",
      })

      if (!path) return

      await saveRecoveryKey(path, recoveryKey)
      toast({ body: "恢复密钥已下载" })
    } catch (error) {
      toast({
        body: `下载恢复密钥失败：${getApiErrorMessage(error)}`,
        type: "error",
      })
    } finally {
      setIsDownloading(false)
    }
  }

  return (
    <div className="grid gap-[var(--shard-space-3)]">
      <p className="text-sm leading-6 text-pretty text-muted-foreground">
        这是唯一能保留密匣内容的重置凭据。Shard 不保存恢复密钥明文，关闭后不会再次显示。
      </p>
      <div className="rounded-[var(--shard-radius-control)] border border-border bg-background p-[var(--shard-space-3)] font-mono text-sm leading-6 break-all">
        {recoveryKey}
      </div>
      <div className="flex flex-wrap items-center gap-[var(--shard-space-2)]">
        <Button
          label="复制"
          onClick={() => {
            void navigator.clipboard?.writeText(recoveryKey)
          }}
          type="button"
          variant="secondary"
        />
        <Button
          isDisabled={isDownloading}
          label={isDownloading ? "下载中" : "下载"}
          onClick={() => {
            void downloadRecoveryKey()
          }}
          type="button"
          variant="secondary"
        />
        <span className="min-w-[220px] flex-1 text-xs leading-5 text-pretty text-muted-foreground">
          输入最后一段 <span className="font-mono font-semibold">{code}</span> 确认已保存。
        </span>
      </div>
      <TextInput
        isLabelHidden
        label="确认恢复密钥"
        onChange={(value) => setRecoveryVerify(value)}
        placeholder={code}
        value={recoveryVerify}
      />
      <Button
        isDisabled={!confirmed}
        label="我已保存恢复密钥"
        onClick={onClose}
        type="button"
        variant="primary"
      />
    </div>
  )
}

function getRecoveryConfirmationCode(recoveryKey: string | null) {
  const parts = recoveryKey?.split("-").filter(Boolean) ?? []
  return parts[parts.length - 1] ?? ""
}

function getRecoveryKeyFileName(code: string) {
  return `shard-recovery-key${code ? `-${code}` : ""}.txt`
}
