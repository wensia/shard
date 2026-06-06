import * as React from "react"

import { cn } from "@/lib/utils"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-16 w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-base transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/[var(--shard-alpha-55)] disabled:cursor-not-allowed disabled:bg-input/[var(--shard-alpha-55)] disabled:opacity-[var(--shard-alpha-55)] aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/[var(--shard-alpha-21)] md:text-sm dark:bg-input/[var(--shard-alpha-34)] dark:disabled:bg-input/[var(--shard-alpha-89)] dark:aria-invalid:border-destructive/[var(--shard-alpha-55)] dark:aria-invalid:ring-destructive/[var(--shard-alpha-34)]",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
