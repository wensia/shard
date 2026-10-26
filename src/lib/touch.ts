import { isWebRuntime } from "@/lib/transport"

/** 主要输入是手指：没有悬停、指针粗。与 CSS 里的 `@media (hover: none) and (pointer: coarse)` 同一口径。 */
export const TOUCH_MEDIA_QUERY = "(hover: none) and (pointer: coarse)"

/**
 * 网页端的触屏设备（手机、平板浏览器）。桌面 Tauri 恒为 false：
 * 触屏专属的行为（打开文档不抢焦点、单格点两下编辑等）只在这里生效，桌面行为不变。
 */
export function isTouchWeb() {
  if (!isWebRuntime()) return false
  return typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(TOUCH_MEDIA_QUERY).matches
}
