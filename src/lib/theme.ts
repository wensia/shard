export type AccentTheme = "clay" | "teal" | "peacock" | "amber"

export interface AccentThemeOption {
  id: AccentTheme
  hex: string
  labelZh: string
  labelEn: string
}

export const ACCENT_THEMES: AccentThemeOption[] = [
  // design-exempt: 与 index.css 的 :root[data-theme] 块一一对应的配色真相源
  { id: "clay", hex: "#b6533c", labelZh: "陶土红", labelEn: "Clay red" },
  // design-exempt: 同上
  { id: "teal", hex: "#3e8c7d", labelZh: "窑青绿", labelEn: "Kiln teal" },
  // design-exempt: 同上
  { id: "peacock", hex: "#2e6e79", labelZh: "孔雀蓝", labelEn: "Peacock blue" },
  // design-exempt: 同上
  { id: "amber", hex: "#be7c32", labelZh: "暖琥珀", labelEn: "Warm amber" },
]

export const DEFAULT_ACCENT_THEME: AccentTheme = "peacock"

const ACCENT_THEME_STORAGE_KEY = "shard.accentTheme"

function isAccentTheme(value: string | null): value is AccentTheme {
  return value !== null && ACCENT_THEMES.some((theme) => theme.id === value)
}

export function getStoredAccentTheme(): AccentTheme {
  try {
    const stored = localStorage.getItem(ACCENT_THEME_STORAGE_KEY)
    return isAccentTheme(stored) ? stored : DEFAULT_ACCENT_THEME
  } catch {
    // 隐私模式等场景 localStorage 可能不可用，静默回退默认值。
    return DEFAULT_ACCENT_THEME
  }
}

function setDomTheme(theme: AccentTheme): void {
  document.documentElement.setAttribute("data-shard-theme", theme)
}

/** 切换配色：立即生效并持久化，供设置面板里的色板按钮调用。 */
export function applyAccentTheme(theme: AccentTheme): void {
  setDomTheme(theme)
  try {
    localStorage.setItem(ACCENT_THEME_STORAGE_KEY, theme)
  } catch {
    // 写入失败不影响本次会话内已经生效的视觉切换。
  }
}

/** 启动时调用一次：把上次持久化的配色应用到 <html data-shard-theme>。 */
export function initAccentTheme(): void {
  setDomTheme(getStoredAccentTheme())
}

// ── 明暗模式 ────────────────────────────────────────────────────
// 外观由 kiln 的暗色层（vendor/kiln/tokens/dark.css）提供，这里只负责
// 何时给 <html> 加 `.dark`：跟随系统、固定浅色或固定深色。

export type ColorMode = "system" | "light" | "dark"

export interface ColorModeOption {
  id: ColorMode
  labelZh: string
  labelEn: string
}

export const COLOR_MODES: ColorModeOption[] = [
  { id: "system", labelZh: "跟随系统", labelEn: "System" },
  { id: "light", labelZh: "浅色", labelEn: "Light" },
  { id: "dark", labelZh: "深色", labelEn: "Dark" },
]

export const DEFAULT_COLOR_MODE: ColorMode = "system"

// index.html 的首帧脚本读同一个键，改名要两边一起改。
const COLOR_MODE_STORAGE_KEY = "shard.colorMode"
const SYSTEM_DARK_QUERY = "(prefers-color-scheme: dark)"

function isColorMode(value: string | null): value is ColorMode {
  return value !== null && COLOR_MODES.some((mode) => mode.id === value)
}

export function getStoredColorMode(): ColorMode {
  try {
    const stored = localStorage.getItem(COLOR_MODE_STORAGE_KEY)
    return isColorMode(stored) ? stored : DEFAULT_COLOR_MODE
  } catch {
    return DEFAULT_COLOR_MODE
  }
}

function systemPrefersDark(): boolean {
  return window.matchMedia?.(SYSTEM_DARK_QUERY).matches ?? false
}

function setDomColorMode(mode: ColorMode): void {
  const isDark = mode === "dark" || (mode === "system" && systemPrefersDark())
  document.documentElement.classList.toggle("dark", isDark)
}

/** 让原生窗口外观（标题栏、滚动条、系统菜单）与页面一致；浏览器预览里静默跳过。 */
async function syncNativeWindowTheme(mode: ColorMode): Promise<void> {
  try {
    const { isTauri } = await import("@tauri-apps/api/core")
    if (!isTauri()) return
    const { getCurrentWindow } = await import("@tauri-apps/api/window")
    await getCurrentWindow().setTheme(mode === "system" ? null : mode)
  } catch {
    // 原生外观只是锦上添花，失败时页面自身的明暗仍然正确。
  }
}

let systemModeListener: ((event: MediaQueryListEvent) => void) | null = null
// matchMedia 每次调用都返回新对象；移除监听必须用注册时的同一个实例，所以缓存它。
let systemModeQuery: MediaQueryList | null = null

function watchSystemMode(mode: ColorMode): void {
  systemModeQuery ??= window.matchMedia?.(SYSTEM_DARK_QUERY) ?? null
  const query = systemModeQuery
  if (!query) return
  if (systemModeListener) {
    query.removeEventListener("change", systemModeListener)
    systemModeListener = null
  }
  if (mode !== "system") return
  systemModeListener = () => setDomColorMode("system")
  query.addEventListener("change", systemModeListener)
}

/** 切换明暗模式：立即生效并持久化，供设置面板调用。 */
export function applyColorMode(mode: ColorMode): void {
  setDomColorMode(mode)
  watchSystemMode(mode)
  void syncNativeWindowTheme(mode)
  try {
    localStorage.setItem(COLOR_MODE_STORAGE_KEY, mode)
  } catch {
    // 写入失败不影响本次会话内已经生效的切换。
  }
}

/** 启动时调用一次：应用上次的明暗模式，并在「跟随系统」时监听系统切换。 */
export function initColorMode(): void {
  const mode = getStoredColorMode()
  setDomColorMode(mode)
  watchSystemMode(mode)
  void syncNativeWindowTheme(mode)
}
