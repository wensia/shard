import type { CSSProperties } from "react"

import styles from "./vault-guide.module.css"

/** 设置里的状态色点：本地 Git、终端命令、服务器连接共用。 */
export type StationTone = "amber" | "emerald" | "empty" | "info" | "ruby"

export const stationToneStyle: Record<StationTone, CSSProperties> = {
  amber: {
    background: "var(--shard-amber)",
    boxShadow: "0 0 0 3px rgb(var(--shard-amber-rgb) / var(--shard-alpha-13))",
  },
  emerald: {
    background: "var(--shard-emerald)",
    boxShadow:
      "0 0 0 3px rgb(var(--shard-emerald-rgb) / var(--shard-alpha-13))",
  },
  empty: {
    border:
      "1.5px solid color-mix(in srgb, var(--muted-foreground) 55%, transparent)",
  },
  info: {
    background: "var(--shard-info)",
    boxShadow: "0 0 0 3px rgb(var(--shard-info-rgb) / var(--shard-alpha-13))",
  },
  ruby: {
    background: "var(--shard-ruby)",
    boxShadow: "0 0 0 3px rgb(var(--shard-ruby-rgb) / var(--shard-alpha-13))",
  },
}

export function StatusIndicator({ label, tone }: { label: string; tone: StationTone }) {
  return (
    <span className={styles.statusIndicator}>
      <span
        aria-hidden="true"
        className={
          tone === "info" ? `${styles.statusDot} ${styles.pulseDot}` : styles.statusDot
        }
        style={stationToneStyle[tone]}
      />
      <span>{label}</span>
    </span>
  )
}
