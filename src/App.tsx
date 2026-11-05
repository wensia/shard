import { useState } from "react"
import { VoiceProvider } from "@/features/voice"

import {
  DEFAULT_WORKSPACE_ROUTE,
  type WorkspaceRoute,
} from "@/workspace/route"
import { WorkbenchShell } from "@/workspace/workbench-shell"

function App() {
  // 捕捉门禁：冷启动必须落在碎片台 composer，不恢复上次空间。
  const [route, setRoute] = useState<WorkspaceRoute>(DEFAULT_WORKSPACE_ROUTE)

  // 换空间即结束朗读与录音，迟到的语音结果不会落进别处。
  return (
    <VoiceProvider scopeKey={JSON.stringify(route)}>
      <WorkbenchShell route={route} setRoute={setRoute} />
    </VoiceProvider>
  )
}

export default App
