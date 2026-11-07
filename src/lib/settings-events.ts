/**
 * 「打开设置」请求：⌘,、侧栏「设置」、macOS 菜单「设置…」、语音缺密钥等入口都汇到工作台的同一个处理，
 * 设置弹窗只有一份。`section` 是设置分区 id（如 `ai`）；不认识或缺省时打开第一个分区。
 */
export const OPEN_SETTINGS_EVENT = "shard:open-settings"

/** macOS 应用菜单「设置…」发来的 Tauri 事件（与 `src-tauri/src/lib.rs` 的 `OPEN_SETTINGS_MENU_EVENT` 同名）。 */
export const OPEN_SETTINGS_MENU_EVENT = "menu:open-settings"

export interface OpenSettingsDetail {
  section?: string
}

export function requestOpenSettings(section?: string) {
  window.dispatchEvent(
    new CustomEvent<OpenSettingsDetail>(OPEN_SETTINGS_EVENT, { detail: { section } })
  )
}

/** ⌘, / Ctrl+,：系统通用的「设置」快捷键。 */
export function isSettingsShortcut(event: KeyboardEvent) {
  return (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key === ","
}
