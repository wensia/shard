import { useState } from "react"

import {
  DEFAULT_WORKSPACE_ROUTE,
  type WorkspaceRoute,
} from "@/workspace/route"
import { WorkbenchShell } from "@/workspace/workbench-shell"

function App() {
  // 捕捉门禁：冷启动必须落在碎片台 composer，不恢复上次空间。
  const [route, setRoute] = useState<WorkspaceRoute>(DEFAULT_WORKSPACE_ROUTE)

  return <WorkbenchShell route={route} setRoute={setRoute} />
}

export default App
