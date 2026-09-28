"use client"

import {
  CircleAlertIcon,
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  TriangleAlertIcon,
  XIcon,
} from "@/components/icons"
import type { CSSProperties } from "react"
import { Toaster as Sonner, type ToasterProps } from "sonner"

import { cn } from "@/lib/utils"

import "./notice.css"

/**
 * 消息通知容器。外观见 notice.css（轻量浮卡），调用入口见 src/lib/notify.tsx。
 * sonner 只负责堆叠、计时、滑动关闭与读屏播报；unstyled 后外观全部由 kiln token 接管，
 * 明暗随 <html>.dark 自动切换，不再固定 theme。
 */
function Toaster({ className, style, toastOptions, ...props }: ToasterProps) {
  return (
    // F6 区域：键盘用户可以跳到通知里的「重试」「详情」等动作。
    <div data-focus-region="notifications">
      <Sonner
        {...props}
        data-slot="toaster"
        position="bottom-right"
        visibleToasts={3}
        gap={8}
        closeButton
        className={cn("toaster group z-[60]", className)}
        // 底部让出状态栏：通知不能盖住外壳控件。
        offset={{
          bottom: "calc(var(--shard-status-bar-height) + var(--space-3))",
          right: "var(--space-4)",
        }}
        mobileOffset={{ bottom: "var(--space-4)", left: "var(--space-4)", right: "var(--space-4)" }}
        icons={{
          success: <CircleCheckIcon />,
          info: <InfoIcon />,
          warning: <TriangleAlertIcon />,
          error: <CircleAlertIcon />,
          loading: <Loader2Icon className="animate-spin" />,
          close: <XIcon />,
        }}
        style={{ "--width": "360px", ...style } as CSSProperties}
        toastOptions={{
          closeButtonAriaLabel: "关闭通知",
          unstyled: true,
          ...toastOptions,
          classNames: {
            toast: "kiln-notice",
            icon: "kiln-notice-icon",
            content: "kiln-notice-content",
            title: "kiln-notice-title",
            description: "kiln-notice-body-slot",
            closeButton: "kiln-notice-close",
            ...toastOptions?.classNames,
          },
        }}
      />
    </div>
  )
}

export { Toaster }
