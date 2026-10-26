#!/usr/bin/env bash
# 恢复演练（在你保管 age 私钥的电脑上跑，VPS 上没有私钥）：
#   restore-drill.sh <shard-时间.tar.zst.age> <age 私钥文件> [shard-server 路径]
# 解密 → 解包到临时目录 → 完整性校验 → 打印内容数量。不碰任何正在用的数据。
set -euo pipefail
archive=${1:?用法：restore-drill.sh <备份文件> <age 私钥文件> [shard-server]}
identity=${2:?缺少 age 私钥文件}
server=${3:-shard-server}

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
age -d -i "$identity" "$archive" | zstd -q -d | tar -C "$work" -xf -
snapshot=$(find "$work" -mindepth 1 -maxdepth 1 -type d -name 'shard-*' | head -1)
"$server" verify --data-dir "$snapshot"
echo "演练通过：$archive 可以解密、解包并通过完整性校验。"
