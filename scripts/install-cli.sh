#!/usr/bin/env bash
# 构建并安装终端快捷创建命令 `shard`。
# 默认装到 ~/.local/bin，可用 PREFIX 覆盖：PREFIX=/usr/local/bin pnpm install:cli
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
prefix="${PREFIX:-$HOME/.local/bin}"

cargo build --release -p shard-cli --manifest-path "$root/Cargo.toml"

mkdir -p "$prefix"
install -m 755 "$root/target/release/shard-cli" "$prefix/shard"
echo "已安装：$prefix/shard"

case ":$PATH:" in
  *":$prefix:"*) ;;
  *) echo "提示：$prefix 不在 PATH 中，可在 ~/.zshrc 加入：export PATH=\"$prefix:\$PATH\"" ;;
esac
