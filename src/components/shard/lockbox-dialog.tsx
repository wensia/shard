import {
  useEffect,
  useMemo,
  useState,
  type ComponentProps,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react"
import { save } from "@tauri-apps/plugin-dialog"
import { ArrowBigUpIcon, XIcon } from "@/components/icons"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
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

const PASSWORD_INPUT_STYLE = {
  height: "var(--shard-space-8)",
  minHeight: "var(--shard-space-8)",
  borderRadius: "var(--shard-radius-control)",
} as const

/**
 * 密码输入框 + 大写锁定提示。刻意不用 type="password"：WKWebView 会在它上面
 * 直接绘制一个实底 Caps Lock 指示器，CSS 关不掉（详见 frontend-rules.css 里
 * data-shard-password 那段）。这里改用 type="text" + text-security 遮蔽，
 * 再用规范内的细线 ⇪ 自绘提示。因为不是真的 password 字段，浏览器不再托管
 * 遮蔽与复制保护，所以自动填充、拼写检查、复制剪切都在这里显式关掉。
 * 密匣空间的内联解锁面板复用同一个输入框。
 */
export function LockboxPasswordInput(props: ComponentProps<typeof Input>) {
  const [capsLockOn, setCapsLockOn] = useState(false)
  const syncCapsLock = (event: ReactKeyboardEvent<HTMLInputElement>) =>
    setCapsLockOn(event.getModifierState("CapsLock"))
  return (
    <div style={{ position: "relative" }}>
      <Input
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        data-shard-password="true"
        spellCheck={false}
        type="text"
        onBlur={() => setCapsLockOn(false)}
        onCopy={(event) => event.preventDefault()}
        onCut={(event) => event.preventDefault()}
        onKeyDown={syncCapsLock}
        onKeyUp={syncCapsLock}
        style={{
          ...PASSWORD_INPUT_STYLE,
          ...(capsLockOn ? { paddingRight: "var(--shard-space-8)" } : null),
        }}
        {...props}
      />
      {capsLockOn ? (
        <span
          role="status"
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            right: "var(--shard-space-3)",
            display: "inline-flex",
            alignItems: "center",
            color: "var(--muted-foreground)",
            pointerEvents: "none",
          }}
        >
          <ArrowBigUpIcon className="size-(--shard-icon-size-sm)" />
          <span className="sr-only">大写锁定已开启</span>
        </span>
      ) : null}
    </div>
  )
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

  // 恢复密钥必须展示，哪怕流程是由密匣空间的内联面板发起、没有弹窗 mode
  if (!mode && !recoveryKey) return null

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
    const message = validateLockboxPasswordPair(newPassword, repeatPassword)
    if (message) {
      setError(message)
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
    <Dialog
      open
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !isBusy && !recoveryKey) onClose()
      }}
    >
      <DialogContent
        aria-busy={isBusy}
        className="gap-0 overflow-hidden p-0 sm:max-w-[440px]"
        showCloseButton={false}
      >
        <DialogHeader className="relative gap-1 border-b border-border px-4 py-3">
          <DialogTitle>{title()}</DialogTitle>
          <DialogDescription>
            本地加密，解锁后闲置数分钟自动上锁。
          </DialogDescription>
          {!isBusy && !recoveryKey ? (
            <Button
              aria-label="关闭"
              className="absolute right-2 top-2"
              onClick={onClose}
              size="icon-sm"
              type="button"
              variant="ghost"
            >
              <XIcon aria-hidden="true" />
              <span className="sr-only">关闭</span>
            </Button>
          ) : null}
        </DialogHeader>
        <div className="p-4">
          <div className="flex flex-col gap-4">
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
              <label className="sr-only" htmlFor="lockbox-password">
                密匣密码
              </label>
              <LockboxPasswordInput
                autoFocus
                disabled={isBusy}
                id="lockbox-password"
                onChange={(event) => setPassword(event.target.value)}
                placeholder="密匣密码"
                value={password}
              />
              <div className="flex items-center justify-between gap-3">
                <Button
                  disabled={isBusy}
                  onClick={() => onModeChange("reset")}
                  type="button"
                  variant="ghost"
                >
                  忘记密码
                </Button>
                <Button
                  disabled={isBusy || !password}
                  type="submit"
                  variant="default"
                >
                  {isBusy ? "解锁中" : "解锁"}
                </Button>
              </div>
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
              <label className="sr-only" htmlFor="lockbox-recovery-key">
                恢复密钥
              </label>
              <Input
                disabled={isBusy}
                id="lockbox-recovery-key"
                onChange={(event) => setRecoveryInput(event.target.value)}
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
              <div className="flex justify-between gap-3">
                <Button
                  disabled={isBusy}
                  onClick={() => onModeChange("unlock")}
                  type="button"
                  variant="ghost"
                >
                  返回解锁
                </Button>
                <Button
                  disabled={isBusy || !recoveryInput}
                  type="submit"
                  variant="default"
                >
                  {isBusy ? "重置中" : "重置密码"}
                </Button>
              </div>
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
              <label className="sr-only" htmlFor="lockbox-current-password">
                当前密码
              </label>
              <LockboxPasswordInput
                autoFocus
                disabled={isBusy}
                id="lockbox-current-password"
                onChange={(event) => setCurrentPassword(event.target.value)}
                placeholder="当前密码"
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
                disabled={isBusy || !currentPassword}
                type="submit"
                variant="default"
              >
                {isBusy ? "修改中" : "修改密码"}
              </Button>
            </form>
          ) : null}

            <LockboxFormError message={error} />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** 密匣表单的统一错误条，弹窗与内联解锁面板共用。 */
export function LockboxFormError({ message }: { message: string }) {
  if (!message) return null
  return (
    <div
      role="alert"
      style={{
        borderRadius: "var(--shard-radius-control)",
        border: "1px solid rgb(var(--shard-ruby-rgb) / var(--shard-alpha-34))",
        background: "rgb(var(--shard-ruby-rgb) / var(--shard-alpha-8))",
        paddingInline: "var(--shard-space-3)",
        paddingBlock: "var(--shard-space-2)",
        fontSize: "0.75rem",
        lineHeight: "1.25rem",
        textWrap: "pretty",
        color: "var(--shard-ruby)",
      }}
    >
      {message}
    </div>
  )
}

/**
 * 新密码校验：长度与两次输入一致性。返回错误文案，通过则返回 null。
 * 弹窗与内联重置面板共用同一套规则。
 */
export function validateLockboxPasswordPair(
  newPassword: string,
  repeatPassword: string
) {
  if (newPassword.length < 8) return "密匣密码至少需要 8 个字符。"
  if (newPassword !== repeatPassword) return "两次输入的密码不一致。"
  return null
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
        disabled={isBusy}
        type="submit"
        variant="default"
      >
        {isBusy ? busyLabel : submitLabel}
      </Button>
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
      <label className="sr-only" htmlFor="lockbox-new-password">
        新密码，至少 8 个字符
      </label>
      <LockboxPasswordInput
        autoFocus
        disabled={isBusy}
        id="lockbox-new-password"
        onChange={(event) => onNewPassword(event.target.value)}
        placeholder="新密码，至少 8 个字符"
        value={newPassword}
      />
      <label className="sr-only" htmlFor="lockbox-repeat-password">
        再次输入新密码
      </label>
      <LockboxPasswordInput
        disabled={isBusy}
        id="lockbox-repeat-password"
        onChange={(event) => onRepeatPassword(event.target.value)}
        placeholder="再次输入新密码"
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
      toast("恢复密钥已下载")
    } catch (error) {
      toast.error(`下载恢复密钥失败：${getApiErrorMessage(error)}`, {
        duration: Infinity,
      })
    } finally {
      setIsDownloading(false)
    }
  }

  return (
    <div className="flex flex-col gap-3">
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
      <div className="flex flex-wrap items-center gap-2">
        <Button
          onClick={() => {
            void navigator.clipboard?.writeText(recoveryKey)
          }}
          type="button"
          variant="secondary"
        >
          复制
        </Button>
        <Button
          disabled={isDownloading}
          onClick={() => {
            void downloadRecoveryKey()
          }}
          type="button"
          variant="secondary"
        >
          {isDownloading ? "下载中" : "下载"}
        </Button>
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
      </div>
      <label className="sr-only" htmlFor="lockbox-recovery-confirmation">
        确认恢复密钥
      </label>
      <Input
        id="lockbox-recovery-confirmation"
        onChange={(event) => setRecoveryVerify(event.target.value)}
        placeholder={code}
        value={recoveryVerify}
      />
      <Button
        disabled={!confirmed}
        onClick={onClose}
        type="button"
        variant="default"
      >
        我已保存恢复密钥
      </Button>
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
