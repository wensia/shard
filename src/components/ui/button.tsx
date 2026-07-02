import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-md border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition-[background-color,border-color,color,box-shadow,opacity,scale] duration-150 ease-out outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/[var(--shard-alpha-55)] disabled:pointer-events-none disabled:opacity-[var(--shard-alpha-55)] aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/[var(--shard-alpha-21)] dark:aria-invalid:border-destructive/[var(--shard-alpha-55)] dark:aria-invalid:ring-destructive/[var(--shard-alpha-34)] [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          "bg-solid text-solid-foreground hover:bg-[color-mix(in_oklch,var(--solid),var(--background)_12%)]",
        primary:
          "bg-primary text-primary-foreground hover:bg-[color-mix(in_oklch,var(--primary),var(--primary-foreground)_11%)]",
        outline:
          "border-border bg-background hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:border-input dark:bg-input/[var(--shard-alpha-34)] dark:hover:bg-input/[var(--shard-alpha-55)]",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)] aria-expanded:bg-secondary aria-expanded:text-secondary-foreground",
        ghost:
          "hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:hover:bg-muted/[var(--shard-alpha-55)]",
        destructive:
          "bg-destructive/[var(--shard-alpha-8)] text-destructive hover:bg-destructive/[var(--shard-alpha-21)] focus-visible:border-destructive/[var(--shard-alpha-34)] focus-visible:ring-destructive/[var(--shard-alpha-21)] dark:bg-destructive/[var(--shard-alpha-21)] dark:hover:bg-destructive/[var(--shard-alpha-34)] dark:focus-visible:ring-destructive/[var(--shard-alpha-34)]",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-3",
        xs: "h-6 px-2 text-xs in-data-[slot=button-group]:rounded-md [&_svg:not([class*='size-'])]:size-3",
        sm: "h-8 px-2.5 text-[0.8rem] in-data-[slot=button-group]:rounded-md [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-10 px-3.5",
        icon: "size-9",
        "icon-xs":
          "size-6 in-data-[slot=button-group]:rounded-md [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-8 in-data-[slot=button-group]:rounded-md",
        "icon-lg": "size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

type ButtonProps = ButtonPrimitive.Props &
  VariantProps<typeof buttonVariants> & {
    static?: boolean
  }

function Button({
  className,
  static: isStatic = false,
  variant = "default",
  size = "default",
  ...props
}: ButtonProps) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(
        buttonVariants({ variant, size }),
        !isStatic && "active:not-aria-[haspopup]:scale-[0.96]",
        className
      )}
      {...props}
    />
  )
}

export { Button, buttonVariants }
