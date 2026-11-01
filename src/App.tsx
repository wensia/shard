import { useState } from "react"

import {
  DEFAULT_WORKSPACE_ROUTE,
  type WorkspaceRoute,
} from "@/workspace/route"
import { WorkbenchShell } from "@/workspace/workbench-shell"
import { KdocsWorkspace } from "@/features/kdocs/kdocs-workspace"

const STORAGE_TARGET_KEY = "shard.storage-target"

function readStorageTarget(): "kdocs" | "local" {
  try {
    return window.localStorage.getItem(STORAGE_TARGET_KEY) === "local" ? "local" : "kdocs"
  } catch {
    return "kdocs"
  }
}

function App() {
  const [storageTarget, setStorageTarget] = useState(readStorageTarget)
  // 本地资料仍从碎片台打开；云端与本地工作区互斥挂载。
  const [route, setRoute] = useState<WorkspaceRoute>(DEFAULT_WORKSPACE_ROUTE)

  function selectStorageTarget(target: "kdocs" | "local") {
    try {
      window.localStorage.setItem(STORAGE_TARGET_KEY, target)
    } catch {
      // 本次切换仍然生效。
    }
    setStorageTarget(target)
  }

  return storageTarget === "kdocs"
    ? <KdocsWorkspace onOpenLocal={() => selectStorageTarget("local")} />
    : <WorkbenchShell route={route} setRoute={setRoute} onOpenCloud={() => selectStorageTarget("kdocs")} />
}

export default App
