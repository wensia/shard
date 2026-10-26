#!/usr/bin/env bash
# 密匣 wasm：把 crates/shard-lockbox-wasm 编成 wasm32，再用 wasm-bindgen 生成 JS 胶水。
#   scripts/build-lockbox-wasm.sh [web|nodejs] [输出目录]
# 需要：rustup target add wasm32-unknown-unknown；wasm-bindgen-cli 与 Cargo.lock 里 wasm-bindgen 同一版本
#（cargo install wasm-bindgen-cli --version <版本> --locked）。
set -euo pipefail
cd "$(dirname "$0")/.."
target="${1:-web}"
out="${2:-src/lib/lockbox-client/wasm}"
want="$(awk '/^name = "wasm-bindgen"$/{getline; gsub(/version = |"/, ""); print; exit}' Cargo.lock)"
have="$(wasm-bindgen --version 2>/dev/null | awk '{print $2}')"
if [ "$want" != "$have" ]; then
  echo "wasm-bindgen-cli 版本不符：Cargo.lock 要 $want，本机是 ${have:-未安装}。" >&2
  echo "运行：cargo install wasm-bindgen-cli --version $want --locked" >&2
  exit 1
fi
cargo build -p shard-lockbox-wasm --target wasm32-unknown-unknown --release
wasm-bindgen --target "$target" --out-dir "$out" target/wasm32-unknown-unknown/release/shard_lockbox_wasm.wasm
echo "已生成 $out"
