import { useEffect } from "react"

import { notify } from "@/lib/notify"
import { transport } from "@/lib/transport"
import { OFFLINE_REFUSAL_PREFIX, subscribeRemoteSyncNotices } from "@/lib/transport/desktop-remote"

const OFFLINE_ID = "remote-offline-refusal"
const CONFLICT_ID = "remote-sync-conflict"
const FAILED_ID = "remote-sync-failed"
const RECOVERED_ID = "remote-sync-recovered"

/**
 * 桌面连接服务器后（S8b）同步引擎要让用户知道的事：
 * - 离线时做了需要联网的操作（改名、移动、删除、导入、导图与数据集写入、密匣写入……）：说明为什么做不了。
 * - 补交时另存了冲突副本：哪条都没丢，你的版本在新碎片里。
 * - 离线修改没能上传（服务器拒绝、连续出错到上限、条目已移入密匣）：不会再自动重试，内容另存在本机。
 * - 服务器从备份恢复后找回了恢复点之后的数据。
 * 同一类提示合并成一条（固定 id）。本地模式与网页什么也不做。
 */
export function useRemoteSyncNotices() {
  useEffect(() => {
    if (transport().kind !== "tauri-remote") return
    return subscribeRemoteSyncNotices((notice) => {
      switch (notice.kind) {
        case "offline":
          notify.warning("需要联网", {
            id: OFFLINE_ID,
            description: notice.message.startsWith(OFFLINE_REFUSAL_PREFIX)
              ? notice.message.slice(OFFLINE_REFUSAL_PREFIX.length)
              : notice.message,
          })
          return
        case "conflict":
          notify.warning("已另存冲突副本", {
            id: CONFLICT_ID,
            description:
              notice.reason === "deleted"
                ? "这条碎片在别处已被删除，你离线时的修改另存为一条新碎片，没有丢。"
                : "这条碎片在别处也改过，你离线时的版本另存为一条新碎片，两份都在。",
          })
          return
        case "failed":
          // Rust 给的说明已是面向用户的话（含另存位置，例如「这条已移入密匣，离线时的修改没有上传，已另存在本机：…」）。
          notify.error("有离线修改没能上传", {
            id: FAILED_ID,
            description: notice.message || "服务器拒绝了这条修改，不会再自动重试；内容已另存在本机。",
          })
          return
        case "recovered":
          notify.info("已找回服务器恢复前的数据", {
            id: RECOVERED_ID,
            description:
              notice.saved > 0
                ? `${notice.pushed} 条已重新上传，另有 ${notice.saved} 条的原文另存在本机。`
                : `${notice.pushed} 条已重新上传。`,
            detail: notice.dir ?? undefined,
          })
      }
    })
  }, [])
}
