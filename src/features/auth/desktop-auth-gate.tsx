import { invoke } from "@tauri-apps/api/core"
import { useSyncExternalStore, type ReactNode } from "react"

import { desktopRemoteStatus } from "@/lib/transport"
import {
  isRemoteAuthRequired,
  remoteConnectionState,
  subscribeRemoteAuthRequired,
  subscribeRemoteConnection,
} from "@/lib/transport/desktop-remote"

import { normalizeEmail } from "./api"
import { LoginForm } from "./auth-gate"

async function signIn(email: string, password: string, server: string) {
  await invoke("remote_login", { server: server.trim(), email: normalizeEmail(email), password, name: "我的 Mac" })
}

/** A missing or revoked device session never opens the former local/GitHub vault. */
export function DesktopAuthGate({ children }: { children: ReactNode }) {
  const authRequired = useSyncExternalStore(subscribeRemoteAuthRequired, isRemoteAuthRequired)
  const connection = useSyncExternalStore(subscribeRemoteConnection, remoteConnectionState)
  const status = desktopRemoteStatus()

  if (!status?.connected || authRequired || connection === "signedOut") {
    return (
      <LoginForm
        connection={{ server: status?.server || "https://shard.askfish.net", signIn }}
        onDone={() => window.location.reload()}
      />
    )
  }
  return children
}
