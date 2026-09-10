import { Select } from "@base-ui/react/select"
import { useEffect, useRef, useState, type KeyboardEvent } from "react"

import { CheckIcon, ChevronDownIcon } from "@/components/icons"
import { cn } from "@/lib/utils"
import "./form-controls.css"

export type SelectControlOption = { value: string; label: string; disabled?: boolean }
export type SelectControlProps = {
  value: string
  onValueChange(value: string): void
  options: SelectControlOption[]
  disabled?: boolean
  id?: string
  name?: string
  className?: string
  size?: "sm" | "default"
  "aria-label"?: string
  "aria-labelledby"?: string
  onOpenChange?(open: boolean): void
}

/** App-rendered options keep the same keyboard and visual contract on macOS/WKWebView. */
export function SelectControl({ value, onValueChange, options, disabled, id, name,
  className, size = "default", onOpenChange, ...labelProps }: SelectControlProps) {
  const composing = useRef(false)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (disabled && open) { setOpen(false); onOpenChange?.(false) }
  }, [disabled, onOpenChange, open])
  function changeOpen(next: boolean) { setOpen(next); if (next !== open) onOpenChange?.(next) }
  function protectComposition(event: KeyboardEvent) {
    if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) {
      event.preventDefault()
      event.stopPropagation()
    }
  }
  return <Select.Root value={value} items={options} disabled={disabled} name={name} id={id}
    onValueChange={next => { if (next !== null && !composing.current) onValueChange(next) }}
    open={open && !disabled} onOpenChange={changeOpen}>
    <Select.Trigger {...labelProps} name={name} data-slot="select-trigger" data-size={size}
      className={cn("kiln-control-trigger", className)}
      onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }}
      onKeyDownCapture={protectComposition} onKeyDown={event => {
        if (open || !["Tab", "Escape"].includes(event.key)) event.stopPropagation()
      }}>
      <Select.Value className="kiln-control-value" />
      <Select.Icon className="kiln-control-icon"><ChevronDownIcon /></Select.Icon>
    </Select.Trigger>
    <Select.Portal>
      <Select.Positioner align="start" sideOffset={4} collisionPadding={8} alignItemWithTrigger={false}
        className="kiln-control-positioner click-outside-ignore" data-slot="select-positioner"
        onKeyDown={event => event.stopPropagation()}>
        <Select.Popup className="kiln-select-popup" data-slot="select-content"
          onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }}
          onKeyDownCapture={protectComposition}
          onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); changeOpen(false) } }}>
          <Select.List className="kiln-select-list">
            {options.map(option => <Select.Item key={option.value} value={option.value}
              disabled={option.disabled} data-value={option.value} className="kiln-select-item">
              <Select.ItemIndicator className="kiln-select-indicator"><CheckIcon /></Select.ItemIndicator>
              <Select.ItemText>{option.label}</Select.ItemText>
            </Select.Item>)}
          </Select.List>
        </Select.Popup>
      </Select.Positioner>
    </Select.Portal>
  </Select.Root>
}
