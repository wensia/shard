import * as React from "react"

import { cn } from "@/lib/utils"

function Textarea({
  className,
  ...props
}: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-16 w-full rounded-[var(--shard-radius-control)] border border-input bg-background px-2.5 py-2 text-base shadow-input transition-[border-color,box-shadow,background-color] outline-none placeholder:text-muted-foreground hover:border-foreground/25 focus-visible:border-primary/70 focus-visible:shadow-[var(--shadow-primary-focus)] disabled:cursor-not-allowed disabled:bg-muted/40 disabled:opacity-[var(--shard-alpha-55)] aria-invalid:border-destructive aria-invalid:shadow-input aria-invalid:ring-3 aria-invalid:ring-destructive/[var(--shard-alpha-21)] md:text-sm",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
