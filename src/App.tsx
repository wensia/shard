import { useState } from "react"

import { AuthGate } from "@/features/auth/auth-gate"
import { RevisionHistoryHost } from "@/features/history/revision-history-dialog"
import { isServerBacked, isWebRuntime } from "@/lib/transport"

import {
  DEFAULT_WORKSPACE_ROUTE,
  type WorkspaceRoute,
} from "@/workspace/route"
import { WorkbenchShell } from "@/workspace/workbench-shell"

function App() {
  // 捕捉门禁：冷启动必须落在碎片台 composer，不恢复上次空间。
  const [route, setRoute] = useState<WorkspaceRoute>(DEFAULT_WORKSPACE_ROUTE)

  const shell = <WorkbenchShell route={route} setRoute={setRoute} />
  // 网页端先过登录门；桌面应用直接进工作台（连接服务器时凭设备令牌，不需要登录）。
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
