import type { ShardDocumentLink } from "@/types"

/** 解析笔记正文里指向图文档的 `shard://map|flow/<id>` 链接；不是图文档链接时返回 null。 */
export function parseShardDocumentLink(href: string): ShardDocumentLink | null {
  const match = /^shard:\/\/(map|flow)\/([^/?#]+)$/u.exec(href)
  if (!match) return null
  try {
    const targetId = decodeURIComponent(match[2])
    return targetId ? { id: href, targetType: match[1] as "map" | "flow", targetId } : null
  } catch { return null }
}
