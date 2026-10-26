#!/usr/bin/env bash
# 密匣 wasm：把 crates/shard-lockbox-wasm 编成 wasm32，再用 wasm-bindgen 生成 JS 胶水。
#   scripts/build-lockbox-wasm.sh [--if-stale] [web|nodejs] [输出目录]
# 默认输出到 src/lib/lockbox-client/wasm（gitignore，网页端按需加载）。`--if-stale`：产物比全部输入都新时跳过
#（pnpm dev / build 用它：改了 Rust 才重编；产物已是最新时不需要 wasm 工具链）。
# 需要：rustup target add wasm32-unknown-unknown；wasm-bindgen-cli 与 Cargo.lock 里 wasm-bindgen 同一版本
#（cargo install wasm-bindgen-cli --version <版本> --locked）。
set -euo pipefail
cd "$(dirname "$0")/.."

if_stale=0
if [ "${1:-}" = "--if-stale" ]; then
  if_stale=1
  shift
fi
target="${1:-web}"
out="${2:-src/lib/lockbox-client/wasm}"
stamp="$out/shard_lockbox_wasm_bg.wasm"

if [ "$if_stale" = 1 ] && [ -f "$stamp" ] && [ -f "$out/shard_lockbox_wasm.js" ]; then
  newer="$(find Cargo.lock Cargo.toml crates/shard-lockbox-wasm crates/shard-lockbox crates/shard-vault crates/shard-core \
    -type f \( -name '*.rs' -o -name 'Cargo.toml' -o -name 'Cargo.lock' \) -newer "$stamp" -print 2>/dev/null | head -n 1 || true)"
  if [ -z "$newer" ]; then
    exit 0
  fi
  echo "密匣 wasm 需要重新构建（${newer} 有改动）。"
fi

want="$(awk '/^name = "wasm-bindgen"$/{getline; gsub(/version = |"/, ""); print; exit}' Cargo.lock)"
missing=()
if ! command -v cargo >/dev/null 2>&1; then
  missing+=("Rust 工具链：到 https://rustup.rs 安装 rustup，重开终端")
elif command -v rustup >/dev/null 2>&1 && ! rustup target list --installed 2>/dev/null | grep -qx wasm32-unknown-unknown; then
  missing+=("wasm32 目标：rustup target add wasm32-unknown-unknown")
fi
have="$(wasm-bindgen --version 2>/dev/null | awk '{print $2}' || true)"
if [ "$want" != "$have" ]; then
  missing+=("wasm-bindgen-cli ${want}（本机：${have:-未安装}）：cargo install wasm-bindgen-cli --version ${want} --locked")
fi
if [ "${#missing[@]}" -gt 0 ]; then
  echo "构建密匣 wasm（网页端的密匣）缺少工具：" >&2
  for item in "${missing[@]}"; do
    echo "  - ${item}" >&2
  done
  echo "装好后重新运行，或手动执行 scripts/build-lockbox-wasm.sh。" >&2
  exit 1
fi

cargo build -p shard-lockbox-wasm --target wasm32-unknown-unknown --release
mkdir -p "$out"
wasm-bindgen --target "$target" --out-dir "$out" target/wasm32-unknown-unknown/release/shard_lockbox_wasm.wasm
# --if-stale 以 .wasm 的时间为准：内容没变时 wasm-bindgen 也会重写它，这里再确认一次。
touch "$stamp"
echo "已生成 ${out}"
