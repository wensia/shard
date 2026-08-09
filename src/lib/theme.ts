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
