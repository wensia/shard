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
          "bg-primary text-primary-foreground hover:bg-primary-hover",
        outline:
          "border-border-visible bg-card text-foreground hover:bg-muted aria-expanded:bg-muted",
        secondary:
          "border-border-visible bg-card text-foreground hover:bg-muted aria-expanded:bg-muted",
        ghost:
          "bg-transparent text-foreground hover:bg-muted aria-expanded:bg-muted",
        destructive:
          "bg-destructive/[var(--shard-alpha-8)] text-destructive hover:bg-destructive/[var(--shard-alpha-21)] focus-visible:ring-destructive/[var(--shard-alpha-21)]",
        link: "bg-transparent text-primary-text underline-offset-4 hover:underline",
      },
      // 高度一律绑 kiln 的控件高度 token，不写死 h-9 —— 写死等于让该控件
      // 静默退出密度档（见 vendor/kiln/references/components.md 的按钮尺寸表）。
      // 档位由根元素的 data-density 决定，compact 档下整体降一档。
      // 无 xs 档：太小的动作用行内文字链接，不发明更小的按钮。
      size: {
        default:
          "h-(--control-height) gap-1.5 px-3 has-data-[icon=inline-end]:pr-2.5 has-data-[icon=inline-start]:pl-2.5",
        sm: "h-(--control-height-sm) gap-1.5 px-2.5 text-[13px] [--shard-icon-stroke:var(--shard-icon-stroke-sm)] [&_svg:not([class*='size-'])]:size-(--shard-icon-size-sm)",
        md: "h-(--control-height) gap-1.5 px-3",
        lg: "h-(--control-height-lg) gap-2 px-3.5",
        icon: "size-(--control-height)",
        "icon-sm": "size-(--control-height-sm)",
        "icon-lg": "size-(--control-height-lg)",
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
