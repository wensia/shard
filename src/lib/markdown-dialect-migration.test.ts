import { describe, expect, it } from "vitest"

import { migrateLockboxMarkdownDialect, migratePublicMarkdownDialect } from "./markdown-dialect-migration"

function fakeInvoke(responses: Record<string, unknown>) {
  const calls: { command: string; args?: Record<string, unknown> }[] = []
  const invoke = async <T,>(command: string, args?: Record<string, unknown>) => {
    calls.push({ command, args })
    return responses[command] as T
  }
  return { calls, invoke }
}

describe("Markdown 方言迁移的前端步骤", () => {
  it("v1 资料库：只把改写过的文件交回 Rust，并带上原 sha", async () => {
    const { calls, invoke } = fakeInvoke({
      list_markdown_dialect_migration: {
        dialect: 1,
        sources: [
          { path: "fragments/a.md", content: "甲\n\n乙\n", sha: "sha-a" },
          { path: "fragments/b.md", content: "一行\n", sha: "sha-b" },
        ],
      },
      apply_markdown_dialect_migration: 1,
    })
    await expect(migratePublicMarkdownDialect(invoke)).resolves.toBe(1)
    expect(calls[1]).toEqual({
      command: "apply_markdown_dialect_migration",
      args: { files: [{ path: "fragments/a.md", expectedSha: "sha-a", content: "甲\n乙\n" }] },
    })
  })

  it("v1 资料库没有要改的文件，仍调用一次写回以记下版本", async () => {
    const { calls, invoke } = fakeInvoke({
      list_markdown_dialect_migration: { dialect: 1, sources: [] },
      apply_markdown_dialect_migration: 0,
    })
    await migratePublicMarkdownDialect(invoke)
    expect(calls.map((call) => call.command)).toEqual([
      "list_markdown_dialect_migration",
      "apply_markdown_dialect_migration",
    ])
  })

  it("已是 v2 的资料库不再写回", async () => {
    const { calls, invoke } = fakeInvoke({ list_markdown_dialect_migration: { dialect: 2, sources: [] } })
    await expect(migratePublicMarkdownDialect(invoke)).resolves.toBe(0)
    expect(calls).toHaveLength(1)
  })

  it("密匣：只交回改写过的正文，没有就不调用写回", async () => {
    const changed = fakeInvoke({
      list_lockbox_dialect_migration: [
        { path: "lockbox/fragments/a.shard", body: "甲\n\n\n乙", sha: "sha-a" },
        { path: "lockbox/fragments/b.shard", body: "一行", sha: "sha-b" },
      ],
      apply_lockbox_dialect_migration: 1,
    })
    await expect(migrateLockboxMarkdownDialect(changed.invoke)).resolves.toBe(1)
    expect(changed.calls[1].args).toEqual({
      files: [{ path: "lockbox/fragments/a.shard", expectedSha: "sha-a", body: "甲\n\n乙" }],
    })

    const unchanged = fakeInvoke({ list_lockbox_dialect_migration: [{ path: "lockbox/x.shard", body: "一行", sha: "s" }] })
    await expect(migrateLockboxMarkdownDialect(unchanged.invoke)).resolves.toBe(0)
    expect(unchanged.calls).toHaveLength(1)
  })
})
