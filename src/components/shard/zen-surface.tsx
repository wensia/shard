import { useEffect, type ReactNode } from "react"

import styles from "./zen-surface.module.css"

export interface ZenSurfaceProps {
  ariaLabel: string
  children: ReactNode
  footer?: ReactNode
  onRequestClose: () => void
}

export function ZenSurface({
  ariaLabel,
  children,
  footer,
  onRequestClose,
}: ZenSurfaceProps) {
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const isComposing =
        event.isComposing || event.key === "Process" || event.keyCode === 229
      if (
        isComposing ||
        event.defaultPrevented ||
        event.repeat ||
        event.key !== "Escape"
      ) {
        return
      }

      event.preventDefault()
      onRequestClose()
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [onRequestClose])

  return (
    <section aria-label={ariaLabel} className={styles.surface} data-focus-scope>
      <div
        aria-hidden="true"
        className={styles.dragRegion}
        data-tauri-drag-region
      />
      <div className={styles.content}>{children}</div>
      {footer ? <footer className={styles.footer}>{footer}</footer> : null}
    </section>
  )
}
