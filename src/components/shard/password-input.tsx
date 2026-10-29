import {
  useRef,
  useState,
  type ComponentProps,
  type CompositionEvent as ReactCompositionEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react"

import { ArrowBigUpIcon, EyeIcon, EyeOffIcon } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { isWebRuntime } from "@/lib/transport"

// 高度绑控件 token：与同排的按钮同高，并随密度档变化（原来写死 32px，和 sm 按钮差一档）。
const PASSWORD_INPUT_STYLE = {
  height: "var(--control-height)",
  minHeight: "var(--control-height)",
  borderRadius: "var(--shard-radius-control)",
} as const

/** 输入法组合期间被丢弃时给用户的提示，宿主可接管显示位置（见 onImeBlockedChange）。 */
export const PASSWORD_IME_HINT = "请切换到英文输入法"

type PasswordInputProps = ComponentProps<typeof Input> & {
  /**
   * 账号密码（登录、设置、改密码）：网页上用真正的 `type="password"`，并按它设 autocomplete，
   * 浏览器与 iCloud 钥匙串才认得出、填得进、存得下，new-password 还会建议强密码。
   * 桌面 WKWebView 上照旧是遮蔽文本（理由见下）。不传（密匣口令）时各端都是遮蔽文本。
   */
  credential?: "current-password" | "new-password"
  /**
   * 密码框拦下输入法组合时通知宿主，由宿主把提示放进字段下方唯一的那一行
   * （kiln：一行说明，出错时替换）。不传时组件在自身下方显示提示。
   */
  onImeBlockedChange?: (blocked: boolean) => void
}

/**
 * 全应用唯一的密码输入框（kiln Password Input）：框内右侧显示 / 隐藏按钮、不接受输入法组合。
 * 密匣口令、网页登录与改密码、桌面连接服务器都用它。
 *
 * 默认刻意不用 type="password"：WKWebView 会在它上面直接绘制一个实底 Caps Lock 指示器，CSS 关不掉
 * （详见 frontend-rules.css 里 data-shard-password 那段）。这里改用 type="text" + text-security 遮蔽，
 * 再用规范内的细线 ⇪ 自绘提示。因为不是真的 password 字段，浏览器不再托管遮蔽与复制保护，
 * 所以自动填充、拼写检查、复制剪切都在这里显式关掉。网页上的账号密码见 `credential`。
 */
export function PasswordInput({ credential, onImeBlockedChange, ref, ...props }: PasswordInputProps) {
  const [capsLockOn, setCapsLockOn] = useState(false)
  const [revealed, setRevealed] = useState(false)
  const [imeBlocked, setImeBlocked] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)
  // 组合开始前的值与选区：组合产生的字符一律丢弃，恢复到这里
  const beforeCompositionRef = useRef<{ value: string; start: number; end: number } | null>(null)
  // 真正的 password 字段：浏览器托管遮蔽、复制保护与大写锁定提示（Safari 自己画），这里不再重复
  const native = Boolean(credential) && isWebRuntime()
  const syncCapsLock = (event: ReactKeyboardEvent<HTMLInputElement>) =>
    setCapsLockOn(!native && event.getModifierState("CapsLock"))
  const disabled = Boolean(props.disabled)

  function setBlocked(next: boolean) {
    setImeBlocked(next)
    onImeBlockedChange?.(next)
  }

  function assignRef(node: HTMLInputElement | null) {
    inputRef.current = node
    if (typeof ref === "function") ref(node)
    else if (ref) (ref as { current: HTMLInputElement | null }).current = node
  }

  /**
   * 把值恢复到组合开始前。经原生 setter + input 事件回写，受控组件的 onChange 能收到。
   * compositionend 与下一帧各恢复一次；快照要留到下一帧才清——有的输入法在失焦后
   * 才把组合文字提交进来，只在 compositionend 恢复会漏掉它。
   */
  function restoreBeforeComposition(input: HTMLInputElement, final = false) {
    const snapshot = beforeCompositionRef.current
    if (final) beforeCompositionRef.current = null
    if (!snapshot) return
    if (input.value !== snapshot.value) {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, snapshot.value)
      input.dispatchEvent(new Event("input", { bubbles: true }))
    }
    input.setSelectionRange(snapshot.start, snapshot.end)
  }

  /**
   * 密码框不接受输入法（kiln Password Input）。遮蔽文本是 type="text"，显示明文时真正的 password 字段
   * 也变成 type="text"，浏览器都不会自动切到英文键盘，所以在组合一开始就：记下原值 → 失焦让
   * 输入法提交或取消组合、收起候选窗 → 下一帧重新聚焦并恢复原值。拼音不会在候选窗里
   * 累积，也不会进入输入法的词库；组合产出的字符永远不进密码。
   */
  function blockComposition(event: ReactCompositionEvent<HTMLInputElement>) {
    const input = event.currentTarget
    beforeCompositionRef.current ??= {
      value: input.value,
      start: input.selectionStart ?? input.value.length,
      end: input.selectionEnd ?? input.value.length,
    }
    setBlocked(true)
    input.blur()
    requestAnimationFrame(() => {
      input.focus({ preventScroll: true })
      restoreBeforeComposition(input, true)
    })
  }

  return (
    <div>
      <div style={{ position: "relative" }}>
        <Input
          autoCapitalize="off"
          autoComplete={native ? credential : "off"}
          autoCorrect="off"
          // 遮蔽文本的钩子（frontend-rules.css 以它画圆点）；显示明文与真正的 password 字段都不要
          data-shard-password={native || revealed ? undefined : "true"}
          spellCheck={false}
          type={native && !revealed ? "password" : "text"}
          onBlur={() => setCapsLockOn(false)}
          onCompositionStart={blockComposition}
          onBeforeInput={(event) => {
            // 组合类输入能取消的引擎直接取消；不能取消的由组合结束后的恢复兜底
            const inputType = (event.nativeEvent as InputEvent).inputType
            if (inputType === "insertCompositionText" || inputType === "insertFromComposition") event.preventDefault()
          }}
          onCompositionEnd={(event) => restoreBeforeComposition(event.currentTarget)}
          onCopy={(event) => event.preventDefault()}
          onCut={(event) => event.preventDefault()}
          onKeyDown={(event) => {
            syncCapsLock(event)
            // 切回英文后正常敲下一个字符，提示随之消失
            if (imeBlocked && !event.nativeEvent.isComposing && event.key.length === 1) setBlocked(false)
          }}
          onKeyUp={syncCapsLock}
          style={{
            ...PASSWORD_INPUT_STYLE,
            // 右侧给显示/隐藏按钮留位（按钮 + 两侧间隙，kiln 的 pr-10）；大写锁定提示出现时再多留一格
            paddingRight: capsLockOn
              ? "calc(var(--control-height-sm) + var(--shard-space-2) + var(--shard-space-6))"
              : "calc(var(--control-height-sm) + var(--shard-space-2))",
          }}
          {...props}
          ref={assignRef}
        />
        <span
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            right: "var(--shard-space-1)",
            display: "inline-flex",
            alignItems: "center",
            gap: "var(--shard-space-1)",
            color: "var(--muted-foreground)",
          }}
        >
          {capsLockOn ? (
            <span role="status" style={{ display: "inline-flex", pointerEvents: "none" }}>
              <ArrowBigUpIcon className="size-(--shard-icon-size-sm)" />
              <span className="sr-only">大写锁定已开启</span>
            </span>
          ) : null}
          {/* 输入框内的显隐开关：嵌在输入边界里的图标控件，静止时保持安静（kiln Password Input） */}
          <Button
            aria-label={revealed ? "隐藏密码" : "显示密码"}
            aria-pressed={revealed}
            disabled={disabled}
            onClick={() => setRevealed((value) => !value)}
            // 点按不抢走输入框焦点，光标留在原位继续输入
            onMouseDown={(event) => event.preventDefault()}
            size="icon-sm"
            type="button"
            variant="ghost"
          >
            {revealed ? <EyeOffIcon /> : <EyeIcon />}
          </Button>
        </span>
      </div>
      {imeBlocked && !onImeBlockedChange ? (
        <p
          role="status"
          style={{
            margin: "var(--shard-space-1) 0 0",
            color: "var(--muted-foreground)",
            fontSize: "var(--text-meta)",
          }}
        >
          {PASSWORD_IME_HINT}
        </p>
      ) : null}
    </div>
  )
}
