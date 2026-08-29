import type { ReactNode } from "react"

import { Button, type ButtonProps } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

type ToolbarIconButtonProps = Omit<
  ButtonProps,
  "aria-label" | "children" | "size"
> & {
  children: ReactNode
  label: string
}

/**
 * Shared contract for icon-only toolbar actions.
 *
 * A single label supplies both the accessible name and the visible hover/focus
 * explanation, so toolbar actions cannot silently ship with only one of them.
 */
function ToolbarIconButton({
  children,
  disabled,
  label,
  ...props
}: ToolbarIconButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger
        disabled={disabled}
        render={
          <Button
            aria-label={label}
            disabled={disabled}
            size="icon-sm"
            {...props}
          />
        }
      >
        {children}
        <span className="sr-only">{label}</span>
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  )
}

export { ToolbarIconButton }
export type { ToolbarIconButtonProps }
