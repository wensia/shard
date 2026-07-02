const STORAGE_KEY = "shard.app-settings.v1"

export const AUTO_SYNC_INTERVAL_OPTIONS = [5, 10, 30] as const

export interface AppSettings {
  autoSyncEnabled: boolean
  autoSyncIntervalMinutes: number
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  autoSyncEnabled: false,
  autoSyncIntervalMinutes: 10,
}

export function loadAppSettings(): AppSettings {
  if (typeof window === "undefined") {
    return DEFAULT_APP_SETTINGS
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      return DEFAULT_APP_SETTINGS
    }

    const parsed = JSON.parse(raw) as Partial<AppSettings>
    const interval = AUTO_SYNC_INTERVAL_OPTIONS.find(
      (minutes) => minutes === parsed.autoSyncIntervalMinutes
    )

    return {
      autoSyncEnabled: parsed.autoSyncEnabled === true,
      autoSyncIntervalMinutes:
        interval ?? DEFAULT_APP_SETTINGS.autoSyncIntervalMinutes,
    }
  } catch {
    return DEFAULT_APP_SETTINGS
  }
}

export function saveAppSettings(settings: AppSettings) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  } catch {
    // localStorage unavailable; settings stay session-only.
  }
}
