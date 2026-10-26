import { useState } from "react"

import { AuthGate } from "@/features/auth/auth-gate"
import { RevisionHistoryHost } from "@/features/history/revision-history-dialog"
import { isWebRuntime } from "@/lib/transport"

import {
  DEFAULT_WORKSPACE_ROUTE,
  type WorkspaceRoute,
} from "@/workspace/route"
import { WorkbenchShell } from "@/workspace/workbench-shell"

function App() {
  // 捕捉门禁：冷启动必须落在碎片台 composer，不恢复上次空间。
  const [route, setRoute] = useState<WorkspaceRoute>(DEFAULT_WORKSPACE_ROUTE)

  const shell = <WorkbenchShell route={route} setRoute={setRoute} />
  // 网页端先过登录门；桌面应用直接进工作台。
  // 版本历史只在网页端（存在服务器上）：菜单发事件，宿主弹出对话框。
  return isWebRuntime() ? (
    <AuthGate>
      {shell}
      <RevisionHistoryHost />
    </AuthGate>
  ) : (
    shell
  )
}

export default App
