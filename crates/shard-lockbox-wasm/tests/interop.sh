#!/usr/bin/env bash
# 密匣 wasm 的全部检查：原生测试、Node 下的固定向量与会话、wasm ↔ 桌面互通（两个方向）。
#   bash crates/shard-lockbox-wasm/tests/interop.sh
set -euo pipefail
cd "$(dirname "$0")/../../.."

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

cargo test -p shard-lockbox-wasm
scripts/build-lockbox-wasm.sh nodejs "$work/wasm"
node crates/shard-lockbox-wasm/tests/node-vectors.cjs "$work/wasm"

export SHARD_LOCKBOX_INTEROP_DIR="$work/interop"
mkdir -p "$SHARD_LOCKBOX_INTEROP_DIR"
cargo test -p shard-lockbox-wasm --test interop -- --ignored --exact desktop_writes_vault_for_wasm
node crates/shard-lockbox-wasm/tests/node-session.cjs "$work/wasm" "$SHARD_LOCKBOX_INTEROP_DIR"
cargo test -p shard-lockbox-wasm --test interop -- --ignored --exact desktop_reads_vault_written_by_wasm
echo "密匣 wasm：全部检查通过"
