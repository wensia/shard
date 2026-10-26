import { useRef, type PointerEvent } from "react"

/**
 * 触屏长按打开自定义菜单。
 *
 * iOS Safari 长按不派发 contextmenu（main.tsx 还在全局拦截原生右键菜单），只认右键的自定义菜单
 * 在手机上就打不开。这里按 pointer 事件计时：手指按住 500ms 不动就触发；移动超过阈值、抬起、
 * 被浏览器接管成滚动（pointercancel）都取消。只认 touch / pen，鼠标仍走右键。
 *
 * 触发后这次按压的抬起（pointerup 与随后补发的兼容鼠标事件）在 window 捕获阶段就被吞掉：既不会「打开」
 * 手指下的条目，也不会被刚弹出的菜单当成外部点击立刻关掉。嵌套的长按区域（条目在目录空白区里）
 * 由最内层先认领这次按压，外层不再计时。
 */

export const LONG_PRESS_DELAY_MS = 500
export const LONG_PRESS_MOVE_TOLERANCE_PX = 10

export interface LongPressDetail {
  x: number
  y: number
  /** 按下时手指下面的元素。 */
  target: EventTarget | null
  /** 挂着长按处理的元素。 */
  currentTarget: HTMLElement
}

const claimedPresses = new WeakSet<Event>()
// 触屏抬手后浏览器还会补发兼容鼠标事件（mousedown → mouseup → click），菜单把其中的 mousedown 当外部点击。
const RELEASE_EVENTS = ["pointerup", "mousedown", "mouseup", "click"] as const

/** 吞掉本次按压剩下的抬起事件，直到下一次按下（Android 长按后不派发 click，靠下一次按下收尾）。 */
function swallowRelease() {
  const swallow = (event: Event) => {
    event.preventDefault()
    // 菜单的外部点击监听也挂在 window 捕获阶段，必须连同一目标上的其他监听一起拦下。
    event.stopImmediatePropagation()
    if (event.type === "click") finish()
  }
  const finish = () => {
    for (const type of RELEASE_EVENTS) window.removeEventListener(type, swallow, true)
    window.removeEventListener("pointerdown", finish, true)
  }
  for (const type of RELEASE_EVENTS) window.addEventListener(type, swallow, true)
  window.addEventListener("pointerdown", finish, true)
}

/** 回调返回 false 表示这次长按不处理（例如按在输入框上），抬手照常派发。 */
export function useLongPress(onLongPress: (detail: LongPressDetail) => boolean | void) {
  const callback = useRef(onLongPress)
  callback.current = onLongPress
  const press = useRef<{ pointerId: number; timer: number; x: number; y: number } | null>(null)

  const cancel = () => {
    if (!press.current) return
    window.clearTimeout(press.current.timer)
    press.current = null
  }

  return {
    onPointerDown(event: PointerEvent<HTMLElement>) {
      cancel()
      if (event.pointerType === "mouse" || !event.isPrimary || claimedPresses.has(event.nativeEvent)) return
      claimedPresses.add(event.nativeEvent)
      const { clientX: x, clientY: y, pointerId, target, currentTarget } = event
      press.current = {
        pointerId,
        x,
        y,
        timer: window.setTimeout(() => {
          press.current = null
          if (callback.current({ x, y, target, currentTarget }) !== false) swallowRelease()
        }, LONG_PRESS_DELAY_MS),
      }
    },
    onPointerMove(event: PointerEvent<HTMLElement>) {
      const current = press.current
      if (!current || event.pointerId !== current.pointerId) return
      if (Math.hypot(event.clientX - current.x, event.clientY - current.y) > LONG_PRESS_MOVE_TOLERANCE_PX) cancel()
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    /**
     * Android Chrome 长按会自己派发 contextmenu：交给宿主的右键处理去开菜单，
     * 这里只取消计时并吞掉随后的抬起，避免同一次长按开两遍或开了又关。
     */
    takeOverByContextMenu() {
      if (!press.current) return
      cancel()
      swallowRelease()
    },
  }
}
