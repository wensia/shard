import { Input as InputPrimitive } from "@base-ui/react/input"
import * as React from "react"

import { cn } from "@/lib/utils"

type InputProps = Omit<React.ComponentProps<"input">, "type"> & {
  type?: "text" | "password" | "email" | "number" | "tel" | "url" | "search"
}

function Input({ className, type, ...props }: InputProps) {
  return (
    <InputPrimitive
      data-slot="input"
      type={type}
      className={cn(
        "h-8 w-full min-w-0 rounded-[var(--shard-radius-control)] border border-input bg-transparent px-2.5 py-1 text-base transition-[border-color,box-shadow,background-color] outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:border-primary/70 focus-visible:shadow-[var(--shadow-primary-focus)] disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/[var(--shard-alpha-55)] disabled:opacity-[var(--shard-alpha-55)] aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/[var(--shard-alpha-21)] md:text-sm",
        type === "number" && "[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none",
        className
      )}
      {...props}
    />
  )
}

export { Input }
