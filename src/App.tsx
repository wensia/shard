import { useState } from "react"
import { isTauri } from "@tauri-apps/api/core"

import { AuthGate } from "@/features/auth/auth-gate"
import { DesktopAuthGate } from "@/features/auth/desktop-auth-gate"
import { RevisionHistoryHost } from "@/features/history/revision-history-dialog"
import { VoiceProvider } from "@/features/voice"
import { isLegacyDesktopFixture, isServerBacked, isWebRuntime } from "@/lib/transport"

import {
  DEFAULT_WORKSPACE_ROUTE,
  type WorkspaceRoute,
} from "@/workspace/route"
import { WorkbenchShell } from "@/workspace/workbench-shell"

function App() {
  // 捕捉门禁：冷启动必须落在碎片台 composer，不恢复上次空间。
  const [route, setRoute] = useState<WorkspaceRoute>(DEFAULT_WORKSPACE_ROUTE)

  // 换空间即结束朗读与录音，迟到的语音结果不会落进别处。
  const shell = (
    <VoiceProvider scopeKey={JSON.stringify(route)}>
      <WorkbenchShell route={route} setRoute={setRoute} />
    </VoiceProvider>
  )
  // 桌面默认进入 VPS 登录门，旧本地配置不构成已登录；只保留显式 DEV 组件测试宿主。
  if (isTauri() && !isLegacyDesktopFixture()) {
    return (
      <DesktopAuthGate>
        {shell}
        <RevisionHistoryHost />
      </DesktopAuthGate>
    )
  }
  // 网页及 iOS 复用服务器账号登录门。
  if (isWebRuntime()) {
    return (
      <AuthGate>
        {shell}
        <RevisionHistoryHost />
      </AuthGate>
    )
  }
  // 版本历史存在服务器上：网页与连接了服务器的桌面才有。菜单发事件，宿主弹出对话框。
  return isServerBacked() ? (
    <>
      {shell}
      <RevisionHistoryHost />
    </>
  ) : (
    shell
  )
}

export default App
