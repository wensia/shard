import { useSyncExternalStore } from "react"

/** 订阅一条媒体查询；断点由调用方给出，与对应 CSS 用同一条查询。 */
export function useMediaQuery(query: string) {
  return useSyncExternalStore(
    (onChange) => {
      const list = window.matchMedia(query)
      list.addEventListener("change", onChange)
      return () => list.removeEventListener("change", onChange)
    },
    () => window.matchMedia(query).matches,
    () => false,
  )
}
