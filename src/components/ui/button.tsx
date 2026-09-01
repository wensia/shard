import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-[var(--shard-radius-control)] border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition-[background-color,border-color,color,box-shadow,opacity,transform] duration-150 ease-out outline-none select-none focus-visible:ring-3 focus-visible:ring-ring/[var(--shard-alpha-55)] active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-[var(--shard-alpha-55)] aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/[var(--shard-alpha-21)] [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-(--shard-icon-size-md)",
  {
    variants: {
      variant: {
        default:
          "bg-solid text-solid-foreground hover:bg-[color-mix(in_oklch,var(--solid),var(--background)_12%)]",
        primary:
          "bg-primary text-primary-foreground hover:bg-[color-mix(in_oklch,var(--primary),var(--primary-foreground)_11%)]",
        outline:
          "border-border-visible bg-card text-foreground hover:bg-muted aria-expanded:bg-muted",
        secondary:
          "border-border-visible bg-card text-foreground hover:bg-muted aria-expanded:bg-muted",
        ghost:
          "bg-transparent text-foreground hover:bg-muted aria-expanded:bg-muted",
        destructive:
          "bg-destructive/[var(--shard-alpha-8)] text-destructive hover:bg-destructive/[var(--shard-alpha-21)] focus-visible:ring-destructive/[var(--shard-alpha-21)]",
        link: "bg-transparent text-primary underline-offset-4 hover:underline",
      },
      size: {
        default:
          "h-9 gap-1.5 px-3 has-data-[icon=inline-end]:pr-2.5 has-data-[icon=inline-start]:pl-2.5",
        xs: "h-6 gap-1 px-2 text-xs [--shard-icon-stroke:var(--shard-icon-stroke-sm)] [&_svg:not([class*='size-'])]:size-(--shard-icon-size-xs)",
        sm: "h-8 gap-1.5 px-2.5 text-[13px] [--shard-icon-stroke:var(--shard-icon-stroke-sm)] [&_svg:not([class*='size-'])]:size-(--shard-icon-size-sm)",
        md: "h-9 gap-1.5 px-3",
        lg: "h-10 gap-2 px-3.5",
        icon: "size-9",
        "icon-xs": "size-6 [--shard-icon-stroke:var(--shard-icon-stroke-sm)] [&_svg:not([class*='size-'])]:size-(--shard-icon-size-xs)",
        "icon-sm": "size-8",
        "icon-lg": "size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

export type ButtonVariant = NonNullable<
  VariantProps<typeof buttonVariants>["variant"]
>

export type ButtonProps = ButtonPrimitive.Props &
  VariantProps<typeof buttonVariants>

function Button({
  className,
  size = "default",
  variant = "default",
  ...props
}: ButtonProps) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  )
}

export { Button, buttonVariants }
