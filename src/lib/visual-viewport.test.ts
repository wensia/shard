import { describe, expect, it } from "vitest"

import { caretScrollDelta, KEYBOARD_MIN_OVERLAP_PX, keyboardOverlap } from "@/lib/visual-viewport"

describe("keyboardOverlap", () => {
  it("可视区比布局视口矮出键盘高度才算键盘", () => {
    expect(keyboardOverlap(664, 364, 1)).toBe(300)
    expect(keyboardOverlap(664, 664, 1)).toBe(0)
  })

  it("地址栏伸缩、输入法候选条这类小幅变化不算", () => {
    expect(keyboardOverlap(664, 664 - KEYBOARD_MIN_OVERLAP_PX + 1, 1)).toBe(0)
    expect(keyboardOverlap(664, 664 - KEYBOARD_MIN_OVERLAP_PX, 1)).toBe(KEYBOARD_MIN_OVERLAP_PX)
  })

  it("双指放大时可视区变小不是键盘", () => {
    expect(keyboardOverlap(664, 332, 2)).toBe(0)
  })
})

describe("caretScrollDelta", () => {
  const view = { top: 52, bottom: 364 }

  it("光标在可视区内不滚动", () => {
    expect(caretScrollDelta({ top: 200, bottom: 220 }, view)).toBe(0)
  })

  it("光标被键盘盖住时向下滚到底边上方留出空隙", () => {
    expect(caretScrollDelta({ top: 580, bottom: 605 }, view)).toBe(605 - 364 + 16)
  })

  it("光标跑到标题栏下面时向上滚", () => {
    expect(caretScrollDelta({ top: 40, bottom: 60 }, view)).toBe(40 - 52 - 16)
  })
})
