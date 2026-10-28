#!/usr/bin/env bash
# 每周恢复演练（在保管 age 私钥的 Mac 上跑，VPS 上只有公钥、解不开）：
# 从异地取最新一份加密备份 → restore-drill.sh 解密、解包、完整性校验 → 失败时弹系统通知。
#
#   restore-drill-latest.sh <rclone 远端，如 b2:shard-backup> <age 私钥文件> [shard-server 路径]
#
# 用 launchd 每周跑一次：见 deploy/dev.shard.restore-drill.plist。
set -uo pipefail
remote=${1:?用法：restore-drill-latest.sh <rclone 远端> <age 私钥文件> [shard-server]}
identity=${2:?缺少 age 私钥文件}
server=${3:-shard-server}
here=$(cd "$(dirname "$0")" && pwd)

notify() {
	osascript -e "display notification \"$1\" with title \"Shard 恢复演练\"" >/dev/null 2>&1 || true
	echo "$1"
}

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
latest=$(rclone lsf --files-only --include 'shard-*.tar.zst.age' "$remote/" | sort | tail -1)
if [ -z "$latest" ]; then
	notify "失败：异地没有找到任何备份（${remote}）。"
	exit 1
fi
if ! rclone copy "$remote/$latest" "$work/"; then
	notify "失败：下载 $latest 出错。"
	exit 1
fi
# 备份文件名里是 UTC 时间：超过 2 天没有新备份，说明 VPS 上的定时备份停了。
stamp=$(echo "$latest" | sed -E 's/^shard-([0-9]{8}T[0-9]{6}Z).*/\1/')
age_seconds=$(( $(date -u +%s) - $(date -u -j -f "%Y%m%dT%H%M%SZ" "$stamp" +%s 2>/dev/null || echo 0) ))
if [ "$age_seconds" -gt $((2 * 86400)) ]; then
	notify "警告：最新异地备份是 ${stamp}，已超过 2 天。"
fi
if "$here/restore-drill.sh" "$work/$latest" "$identity" "$server"; then
	echo "演练通过：$latest"
else
	notify "失败：$latest 解密、解包或完整性校验没有通过。"
	exit 1
fi
