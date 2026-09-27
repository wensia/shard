import { useLayoutEffect, useRef } from "react"
import { createPortal } from "react-dom"

import type { SuggestionMenuHost, SuggestionMenuState } from "./menu-host"

interface SuggestionMenuProps {
  host: SuggestionMenuHost
  state: SuggestionMenuState
}

/**
 * 标签建议与命令菜单共用的浮层。
 *
 * 挂 `document.body` + fixed 定位：编辑器视口（.codeMirrorViewport 一类）是
 * overflow:hidden 的，浮层作为编辑器后代会被那条裁切链切断，候选一多就只露出
 * 上半截——旧 CodeMirror 弹层踩过同样的坑（见 tag-autocomplete.ts:188-191）。
 *
 * 选中态只用 `aria-selected` + `--accent` 底色表达，不画焦点环：DOM 焦点始终留在编辑器里。
 */
export function SuggestionMenu({ host, state }: SuggestionMenuProps) {
  const elementRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  // 指针悬停改的当前项已经在视口里，不跟随滚动：否则列表在指针下滚动，
  // 又触发下一项的 mouseenter，一路滚到底。
  const pointerDrivenRef = useRef(false)

  useLayoutEffect(() => {
    const element = elementRef.current
    if (!element) return

    const { height, width } = element.getBoundingClientRect()
    const gap = 4
    const margin = 8
    const flipped = state.anchor.bottom + gap + height > window.innerHeight - margin
    const top = flipped
      ? Math.max(margin, state.anchor.top - gap - height)
      : state.anchor.bottom + gap
    const left = Math.max(
      margin,
      Math.min(state.anchor.left, window.innerWidth - width - margin)
    )

    element.style.top = `${top}px`
    element.style.left = `${left}px`
  }, [state])

  // 键盘上下移动时把当前项滚进列表可视区。只滚列表自己，不用 scrollIntoView，
  // 免得连带滚动编辑器所在的祖先容器。
  useLayoutEffect(() => {
    if (pointerDrivenRef.current) {
      pointerDrivenRef.current = false
      return
    }
    const list = listRef.current
    const item = list?.children[state.activeIndex]
    if (!list || !(item instanceof HTMLElement)) return
    const padding = parseFloat(getComputedStyle(list).paddingTop) || 0
    const top = item.offsetTop - padding
    const bottom = item.offsetTop + item.offsetHeight + padding
    if (top < list.scrollTop) list.scrollTop = top
    else if (bottom > list.scrollTop + list.clientHeight) {
      list.scrollTop = bottom - list.clientHeight
    }
  }, [state.activeIndex, state.items])

  return createPortal(
    <div className="shard-rich-suggestion-popover" ref={elementRef}>
      <ul aria-label={state.ariaLabel} ref={listRef} role="listbox">
        {state.items.map((item, index) => (
          <li
            aria-selected={index === state.activeIndex}
            key={item.key}
            // 指针优先：mousedown 会先把焦点抢出编辑器，改用它来提交选择并阻止默认行为。
            onMouseDown={(event) => {
              event.preventDefault()
              host.selectIndex(index)
            }}
            onMouseEnter={() => {
              if (index === state.activeIndex) return
              pointerDrivenRef.current = true
              host.setActiveIndex(index)
            }}
            role="option"
          >
            <span className="shard-rich-suggestion-label">{item.label}</span>
            <span className="shard-rich-suggestion-badge">{item.badge}</span>
          </li>
        ))}
      </ul>
    </div>,
    document.body
  )
}
