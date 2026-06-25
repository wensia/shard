import { useTheme } from "next-themes"
import { Toaster as Sonner, type ToasterProps } from "sonner"
import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react"

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme()

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      mobileOffset={{ bottom: 204, left: 16, right: 16 }}
      offset={{ bottom: 24, right: 24 }}
      position="bottom-right"
      richColors
      icons={{
        success: (
          <CircleCheckIcon className="size-4" />
        ),
        info: (
          <InfoIcon className="size-4" />
        ),
        warning: (
          <TriangleAlertIcon className="size-4" />
        ),
        error: (
          <OctagonXIcon className="size-4" />
        ),
        loading: (
          <Loader2Icon className="size-4 animate-spin" />
        ),
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--shard-radius-control)",
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          description: "cn-toast-description",
          error: "cn-toast-error",
          info: "cn-toast-info",
          loading: "cn-toast-loading",
          success: "cn-toast-success",
          toast: "cn-toast",
          warning: "cn-toast-warning",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
