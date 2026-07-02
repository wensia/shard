import { useEffect, useState } from "react"

import { getVersion } from "@tauri-apps/api/app"
import { isTauri } from "@tauri-apps/api/core"

let cachedVersion: string | null = null

export function useAppVersion() {
  const [version, setVersion] = useState(cachedVersion)

  useEffect(() => {
    if (cachedVersion || !isTauri()) {
      return
    }
    let cancelled = false
    void getVersion().then((value) => {
      cachedVersion = value
      if (!cancelled) {
        setVersion(value)
      }
    })
    return () => {
      cancelled = true
    }
  }, [])

  return version
}
