import { migrateLegacyParagraphGaps } from "@/editor-rich/markdown/migrate"

/**
 * Markdown 方言 v1 → v2 的一次性迁移（v2：源码一行显示一行，空一行显示一行空白）。
 * 改写在前端做，与编辑器用同一个解析器；Rust 侧只列原文、核对 sha、整批写回、记版本
 * （`src-tauri/src/markdown_dialect.rs`）。任何一步失败都不会写入，下次读取时重试。
 */

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>

const CURRENT_MARKDOWN_DIALECT = 2

interface PublicMigrationPlan {
  dialect: number
  sources: { path: string; content: string; sha: string }[]
}

interface LockboxSource {
  path: string
  body: string
  sha: string
}

/** 公开内容还是 v1 时改写并写回，资料库随之标为 v2；返回改写的文件数。 */
export async function migratePublicMarkdownDialect(invoke: Invoke): Promise<number> {
  const plan = await invoke<PublicMigrationPlan>("list_markdown_dialect_migration")
  if (plan.dialect >= CURRENT_MARKDOWN_DIALECT) return 0
  const files = plan.sources.flatMap((source) => {
    const content = migrateLegacyParagraphGaps(source.content)
    return content === source.content ? [] : [{ path: source.path, expectedSha: source.sha, content }]
  })
  // 没有要改的文件也要调用一次，把资料库标成 v2。
  return invoke<number>("apply_markdown_dialect_migration", { files })
}

/** 解锁后改写还是 v1 的密匣正文；返回改写的条数。 */
export async function migrateLockboxMarkdownDialect(invoke: Invoke): Promise<number> {
  const sources = await invoke<LockboxSource[]>("list_lockbox_dialect_migration")
  const files = sources.flatMap((source) => {
    const body = migrateLegacyParagraphGaps(source.body)
    return body === source.body ? [] : [{ path: source.path, expectedSha: source.sha, body }]
  })
  if (files.length === 0) return 0
  return invoke<number>("apply_lockbox_dialect_migration", { files })
}
