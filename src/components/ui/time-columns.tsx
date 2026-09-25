import { useEffect, useRef } from "react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import "./form-controls.css"

const pad = (value: number) => String(value).padStart(2, "0")
const hours = Array.from({ length: 24 }, (_, index) => pad(index))
const minutes = Array.from({ length: 12 }, (_, index) => pad(index * 5))

export type TimeColumnsProps = {
  /** 已选小时 `HH`，未选为 null。 */
  hour: string | null
  /** 已选分钟 `mm`，未选为 null；不在 5 分刻度上时两列都不高亮该分钟。 */
  minute: string | null
  onHourChange(hour: string): void
  onMinuteChange(minute: string): void
  className?: string
}

/**
 * 共享内联时间列：小时、分钟两列（分钟 5 分步进），选中项实心 primary。
 * 挂载时把已选项滚到列中间；只动列自己的 scrollTop，不牵动外层滚动容器。
 */
export function TimeColumns({ hour, minute, onHourChange, onMinuteChange, className }: TimeColumnsProps) {
  const hourListRef = useRef<HTMLDivElement>(null)
  const minuteListRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      for (const list of [hourListRef.current, minuteListRef.current]) {
        const selected = list?.querySelector<HTMLElement>("[aria-pressed='true']")
        if (list && selected) list.scrollTop = selected.offsetTop - (list.clientHeight - selected.offsetHeight) / 2
      }
    })
    return () => cancelAnimationFrame(frame)
  }, [])

  return <div className={cn("kiln-time-columns", className)} data-slot="time-columns">
    <div ref={hourListRef} className="kiln-time-column" role="group" aria-label="小时">
      {hours.map(item => <Button key={item} type="button" variant="ghost" size="sm" className="kiln-time-option"
        aria-pressed={hour === item} onClick={() => onHourChange(item)}>{item}</Button>)}
    </div>
    <div ref={minuteListRef} className="kiln-time-column" role="group" aria-label="分钟">
      {minutes.map(item => <Button key={item} type="button" variant="ghost" size="sm" className="kiln-time-option"
        aria-pressed={minute === item} onClick={() => onMinuteChange(item)}>{item}</Button>)}
    </div>
  </div>
}
