import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const badgeVariants = cva(
  "group/badge inline-flex h-5 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-md border border-transparent px-2 py-0.5 text-[11px] font-medium whitespace-nowrap tabular-nums transition-[background-color,border-color,color,box-shadow,opacity] duration-150 ease-out focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/[var(--shard-alpha-55)] has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 aria-invalid:border-destructive aria-invalid:ring-destructive/[var(--shard-alpha-21)] dark:aria-invalid:ring-destructive/[var(--shard-alpha-34)] [&>svg]:pointer-events-none [&>svg]:size-3!",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground [a]:hover:bg-[color-mix(in_oklch,var(--primary),var(--primary-foreground)_11%)]",
        secondary:
          "bg-secondary text-secondary-foreground [a]:hover:bg-secondary/[var(--shard-alpha-89)]",
        destructive:
          "bg-destructive/[var(--shard-alpha-8)] text-destructive focus-visible:ring-destructive/[var(--shard-alpha-21)] dark:bg-destructive/[var(--shard-alpha-21)] dark:focus-visible:ring-destructive/[var(--shard-alpha-34)] [a]:hover:bg-destructive/[var(--shard-alpha-21)]",
        success:
          "border-success/[var(--shard-alpha-21)] bg-success/[var(--shard-alpha-8)] text-success [a]:hover:bg-success/[var(--shard-alpha-13)]",
        info:
          "border-info/[var(--shard-alpha-21)] bg-info/[var(--shard-alpha-8)] text-info [a]:hover:bg-info/[var(--shard-alpha-13)]",
        warning:
          "border-warning/[var(--shard-alpha-21)] bg-warning/[var(--shard-alpha-8)] text-warning [a]:hover:bg-warning/[var(--shard-alpha-13)]",
        outline:
          "border-border text-foreground [a]:hover:bg-muted [a]:hover:text-muted-foreground",
        ghost:
          "hover:bg-muted hover:text-muted-foreground dark:hover:bg-muted/[var(--shard-alpha-55)]",
        link: "text-primary underline-offset-4 hover:underline",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Badge({
  className,
  variant = "default",
  render,
  ...props
}: useRender.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(
      {
        className: cn(badgeVariants({ variant }), className),
      },
      props
    ),
    render,
    state: {
      slot: "badge",
      variant,
    },
  })
}

export { Badge, badgeVariants }
