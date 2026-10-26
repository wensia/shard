// wasm 会话（与浏览器里跑的是同一份 .wasm 的 nodejs 版）的端到端检查与互通的 wasm 一半：
//   node crates/shard-lockbox-wasm/tests/node-session.cjs <wasm 胶水目录> <互通目录>
// 1. 读桌面函数写出的 <互通目录>/desktop（tests/interop.rs 的 desktop_writes_vault_for_wasm），解锁后与期望逐条比对；
// 2. 自己设置一个密匣、经假服务器写入、锁着用公钥写、归档、属性，导出到 <互通目录>/web 与 web-expect.json，
//    交给 desktop_reads_vault_written_by_wasm 用桌面函数解开。
const fs = require("fs")
const path = require("path")
const assert = require("assert")
const crypto = require("crypto")

const wasm = require(path.resolve(process.argv[2], "shard_lockbox_wasm.js"))
const root = path.resolve(process.argv[3])
const PASSWORD = "interop password"

const sha = (text) => crypto.createHash("sha256").update(text, "utf8").digest("hex")

function open() {
  const session = new wasm.LockboxSession()
  const call = (method, args = {}) => {
    const reply = JSON.parse(session.call(method, JSON.stringify({ ...args, clock: { nowMs: Date.now(), utcOffsetMinutes: 480 } })))
    if ("ok" in reply) return reply.ok
    const error = new Error(reply.error ?? JSON.stringify(reply.searchError))
    error.reply = reply
    throw error
  }
  return { session, call }
}

/** 照 crates/shard-server/src/lockbox.rs：CAS、整批成败、put 缺省路径沿用原来的。 */
class FakeServer {
  manifest = null
  items = new Map()
  snapshot() {
    return {
      configured: this.manifest !== null,
      manifest: this.manifest,
      items: [...this.items].map(([id, item]) => ({ id, ...item, revision: 1 })),
      itemsWithheld: false,
      webUnlock: true,
    }
  }
  apply(args) {
    const items = new Map(this.items)
    let manifest = this.manifest
    let outManifest = null
    if (args.manifest) {
      if ((manifest?.sha ?? null) !== args.manifest.expectedSha) throw new Error("STALE_BASE")
      manifest = { body: args.manifest.body, sha: sha(args.manifest.body) }
      outManifest = { sha: manifest.sha, revision: 2 }
    }
    const out = []
    for (const item of args.items ?? []) {
      const current = items.get(item.id)?.sha ?? null
      if (current !== item.expectedSha) throw new Error("STALE_BASE")
      if (item.op === "put") {
        const next = { envelope: item.envelope, sha: sha(item.envelope), path: item.path ?? items.get(item.id)?.path ?? null }
        items.set(item.id, next)
        out.push({ id: item.id, sha: next.sha, revision: 2, path: next.path })
      } else {
        items.delete(item.id)
        out.push({ id: item.id, sha: null })
      }
    }
    this.manifest = manifest
    this.items = items
    return { manifest: outManifest, items: out }
  }
}

function write(client, server, method, args) {
  const reply = client.call(method, args)
  if (reply.forward) return reply
  if (reply.write) {
    assert.strictEqual(reply.write.seal, null)
    const apply = server.apply(reply.write.apply)
    client.call("commit", { apply, seal: null })
  }
  return reply.result
}

function essence(fragments) {
  const out = {}
  for (const f of [...fragments].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    out[f.id] = {
      content: f.content,
      tags: f.tags,
      pinned: f.pinned,
      archived: f.archived,
      path: f.path,
      fileSha: f.fileSha,
      createdAt: f.createdAt,
      properties: f.properties,
    }
  }
  return out
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (entry.name.endsWith(".shard")) out.push(full)
  }
  return out
}

// ---- 1. wasm 读桌面写出的目录 ----
{
  const dir = path.join(root, "desktop")
  const body = fs.readFileSync(path.join(dir, ".shard/lockbox.json"), "utf8")
  const items = walk(path.join(dir, "lockbox")).map((file) => {
    const envelope = fs.readFileSync(file, "utf8")
    return { id: JSON.parse(envelope).id, envelope, sha: sha(envelope), path: path.relative(dir, file).split(path.sep).join("/") }
  })
  const client = open()
  client.call("load", { snapshot: { configured: true, manifest: { body, sha: sha(body) }, items, itemsWithheld: false, webUnlock: true } })
  assert.throws(() => client.call("unlock", { password: "wrong password" }), /密码不正确/)
  const unlocked = client.call("unlock", { password: PASSWORD })
  assert.strictEqual(unlocked.write, null, "桌面的 manifest 已有写入密钥对，解锁不应写回")
  const expected = JSON.parse(fs.readFileSync(path.join(root, "desktop-expect.json"), "utf8"))
  assert.deepStrictEqual(essence(client.call("list")), expected)
  client.session.free()
}

// ---- 2. wasm 写，桌面读 ----
{
  const server = new FakeServer()
  const client = open()
  client.call("load", { snapshot: server.snapshot() })
  const started = Date.now()
  const { recoveryKey } = write(client, server, "setup", { password: PASSWORD })
  console.log(`wasm 设置密匣（含 RSA-2048 密钥对）：${Date.now() - started} ms`)
  assert.match(recoveryKey, /^shard-/)

  const first = write(client, server, "create", { content: "网页写的第一条", tags: ["密匣", "日记"] })
  write(client, server, "update", { id: first.id, content: "网页改过的第一条\n\n第二段", tags: ["密匣", "日记"], expectedFileSha: first.fileSha })
  write(client, server, "set_property", { id: first.id, key: "地点", value: { type: "text", value: "杭州" } })
  write(client, server, "set_pinned", { id: first.id, pinned: true })
  const second = write(client, server, "create", { content: "网页写了又归档", tags: ["密匣"] })
  write(client, server, "set_archived", { id: second.id, archived: true })

  client.call("lock")
  assert.deepStrictEqual(client.call("list"), [])
  const locked = write(client, server, "create", { content: "网页锁着用公钥写的", tags: ["密匣"] })
  assert.strictEqual(locked.content, "")
  assert.throws(() => client.call("update", { id: locked.id, content: "x", tags: [] }), /lockbox_locked/)

  const begin = Date.now()
  write(client, server, "unlock", { password: PASSWORD })
  console.log(`wasm 解锁：${Date.now() - begin} ms`)
  const listed = client.call("list")
  assert.strictEqual(listed.length, 3)
  assert.ok(listed.some((f) => f.content === "网页锁着用公钥写的"))

  const search = client.call("search", {
    vaultPath: "web",
    request: {
      clientRequestId: "r", expectedVaultPath: "web", context: null, scope: "lockbox", includeTrash: true,
      queryVersion: 1, projectionVersion: 1, query: "公钥", limit: 10, refresh: "auto",
    },
  })
  assert.strictEqual(search.total, 1)

  const out = path.join(root, "web")
  fs.rmSync(out, { recursive: true, force: true })
  fs.mkdirSync(path.join(out, ".shard"), { recursive: true })
  fs.writeFileSync(path.join(out, ".shard/lockbox.json"), server.manifest.body)
  for (const [id, item] of server.items) {
    assert.ok(item.path, `${id} 应有路径`)
    fs.mkdirSync(path.dirname(path.join(out, item.path)), { recursive: true })
    fs.writeFileSync(path.join(out, item.path), item.envelope)
  }
  fs.writeFileSync(path.join(root, "web-expect.json"), JSON.stringify(essence(listed), null, 2))
  client.call("lock")
  client.session.free()
}

console.log("wasm 会话：全部通过")
