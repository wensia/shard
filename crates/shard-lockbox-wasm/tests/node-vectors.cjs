// wasm 版解开 shard-lockbox 的两份固定向量（含旧桌面真实写出的那份），证明浏览器与桌面同一格式。
//   scripts/build-lockbox-wasm.sh nodejs <目录> && node crates/shard-lockbox-wasm/tests/node-vectors.cjs <目录>
const fs = require("fs")
const path = require("path")
const assert = require("assert")

const wasm = require(path.resolve(process.argv[2], "shard_lockbox_wasm.js"))
const fixtures = path.join(__dirname, "../../shard-lockbox/tests/fixtures")

for (const file of ["lockbox-v1.json", "lockbox-desktop-v1.json"]) {
  const fixture = JSON.parse(fs.readFileSync(path.join(fixtures, file), "utf8"))
  for (const envelope of fixture.envelopes) {
    const payload = JSON.parse(wasm.openWithPassword(fixture.manifest, fixture.password, envelope.text))
    const expected = envelope.body ?? JSON.parse(envelope.plaintext).body
    assert.strictEqual(payload.body, expected, `${file} ${envelope.name ?? envelope.id}`)
  }
  assert.throws(() => wasm.openWithPassword(fixture.manifest, "wrong password", fixture.envelopes[0].text), /密码不正确/)
}
console.log("wasm 向量：全部通过")
