import { convertFileSrc, invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"

import type { ShardTransport } from "./index"

/** Rust 端 `vault_asset_protocol` 注册的协议名。 */
const VAULT_IMAGE_SCHEME = "shard-asset"

export const tauriTransport: ShardTransport = {
  kind: "tauri",
  invoke: (command, args) => invoke(command, args),
  invokeBytes: (command, body, headers) => invoke(command, body, { headers }),
  async listen(event, handler) {
    const dispose = await listen(event, (message) => handler(message.payload as never))
    return dispose
  },
  fileUrl: (reference) => convertFileSrc(reference, VAULT_IMAGE_SCHEME),
}
