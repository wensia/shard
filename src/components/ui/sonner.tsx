"use client"

import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react"
import type { CSSProperties } from "react"
import { Toaster as Sonner, type ToasterProps } from "sonner"

import { cn } from "@/lib/utils"

const toastClassNames = {
  description: "cn-toast-description",
  error: "cn-toast-error",
  info: "cn-toast-info",
  loading: "cn-toast-loading",
  success: "cn-toast-success",
  toast: "cn-toast",
  warning: "cn-toast-warning",
} as const

function Toaster({
  className,
  style,
  toastOptions,
  ...props
}: ToasterProps) {
  return (
    <Sonner
      {...props}
      data-slot="toaster"
      theme="light"
      position="bottom-right"
      visibleToasts={5}
      duration={5000}
      className={cn("toaster group z-[60]", className)}
      offset={{ bottom: 24, right: 24 }}
      mobileOffset={{ bottom: 16, left: 16, right: 16 }}
      richColors
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--shard-surface-radius)",
          ...style,
        } as CSSProperties
      }
      toastOptions={{
        ...toastOptions,
        classNames: {
          ...toastClassNames,
          ...toastOptions?.classNames,
        },
      }}
    />
  )
}

export { Toaster }
