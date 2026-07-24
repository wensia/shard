import {
  LockKeyholeIcon,
  XIcon,
} from "lucide-react"
import { useEffect, useMemo, useState, type FormEvent } from "react"
import { save } from "@tauri-apps/plugin-dialog"

import { Button } from "@astryxdesign/core/Button"
import { HStack } from "@astryxdesign/core/HStack"
import { Stack } from "@astryxdesign/core/Stack"
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
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 60,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "color-mix(in oklab, var(--background) 89%, transparent)",
        paddingInline: "var(--shard-content-inset)",
        paddingBlock: "var(--shard-space-4)",
        backdropFilter: "blur(4px)",
      }}
    >
      <section
        aria-labelledby="lockbox-dialog-title"
        aria-modal="true"
        role="dialog"
        style={{
          position: "relative",
          width: "100%",
          maxWidth: 520,
          borderRadius: "var(--shard-surface-radius)",
          border: "1px solid var(--border)",
          background: "var(--card)",
          boxShadow: "var(--shard-shadow-popover)",
        }}
      >
        <Button
          icon={<XIcon size={16} />}
          isDisabled={isBusy || Boolean(recoveryKey)}
          isIconOnly
          label="关闭密匣弹窗"
          onClick={onClose}
          size="sm"
          style={{
            position: "absolute",
            top: "var(--shard-space-3)",
            right: "var(--shard-space-3)",
          }}
          type="button"
          variant="ghost"
        />

        <header
          style={{
            borderBottom: "1px solid var(--border)",
            paddingInline: "var(--shard-space-5)",
            paddingBlock: "var(--shard-space-4)",
            paddingRight: "calc(var(--shard-space-8) + 32px)",
          }}
        >
          <HStack gap={3} vAlign="center">
            <span
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: 36,
                height: 36,
                flexShrink: 0,
                borderRadius: "var(--shard-radius-control)",
                border: "1px solid var(--border)",
                background: "var(--background)",
                color: "var(--shard-sapphire)",
              }}
            >
              <LockKeyholeIcon size={18} strokeWidth={1.75} />
            </span>
            <div style={{ minWidth: 0 }}>
              <h2
                id="lockbox-dialog-title"
                style={{
                  margin: 0,
                  fontSize: "1rem",
                  lineHeight: "1.5rem",
                  fontWeight: 600,
                  textWrap: "balance",
                }}
              >
                {title()}
              </h2>
              <p
                style={{
                  margin: 0,
                  marginTop: "var(--shard-space-1)",
                  fontSize: "0.75rem",
                  lineHeight: "1.25rem",
                  textWrap: "pretty",
                  color: "var(--muted-foreground)",
                }}
              >
                本地加密，解锁后 15 分钟闲置自动上锁。
              </p>
            </div>
          </HStack>
        </header>

        <Stack gap={4} padding={5}>
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
              style={{ display: "flex", flexDirection: "column", gap: "var(--shard-space-3)" }}
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
              <HStack gap={3} hAlign="between" vAlign="center">
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
              </HStack>
            </form>
          ) : mode === "reset" ? (
            <form
              style={{ display: "flex", flexDirection: "column", gap: "var(--shard-space-3)" }}
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
              <HStack gap={3} hAlign="between">
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
              </HStack>
            </form>
          ) : mode === "change" ? (
            <form
              style={{ display: "flex", flexDirection: "column", gap: "var(--shard-space-3)" }}
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
            <div
              style={{
                borderRadius: "var(--shard-radius-control)",
                border: "1px solid rgb(var(--shard-ruby-rgb) / var(--shard-alpha-34))",
                background: "rgb(var(--shard-ruby-rgb) / var(--shard-alpha-8))",
                paddingInline: "var(--shard-space-3)",
                paddingBlock: "var(--shard-space-2)",
                fontSize: "0.75rem",
                lineHeight: "1.25rem",
                color: "var(--shard-ruby)",
              }}
            >
              {error}
            </div>
          ) : null}
        </Stack>
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
    <form
      style={{ display: "flex", flexDirection: "column", gap: "var(--shard-space-3)" }}
      onSubmit={onSubmit}
    >
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
    <Stack gap={3}>
      <p
        style={{
          margin: 0,
          fontSize: "0.875rem",
          lineHeight: "1.5rem",
          textWrap: "pretty",
          color: "var(--muted-foreground)",
        }}
      >
        这是唯一能保留密匣内容的重置凭据。Shard 不保存恢复密钥明文，关闭后不会再次显示。
      </p>
      <div
        style={{
          borderRadius: "var(--shard-radius-control)",
          border: "1px solid var(--border)",
          background: "var(--background)",
          padding: "var(--shard-space-3)",
          fontFamily: "var(--font-family-code)",
          fontSize: "0.875rem",
          lineHeight: "1.5rem",
          wordBreak: "break-all",
        }}
      >
        {recoveryKey}
      </div>
      <HStack gap={2} vAlign="center" wrap="wrap">
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
        <span
          style={{
            minWidth: 220,
            flex: "1 1 auto",
            fontSize: "0.75rem",
            lineHeight: "1.25rem",
            textWrap: "pretty",
            color: "var(--muted-foreground)",
          }}
        >
          输入最后一段{" "}
          <span style={{ fontFamily: "var(--font-family-code)", fontWeight: 600 }}>
            {code}
          </span>{" "}
          确认已保存。
        </span>
      </HStack>
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
    </Stack>
  )
}

function getRecoveryConfirmationCode(recoveryKey: string | null) {
  const parts = recoveryKey?.split("-").filter(Boolean) ?? []
  return parts[parts.length - 1] ?? ""
}

function getRecoveryKeyFileName(code: string) {
  return `shard-recovery-key${code ? `-${code}` : ""}.txt`
}
