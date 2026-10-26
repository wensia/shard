import { useEffect, useRef } from "react"

import { notify } from "@/lib/notify"
import { transport } from "@/lib/transport"
import { isRemoteAuthRequired, subscribeRemoteAuthRequired } from "@/lib/transport/desktop-remote"

const PROMPT_ID = "remote-auth-required"

/**
 * 桌面连接服务器后，设备令牌失效（在网页「设置 → 设备」里被吊销）：提示重新连接，并带去设置的「服务器」分区。
 * 启动时就已失效（Rust 在页面订阅前收到 401）也提示一次。本地模式与网页什么也不做。
 */
export function useRemoteAuthPrompt(openServerSettings: () => void) {
  const openRef = useRef(openServerSettings)
  openRef.current = openServerSettings

  useEffect(() => {
    if (transport().kind !== "tauri-remote") return
    const prompt = () =>
      notify.warning("这台设备的连接已失效", {
        id: PROMPT_ID,
        description: "请重新连接服务器。",
        action: { label: "重新连接", onClick: () => openRef.current() },
        persistent: true,
      })
    if (isRemoteAuthRequired()) prompt()
    return subscribeRemoteAuthRequired(prompt)
  }, [])
}
