#!/usr/bin/env bash
# Shard 备份：一致快照 → 校验 → 打包压缩 → age 公钥加密 →（--upload 时）传到异地。
#
#   shard-backup.sh            每小时：只留本地加密快照（默认保留 48 份）
#   shard-backup.sh --upload   每天：同时用 rclone 传到 SHARD_BACKUP_REMOTE，并清理超期的异地副本
#
# 依赖：shard-server、tar、zstd、age、rclone（只在 --upload 时需要）。
set -euo pipefail

DATA_DIR=${SHARD_DATA_DIR:-/var/lib/shard}
BACKUP_DIR=${SHARD_BACKUP_DIR:-/var/backups/shard}
RECIPIENTS=${SHARD_BACKUP_RECIPIENTS:-/etc/shard/backup-recipients.txt}
REMOTE=${SHARD_BACKUP_REMOTE:-}
KEEP_LOCAL=${SHARD_BACKUP_KEEP_LOCAL:-48}
KEEP_REMOTE_DAYS=${SHARD_BACKUP_KEEP_REMOTE_DAYS:-90}
SERVER=${SHARD_SERVER_BIN:-/usr/local/bin/shard-server}

upload=false
[ "${1:-}" = "--upload" ] && upload=true

if [ ! -s "$RECIPIENTS" ]; then
	echo "缺少 age 公钥文件：$RECIPIENTS（见 deploy/README.md 的「备份」一节）" >&2
	exit 1
fi

umask 077
mkdir -p "$BACKUP_DIR"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
work=$(mktemp -d "$BACKUP_DIR/.work-XXXXXX")
trap 'rm -rf "$work"' EXIT

snapshot="$work/shard-$stamp"
"$SERVER" snapshot --data-dir "$DATA_DIR" --out-dir "$snapshot"
# 校验不过就不产出这份备份，留着上一份好的。
"$SERVER" verify --data-dir "$snapshot"
rm -f "$snapshot"/*-wal "$snapshot"/*-shm

archive="$BACKUP_DIR/shard-$stamp.tar.zst.age"
tar -C "$work" -cf - "shard-$stamp" | zstd -q -T0 -19 | age -R "$RECIPIENTS" -o "$archive.partial"
mv "$archive.partial" "$archive"
echo "已生成 $archive"

# 本地只留最近 KEEP_LOCAL 份。
ls -1t "$BACKUP_DIR"/shard-*.tar.zst.age 2>/dev/null | tail -n +"$((KEEP_LOCAL + 1))" | xargs -r rm -f

if $upload; then
	if [ -z "$REMOTE" ]; then
		echo "没有配置 SHARD_BACKUP_REMOTE，跳过异地上传。" >&2
		exit 1
	fi
	rclone copy "$archive" "$REMOTE/"
	rclone delete --min-age "${KEEP_REMOTE_DAYS}d" --include 'shard-*.tar.zst.age' "$REMOTE/"
	echo "已上传到 $REMOTE"
fi
