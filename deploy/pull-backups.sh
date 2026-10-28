#!/usr/bin/env bash
# Mac 上的异地副本：把服务器上最新一份加密快照拉到本地，每隔 7 天顺带做一次恢复演练。
# launchd 每天跑两次（deploy/dev.shard.pull-backups.plist）；Mac 关机错过的，下次运行时补上。
#
#   pull-backups.sh <ssh 主机> <age 私钥文件> <shard-server 路径> [--drill]
#
# 本地保留最近 14 天拉到的全部，更早的每天留最后一份，90 天以前的删除。
# 服务器上的快照属主是容器用户、权限 600，所以用 sudo 读（ssh 用户要有免密 sudo）。
# macOS 自带的 bash 是 3.2：不要用 mapfile、关联数组。
set -uo pipefail

host=${1:?用法：pull-backups.sh <ssh 主机> <age 私钥文件> <shard-server 路径> [--drill]}
identity=${2:?缺少 age 私钥文件}
server=${3:?缺少 shard-server 路径}
force_drill=${4:-}
dest=${SHARD_BACKUP_LOCAL_DIR:-$HOME/shard-backups}
remote_dir=${SHARD_BACKUP_REMOTE_DIR:-/opt/shard/backups}
here=$(cd "$(dirname "$0")" && pwd)
pattern='^shard-[0-9]{8}T[0-9]{6}Z\.tar\.zst\.age$'

notify() {
	osascript -e "display notification \"$1\" with title \"Shard 备份\"" >/dev/null 2>&1 || true
	echo "$(date '+%F %T') $1"
}

# 备份文件名里的 UTC 时间 → 秒。
stamp_seconds() {
	local stamp=${1#shard-}
	date -u -j -f "%Y%m%dT%H%M%SZ" "${stamp%%.*}" +%s 2>/dev/null
}

mkdir -p "$dest"
latest=$(ssh -o BatchMode=yes -o ConnectTimeout=20 "$host" "sudo ls -1 $remote_dir" 2>/dev/null | grep -E "$pattern" | sort | tail -1)
if [ -z "$latest" ]; then
	notify "失败：连不上 $host，或服务器上没有任何备份。"
	exit 1
fi
if [ ! -f "$dest/$latest" ]; then
	if ! rsync -a --rsync-path="sudo rsync" "$host:$remote_dir/$latest" "$dest/.partial-$latest"; then
		rm -f "$dest/.partial-$latest"
		notify "失败：下载 $latest 出错。"
		exit 1
	fi
	mv "$dest/.partial-$latest" "$dest/$latest"
	echo "$(date '+%F %T') 已拉取 $latest"
fi

now=$(date -u +%s)
# 服务器每小时备份一次：最新一份超过 6 小时，说明服务器上的定时备份停了。
latest_seconds=$(stamp_seconds "$latest" || echo 0)
if [ $((now - latest_seconds)) -gt $((6 * 3600)) ]; then
	notify "警告：服务器上最新的备份是 $latest，已超过 6 小时没有新备份。"
fi

# 保留策略：从新到旧，14 天以前的每天只留遇到的第一份（当天最晚的）。
seen=" "
for file in $(ls -1 "$dest" | grep -E "$pattern" | sort -r); do
	seconds=$(stamp_seconds "$file") || continue
	days=$(((now - seconds) / 86400))
	day=${file#shard-}
	day=${day%%T*}
	if [ "$days" -ge 90 ]; then
		rm -f "$dest/$file"
		continue
	fi
	if [ "$days" -ge 14 ]; then
		case "$seen" in *" $day "*)
			rm -f "$dest/$file"
			continue
			;;
		esac
	fi
	seen="$seen$day "
done

# 恢复演练：距上次成功满 7 天（或带 --drill）就做一次。
marker="$dest/.last-drill"
last_drill=$(cat "$marker" 2>/dev/null || echo 0)
if [ "$force_drill" = "--drill" ] || [ $((now - last_drill)) -ge $((7 * 86400)) ]; then
	if "$here/restore-drill.sh" "$dest/$latest" "$identity" "$server"; then
		echo "$now" >"$marker"
	else
		notify "失败：$latest 解密、解包或完整性校验没有通过。"
		exit 1
	fi
fi
